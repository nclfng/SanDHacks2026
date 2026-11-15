// Help requests: a caller asks for a pickup, a ride or a check. Every volunteer gets a message
// (neighbors.ts) and the first to reply YES <id> takes it. The agent only reports status: it reads `say_this`,
// which this file chooses from the request row.
import { z } from 'zod';
import type { HelpRequest, RequestHelpOutput, RequestStatus } from '../../../../data/schema/types';
import { db } from '../shared/db';
import { resolveLocation } from '../shared/find-sites';
import { hashPhone } from '../shared/phone';
import { eventsOf, logEvent } from './events';
import { blastNeighbors } from './neighbors';

const FAILED =
  "I couldn't send your request. Please call 2 1 1. They can help, and they can arrange a free ride. If this is an emergency, call 9 1 1.";
const SENT = "I've sent your request to neighbors nearby who signed up to help.";

/** The only place a status becomes words. Only 'incoming' says help is coming, and nothing promises a time. */
export function sayThis(status: RequestStatus, neighborsMessaged: number | null = null): string {
  if (status === 'incoming') {
    return 'A neighbor has said they can come help you. Please stay where you are and hold tight. If anyone feels worse, hang up and call 9 1 1.';
  }
  if (status === 'requesting' && neighborsMessaged === 0) {
    return "I couldn't reach any neighbors who signed up to help near you. Please call 2 1 1. They can arrange a free ride. If anyone feels worse, call 9 1 1.";
  }
  if (status === 'requesting') {
    return "No neighbor has said yes yet, so I can't tell you that help is coming. Please stay on the line.";
  }
  return 'Your request is no longer open. Please call 2 1 1 for help. If this is an emergency, call 9 1 1.';
}

/** Where the blast says the caller is. A street address stays out: only the neighbor who says yes gets it. */
export function blastArea(loc: { label: string; precision: string } | null, zip: string | null): string {
  if (loc && ['intersection', 'landmark', 'area'].includes(loc.precision)) return `near ${loc.label}`;
  return zip ? `in ${zip}` : 'near you';
}

export const checkStatusBody = z.object({ conversation_id: z.string().min(1) });

export async function handleCheckStatus({ conversation_id }: z.infer<typeof checkStatusBody>): Promise<RequestHelpOutput> {
  if (!db) return { ok: false, say_this: FAILED };
  try {
    const { rows: [r] } = await db.query(`select id, status, neighbors_messaged from requests where conversation_id = $1`, [conversation_id]);
    if (!r) return { ok: false, say_this: 'I have no help request on file for this call.' };
    return { ok: true, request_id: r.id, status: r.status, say_this: sayThis(r.status, r.neighbors_messaged) };
  } catch (err) {
    console.error('[requests] check status failed', err);
    return { ok: false, say_this: FAILED };
  }
}

export const requestHelpBody = z.object({
  said: z.string().trim().min(1).max(1000),
  location: z.string().trim().min(1).max(300),
  needs: z.array(z.string().trim().min(1).max(60)).max(8).optional().catch(undefined),
  language: z.enum(['en', 'es', 'tl', 'vi', 'zh']).optional().catch(undefined),
  caller_id: z.string().optional(),
  conversation_id: z.string().optional(),
});

export async function handleRequestHelp(body: z.infer<typeof requestHelpBody>): Promise<RequestHelpOutput> {
  if (!db) return { ok: false, say_this: FAILED };
  try {
    // A request with no map position is still a request: a failed lookup must not block it.
    const loc = await resolveLocation({ location: body.location }).catch(() => null);
    // A landmark far from any known zip comes back without one; the zip the caller said still finds their neighbors.
    const zip = loc?.zip ?? body.location.match(/\b9[12]\d{3}\b/)?.[0] ?? null;
    const raw = body.caller_id?.trim();
    const phone = raw && /^\+\d{10,15}$/.test(raw) ? raw : null;
    const inserted = await db.query(
      `insert into requests (conversation_id, said, location, zip, lat, lon, needs, language, phone_e164)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (conversation_id) do nothing
       returning id, status`,
      [
        body.conversation_id || null, body.said, body.location, zip, loc?.pt.lat ?? null, loc?.pt.lon ?? null,
        body.needs ?? [], body.language ?? null, phone,
      ],
    );
    // No row back means this call already has a request: report that one instead of filing a second.
    const row =
      inserted.rows[0] ??
      (await db.query(`select id, status, neighbors_messaged from requests where conversation_id = $1`, [body.conversation_id])).rows[0];
    if (inserted.rows[0]) {
      const needs = body.needs?.length ? `: ${body.needs.join(', ')}` : '';
      await logEvent(body.conversation_id, 'help_requested', `Caller asked for help${needs}`);
      // Runs after the tool returns; the agent learns the outcome through check_request_status.
      void blastNeighbors({
        id: row.id, conversationId: body.conversation_id, zip, area: blastArea(loc, zip),
        // Without PHONE_SALT the caller can't be matched to a subscriber; they may then get their own blast.
        needs: body.needs ?? [], callerHash: phone && process.env.PHONE_SALT ? hashPhone(phone) : null,
      });
      return { ok: true, request_id: row.id, status: row.status, say_this: `${SENT} ${sayThis(row.status)}` };
    }
    return { ok: true, request_id: row.id, status: row.status, say_this: sayThis(row.status, row.neighbors_messaged) };
  } catch (err) {
    console.error('[requests] request_help failed', err);
    return { ok: false, say_this: FAILED };
  }
}

/** Columns the inbox may see. `phone_e164` is deliberately absent. */
export const INBOX_COLUMNS = 'id, status, help_type, said, location, zip, lat, lon, needs, language, created_at';

export async function listOpenRequests(): Promise<HelpRequest[]> {
  if (!db) return [];
  const { rows } = await db.query(
    `select ${INBOX_COLUMNS}, ${eventsOf('requests.conversation_id')} events
     from requests where status in ('requesting', 'incoming') order by created_at`,
  );
  return rows;
}
