// The Messenger relay between a volunteer and the caller they said YES to. Facebook's API can't make a group chat,
// so the Page passes messages along instead: while the request is 'incoming', anything else the volunteer writes
// goes to the caller's linked Messenger (JOIN <zip> <phone>), and anything the caller writes goes to the volunteer.
// YES / DONE / CANCEL and the keywords are answered before this runs, and DONE or CANCEL ends the relay. A message
// that starts with SHADE goes to the text agent instead. Neither side needs the other's number, though both still
// get it (neighbors.ts): a caller without a linked Messenger can only be called.
import { emergencyReply, matchEmergency } from '../m4/agent/safety';
import { getSubscriber, insertFollowup, insertMessage } from '../m4/db';
import { sendMessengerInWindow } from '../m4/messenger/send';
import { isMessengerContact, type CallOutcome, type Language, type MessengerContact, type SubscriberRow } from '../m4/types';
import { db } from '../shared/db';
import { hashPhone } from '../shared/phone';
import { logEvent } from './events';
import { activeAssignment, callerProfile, shownPhone, volunteerPhoneFor } from './neighbors';

const TO_SHADE = /^\s*shade\b/i;
// Room for the label and the 911 line inside Twilio's 1,600 characters.
const MAX_RELAYED = 1300;
// A held message is stale after a day: the request is likely over by then.
const HOLD_HOURS = 24;

interface Pair {
  id: number;
  conversationId: string | null;
  from: 'volunteer' | 'caller';
  to: MessengerContact;
  otherPhone: string | null; // the recipient's number, for the sender to call when the message can't go now
}

/** Who is on the other end of `sender`'s open request, if both sides are on Messenger. */
async function findPair(sender: SubscriberRow, contactHash: string): Promise<Pair | null> {
  if (!db) return null;
  const assignment = await activeAssignment(contactHash);
  if (assignment) {
    const to = await callerProfile(assignment.phone_e164);
    if (!to) return null;
    const { rows: [r] } = await db.query(`select conversation_id from requests where id = $1`, [assignment.id]);
    return { id: assignment.id, conversationId: r?.conversation_id ?? null, from: 'volunteer', to, otherPhone: assignment.phone_e164 };
  }
  if (!sender.linked_phone_hash || !process.env.PHONE_SALT) return null;
  // Requests keep the raw number, not its hash, so the match is made here. Open requests are few.
  const { rows } = await db.query(
    `select id, conversation_id, phone_e164, volunteer_hash from requests
     where status = 'incoming' and phone_e164 is not null and volunteer_hash is not null order by updated_at desc`);
  const r = rows.find((row) => hashPhone(row.phone_e164) === sender.linked_phone_hash);
  if (!r) return null;
  const volunteer = await getSubscriber(r.volunteer_hash);
  if (!volunteer || volunteer.opted_out_at || !isMessengerContact(volunteer)) return null;
  return { id: r.id, conversationId: r.conversation_id, from: 'caller', to: volunteer, otherPhone: await volunteerPhoneFor(r.id) };
}

function relayed(pair: Pair, body: string, emergency: boolean): string {
  const es = pair.to.language === 'es';
  const who = pair.from === 'volunteer'
    ? (es ? 'Su voluntario' : 'Your volunteer')
    : (es ? `La persona que ayuda (solicitud ${pair.id})` : `The person you're helping (request ${pair.id})`);
  const text = body.trim().slice(0, MAX_RELAYED);
  const warning = !emergency ? '' : es
    ? '\n🚨 Esto puede ser una emergencia. Si lo es, llame al 911 ahora.'
    : '\n🚨 This may be an emergency. If it is, call 911 now.';
  return `💬 ${who}: ${text}${warning}`;
}

function heldNote(pair: Pair, language: Language): string {
  const es = language === 'es';
  const them = pair.from === 'volunteer'
    ? (es ? 'La persona que ayuda' : "The person you're helping")
    : (es ? 'Su voluntario' : 'Your volunteer');
  const call = pair.otherPhone ? (es ? ` Para hablar ahora, llame al ${shownPhone(pair.otherPhone)}.` : ` To reach them now, call ${shownPhone(pair.otherPhone)}.`) : '';
  return es
    ? `${them} no ha escrito a Shade en el último día, así que Facebook no nos deja pasar su mensaje todavía. Se lo enviaremos cuando escriba.${call}`
    : `${them} hasn't written to Shade in the last day, so Facebook won't let us pass your message on yet. We'll send it when they next write.${call}`;
}

export interface RelayResult {
  reply: string | null; // to the sender; null = nothing, the message went through
  outcome: CallOutcome | null;
}

/**
 * Passes `body` from `sender` to the other side of their open request. Returns null when there is no one to relay
 * to (or the message is for SHADE), and the caller handles it as before. Throws on a database failure.
 */
export async function relayMessage(sender: SubscriberRow | null, contactHash: string, body: string): Promise<RelayResult | null> {
  if (!sender || sender.opted_out_at || TO_SHADE.test(body) || !body.trim()) return null;
  const pair = await findPair(sender, contactHash);
  if (!pair) return null;

  const emergency = matchEmergency(body);
  const text = relayed(pair, body, !!emergency);
  const sent = await sendMessengerInWindow(pair.to, text, `relay on request ${pair.id}`);
  const held = !sent.ok && sent.error === 'messenger_window_closed';
  if (held) {
    // Goes out at the top of their next message (deliverFollowups), which also saves it to their conversation.
    await insertFollowup({ phoneHash: pair.to.phone_hash, body: text, siteId: null, expiresAt: new Date(Date.now() + HOLD_HOURS * 3600_000) });
  }

  // Both sides' conversations keep it, so the text agent knows what was said once the relay ends.
  await insertMessage({ phoneHash: contactHash, role: 'user', body });
  if (sent.ok) await insertMessage({ phoneHash: pair.to.phone_hash, role: 'assistant', body: text });

  const who = pair.from === 'volunteer' ? 'The volunteer' : 'The caller';
  await logEvent(pair.conversationId, 'help_incoming',
    sent.ok ? `${who} sent a message through Shade` : held ? `${who} sent a message through Shade; held until the other side writes` : `${who} sent a message through Shade; it could not be delivered`);

  const language: Language = emergency?.language ?? sender.language;
  if (emergency) return { reply: emergencyReply(language), outcome: 'escalated_911' };
  if (sent.ok) return { reply: null, outcome: null };
  if (held) return { reply: heldNote(pair, language), outcome: null };
  const call = pair.otherPhone ? ` ${language === 'es' ? 'Llame al' : 'Call'} ${shownPhone(pair.otherPhone)}.` : '';
  return {
    reply: language === 'es' ? `No pudimos pasar su mensaje.${call}` : `We couldn't pass your message on.${call}`,
    outcome: 'error',
  };
}
