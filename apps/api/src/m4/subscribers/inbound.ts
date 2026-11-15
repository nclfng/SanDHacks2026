import { generateTextReply } from '../agent/reply';
import { getSubscriber, insertCall } from '../db';
import { hashPhone, maskPhone, toE164 } from '../phone';
import { helpMessage, joinUsage, optInConfirmation, optOutConfirmation, replyUnavailable } from '../sms/templates';
import type { AlertChannel, CallOutcome, Language } from '../types';
import { detectKeyword, optOut, subscribe, type KeywordMatch } from './consent';

export interface InboundSms {
  from: string; // as Twilio sends it for SMS; for WhatsApp, the E.164 number without 'whatsapp:'
  body: string;
  messageSid: string;
  // 'whatsapp' for the WhatsApp webhook. The same flow handles both: a WhatsApp number is a phone number, hashed
  // the same way, and a JOIN on WhatsApp sends that subscriber's alerts to WhatsApp. Default 'sms'.
  channel?: AlertChannel;
}

export interface InboundResult {
  reply: string | null; // null = send nothing
}

// Twilio can deliver one message twice. Nothing in the schema stores MessageSid, so recent ones are remembered
// here, in this process only, and a repeat gets the answer the first delivery got instead of being handled again.
const DEDUPE_TTL_MS = 10 * 60_000;
const recent = new Map<string, { at: number; result: Promise<InboundResult> }>();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// Routes one inbound text: STOP / START / HELP / JOIN <zip> are handled here, anything else goes to the text agent.
// Returns the reply to send back and logs the inbound sms row in calls. Never throws: when something fails the
// reply is replyUnavailable, so the person is not left with silence.
export function handleInboundSms(msg: InboundSms): Promise<InboundResult> {
  const now = Date.now();
  for (const [sid, entry] of recent) {
    if (now - entry.at > DEDUPE_TTL_MS) recent.delete(sid);
  }
  const seen = recent.get(msg.messageSid);
  if (seen) return seen.result;

  const result = route(msg);
  recent.set(msg.messageSid, { at: now, result });
  return result;
}

async function route(msg: InboundSms): Promise<InboundResult> {
  const phoneE164 = toE164(msg.from);
  // A short code or an alphanumeric sender: there is nobody to answer.
  if (!phoneE164) return { reply: null };

  const match = detectKeyword(msg.body);
  try {
    return await answer(phoneE164, msg.body, match, msg.channel === 'whatsapp' ? 'whatsapp' : 'sms');
  } catch (error) {
    console.error(`[m4] inbound text from ${maskPhone(phoneE164)} failed (${reason(error)})`);
    // The subscriber's language is not known here unless the keyword gave it away, so the reply carries both.
    // It goes out even though the opt-out state is unknown: it answers a text the person just sent.
    return {
      reply: match?.language === 'es' ? replyUnavailable('es') : `${replyUnavailable('en')}\n\n${replyUnavailable('es')}`,
    };
  }
}

async function answer(
  phoneE164: string,
  body: string,
  match: KeywordMatch | null,
  channel: AlertChannel,
): Promise<InboundResult> {
  const phoneHash = hashPhone(phoneE164);
  const subscriber = await getSubscriber(phoneHash);
  // A Spanish keyword is answered in Spanish. Otherwise the subscriber's language, else English. The English
  // keywords say nothing about language: our Spanish texts also tell people to reply STOP and HELP.
  let language: Language = match?.language === 'es' ? 'es' : (subscriber?.language ?? 'en');
  let zip = subscriber?.zip ?? null;
  let reply: string | null;
  // call_outcome has no value for a keyword exchange, so those rows keep a null outcome.
  let outcome: CallOutcome | null = null;
  let siteId: number | null = null;

  switch (match?.keyword) {
    case 'stop':
      // On SMS, Twilio answers its own STOP words itself and then blocks our texts to the number, so this reply
      // only arrives for the Spanish words, which Twilio does not know. On WhatsApp it arrives for all of them.
      // Either way the opt-out covers both channels: alerts stop wherever they were going.
      await optOut(phoneE164);
      reply = optOutConfirmation(language);
      break;

    case 'start':
    case 'join': {
      const typedZip = match.keyword === 'join' ? /\b\d{5}\b/.exec(body)?.[0] : undefined;
      const newZip = typedZip ?? subscriber?.zip;
      if (!newZip) {
        reply = joinUsage(language);
        break;
      }
      // Alerts go to the channel this opt-in came in on.
      const row = await subscribe({
        phoneE164,
        zip: newZip,
        language: match.language === 'es' ? 'es' : undefined,
        alertChannel: channel,
      });
      language = row.language;
      zip = row.zip;
      reply = optInConfirmation(language);
      break;
    }

    case 'help':
      // TODO: Twilio may answer HELP itself as well. Check for a double reply on the first real test.
      reply = helpMessage(language);
      break;

    default:
      if (subscriber?.opted_out_at) {
        // They sent STOP. Nothing goes back until they send START.
        reply = null;
      } else if (!body.trim()) {
        // A picture with no words, for example.
        reply = helpMessage(language);
      } else {
        // The agent slice writes the messages rows. Keyword exchanges are not stored there.
        try {
          const turn = await generateTextReply({ contactHash: phoneHash, body, channel, logLabel: maskPhone(phoneE164) });
          reply = turn.text;
          outcome = turn.outcome;
          siteId = turn.siteId;
          zip = turn.zip ?? zip; // where they said they are, when the agent looked it up; else the zip on file
          language = turn.language;
        } catch (error) {
          console.error(`[m4] text agent failed for ${maskPhone(phoneE164)} (${reason(error)})`);
          reply = replyUnavailable(language);
          outcome = 'error';
        }
      }
  }

  // The reply matters more than the log row. A WhatsApp row also opens the 24-hour window for free-form alerts
  // (db.lastInboundAt), so until the database has the 'whatsapp' channel value, WhatsApp alerts need the template.
  await insertCall({ direction: 'inbound', channel, phoneHash, zip, language, siteId, outcome }).catch(
    (error) => console.error(`[m4] inbound text from ${maskPhone(phoneE164)}: calls row not written (${reason(error)})`),
  );
  return { reply };
}
