// Neighbor help over Messenger. Volunteers sign up with JOIN <zip> VOLUNTEER (subscribers.volunteer_at). A help
// request goes to every volunteer, wherever they live, and the first to reply YES <id> takes it. The blast carries
// the area and needs only; the exact location goes to the volunteer who said yes. The caller then gets a Messenger
// follow-up.
import { getMessengerProfileByPhone, listActiveVolunteers } from '../m4/db';
import { deliverNowIfWindowOpen, queueFollowup } from '../m4/messenger/followups';
import { sendMessengerInWindow } from '../m4/messenger/send';
import { isMessengerContact, type Language, type SubscriberRow } from '../m4/types';
import { db } from '../shared/db';
import { hashPhone } from '../shared/phone';
import { logEvent } from './events';

const es = (language: string | null | undefined) => language === 'es';

export function blastMessage(id: number, area: string, needs: string[], language: string): string {
  const said = needs.length ? (es(language) ? ` Dijeron: ${needs.join(', ')}.` : ` They said: ${needs.join(', ')}.`) : '';
  return es(language)
    ? `Shade: un vecino ${area} necesita ayuda por el calor.${said} ¿Puede ir? Responda SI ${id} y le enviaremos dónde está. Si alguien tiene señales de golpe de calor, llame al 911.`
    : `Shade: a neighbor ${area} needs help in the heat.${said} Can you go to them? Reply YES ${id} and we'll send you where they are. If anyone has signs of heat illness, call 911.`;
}

/** Messages every reachable volunteer, except the caller, and records how many it reached. Never throws. */
export async function blastNeighbors(r: {
  id: number; conversationId?: string; zip: string | null; area: string; needs: string[]; callerHash: string | null;
}): Promise<void> {
  if (!db) return;
  let reached = 0;
  try {
    // Messenger only: SMS is carrier-blocked and WhatsApp is parked (src/m4/AGENTS.md).
    const contacts = (await listActiveVolunteers())
      .filter((c) => isMessengerContact(c) && c.linked_phone_hash !== r.callerHash);
    // All at once: the caller is waiting on the line. Batch it if volunteers grow to thousands.
    const sent = await Promise.all(
      contacts.map((c) => sendMessengerInWindow(c, blastMessage(r.id, r.area, r.needs, c.language), `help request ${r.id}`)),
    );
    reached = sent.filter((s) => s.ok).length;
  } catch (err) {
    console.error(`[neighbors] blast for request ${r.id} failed`, (err as Error).message);
  }
  await db.query(`update requests set neighbors_messaged = $2 where id = $1`, [r.id, reached])
    .catch((err) => console.error(`[neighbors] request ${r.id}: count not saved`, err.message));
  await logEvent(r.conversationId, 'help_requested',
    reached ? `Sent to ${reached} volunteer${reached === 1 ? '' : 's'}` : 'No volunteer could be messaged');
}

const YES = /^\s*(?:yes|si|sí)\s*#?\s*(\d{1,9})\s*[.!]*\s*$/i;

/** The request id in a "YES 12" / "SI 12" reply, or null. A bare "yes" is left to the text agent. */
export function parseYes(body: string): number | null {
  const m = body.match(YES);
  return m ? Number(m[1]) : null;
}

/**
 * Answers YES <id> from Messenger, or returns null for anything else.
 * `subscriber` is the sender's row, null when they never sent JOIN.
 */
export async function answerNeighbor(
  subscriber: Pick<SubscriberRow, 'phone_hash' | 'zip' | 'language' | 'opted_out_at'> | null,
  body: string,
): Promise<string | null> {
  const id = parseYes(body);
  const active = subscriber && !subscriber.opted_out_at ? subscriber : null;
  if (id === null || !active || !db) return null;
  const spanish = es(active.language);
  // One statement, so two volunteers can't both win. Any active volunteer can take it, wherever they live.
  const won = await db.query(
    `update requests set status = 'incoming', volunteer_hash = $2, updated_at = now()
     where id = $1 and status = 'requesting'
       and exists (select 1 from subscribers where phone_hash = $2 and volunteer_at is not null and opted_out_at is null)
     returning conversation_id`,
    [id, active.phone_hash],
  );
  if (won.rows[0]) {
    await logEvent(won.rows[0].conversation_id, 'help_incoming', 'A volunteer said yes and was sent the location');
    void messageCaller(id);
  }

  const { rows: [r] } = await db.query(`select status, volunteer_hash, location, needs, said from requests where id = $1`, [id]);
  const volunteer = (await db.query(
    `select 1 from subscribers where phone_hash = $1 and volunteer_at is not null and opted_out_at is null`, [active.phone_hash])).rows.length > 0;
  if (r && r.volunteer_hash === active.phone_hash && r.status === 'incoming') {
    const needs = r.needs.length ? (spanish ? `\nNecesitan: ${r.needs.join(', ')}` : `\nThey need: ${r.needs.join(', ')}`) : '';
    const said = r.said.slice(0, 500);
    return spanish
      ? `Gracias. Vaya a: ${r.location}${needs}\nSus palabras: "${said}"\nSi alguien tiene señales de golpe de calor, llame al 911.`
      : `Thank you. Go to: ${r.location}${needs}\nIn their words: "${said}"\nIf anyone has signs of heat illness, call 911.`;
  }
  if (r && volunteer && r.status === 'incoming') {
    return spanish ? 'Gracias. Otro vecino ya dijo que sí.' : 'Thank you. Another neighbor already said yes.';
  }
  return spanish ? `La solicitud ${id} no está abierta para usted. Gracias.` : `Request ${id} is not open to you. Thank you.`;
}

/**
 * Tells the caller on Messenger that a neighbor said yes, whether or not they are still on the call. It goes to the
 * profile linked to their phone (JOIN <zip> <phone>): now if they wrote in the last 24 hours, else when they next
 * write. Callers with no linked profile can't be reached: SMS is carrier-blocked. Never throws.
 */
async function messageCaller(id: number): Promise<void> {
  if (!db) return;
  let conversationId: string | null = null;
  try {
    const { rows: [r] } = await db.query(`select phone_e164, language, conversation_id from requests where id = $1`, [id]);
    conversationId = r?.conversation_id ?? null;
    const profile = r?.phone_e164 && process.env.PHONE_SALT ? await getMessengerProfileByPhone(hashPhone(r.phone_e164)) : null;
    if (!profile) {
      await logEvent(conversationId, 'help_incoming', 'Caller has no linked Messenger, so no follow-up was sent');
      return;
    }
    const language: Language = es(r.language) ? 'es' : 'en';
    const body = language === 'es'
      ? 'Un vecino dijo que puede ir a ayudarle. Quédese donde está si puede. Si alguien se siente peor, llame al 911.'
      : 'A neighbor said they can come help you. Stay where you are if you can. If anyone feels worse, call 911.';
    await queueFollowup({ profile, body, siteId: null, language, dedupe: false });
    const now = await deliverNowIfWindowOpen(profile);
    await logEvent(conversationId, 'help_incoming',
      now ? 'Messaged the caller that a neighbor is coming' : 'Follow-up for the caller held until they next write to the Page');
  } catch (err) {
    console.error(`[neighbors] request ${id}: caller follow-up failed`, (err as Error).message);
    await logEvent(conversationId, 'help_incoming', 'Follow-up to the caller failed');
  }
}
