import { activeAssignment, answerNeighbor, helperNote } from '../../requests/neighbors';
import { relayMessage } from '../../requests/relay';
import { generateTextReply } from '../agent/reply';
import { getSubscriber, insertCall, insertMessage } from '../db';
import {
  messengerHelpMessage,
  messengerJoinUsage,
  messengerOptInConfirmation,
  messengerPhoneInvalid,
  messengerStopConfirmation,
  replyUnavailable,
} from '../sms/templates';
import { detectKeyword, optOutMessenger, subscribeMessenger, type KeywordMatch } from '../subscribers/consent';
import type { CallOutcome, Language, SendSmsOutput } from '../types';
import { deliverFollowups, dropFollowups } from './followups';
import { hashMessengerId, messengerLogLabel, parseMessengerAddress } from './identity';
import { parseJoinMessage } from './join';
import { fetchMessengerName } from './profile';
import { sendMessengerReply } from './send';

export interface InboundMessenger {
  psid: string; // the person's page-scoped id: inbound From, minus 'messenger:'
  pageId: string; // the Facebook Page written to: inbound To, minus 'messenger:'. The reply goes out from it
  body: string;
  messageSid: string;
}

export interface MessengerResult {
  reply: string | null; // null = nothing sent
  sent: SendSmsOutput | null;
}

// Twilio can deliver one message twice. As for SMS, recent MessageSids are remembered in this process only, and
// a repeat is dropped: the first delivery already sent the reply.
const DEDUPE_TTL_MS = 10 * 60_000;
const recent = new Map<string, number>();

// Pure. Reads Twilio's inbound-message form fields for a Messenger message: From is `messenger:<psid>`, To is
// `messenger:<page id>`, plus Body and MessageSid. Null when a field is missing or From / To is not a Messenger
// address, for example an SMS webhook pointed at the Messenger route.
export function parseMessengerWebhook(params: Record<string, string>): InboundMessenger | null {
  const psid = parseMessengerAddress(params.From ?? '');
  const pageId = parseMessengerAddress(params.To ?? '');
  const messageSid = params.MessageSid ?? '';
  if (!psid || !pageId || !messageSid) return null;
  return { psid, pageId, body: params.Body ?? '', messageSid };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// Handles one inbound Messenger message and sends the reply itself, through the Messages API. The webhook has
// already answered Twilio by then, so a slow agent turn cannot hit Twilio's 15-second limit.
// Messenger is Shade's main channel, with the same keywords as SMS: JOIN <zip> and START sign the person up for
// alerts here (subscribers row keyed by the Messenger hash, alert_channel 'messenger'), STOP opts them out, HELP
// explains. While a volunteer is on their help request, the volunteer and the caller write to each other through the
// Page (requests/relay.ts). Anything else goes to the text agent, keyed by the Messenger hash.
// Logs one calls row (inbound, messenger), which also opens Messenger's 24-hour window for alerts. Never throws.
export async function handleInboundMessenger(msg: InboundMessenger): Promise<MessengerResult> {
  const now = Date.now();
  for (const [sid, at] of recent) {
    if (now - at > DEDUPE_TTL_MS) recent.delete(sid);
  }
  if (recent.has(msg.messageSid)) return { reply: null, sent: null };
  recent.set(msg.messageSid, now);

  const match = detectKeyword(msg.body);
  let reply: string | null;
  let label = 'messenger:unknown';
  try {
    const contactHash = hashMessengerId(msg.psid);
    label = messengerLogLabel(contactHash);
    // Anything held from a phone call goes out first, now that they have written (mode 1). STOP drops it instead.
    if (match?.keyword === 'stop') await dropFollowups(contactHash);
    else await deliverFollowups({ contactHash, psid: msg.psid, pageId: msg.pageId });
    reply = await answer(msg, contactHash, label, match);
  } catch (error) {
    console.error(`[m4] inbound Messenger message from ${label} failed (${reason(error)})`);
    // The language is not known unless a keyword gave it away, so the reply carries both.
    reply = match?.language === 'es' ? replyUnavailable('es') : `${replyUnavailable('en')}\n\n${replyUnavailable('es')}`;
  }

  // No reply when the message was relayed: the other side got it.
  const sent = reply === null ? null : await sendMessengerReply({ pageId: msg.pageId, psid: msg.psid, body: reply });
  return { reply, sent };
}

async function answer(
  msg: InboundMessenger,
  contactHash: string,
  label: string,
  match: KeywordMatch | null,
): Promise<string | null> {
  const subscriber = await getSubscriber(contactHash);
  // A Spanish keyword is answered in Spanish. Otherwise the subscriber's language, else English.
  let language: Language = match?.language === 'es' ? 'es' : (subscriber?.language ?? 'en');
  let zip = subscriber?.zip ?? null;
  // call_outcome has no value for a keyword exchange, so those rows keep a null outcome.
  let outcome: CallOutcome | null = null;
  let siteId: number | null = null;
  let reply: string | null;

  switch (match?.keyword) {
    case 'stop':
      await optOutMessenger(contactHash);
      reply = messengerStopConfirmation(language);
      break;

    case 'start':
    case 'join': {
      // JOIN <zip> [phone] [VOLUNTEER]. START re-subscribes with what is on file, volunteering included.
      const request = match.keyword === 'join' ? parseJoinMessage(msg.body) : null;
      if (request?.phoneInvalid) {
        reply = messengerPhoneInvalid(language);
        break;
      }
      const newZip = request?.zip ?? subscriber?.zip;
      if (!newZip) {
        reply = messengerJoinUsage(language);
        break;
      }
      const row = await subscribeMessenger({
        contactHash,
        psid: msg.psid,
        pageId: msg.pageId,
        zip: newZip,
        language: match.language === 'es' ? 'es' : undefined,
        phoneE164: request?.phoneE164,
        // From their Facebook profile, not typed. Null keeps the name on file.
        name: await fetchMessengerName(msg.psid),
        volunteer: request?.volunteer,
      });
      language = row.language;
      zip = row.zip;
      reply = messengerOptInConfirmation(language, row.zip, {
        phoneLast4: request?.phoneE164?.slice(-4),
        name: row.display_name,
        volunteer: request?.volunteer,
      });
      break;
    }

    case 'help':
      reply = messengerHelpMessage(language);
      break;

    default: {
      let relay: Awaited<ReturnType<typeof relayMessage>>;
      // YES / DONE / CANCEL <id> on a help request (requests/neighbors.ts). Null for anything else.
      const neighborReply = await answerNeighbor(subscriber, msg.body);
      if (neighborReply) {
        reply = neighborReply;
        // Kept in the conversation, so the agent knows what the volunteer was sent when they write next.
        await insertMessage({ phoneHash: contactHash, role: 'user', body: msg.body })
          .then(() => insertMessage({ phoneHash: contactHash, role: 'assistant', body: neighborReply }))
          .catch((error) => console.error(`[m4] volunteer turn for ${label} not saved (${reason(error)})`));
      } else if (!msg.body.trim()) {
        // A sticker or a picture with no words, for example.
        reply = messengerHelpMessage(language);
      } else if ((relay = await relayMessage(subscriber, contactHash, msg.body).catch((error) => {
        console.error(`[m4] relay for ${label} failed (${reason(error)})`);
        return null;
      }))) {
        // Passed to the volunteer or the caller on the other end of an open help request.
        reply = relay.reply;
        outcome = relay.outcome;
      } else {
        // Answered even after STOP: STOP cancels alerts, and this person just wrote to us.
        try {
          // Helper mode: a volunteer on a request gets answers about it instead of the cooling-center script.
          const assignment = subscriber ? await activeAssignment(contactHash).catch(() => null) : null;
          const turn = await generateTextReply({
            contactHash, body: msg.body, channel: 'messenger', logLabel: label,
            context: assignment ? helperNote(assignment) : undefined,
          });
          reply = turn.text;
          outcome = turn.outcome;
          siteId = turn.siteId;
          zip = turn.zip ?? zip; // where they said they are, when the agent looked it up; else the zip on file
          language = turn.language;
        } catch (error) {
          console.error(`[m4] text agent failed for ${label} (${reason(error)})`);
          reply = replyUnavailable(language);
          outcome = 'error';
        }
      }
    }
  }

  // The reply matters more than the log row.
  await insertCall({ direction: 'inbound', channel: 'messenger', phoneHash: contactHash, zip, language, siteId, outcome }).catch(
    (error) => console.error(`[m4] inbound Messenger message from ${label}: calls row not written (${reason(error)})`),
  );
  return reply;
}
