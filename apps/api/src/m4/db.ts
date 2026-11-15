import { env } from './env';
import type {
  AlertChannel,
  AlertKind,
  AlertRow,
  CallDirection,
  CallOutcome,
  CallerNeeds,
  Channel,
  Language,
  MessageRow,
  Reading,
  Site,
  MessengerContact,
  SubscriberContact,
  SubscriberRow,
} from './types';

// Data access for M4, over Neon's HTTPS query endpoint: one fetch per statement, with no driver and no pool,
// so the app needs no Postgres package. Swap `query` for a shared client if the team adds one.
// M4 writes subscribers, alerts, messages and its own calls rows. sites and readings are read-only here.

const DB_TIMEOUT_MS = 10_000;

// A failed statement. `code` is the Postgres SQLSTATE when the database returned one (23505 = unique violation).
export class DbError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

// Runs one statement. Values go in `params` ($1, $2, ...), never into the SQL text. Parameters arrive as text,
// so anything that is not text needs a cast in the statement ($1::int, $2::timestamptz, $3::alert_kind).
async function query<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const url = env.databaseUrl();
  let response: Response;
  try {
    response = await fetch(`https://${new URL(url).hostname}/sql`, {
      method: 'POST',
      headers: { 'Neon-Connection-String': url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, params }),
      signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DbError(`Database request failed: ${error instanceof Error ? error.name : 'unknown error'}`, null);
  }

  const payload = (await response.json().catch(() => null)) as {
    rows?: Row[];
    message?: unknown;
    code?: unknown;
  } | null;
  if (!response.ok || !Array.isArray(payload?.rows)) {
    // Only Postgres's message is kept: its `detail` field can quote the values of the offending row.
    const message = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new DbError(message, typeof payload?.code === 'string' ? payload.code : null);
  }
  return payload.rows;
}

// The endpoint returns timestamptz in Postgres's own text format, so every timestamp is selected as ISO 8601.
function iso(column: string): string {
  return `to_char("${column}" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "${column}"`;
}

// A text[] parameter, passed as a JSON string.
function textArray(placeholder: string): string {
  return `array(select jsonb_array_elements_text(${placeholder}::jsonb))`;
}

const SUBSCRIBER_COLUMNS_BEFORE_ALERT_CHANNEL = `id, phone_hash, phone_e164, language, zip, needs, ${iso('consent_at')}, ${iso('opted_out_at')}`;
const SUBSCRIBER_COLUMNS = `${SUBSCRIBER_COLUMNS_BEFORE_ALERT_CHANNEL}, alert_channel, messenger_psid, messenger_page_id,
  linked_phone_hash, display_name`;
// The columns a database without them reads as null. See withAlertChannel.
const NEWER_SUBSCRIBER_FIELDS = {
  alert_channel: null,
  messenger_psid: null,
  messenger_page_id: null,
  linked_phone_hash: null,
  display_name: null,
} as const;
const ALERT_COLUMNS = `id, kind, nws_id, zips, headline, ${iso('onset_at')}, ${iso('expires_at')}, ${iso('detected_at')}, texts_sent`;
const MESSAGE_COLUMNS = `id, phone_hash, role, body, ${iso('created_at')}`;
const SITE_COLUMNS = `id, name, kind, tier, confidence, address, zip, lat, lon, hours, hours_confirmed_on_source,
  has_ac, has_filtration, capacity_est, phone, source_url, ${iso('last_verified_at')}, evidence`;

// ---- subscribers ----

// Postgres's code for a column that does not exist.
const UNDEFINED_COLUMN = '42703';

function isMissingColumn(error: unknown): boolean {
  return error instanceof DbError && error.code === UNDEFINED_COLUMN;
}

// subscribers.alert_channel, messenger_psid and messenger_page_id are newer than some databases (see the migration
// in data/schema/schema.sql). Until they exist, a read is retried without them (`current` false) and every row
// comes back as SMS, so SMS keeps working.
async function withAlertChannel<Row extends SubscriberRow>(
  run: (columns: string, current: boolean) => Promise<Row[]>,
): Promise<Row[]> {
  try {
    return await run(SUBSCRIBER_COLUMNS, true);
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    const rows = await run(SUBSCRIBER_COLUMNS_BEFORE_ALERT_CHANNEL, false);
    return rows.map((row) => ({ ...row, ...NEWER_SUBSCRIBER_FIELDS }));
  }
}

export interface UpsertSubscriberInput {
  phoneHash: string;
  phoneE164: string; // stored in subscribers.phone_e164 so alerts have a number to send to
  zip: string;
  language: Language;
  needs?: CallerNeeds;
  consentAt: Date;
  alertChannel?: AlertChannel; // the channel they opted in on. Default 'sms'
}

export async function getSubscriber(phoneHash: string): Promise<SubscriberRow | null> {
  const rows = await withAlertChannel((columns) =>
    query<SubscriberRow>(`select ${columns} from subscribers where phone_hash = $1`, [phoneHash]),
  );
  return rows[0] ?? null;
}

// Keyed on phone_hash. Re-subscribing clears opted_out_at, refreshes consent_at, stores phone_e164 again and
// moves alerts to the channel of this opt-in ('sms' is stored as null).
// On a database without subscribers.alert_channel, an SMS opt-in is written without the column. A WhatsApp
// opt-in throws instead: written without it, it would become an SMS subscription nobody agreed to.
export async function upsertSubscriber(input: UpsertSubscriberInput): Promise<SubscriberRow> {
  const alertChannel = input.alertChannel === 'whatsapp' ? 'whatsapp' : null;
  const params = [
    input.phoneHash,
    input.phoneE164,
    input.zip,
    input.language,
    JSON.stringify(input.needs ?? {}),
    input.consentAt.toISOString(),
  ];
  try {
    const rows = await query<SubscriberRow>(
      `insert into subscribers (phone_hash, phone_e164, zip, language, needs, consent_at, opted_out_at, alert_channel)
       values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, null, $7)
       on conflict (phone_hash) do update set
         phone_e164 = excluded.phone_e164, zip = excluded.zip, language = excluded.language,
         needs = excluded.needs, consent_at = excluded.consent_at, opted_out_at = null,
         alert_channel = excluded.alert_channel
       returning ${SUBSCRIBER_COLUMNS}`,
      [...params, alertChannel],
    );
    return rows[0];
  } catch (error) {
    if (!isMissingColumn(error) || alertChannel) throw error;
  }
  const rows = await query<SubscriberRow>(
    `insert into subscribers (phone_hash, phone_e164, zip, language, needs, consent_at, opted_out_at)
     values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, null)
     on conflict (phone_hash) do update set
       phone_e164 = excluded.phone_e164, zip = excluded.zip, language = excluded.language,
       needs = excluded.needs, consent_at = excluded.consent_at, opted_out_at = null
     returning ${SUBSCRIBER_COLUMNS_BEFORE_ALERT_CHANNEL}`,
    params,
  );
  return { ...rows[0], ...NEWER_SUBSCRIBER_FIELDS };
}

export interface UpsertMessengerSubscriberInput {
  phoneHash: string; // hashMessengerId(psid)
  psid: string; // stored in subscribers.messenger_psid so alerts have someone to send to
  pageId: string; // the Page they wrote to, which alerts are sent from
  zip: string;
  language: Language;
  needs?: CallerNeeds;
  consentAt: Date;
  linkedPhoneHash?: string | null; // hashPhone(e164) of the number given with JOIN; null/undefined keeps the old link
  displayName?: string | null; // the name given with JOIN; null/undefined keeps the old one
  // JOIN ... VOLUNTEER sets subscribers.volunteer_at, a JOIN without it clears it, undefined (START) keeps it.
  volunteer?: boolean;
}

// A Messenger opt-in, keyed on the Messenger hash: stores the ids alerts need and sets alert_channel 'messenger'.
// Re-subscribing clears opted_out_at and refreshes consent_at. A JOIN without a phone or name keeps the ones on
// file. A phone number links to one profile only: linking it here unlinks it from any other.
// Throws on a database without the Messenger columns.
export async function upsertMessengerSubscriber(input: UpsertMessengerSubscriberInput): Promise<SubscriberRow> {
  if (input.linkedPhoneHash) {
    await query(`update subscribers set linked_phone_hash = null where linked_phone_hash = $1 and phone_hash <> $2`, [
      input.linkedPhoneHash,
      input.phoneHash,
    ]);
  }
  const rows = await query<SubscriberRow>(
    `insert into subscribers (phone_hash, phone_e164, zip, language, needs, consent_at, opted_out_at, alert_channel,
                              messenger_psid, messenger_page_id, linked_phone_hash, display_name, volunteer_at)
     values ($1, null, $2, $3, $4::jsonb, $5::timestamptz, null, 'messenger', $6, $7, $8, $9,
             case when $10::boolean then now() end)
     on conflict (phone_hash) do update set
       zip = excluded.zip, language = excluded.language, needs = excluded.needs, consent_at = excluded.consent_at,
       opted_out_at = null, alert_channel = 'messenger',
       messenger_psid = excluded.messenger_psid, messenger_page_id = excluded.messenger_page_id,
       linked_phone_hash = coalesce(excluded.linked_phone_hash, subscribers.linked_phone_hash),
       display_name = coalesce(excluded.display_name, subscribers.display_name),
       volunteer_at = case when $10::boolean is null then subscribers.volunteer_at
                           when $10::boolean then coalesce(subscribers.volunteer_at, now()) end
     returning ${SUBSCRIBER_COLUMNS}`,
    [
      input.phoneHash,
      input.zip,
      input.language,
      JSON.stringify(input.needs ?? {}),
      input.consentAt.toISOString(),
      input.psid,
      input.pageId,
      input.linkedPhoneHash ?? null,
      input.displayName ?? null,
      input.volunteer ?? null,
    ],
  );
  return rows[0];
}

// The active Messenger profile linked to this phone (hashPhone(e164)), or null. For reaching someone known by their
// phone number, such as a voice caller, on Messenger instead of SMS.
export async function getMessengerProfileByPhone(phoneHash: string): Promise<MessengerContact | null> {
  const rows = await query<MessengerContact>(
    `select ${SUBSCRIBER_COLUMNS} from subscribers
     where linked_phone_hash = $1 and opted_out_at is null and alert_channel = 'messenger'
       and messenger_psid is not null and messenger_page_id is not null
     order by consent_at desc
     limit 1`,
    [phoneHash],
  );
  return rows[0] ?? null;
}

// Stamps opted_out_at and clears the personal details (phone_e164, the Messenger ids, the linked phone and the
// name): they are kept only while the opt-in stands. The row and its phone_hash stay, so send_sms can still refuse
// the number. A repeated STOP keeps the first date.
export async function setOptedOut(phoneHash: string, at: Date): Promise<void> {
  const params = [phoneHash, at.toISOString()];
  try {
    await query(
      `update subscribers set opted_out_at = coalesce(opted_out_at, $2::timestamptz), phone_e164 = null,
         messenger_psid = null, messenger_page_id = null, linked_phone_hash = null, display_name = null
       where phone_hash = $1`,
      params,
    );
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    await query(
      `update subscribers set opted_out_at = coalesce(opted_out_at, $2::timestamptz), phone_e164 = null
       where phone_hash = $1`,
      params,
    );
  }
}

// Opted-in rows that can be reached: an SMS or WhatsApp number on file, or Messenger ids on file.
export async function listActiveSubscribersByZips(zips: string[]): Promise<(SubscriberContact | MessengerContact)[]> {
  if (zips.length === 0) return [];
  return withAlertChannel((columns, current) =>
    query<SubscriberContact | MessengerContact>(
      `select ${columns} from subscribers
       where opted_out_at is null and zip = any(${textArray('$1')})
         and ${current ? '(phone_e164 is not null or (messenger_psid is not null and messenger_page_id is not null))' : 'phone_e164 is not null'}
       order by id`,
      [JSON.stringify(zips)],
    ),
  );
}

// Every opted-in volunteer (JOIN ... VOLUNTEER) reachable on Messenger, wherever they live: help requests go to all
// of them (requests/neighbors.ts).
export async function listActiveVolunteers(): Promise<MessengerContact[]> {
  return withAlertChannel((columns) =>
    query<MessengerContact>(
      `select ${columns} from subscribers
       where opted_out_at is null and volunteer_at is not null
         and messenger_psid is not null and messenger_page_id is not null
       order by id`,
    ),
  );
}

// ---- alerts ----

export interface NewAlert {
  kind: AlertKind;
  nwsId: string | null; // null for mock alerts
  zips: string[];
  headline?: string | null;
  onsetAt?: Date | null;
  expiresAt?: Date | null;
}

export async function getAlertByNwsId(nwsId: string): Promise<AlertRow | null> {
  const rows = await query<AlertRow>(`select ${ALERT_COLUMNS} from alerts where nws_id = $1`, [nwsId]);
  return rows[0] ?? null;
}

// Throws DbError with code 23505 when an alert with the same nws_id already exists.
export async function insertAlert(alert: NewAlert): Promise<AlertRow> {
  const rows = await query<AlertRow>(
    `insert into alerts (kind, nws_id, zips, headline, onset_at, expires_at)
     values ($1::alert_kind, $2, ${textArray('$3')}, $4, $5::timestamptz, $6::timestamptz)
     returning ${ALERT_COLUMNS}`,
    [
      alert.kind,
      alert.nwsId,
      JSON.stringify(alert.zips),
      alert.headline ?? null,
      alert.onsetAt?.toISOString() ?? null,
      alert.expiresAt?.toISOString() ?? null,
    ],
  );
  return rows[0];
}

export async function addTextsSent(alertId: number, count: number): Promise<void> {
  await query(`update alerts set texts_sent = texts_sent + $2::int where id = $1::int`, [alertId, count]);
}

// True when an alert of this kind covering the zip was raised at or after `since`. Keeps reading-based alerts to
// one per zip and kind per cooldown.
export async function hasRecentAlertForZip(kind: AlertKind, zip: string, since: Date): Promise<boolean> {
  const rows = await query(
    `select 1 from alerts where kind = $1::alert_kind and $2 = any(zips) and detected_at >= $3::timestamptz limit 1`,
    [kind, zip, since.toISOString()],
  );
  return rows.length > 0;
}

// ---- messenger_followups (send_sms held for a caller's Messenger) ----

export interface FollowupRow {
  id: number;
  phone_hash: string;
  body: string;
  site_id: number | null;
}

export async function insertFollowup(followup: {
  phoneHash: string; // the Messenger profile's hash
  body: string;
  siteId: number | null;
  expiresAt: Date;
}): Promise<{ id: number }> {
  const rows = await query<{ id: number }>(
    `insert into messenger_followups (phone_hash, body, site_id, expires_at)
     values ($1, $2, (select id from sites where id = $3::int), $4::timestamptz)
     returning id`,
    [followup.phoneHash, followup.body, followup.siteId, followup.expiresAt.toISOString()],
  );
  return rows[0];
}

// True when this site was held for this profile at or after `since`, delivered or not.
export async function hasRecentFollowup(phoneHash: string, siteId: number, since: Date): Promise<boolean> {
  const rows = await query(
    `select 1 from messenger_followups where phone_hash = $1 and site_id = $2::int and created_at >= $3::timestamptz limit 1`,
    [phoneHash, siteId, since.toISOString()],
  );
  return rows.length > 0;
}

// Not yet delivered and not expired, oldest first.
export async function listPendingFollowups(phoneHash: string): Promise<FollowupRow[]> {
  return query<FollowupRow>(
    `select id, phone_hash, body, site_id from messenger_followups
     where phone_hash = $1 and delivered_at is null and expires_at > now()
     order by id`,
    [phoneHash],
  );
}

export async function markFollowupDelivered(id: number): Promise<void> {
  await query(`update messenger_followups set delivered_at = now() where id = $1::int`, [id]);
}

// STOP: drops everything still waiting for this profile.
export async function cancelFollowups(phoneHash: string): Promise<void> {
  await query(`delete from messenger_followups where phone_hash = $1 and delivered_at is null`, [phoneHash]);
}

// ---- messages (text agent memory) ----

export interface NewMessage {
  phoneHash: string;
  role: 'user' | 'assistant';
  body: string;
}

// Oldest first, capped at `limit`.
export async function listRecentMessages(phoneHash: string, limit = 20): Promise<MessageRow[]> {
  return query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from (
       select * from messages where phone_hash = $1 order by id desc limit $2::int
     ) recent
     order by id`,
    [phoneHash, limit],
  );
}

export async function insertMessage(message: NewMessage): Promise<MessageRow> {
  const rows = await query<MessageRow>(
    `insert into messages (phone_hash, role, body) values ($1, $2, $3) returning ${MESSAGE_COLUMNS}`,
    [message.phoneHash, message.role, message.body],
  );
  return rows[0];
}

// ---- calls (M4 rows only: outbound and sms) ----

export interface NewCall {
  direction: CallDirection;
  channel: Channel;
  phoneHash: string | null;
  zip?: string | null;
  language?: Language | null;
  siteId?: number | null;
  outcome?: CallOutcome | null;
  alertId?: number | null;
}

// A text has no duration, so ended_at equals started_at. site_id is stored only when that site has a row:
// the find_sites stand-in returns a site that does not, and a missing site must not cost us the log row.
export async function insertCall(call: NewCall): Promise<{ id: number }> {
  const rows = await query<{ id: number }>(
    `insert into calls (direction, channel, phone_hash, zip, language, site_id, outcome, alert_id, ended_at)
     values ($1::call_direction, $2::channel, $3, $4, $5, (select id from sites where id = $6::int),
             $7::call_outcome, $8::int, now())
     returning id`,
    [
      call.direction,
      call.channel,
      call.phoneHash,
      call.zip ?? null,
      call.language ?? null,
      call.siteId ?? null,
      call.outcome ?? null,
      call.alertId ?? null,
    ],
  );
  return rows[0];
}

// Guards against texting the same subscriber twice for one alert.
export async function hasAlertText(phoneHash: string, alertId: number): Promise<boolean> {
  const rows = await query(
    `select 1 from calls where phone_hash = $1 and alert_id = $2::int and outcome = 'sms_sent' limit 1`,
    [phoneHash, alertId],
  );
  return rows.length > 0;
}

// When this number last wrote to us on `channel`, from the inbound calls rows, or null when it never has.
// WhatsApp allows free-form messages for 24 hours after that; later ones need an approved template.
export async function lastInboundAt(phoneHash: string, channel: Channel): Promise<Date | null> {
  const rows = await query<{ at: string | null }>(
    `select to_char(max(started_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from calls
     where phone_hash = $1 and direction = 'inbound' and channel = $2::channel`,
    [phoneHash, channel],
  );
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

// Cooldown guard: true when the subscriber was sent a text for any alert of this kind at or after `since`.
// Reads calls joined to alerts on alert_id (outcome 'sms_sent', alerts.kind = kind). No schema change needed.
export async function hasRecentAlertText(phoneHash: string, kind: AlertKind, since: Date): Promise<boolean> {
  const rows = await query(
    `select 1 from calls c join alerts a on a.id = c.alert_id
     where c.phone_hash = $1 and c.outcome = 'sms_sent' and a.kind = $2::alert_kind
       and c.started_at >= $3::timestamptz
     limit 1`,
    [phoneHash, kind, since.toISOString()],
  );
  return rows.length > 0;
}

// ---- read-only (M2 writes these) ----

export async function getSite(siteId: number): Promise<Site | null> {
  const rows = await query<Site>(`select ${SITE_COLUMNS} from sites where id = $1::int`, [siteId]);
  return rows[0] ?? null;
}

// How old a reading can be and still be quoted in a text as the air quality right now.
const READING_MAX_AGE_HOURS = 3;

// The newest reading for the zip that carries an AQI, which is the only field M4 puts in a text.
// Null when there is none from the last READING_MAX_AGE_HOURS.
export async function getLatestReading(zip: string): Promise<Reading | null> {
  const rows = await query<Reading>(
    `select ${iso('time')}, zip, temp_f, heat_index, aqi, source from readings
     where zip = $1 and aqi is not null and readings."time" >= now() - make_interval(hours => $2::int)
     order by readings."time" desc
     limit 1`,
    [zip, READING_MAX_AGE_HOURS],
  );
  return rows[0] ?? null;
}

// Zips with at least one opted-in subscriber who can be reached, on any channel.
export async function listActiveSubscriberZips(): Promise<string[]> {
  const rows = await query<{ zip: string }>(
    `select distinct zip from subscribers
     where opted_out_at is null and (phone_e164 is not null or messenger_psid is not null)
     order by zip`,
  );
  return rows.map((row) => row.zip);
}

export interface CurrentReading {
  zip: string;
  heat_index: number | null;
  aqi: number | null;
}

// Per zip, the newest heat index and the newest AQI measured in the last READING_MAX_AGE_HOURS. Rows dated more
// than an hour ahead are forecasts and are left out, so an alert says what it is like now.
export async function currentReadings(zips: string[]): Promise<CurrentReading[]> {
  if (zips.length === 0) return [];
  const window = `readings."time" between now() - make_interval(hours => $2::int) and now() + interval '1 hour'`;
  return query<CurrentReading>(
    `select z.zip,
       (select heat_index from readings where readings.zip = z.zip and heat_index is not null and ${window}
        order by readings."time" desc limit 1) as heat_index,
       (select aqi from readings where readings.zip = z.zip and aqi is not null and ${window}
        order by readings."time" desc limit 1) as aqi
     from unnest(${textArray('$1')}) as z(zip)`,
    [JSON.stringify(zips), READING_MAX_AGE_HOURS],
  );
}
