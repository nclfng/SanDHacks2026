import { getSubscriber, insertMessage, listRecentMessages } from '../db';
import { textAgent } from '../mastra/text-agent';
import { aiDisclosure, replyUnavailable } from '../sms/templates';
import { LANGUAGES } from '../types';
import type { CallOutcome, FindSitesOutput, Language, MessageRow, SubscriberRow } from '../types';
import { emergencyReply, matchEmergency } from './safety';

// Where the conversation happens. Facebook Messenger turns are keyed by the Messenger hash, never a phone hash.
export type TextChannel = 'sms' | 'messenger' | 'whatsapp';

export interface TextReply {
  text: string;
  outcome: CallOutcome | null; // null when the turn neither gave a site nor escalated, e.g. a clarifying question
  siteId: number | null;
  zip: string | null; // where find_sites placed the person this turn (resolved_zip); null when it did not run
  language: Language;
}

// Twilio waits about 15 seconds for the webhook's answer. The whole agent run gets less than that, so a slow
// model still leaves time to send the fallback.
const AGENT_TIMEOUT_MS = 11_000;
// The prompt keeps the visible reply under about 300 characters. The cap is far above that because Claude's
// thinking counts against it: after a find_sites call a step can spend about 300 tokens thinking, and 400 in all
// cut replies off with finish reason 'length'.
const MAX_OUTPUT_TOKENS = 1500;
const TIME_ZONE = 'America/Los_Angeles';

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// Per-turn context for the model. No phone number or Messenger id goes in here: agent runs are exported by
// observability.
function systemNote(subscriber: SubscriberRow | null, disclosed: boolean, channel: TextChannel): string {
  const now = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
  const lines = [`System note. Local time in San Diego: ${now}.`];
  if (channel === 'messenger') {
    lines.push(
      'This conversation is on Facebook Messenger, not SMS. To get heat and smoke alerts here, the person sends JOIN and their zip code (for example JOIN 92105); STOP cancels them.',
      [
        'Formatting for Messenger: plain text with line breaks; Messenger shows no markdown. Keep the reply under about 500 characters.',
        'Sound warm and human. Before a site, write one short lead-in line, such as "Here\'s the nearest open spot:" or "Good news, there\'s a cooling center close by:". Never call a discovered site a cooling center in the lead-in.',
        'Then give the site as a block of short lines, in this order:',
        '📍 Site name',
        'Street address, city',
        '🕒 Open until 9:30 PM · 0.2 mi away (whatever hours and distance the tool gave)',
        '☎️ One short line for any call-ahead or not-official caveat, when there is one',
        '🗺️ Map: <the map link exactly as the tool returned it>',
        'Put a blank line between the site block and anything else, such as the 211 ride tip or a question.',
        'Use emojis only as these line labels (📍 🕒 ☎️ 🗺️, plus 🚗 for a ride tip and 🚨 for 911), never decoration, and no more than five.',
      ].join('\n'),
    );
  } else {
    lines.push('Formatting for SMS: plain text only, no emojis or bullets. Keep each reply under about 300 characters, and shorter when you can.');
  }
  if (subscriber) {
    const needs = Object.entries(subscriber.needs)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    lines.push(
      `Subscriber zip: ${subscriber.zip}. Language on file: ${subscriber.language}. Needs on file: ${needs || 'none'}.`,
    );
  } else {
    lines.push('This person is not a subscriber, so there is no zip on file.');
  }
  // The disclosure is added in code (see below), so the model must not add a second one.
  lines.push(
    disclosed
      ? 'This person was already told they are texting an automated AI assistant.'
      : 'A line saying you are an automated AI assistant is added in front of your reply for you. Do not repeat it.',
  );
  return lines.join('\n');
}

// True when an earlier reply in the history already carried the AI disclosure.
function alreadyDisclosed(history: MessageRow[]): boolean {
  const lines = [aiDisclosure('en'), aiDisclosure('es')];
  return history.some((m) => m.role === 'assistant' && lines.some((line) => m.body.includes(line)));
}

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

type ToolChunk = { payload: { toolName: string; args?: Record<string, unknown>; result?: unknown; isError?: boolean } };

// outcome, siteId and zip from the last find_sites result in the turn, and the language the model asked it for.
function readToolUse(steps: { toolCalls: ToolChunk[]; toolResults: ToolChunk[] }[]): {
  outcome: CallOutcome | null;
  siteId: number | null;
  zip: string | null;
  language: Language | null;
} {
  const calls = steps.flatMap((s) => s.toolCalls).filter((c) => c.payload.toolName === 'find_sites');
  const results = steps.flatMap((s) => s.toolResults).filter((r) => r.payload.toolName === 'find_sites');
  const lastLanguage = calls.at(-1)?.payload.args?.language;
  const language = isLanguage(lastLanguage) ? lastLanguage : null;

  const last = results.at(-1);
  if (!last) return { outcome: null, siteId: null, zip: null, language };
  if (last.payload.isError) return { outcome: 'error', siteId: null, zip: null, language };
  const output = last.payload.result as FindSitesOutput | undefined;
  const first = output?.sites?.[0];
  const zip = output?.resolved_zip ?? null;
  return first
    ? { outcome: 'site_given', siteId: first.site_id, zip, language }
    : { outcome: 'no_site_found', siteId: null, zip, language };
}

// One turn of an SMS or Messenger conversation: load history by contact hash, run the agent, store both messages.
// contactHash is hashPhone(e164) for SMS and hashMessengerId(psid) for Messenger. logLabel names the person in
// log lines (maskPhone or messengerLogLabel) and must not be a raw number or id.
// It writes only to messages. STOP/START/HELP handling, sending the reply and the calls row belong to the caller.
// Never throws for a model failure: that comes back as a "try again, or call 211" text with outcome 'error'.
// A database failure before the model runs does throw, and the caller answers with the same fallback.
export async function generateTextReply(args: {
  contactHash: string;
  body: string;
  channel: TextChannel;
  logLabel: string;
  context?: string; // extra facts for this turn, such as a volunteer's active help request (helper mode)
}): Promise<TextReply> {
  const phoneHash = args.contactHash;
  // Messenger hashes never match a subscriber row, so a Messenger turn always takes the non-subscriber path.
  const subscriber = await getSubscriber(phoneHash);
  const fallbackLanguage: Language = subscriber?.language ?? 'en';

  // Emergency pre-check, before any model call.
  const emergency = matchEmergency(args.body);
  if (emergency) {
    const language = emergency.language === 'es' ? 'es' : fallbackLanguage;
    const text = emergencyReply(language);
    await saveTurn(phoneHash, args.body, text);
    return { text, outcome: 'escalated_911', siteId: null, zip: null, language };
  }

  // Oldest first. Alert texts are stored here too, so "something closer?" has the alert it answers.
  const history = await listRecentMessages(phoneHash);
  const disclosed = alreadyDisclosed(history);

  let reply: TextReply;
  try {
    const response = await textAgent.generate(
      [
        ...history.map((m) =>
          m.role === 'user' ? { role: 'user' as const, content: m.body } : { role: 'assistant' as const, content: m.body },
        ),
        { role: 'user' as const, content: args.body },
      ],
      {
        system: args.context ? `${systemNote(subscriber, disclosed, args.channel)}\n\n${args.context}` : systemNote(subscriber, disclosed, args.channel),
        maxSteps: 4,
        modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS, timeout: { totalMs: AGENT_TIMEOUT_MS } },
        tracingOptions: { tags: [`m4-${args.channel}`] },
      },
    );
    const text = response.text.trim();
    if (response.finishReason === 'error' || response.error || !text) {
      throw new Error(response.error ? reason(response.error) : `finish reason ${response.finishReason}, no text`);
    }
    const tools = readToolUse(response.steps as unknown as { toolCalls: ToolChunk[]; toolResults: ToolChunk[] }[]);
    const language = tools.language ?? fallbackLanguage;
    reply = {
      // Enforced here rather than left to the prompt: the first reply always says it is an AI.
      text: disclosed ? text : `${aiDisclosure(language)}${args.channel === 'messenger' ? '\n\n' : '\n'}${text}`,
      outcome: tools.outcome,
      siteId: tools.siteId,
      zip: tools.zip,
      language,
    };
  } catch (error) {
    console.error(`[m4] text agent failed for ${args.logLabel} (${reason(error)})`);
    reply = { text: replyUnavailable(fallbackLanguage), outcome: 'error', siteId: null, zip: null, language: fallbackLanguage };
  }

  // Stored user first, so the next turn sees the exchange in order.
  await saveTurn(phoneHash, args.body, reply.text);
  return reply;
}

// A failed write loses context for the next turn but must not cost this reply.
async function saveTurn(phoneHash: string, userBody: string, assistantBody: string): Promise<void> {
  try {
    await insertMessage({ phoneHash, role: 'user', body: userBody });
    await insertMessage({ phoneHash, role: 'assistant', body: assistantBody });
  } catch (error) {
    console.error(`[m4] conversation turn not saved to messages (${reason(error)})`);
  }
}
