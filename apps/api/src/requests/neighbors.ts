// Neighbor help over Messenger. Volunteers sign up with JOIN <zip> <phone> VOLUNTEER (subscribers.volunteer_at, and
// their phone in subscribers.phone_e164). A help request goes to every volunteer, wherever they live, and the first
// to reply YES <id> takes it. The blast carries the area and needs only. The volunteer who says yes gets the exact
// location, a map link and the caller's number; the caller gets the volunteer's number. The volunteer then sends
// DONE <id> when the person is safe (the caller is told), or CANCEL <id> to hand the request back to the other
// volunteers. Until then, when the caller has a linked Messenger, the Page relays messages between the two
// (relay.ts).
import { getMessengerProfileByPhone, listActiveVolunteers } from '../m4/db';
import { deliverNowIfWindowOpen, queueFollowup } from '../m4/messenger/followups';
import { sendMessengerInWindow } from '../m4/messenger/send';
import { isMessengerContact, type Language, type MessengerContact, type SubscriberRow } from '../m4/types';
import { db } from '../shared/db';
import { hashPhone } from '../shared/phone';
import { logEvent } from './events';

const es = (language: string | null | undefined) => language === 'es';

/** "+16195550123" -> "(619) 555-0123"; anything else as given. */
export function shownPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** "+16195550123" -> "6 1 9, 5 5 5, 0 1 2 3": how the voice agent reads a number aloud. */
export function spokenPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  const digits = (s: string) => s.split('').join(' ');
  return m ? `${digits(m[1])}, ${digits(m[2])}, ${digits(m[3])}` : digits(e164.replace(/\D/g, ''));
}

/** The caller's Messenger profile, linked to the phone they called from (JOIN <zip> <phone>); null when none. */
export async function callerProfile(phoneE164: string | null): Promise<MessengerContact | null> {
  if (!phoneE164 || !process.env.PHONE_SALT) return null;
  return getMessengerProfileByPhone(hashPhone(phoneE164));
}

function mapLink(location: string, lat: number | null, lon: number | null): string {
  const q = lat != null && lon != null ? `${lat},${lon}` : location;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function blastMessage(id: number, area: string, needs: string[], language: string): string {
  const said = needs.length ? (es(language) ? ` Dijeron: ${needs.join(', ')}.` : ` They said: ${needs.join(', ')}.`) : '';
  return es(language)
    ? `Shade: un vecino ${area} necesita ayuda por el calor.${said} ¿Puede ir? Responda SI ${id} y le enviaremos dónde está. Si alguien tiene señales de golpe de calor, llame al 911.`
    : `Shade: a neighbor ${area} needs help in the heat.${said} Can you go to them? Reply YES ${id} and we'll send you where they are. If anyone has signs of heat illness, call 911.`;
}

/**
 * Messages every reachable volunteer, except the caller and anyone in `exclude` (a volunteer who handed it back),
 * and records how many it reached. Never throws.
 */
export async function blastNeighbors(r: {
  id: number; conversationId?: string; zip: string | null; area: string; needs: string[]; callerHash: string | null;
  exclude?: string[];
}): Promise<void> {
  if (!db) return;
  let reached = 0;
  try {
    // Messenger only: SMS is carrier-blocked and WhatsApp is parked (src/m4/AGENTS.md).
    const contacts = (await listActiveVolunteers())
      .filter((c) => isMessengerContact(c) && c.linked_phone_hash !== r.callerHash && !r.exclude?.includes(c.phone_hash));
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
// The number is required: a bare CANCEL is the carrier opt-out keyword (STOP) and is handled as one.
const COMMAND = /^\s*(done|listo|cancel|cancelar)\s*#?\s*(\d{1,9})\s*[.!]*\s*$/i;

/** The request id in a "YES 12" / "SI 12" reply, or null. A bare "yes" is left to the text agent. */
export function parseYes(body: string): number | null {
  const m = body.match(YES);
  return m ? Number(m[1]) : null;
}

/** "DONE 12" / "LISTO 12" closes, "CANCEL 12" / "CANCELAR 12" hands back; null for anything else. */
export function parseVolunteerCommand(body: string): { action: 'done' | 'cancel'; id: number } | null {
  const m = body.match(COMMAND);
  if (!m) return null;
  return { action: /^(done|listo)$/i.test(m[1]) ? 'done' : 'cancel', id: Number(m[2]) };
}

type Sender = Pick<SubscriberRow, 'phone_hash' | 'zip' | 'language' | 'opted_out_at'> | null;

const isVolunteer = async (hash: string) => !!db &&
  (await db.query(`select 1 from subscribers where phone_hash = $1 and volunteer_at is not null and opted_out_at is null`, [hash])).rows.length > 0;

/**
 * Answers YES <id>, DONE <id> and CANCEL <id> from Messenger, or returns null for anything else.
 * `subscriber` is the sender's row, null when they never sent JOIN.
 */
export async function answerNeighbor(subscriber: Sender, body: string): Promise<string | null> {
  const active = subscriber && !subscriber.opted_out_at ? subscriber : null;
  if (!active || !db) return null;
  const command = parseVolunteerCommand(body);
  if (command) return command.action === 'done' ? finishRequest(active, command.id) : handBack(active, command.id);
  const id = parseYes(body);
  if (id === null) return null;
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
    await logEvent(won.rows[0].conversation_id, 'help_incoming', 'A volunteer said yes and was sent the location and the caller\'s number');
    void messageCaller(id, 'coming');
  }

  const { rows: [r] } = await db.query(
    `select status, volunteer_hash, location, lat, lon, needs, said, phone_e164 from requests where id = $1`, [id]);
  if (r && r.volunteer_hash === active.phone_hash && r.status === 'incoming') {
    const relay = !!(await callerProfile(r.phone_e164).catch(() => null));
    return handoffMessage(id, r, spanish, relay);
  }
  if (r && r.status === 'incoming' && (await isVolunteer(active.phone_hash))) {
    return spanish ? 'Gracias. Otro voluntario ya dijo que sí.' : 'Thank you. Another volunteer already said yes.';
  }
  return spanish ? `La solicitud ${id} no está abierta para usted. Gracias.` : `Request ${id} is not open to you. Thank you.`;
}

interface Assignment { location: string; lat: number | null; lon: number | null; needs: string[]; said: string; phone_e164: string | null }

/**
 * What the volunteer who said yes gets: where to go, the map, who to call, and how to finish. With `relay`, the
 * caller is on Messenger and what the volunteer writes here reaches them.
 */
function handoffMessage(id: number, r: Assignment, spanish: boolean, relay: boolean): string {
  const map = mapLink(r.location, r.lat, r.lon);
  const said = r.said.slice(0, 500);
  if (spanish) {
    return [
      `🙌 ¡Gracias! Está ayudando con la solicitud ${id}.`,
      `📍 Vaya a: ${r.location}`,
      `🗺️ Mapa: ${map}`,
      r.needs.length ? `🙋 Necesitan: ${r.needs.join(', ')}` : '',
      `💬 Sus palabras: "${said}"`,
      r.phone_e164 ? `📞 Su número: ${shownPhone(r.phone_e164)}. Llame cuando esté cerca.` : '',
      relay ? '💬 Lo que escriba aquí le llega por Messenger. Empiece con SHADE para preguntarle a Shade.' : '',
      `✅ Envíe LISTO ${id} cuando estén a salvo, o CANCELAR ${id} si no puede ir.`,
      'Si alguien tiene señales de golpe de calor, llame al 911.',
    ].filter(Boolean).join('\n');
  }
  return [
    `🙌 Thank you! You're helping with request ${id}.`,
    `📍 Go to: ${r.location}`,
    `🗺️ Map: ${map}`,
    r.needs.length ? `🙋 They need: ${r.needs.join(', ')}` : '',
    `💬 In their words: "${said}"`,
    r.phone_e164 ? `📞 Their number: ${shownPhone(r.phone_e164)}. Call them when you're close.` : '',
    relay ? "💬 Anything you write here reaches them on Messenger. Start with SHADE to ask Shade instead." : '',
    `✅ Send DONE ${id} when they're safe, or CANCEL ${id} if you can't make it.`,
    'If anyone has signs of heat illness, call 911.',
  ].filter(Boolean).join('\n');
}

/**
 * DONE <id>: the volunteer says the person is safe. Closes the request, drops the callback number, and tells the
 * caller on Messenger.
 */
async function finishRequest(active: NonNullable<Sender>, id: number): Promise<string> {
  const spanish = es(active.language);
  // `old` is the row before the update, so the number being dropped can still reach the caller.
  const { rows: [r] } = await db!.query(
    `update requests q set status = 'closed', phone_e164 = null, updated_at = now()
     from requests old
     where old.id = q.id and q.id = $1 and q.volunteer_hash = $2 and q.status = 'incoming'
     returning q.conversation_id, q.language, old.phone_e164`,
    [id, active.phone_hash],
  );
  if (!r) return spanish ? `La solicitud ${id} no es una que usted esté ayudando.` : `Request ${id} isn't one you're helping with.`;
  await logEvent(r.conversation_id, 'closed', 'The volunteer marked the request done');
  void messageCaller(id, 'done', r);
  return spanish ? `🙏 ¡Gracias por ayudar! La solicitud ${id} está cerrada.` : `🙏 Thank you for helping! Request ${id} is closed.`;
}

/** CANCEL <id>: the volunteer can't go. The request goes back to every other volunteer, and the caller is told. */
async function handBack(active: NonNullable<Sender>, id: number): Promise<string> {
  const spanish = es(active.language);
  const { rows: [r] } = await db!.query(
    `update requests set status = 'requesting', volunteer_hash = null, updated_at = now()
     where id = $1 and volunteer_hash = $2 and status = 'incoming' returning conversation_id, zip, needs, phone_e164`,
    [id, active.phone_hash],
  );
  if (!r) return spanish ? `La solicitud ${id} no es una que usted esté ayudando.` : `Request ${id} isn't one you're helping with.`;
  await logEvent(r.conversation_id, 'help_requested', 'The volunteer could not make it; sent to the other volunteers again');
  void messageCaller(id, 'handed_back');
  void blastNeighbors({
    id, conversationId: r.conversation_id, zip: r.zip, area: r.zip ? `in ${r.zip}` : 'near you', needs: r.needs ?? [],
    callerHash: r.phone_e164 && process.env.PHONE_SALT ? hashPhone(r.phone_e164) : null, exclude: [active.phone_hash],
  });
  return spanish
    ? `Entendido. La solicitud ${id} vuelve a los otros voluntarios. Gracias por avisar.`
    : `Got it. Request ${id} is back with the other volunteers. Thanks for letting us know.`;
}

/** The phone of the volunteer who took request `id`, while they still volunteer; null when they gave none. */
export async function volunteerPhoneFor(id: number): Promise<string | null> {
  if (!db) return null;
  const { rows: [r] } = await db.query(
    `select s.phone_e164 from requests q join subscribers s on s.phone_hash = q.volunteer_hash
     where q.id = $1 and s.volunteer_at is not null and s.opted_out_at is null`, [id]);
  return r?.phone_e164 ?? null;
}

/** The request this volunteer is helping with right now, newest first, for the Messenger agent's helper mode. */
export async function activeAssignment(volunteerHash: string): Promise<(Assignment & { id: number }) | null> {
  if (!db) return null;
  const { rows: [r] } = await db.query(
    `select id, location, lat, lon, needs, said, phone_e164 from requests
     where volunteer_hash = $1 and status = 'incoming' order by updated_at desc limit 1`, [volunteerHash]);
  return r ?? null;
}

/** Facts the Messenger agent gets when a volunteer who is on a request writes in (helper mode). */
export function helperNote(a: Assignment & { id: number }): string {
  return [
    `Helper mode: this person is a Shade volunteer who said YES to help request ${a.id} and is on their way.`,
    `Location the caller gave: ${a.location}. Map: ${mapLink(a.location, a.lat, a.lon)}.`,
    a.needs.length ? `What they need: ${a.needs.join(', ')}.` : '',
    `In the caller's words: "${a.said.slice(0, 300)}".`,
    a.phone_e164 ? `The caller's number: ${shownPhone(a.phone_e164)}.` : 'The caller left no number.',
    `Answer the volunteer's questions about this request from these facts only. They finish with DONE ${a.id} when the person is safe, or CANCEL ${a.id} if they can't make it; remind them of those when it fits.`,
    "Don't ask the volunteer whether anyone with them is sick, and don't suggest a cooling center for them unless they ask. If they describe someone confused, fainting, not responding, or with trouble breathing, tell them to call 911 first.",
  ].filter(Boolean).join(' ');
}

type CallerUpdate = 'coming' | 'handed_back' | 'done';
interface CallerFacts { phone_e164: string | null; language: string | null; conversation_id: string | null }

const updateEvent = (kind: CallerUpdate) => (kind === 'coming' ? 'help_incoming' : kind === 'done' ? 'closed' : 'help_requested');

/**
 * Tells the caller on Messenger, whether or not they are still on the call: 'coming' when a volunteer said yes
 * (with the volunteer's number), 'handed_back' when that volunteer had to cancel, 'done' when they closed the
 * request. It goes to the profile linked to their phone (JOIN <zip> <phone>): now if they wrote in the last 24
 * hours, else when they next write. Callers with no linked profile can't be reached: SMS is carrier-blocked.
 * `known` is the request's caller details when the row no longer has them (DONE drops the number). Never throws.
 */
async function messageCaller(id: number, kind: CallerUpdate, known?: CallerFacts): Promise<void> {
  if (!db) return;
  let conversationId: string | null = known?.conversation_id ?? null;
  try {
    const r: CallerFacts | undefined = known
      ?? (await db.query(`select phone_e164, language, conversation_id from requests where id = $1`, [id])).rows[0];
    conversationId = r?.conversation_id ?? null;
    const profile = await callerProfile(r?.phone_e164 ?? null);
    if (!profile) {
      await logEvent(conversationId, updateEvent(kind), 'Caller has no linked Messenger, so no follow-up was sent');
      return;
    }
    const language: Language = es(r?.language) ? 'es' : 'en';
    const phone = kind === 'coming' ? await volunteerPhoneFor(id) : null;
    const body = kind === 'coming'
      ? language === 'es'
        ? ['🙋 Un voluntario dijo que puede ir a ayudarle.', phone ? `📞 Su número: ${shownPhone(phone)}` : '',
            '💬 Responda aquí y le pasaremos su mensaje.',
            'Quédese donde está si puede. Si alguien se siente peor, llame al 911.'].filter(Boolean).join('\n')
        : ['🙋 A volunteer said they can come help you.', phone ? `📞 Their number: ${shownPhone(phone)}` : '',
            "💬 Reply here and we'll pass your message to them.",
            'Stay where you are if you can. If anyone feels worse, call 911.'].filter(Boolean).join('\n')
      : kind === 'done'
        ? language === 'es'
          ? '✅ Su voluntario marcó su solicitud como terminada. Nos alegra que esté a salvo.\nSi todavía necesita ayuda, llame al 211. Si alguien se siente peor, llame al 911.'
          : "✅ Your volunteer marked your request as done. We're glad you're safe.\nIf you still need help, call 211. If anyone feels worse, call 911."
      : language === 'es'
        ? 'El voluntario que dijo que sí ya no puede ir. Se lo pedimos a los otros voluntarios. Si necesita ayuda ahora, llame al 211. Si alguien se siente peor, llame al 911.'
        : "The volunteer who said yes can't make it after all. We've asked the other volunteers again. If you need help now, call 211. If anyone feels worse, call 911.";
    await queueFollowup({ profile, body, siteId: null, language, dedupe: false });
    const now = await deliverNowIfWindowOpen(profile);
    const what = { coming: " with the volunteer's number", handed_back: ' that the volunteer cancelled', done: ' that the request is done' }[kind];
    await logEvent(conversationId, updateEvent(kind),
      now ? `Messaged the caller on Messenger${what}` : 'Follow-up for the caller held until they next write to the Page');
  } catch (err) {
    console.error(`[neighbors] request ${id}: caller follow-up failed`, (err as Error).message);
    await logEvent(conversationId, updateEvent(kind), 'Follow-up to the caller failed');
  }
}
