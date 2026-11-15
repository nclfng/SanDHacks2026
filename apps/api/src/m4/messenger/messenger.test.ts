// Messenger integration tests. Nothing leaves the process: fetch is replaced, so no Neon or Twilio call is made.
//   npx tsx --test src/m4/messenger/messenger.test.ts      (from apps/api)

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Hono } from 'hono';
import { dispatchAlert } from '../alerts/dispatch';
import { checkReadingAlerts } from '../alerts/readings';
import { m4ApiRoutes } from '../mastra/routes';
import { followUpAfterCall, sendSms } from '../sms/send-sms';
import type { AlertRow, Site, SubscriberRow } from '../types';
import { hashPhone } from '../phone';
import { sendTwilioMessenger, twilioSignature, validateTwilioSignature } from '../sms/twilio';
import { hashMessengerId, messengerLogLabel, parseMessengerAddress } from './identity';
import { handleInboundMessenger, parseMessengerWebhook } from './inbound';
import { parseJoinMessage } from './join';

describe('parseJoinMessage', () => {
  it('reads zip and phone in either order and any common format, ignoring other words', () => {
    assert.deepEqual(parseJoinMessage('JOIN 92105'), { zip: '92105', phoneE164: null, phoneInvalid: false, volunteer: false });
    assert.deepEqual(parseJoinMessage('JOIN 92105 16195550147'), {
      zip: '92105',
      phoneE164: '+16195550147',
      phoneInvalid: false,
      volunteer: false,
    });
    assert.deepEqual(parseJoinMessage('join 92105 (619) 555-0147 Ana Ruiz'), {
      zip: '92105',
      phoneE164: '+16195550147',
      phoneInvalid: false,
      volunteer: false,
    });
    assert.deepEqual(parseJoinMessage('UNIRME 6195550147 92105'), {
      zip: '92105',
      phoneE164: '+16195550147',
      phoneInvalid: false,
      volunteer: false,
    });
    assert.equal(parseJoinMessage('JOIN 92105 +1 619 555 0147').phoneE164, '+16195550147');
    assert.equal(parseJoinMessage('JOIN 92105 volunteer').volunteer, true);
    assert.equal(parseJoinMessage('UNIRME VOLUNTARIA 92105 6195550147').volunteer, true);
  });

  it('flags digits that are not a phone number', () => {
    assert.equal(parseJoinMessage('JOIN 92105 555-12').phoneInvalid, true);
    assert.equal(parseJoinMessage('JOIN 6195550147').zip, null);
  });
});

// Made-up values. None of them is a real account, Page or person.
const PSID = '7712345678901234';
const PAGE_ID = '104455667788990';
const PUBLIC_BASE_URL = 'https://shade.example.test';

Object.assign(process.env, {
  PHONE_SALT: 'test-salt',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_PHONE_NUMBER: '+16195550123',
  PUBLIC_BASE_URL,
  NEON_DATABASE_URL: 'postgres://user:pass@db.example.test/neondb',
});
delete process.env.M4_SMS_DRY_RUN;
delete process.env.TWILIO_SID;
delete process.env.TWILIO_SECRET;

type Sent = { url: string; form?: URLSearchParams; sql?: { query: string; params: unknown[] }; graph?: URL };

let requests: Sent[] = [];
let logged: string[] = [];
let twilioResponse: () => Response;
// The fake Facebook Graph API's answer to a profile lookup.
let graphResponse: () => Response;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

// The fake database's answers, set per test.
let db: {
  subscriber: SubscriberRow | null;
  active: SubscriberRow[];
  lastInbound: string | null;
  followups: { id: number; phone_hash: string; body: string; site_id: number | null }[];
  site: Site | null;
  profile: SubscriberRow | null; // what getMessengerProfileByPhone returns
  zips: string[];
  readings: { zip: string; heat_index: number | null; aqi: number | null }[];
  recentAlert: boolean;
  recentFollowup: boolean; // the same site was held for this profile in the last 2 hours
};

// A made-up site, open every day, for send_sms to describe.
const SITE: Site = {
  id: 501,
  name: 'Test Library',
  kind: 'library',
  tier: 'official',
  confidence: null,
  address: '100 Example St, San Diego, CA 92105',
  zip: '92105',
  lat: 32.74,
  lon: -117.09,
  hours: { weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' })) },
  hours_confirmed_on_source: true,
  has_ac: true,
  has_filtration: null,
  capacity_est: null,
  phone: null,
  source_url: 'https://example.test/library',
  last_verified_at: '2026-11-14T00:00:00.000Z',
};

const MOCK_ALERT: AlertRow = {
  id: 9,
  kind: 'mock',
  nws_id: null,
  zips: ['92105'],
  headline: null,
  onset_at: null,
  expires_at: null,
  detected_at: '2026-11-14T00:00:00.000Z',
  texts_sent: 0,
};

function messengerRow(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: 1,
    phone_hash: hashMessengerId(PSID),
    phone_e164: null,
    language: 'en',
    zip: '92105',
    needs: {},
    consent_at: '2026-11-14T00:00:00.000Z',
    opted_out_at: null,
    alert_channel: 'messenger',
    messenger_psid: PSID,
    messenger_page_id: PAGE_ID,
    linked_phone_hash: null,
    display_name: null,
    ...overrides,
  };
}

function answer(query: string, params: unknown[]): unknown[] {
  // Before the active-subscribers pattern below, which this query would also match.
  if (/select distinct zip from subscribers/.test(query)) return db.zips.map((zip) => ({ zip }));
  if (/insert into subscribers/.test(query)) {
    return [
      messengerRow({
        zip: String(params[1]),
        language: params[2] as SubscriberRow['language'],
        linked_phone_hash: (params[7] as string | null) ?? null,
        display_name: (params[8] as string | null) ?? null,
      }),
    ];
  }
  if (/from subscribers where phone_hash/.test(query)) return db.subscriber ? [db.subscriber] : [];
  if (/from subscribers\s+where opted_out_at is null/.test(query)) return db.active;
  if (/max\(started_at\)/.test(query)) return [{ at: db.lastInbound }];
  if (/from messenger_followups where phone_hash = \$1 and site_id/.test(query)) return db.recentFollowup ? [{ '?column?': 1 }] : [];
  if (/from messenger_followups/.test(query)) return db.followups;
  // A held follow-up becomes pending, as in the real table.
  if (/insert into messenger_followups/.test(query)) {
    const id = 900 + db.followups.length;
    db.followups.push({ id, phone_hash: String(params[0]), body: String(params[1]), site_id: params[2] as number | null });
    return [{ id }];
  }
  if (/from sites where id/.test(query)) return db.site ? [db.site] : [];
  if (/linked_phone_hash = \$1 and opted_out_at is null/.test(query)) return db.profile ? [db.profile] : [];
  if (/from unnest/.test(query)) return db.readings;
  if (/from alerts where kind/.test(query)) return db.recentAlert ? [{ '?column?': 1 }] : [];
  if (/insert into alerts/.test(query)) {
    return [{ ...MOCK_ALERT, id: 11, kind: String(params[0]), nws_id: null, zips: JSON.parse(String(params[2])), headline: params[3] }];
  }
  if (/select 1 from calls/.test(query)) return [];
  return [{ id: 1 }];
}

beforeEach(() => {
  requests = [];
  logged = [];
  db = {
    subscriber: null,
    active: [],
    lastInbound: null,
    followups: [],
    site: null,
    profile: null,
    zips: [],
    readings: [],
    recentAlert: false,
    recentFollowup: false,
  };
  twilioResponse = () => Response.json({ sid: 'SM00000000000000000000000000000001' }, { status: 201 });
  graphResponse = () => Response.json({ first_name: 'Ana', last_name: 'Ruiz', id: PSID });
  delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.twilio.com/')) {
      requests.push({ url, form: new URLSearchParams(String(init?.body)) });
      return twilioResponse();
    }
    if (url.startsWith('https://graph.facebook.com/')) {
      requests.push({ url, graph: new URL(url) });
      return graphResponse();
    }
    if (url === 'https://db.example.test/sql') {
      const sql = JSON.parse(String(init?.body)) as { query: string; params: unknown[] };
      requests.push({ url, sql });
      return Response.json({ rows: answer(sql.query, sql.params) });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

const twilioSends = () => requests.filter((r) => r.form);
const graphCalls = () => requests.filter((r) => r.graph).map((r) => r.graph!);
const sqlCalls = () => requests.filter((r) => r.sql).map((r) => r.sql!);

function webhook(body: string, messageSid: string): Record<string, string> {
  return {
    MessageSid: messageSid,
    AccountSid: 'AC00000000000000000000000000000000',
    From: `messenger:${PSID}`,
    To: `messenger:${PAGE_ID}`,
    Body: body,
    NumMedia: '0',
  };
}

describe('Messenger identity', () => {
  it('parses messenger: addresses and refuses anything else', () => {
    assert.equal(parseMessengerAddress(`messenger:${PSID}`), PSID);
    assert.equal(parseMessengerAddress('+16195550100'), null);
    assert.equal(parseMessengerAddress('whatsapp:+16195550100'), null);
    assert.equal(parseMessengerAddress('messenger:'), null);
    assert.equal(parseMessengerAddress('messenger:12 34'), null);
  });

  it('hashes ids apart from phone numbers and never logs the raw id', () => {
    const hash = hashMessengerId(PSID);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, hashMessengerId(PSID));
    assert.notEqual(hash, hashPhone(PSID));
    assert.notEqual(hash, hashPhone(`+${PSID}`));
    assert.ok(!messengerLogLabel(hash).includes(PSID));
  });
});

describe('Messenger webhook', () => {
  it('reads sender, Page, body and sid, without treating the sender as a phone number', () => {
    assert.deepEqual(parseMessengerWebhook(webhook('hi', 'SM1')), {
      psid: PSID,
      pageId: PAGE_ID,
      body: 'hi',
      messageSid: 'SM1',
    });
    // An SMS webhook pointed at the Messenger route.
    assert.equal(parseMessengerWebhook({ ...webhook('hi', 'SM1'), From: '+16195550100' }), null);
    assert.equal(parseMessengerWebhook({ ...webhook('hi', 'SM1'), MessageSid: '' }), null);
  });

  it('accepts the signature only for the exact public Messenger URL', () => {
    const params = webhook('hi', 'SM1');
    const url = `${PUBLIC_BASE_URL}/m4/twilio/messenger`;
    const signature = twilioSignature(url, params);
    assert.ok(validateTwilioSignature({ signature, url, params }));
    assert.ok(!validateTwilioSignature({ signature, url: `${PUBLIC_BASE_URL}/m4/twilio/sms`, params }));
    assert.ok(!validateTwilioSignature({ signature, url, params: { ...params, Body: 'changed' } }));
  });
});

describe('sendTwilioMessenger', () => {
  it('posts messenger: addresses to the Messages API', async () => {
    await sendTwilioMessenger({ pageId: PAGE_ID, psid: PSID, body: 'hello' });
    const [send] = twilioSends();
    assert.equal(send.url, 'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json');
    assert.equal(send.form!.get('From'), `messenger:${PAGE_ID}`);
    assert.equal(send.form!.get('To'), `messenger:${PSID}`);
    assert.equal(send.form!.get('Body'), 'hello');
  });

  it('scrubs the Messenger id out of Twilio error messages', async () => {
    twilioResponse = () =>
      Response.json({ code: 63003, message: `Invalid To address messenger:${PSID}` }, { status: 400 });
    await assert.rejects(sendTwilioMessenger({ pageId: PAGE_ID, psid: PSID, body: 'hello' }), (error: Error) => {
      assert.ok(!error.message.includes(PSID));
      return true;
    });
  });
});

describe('handleInboundMessenger', () => {
  it('answers HELP from the Page, logs a hashed messenger calls row, and drops a repeat delivery', async () => {
    const msg = parseMessengerWebhook(webhook('HELP', 'SMtest-help'))!;
    const result = await handleInboundMessenger(msg);
    assert.deepEqual(result.sent, { ok: true });
    assert.match(result.reply!, /cooling center/);

    const [send] = twilioSends();
    assert.equal(send.form!.get('From'), `messenger:${PAGE_ID}`);
    assert.equal(send.form!.get('To'), `messenger:${PSID}`);
    assert.equal(send.form!.get('Body'), result.reply);

    const call = sqlCalls().find((sql) => /insert into calls/.test(sql.query))!;
    assert.deepEqual(call.params.slice(0, 3), ['inbound', 'messenger', hashMessengerId(PSID)]);

    // Without an opt-in, the raw id goes to Twilio and nowhere else: not to the database, not to the log.
    assert.ok(!JSON.stringify(sqlCalls()).includes(PSID));
    assert.ok(!logged.join('\n').includes(PSID));

    const repeat = await handleInboundMessenger(msg);
    assert.deepEqual(repeat, { reply: null, sent: null });
    assert.equal(twilioSends().length, 1);
  });

  it('marks JOIN <zip> VOLUNTEER as a volunteer, and invites a plain JOIN to become one', async () => {
    const plain = await handleInboundMessenger(parseMessengerWebhook(webhook('JOIN 92105', 'SMtest-join-plain'))!);
    assert.match(plain.reply!, /Send JOIN 92105 VOLUNTEER/);
    const vol = await handleInboundMessenger(parseMessengerWebhook(webhook('JOIN 92105 VOLUNTEER', 'SMtest-join-vol'))!);
    assert.match(vol.reply!, /You're a volunteer/);
    const upserts = sqlCalls().filter((sql) => /insert into subscribers/.test(sql.query));
    assert.deepEqual(upserts.map((sql) => sql.params[9]), [false, true]);
  });

  it('signs JOIN up for Messenger alerts, storing the ids only on the subscriber row', async () => {
    const result = await handleInboundMessenger(parseMessengerWebhook(webhook('JOIN 92105', 'SMtest-join'))!);
    assert.match(result.reply!, /Shade will message you here with heat and smoke alerts for 92105/);
    assert.deepEqual(result.sent, { ok: true });

    const upsert = sqlCalls().find((sql) => /insert into subscribers/.test(sql.query))!;
    assert.match(upsert.query, /'messenger'/);
    assert.deepEqual(
      [upsert.params[0], upsert.params[1], upsert.params[5], upsert.params[6]],
      [hashMessengerId(PSID), '92105', PSID, PAGE_ID],
    );
    // The ids are stored for alerts on the subscriber row, and nowhere else.
    assert.ok(sqlCalls().filter((sql) => sql !== upsert).every((sql) => !JSON.stringify(sql).includes(PSID)));
    assert.ok(!logged.join('\n').includes(PSID));
    const call = sqlCalls().find((sql) => /insert into calls/.test(sql.query))!;
    assert.equal(call.params[3], '92105');
  });

  it('asks for a zip when JOIN has none', async () => {
    const result = await handleInboundMessenger(parseMessengerWebhook(webhook('JOIN', 'SMtest-join-nozip'))!);
    assert.match(result.reply!, /send JOIN, your zip code and your phone number/);
    assert.ok(sqlCalls().every((sql) => !/insert into subscribers/.test(sql.query)));
  });

  it('opts a Spanish STOP out, answering in Spanish', async () => {
    db.subscriber = messengerRow();
    const result = await handleInboundMessenger(parseMessengerWebhook(webhook('ALTO', 'SMtest-stop'))!);
    assert.match(result.reply!, /Cancelaste tu suscripción/);
    const update = sqlCalls().find((sql) => /update subscribers set opted_out_at/.test(sql.query))!;
    assert.equal(update.params[0], hashMessengerId(PSID));
    assert.match(update.query, /messenger_psid = null/);
  });

  it('signs a past subscriber up again with START and their zip on file', async () => {
    db.subscriber = messengerRow({ zip: '92113', opted_out_at: '2026-11-14T00:00:00.000Z' });
    const result = await handleInboundMessenger(parseMessengerWebhook(webhook('START', 'SMtest-start'))!);
    assert.match(result.reply!, /92113/);
  });

  // A made-up number and name.
  const PHONE = '+16195550147';

  it('links a phone number with JOIN <zip> <phone>, taking the name from Facebook and storing only the phone hash', async () => {
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'test-page-token';
    // A typed name is ignored: the name comes from the Facebook profile.
    const msg = parseMessengerWebhook(webhook('JOIN 92105 16195550147 Someone Else', 'SMtest-join-phone'))!;
    const result = await handleInboundMessenger(msg);
    assert.match(result.reply!, /^✅ You're all set, Ana!/);
    assert.match(result.reply!, /phone number ending in 0147/);
    assert.ok(!result.reply!.includes('6195550147'));

    const [graph] = graphCalls();
    assert.equal(graph.pathname, `/${PSID}`);
    assert.equal(graph.searchParams.get('fields'), 'first_name,last_name');
    assert.equal(graph.searchParams.get('access_token'), 'test-page-token');

    const unlink = sqlCalls().find((sql) => /set linked_phone_hash = null/.test(sql.query))!;
    assert.deepEqual(unlink.params, [hashPhone(PHONE), hashMessengerId(PSID)]);
    const upsert = sqlCalls().find((sql) => /insert into subscribers/.test(sql.query))!;
    assert.equal(upsert.params[1], '92105');
    assert.equal(upsert.params[7], hashPhone(PHONE));
    assert.equal(upsert.params[8], 'Ana Ruiz');
    // The raw phone number, the name and the token go nowhere else: not to the database, not to the log.
    assert.ok(!JSON.stringify(sqlCalls()).includes('6195550147'));
    for (const secret of ['6195550147', 'Ana', 'test-page-token', PSID]) assert.ok(!logged.join('\n').includes(secret));
  });

  it('signs up without a name when there is no Page token, or Facebook fails', async () => {
    const plain = await handleInboundMessenger(parseMessengerWebhook(webhook('JOIN 92105', 'SMtest-join-notoken'))!);
    assert.match(plain.reply!, /^✅ You're all set!/);
    assert.equal(graphCalls().length, 0);

    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'test-page-token';
    graphResponse = () => Response.json({ error: { code: 100, message: `Unsupported get request ${PSID}` } }, { status: 400 });
    const failed = await handleInboundMessenger(parseMessengerWebhook(webhook('JOIN 92105', 'SMtest-join-graphfail'))!);
    assert.match(failed.reply!, /^✅ You're all set!/);
    assert.equal(graphCalls().length, 1);
    assert.ok(logged.some((line) => /Facebook profile lookup failed: HTTP 400 \(Graph error 100\)/.test(line)));
    assert.ok(!logged.join('\n').includes(PSID));
  });

  it('refuses a JOIN whose phone number cannot be read, saving nothing', async () => {
    for (const [body, sid] of [
      ['JOIN 92105 555-12', 'SMtest-join-bad'],
      ['JOIN 92105 12345', 'SMtest-join-bad2'], // the second 5-digit number is read as a (too short) phone
    ]) {
      const result = await handleInboundMessenger(parseMessengerWebhook(webhook(body, sid))!);
      assert.match(result.reply!, /phone number does not look right/);
    }
    assert.ok(sqlCalls().every((sql) => !/insert into subscribers/.test(sql.query)));
  });

  it('clears the phone link and name on STOP', async () => {
    db.subscriber = messengerRow({ linked_phone_hash: hashPhone(PHONE), display_name: 'Ana Ruiz' });
    await handleInboundMessenger(parseMessengerWebhook(webhook('STOP', 'SMtest-stop-linked'))!);
    const update = sqlCalls().find((sql) => /update subscribers set opted_out_at/.test(sql.query))!;
    assert.match(update.query, /linked_phone_hash = null/);
    assert.match(update.query, /display_name = null/);
  });

  it('reports a failed send without throwing or logging the id', async () => {
    twilioResponse = () => Response.json({ code: 63018, message: `Rate limit for messenger:${PSID}` }, { status: 429 });
    const result = await handleInboundMessenger(parseMessengerWebhook(webhook('HELP', 'SMtest-fail'))!);
    assert.deepEqual(result.sent, { ok: false, error: 'twilio_63018' });
    assert.ok(!logged.join('\n').includes(PSID));
  });
});

// The real M4 routes in a bare Hono app, with a stand-in for the Mastra instance the handlers read their logger from.
function app(): Hono {
  const server = new Hono();
  server.use(async (c, next) => {
    c.set('mastra' as never, { getLogger: () => undefined } as never);
    await next();
  });
  for (const route of m4ApiRoutes) {
    if ('path' in route && 'handler' in route && route.method === 'POST') {
      server.post(route.path, route.handler as never);
    }
  }
  return server;
}

async function post(path: string, params: Record<string, string>, signature: string | null): Promise<Response> {
  return app().request(`http://localhost:4111${path}`, {
    method: 'POST',
    headers: signature ? { 'X-Twilio-Signature': signature } : {},
    body: new URLSearchParams(params),
  });
}

// The Messenger route sends after it has answered, so wait for the send to land.
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && twilioSends().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('POST /m4/twilio/messenger', () => {
  const path = '/m4/twilio/messenger';
  const sign = (params: Record<string, string>, p = path) => twilioSignature(PUBLIC_BASE_URL + p, params);

  it('acks with an empty <Response/> and sends the reply over Messenger', async () => {
    const params = webhook('HELP', 'SMroute-ok');
    const response = await post(path, params, sign(params));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<Response\/>$/);
    await settle();
    const [send] = twilioSends();
    assert.equal(send.form!.get('From'), `messenger:${PAGE_ID}`);
    assert.equal(send.form!.get('To'), `messenger:${PSID}`);
  });

  it('refuses a missing signature, or one made for the SMS URL', async () => {
    const params = webhook('HELP', 'SMroute-forbidden');
    assert.equal((await post(path, params, null)).status, 403);
    assert.equal((await post(path, params, sign(params, '/m4/twilio/sms'))).status, 403);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(requests.length, 0);
  });

  it('refuses a signed webhook whose sender is a phone number', async () => {
    const params = { ...webhook('HELP', 'SMroute-sms'), From: '+16195550100', To: '+16195550123' };
    assert.equal((await post(path, params, sign(params))).status, 400);
    assert.equal(requests.length, 0);
  });
});

describe('POST /m4/twilio/sms (unchanged)', () => {
  it('still answers a signed SMS with TwiML and an sms calls row', async () => {
    const params = { MessageSid: 'SMroute-sms-help', From: '+16195550100', To: '+16195550123', Body: 'HELP' };
    const signature = twilioSignature(`${PUBLIC_BASE_URL}/m4/twilio/sms`, params);
    const response = await post('/m4/twilio/sms', params, signature);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<Message>Shade: heat and smoke alerts/);
    assert.equal(twilioSends().length, 0);
    const insert = sqlCalls().find((sql) => /insert into calls/.test(sql.query))!;
    assert.deepEqual(insert.params.slice(0, 3), ['inbound', 'sms', hashPhone('+16195550100')]);
  });
});

describe('dispatchAlert to Messenger subscribers', () => {
  const alert: AlertRow = {
    id: 9,
    kind: 'mock',
    nws_id: null,
    zips: ['92105'],
    headline: null,
    onset_at: null,
    expires_at: null,
    detected_at: '2026-11-14T00:00:00.000Z',
    texts_sent: 0,
  };

  it('sends the alert from their Page when they wrote in the last 24 hours, and logs it for the guards', async () => {
    db.active = [messengerRow()];
    db.lastInbound = new Date(Date.now() - 3600_000).toISOString();
    assert.deepEqual(await dispatchAlert(alert), { textsSent: 1 });

    const [send] = twilioSends();
    assert.equal(send.form!.get('From'), `messenger:${PAGE_ID}`);
    assert.equal(send.form!.get('To'), `messenger:${PSID}`);
    assert.match(send.form!.get('Body')!, /^⚠️ Heads up from Shade \(test\): This is a practice alert/);

    const call = sqlCalls().find((sql) => /insert into calls/.test(sql.query))!;
    assert.deepEqual(call.params.slice(0, 3), ['outbound', 'messenger', hashMessengerId(PSID)]);
    assert.equal(call.params[6], 'sms_sent');
    assert.equal(call.params[7], 9);
    assert.ok(!logged.join('\n').includes(PSID));
  });

  it('skips them when their last message is older than 24 hours', async () => {
    db.active = [messengerRow()];
    db.lastInbound = new Date(Date.now() - 30 * 3600_000).toISOString();
    assert.deepEqual(await dispatchAlert(alert), { textsSent: 0 });
    assert.equal(twilioSends().length, 0);
    assert.ok(logged.some((line) => /messenger_window_closed/.test(line)));
  });
});

describe('mode 1: automatic follow-up when a call ends', () => {
  const CALLER = '+16195550189'; // made up
  const held = () => sqlCalls().filter((sql) => /insert into messenger_followups/.test(sql.query));

  it('sends at once, from the call or from send_sms, when the caller messaged the Page in the last 24 hours', async () => {
    db.site = SITE;
    db.profile = messengerRow({ linked_phone_hash: hashPhone(CALLER) });
    db.lastInbound = new Date(Date.now() - 2 * 3600_000).toISOString(); // their JOIN, two hours ago
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: SITE.id, language: 'en' }), 'sent');
    const [send] = twilioSends();
    assert.equal(send.form!.get('To'), `messenger:${PSID}`);
    assert.match(send.form!.get('Body')!, /^📞 Here's the follow-up from your call with Shade\./);
    assert.ok(sqlCalls().some((sql) => /set delivered_at = now\(\)/.test(sql.query)));

    const result = await sendSms({ to: '+16195550177', site_id: SITE.id });
    assert.equal(result.ok, true);
    assert.match(result.note!, /Sent to the caller's Facebook Messenger just now/);
    assert.doesNotMatch(result.note!, /send any message/);
  });

  it("holds the site for a linked caller without anyone asking for a text", async () => {
    db.site = SITE;
    db.profile = messengerRow({ linked_phone_hash: hashPhone(CALLER) });
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: SITE.id, language: 'es' }), 'queued');
    assert.equal(held().length, 1);
    assert.match(String(held()[0].params[1]), /^📞 Aquí tienes el seguimiento de tu llamada con Shade\.\n\nEste es el centro de enfriamiento que encontramos para ti:\n📍 Test Library/);
    assert.equal(twilioSends().length, 0);
    assert.ok(!JSON.stringify(sqlCalls()).includes('6195550189'));
  });

  it('does not hold the same site twice (send_sms during the call already did)', async () => {
    db.site = SITE;
    db.profile = messengerRow();
    db.recentFollowup = true;
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: SITE.id }), 'already_queued');
    assert.equal(held().length, 0);
  });

  it('send_sms sends a site again when the caller asks for it again within the dedupe window', async () => {
    db.site = SITE;
    db.profile = messengerRow({ linked_phone_hash: hashPhone(CALLER) });
    db.recentFollowup = true; // the same site went out on an earlier call
    db.lastInbound = new Date(Date.now() - 3600_000).toISOString();
    const result = await sendSms({ to: CALLER, site_id: SITE.id });
    assert.equal(result.ok, true);
    assert.equal(held().length, 1);
    assert.equal(twilioSends().length, 1);
    assert.match(result.note!, /Sent to the caller's Facebook Messenger just now/);
  });

  it('does nothing without a linked profile, a site, or when the number opted out', async () => {
    db.site = SITE;
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: SITE.id }), 'no_profile');
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: null }), 'no_site');
    db.profile = messengerRow();
    db.subscriber = messengerRow({ opted_out_at: '2026-11-14T00:00:00.000Z' });
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: SITE.id }), 'opted_out');
    assert.equal(held().length, 0);
  });

  it('falls back to English for a language it does not know', async () => {
    db.site = SITE;
    db.profile = messengerRow();
    assert.equal(await followUpAfterCall({ phoneE164: CALLER, siteId: SITE.id, language: 'Spanish' }), 'queued');
    assert.match(String(held()[0].params[1]), /^📞 Here's the follow-up from your call with Shade\.\n\nHere's the cooling center we found for you:\n📍 Test Library/);
  });
});

describe('mode 1: send_sms after a phone call', () => {
  const CALLER = '+16195550188'; // made up

  it("holds the site details for the caller's linked Messenger profile and sends nothing yet", async () => {
    db.site = SITE;
    db.profile = messengerRow({ linked_phone_hash: hashPhone(CALLER) });
    const result = await sendSms({ to: CALLER, site_id: SITE.id, language: 'en' });
    assert.equal(result.ok, true);
    assert.match(result.note!, /send any message to the Shadoes Facebook Page/);
    assert.match(result.note!, /Do not call it a text message/);
    assert.equal(twilioSends().length, 0);

    const lookup = sqlCalls().find((sql) => /linked_phone_hash = \$1 and opted_out_at is null/.test(sql.query))!;
    assert.deepEqual(lookup.params, [hashPhone(CALLER)]);
    const held = sqlCalls().find((sql) => /insert into messenger_followups/.test(sql.query))!;
    assert.equal(held.params[0], hashMessengerId(PSID));
    assert.match(String(held.params[1]), /^📞 Here's the follow-up from your call with Shade\.\n\nHere's the cooling center we found for you:\n📍 Test Library\n.*\n🗺️ Map: https:.*\n\n💬 Reply here anytime/s);
    assert.equal(held.params[2], SITE.id);
    // The caller's number is only ever hashed.
    assert.ok(!JSON.stringify(sqlCalls()).includes('6195550188'));
    assert.ok(!logged.join('\n').includes('6195550188'));
  });

  it('sends nothing and explains how to link Messenger when the number has no profile', async () => {
    db.site = SITE;
    const result = await sendSms({ to: CALLER, site_id: SITE.id });
    assert.deepEqual([result.ok, result.error], [false, 'no_messenger_profile']);
    assert.match(result.note!, /JOIN/);
    assert.equal(twilioSends().length, 0);
    assert.ok(sqlCalls().every((sql) => !/insert into messenger_followups/.test(sql.query)));
  });

  it('logs the text instead (dry run) for a caller with no profile, so the demo fallback works', async () => {
    db.site = SITE;
    process.env.M4_SMS_DRY_RUN = '1';
    try {
      const result = await sendSms({ to: CALLER, site_id: SITE.id });
      assert.equal(result.ok, true);
      assert.equal(twilioSends().length, 0);
      assert.ok(logged.some((line) => /dry run, not sent/.test(line) && line.includes('Test Library')));
    } finally {
      delete process.env.M4_SMS_DRY_RUN;
    }
  });

  it('still refuses a number that opted out', async () => {
    db.site = SITE;
    db.subscriber = messengerRow({ opted_out_at: '2026-11-14T00:00:00.000Z' });
    db.profile = messengerRow();
    const result = await sendSms({ to: CALLER, site_id: SITE.id });
    assert.deepEqual(result, { ok: false, error: 'opted_out' });
  });

  it('delivers what was held first when they next message the Page, then answers', async () => {
    db.followups = [{ id: 31, phone_hash: hashMessengerId(PSID), body: 'From your call with Shade:\nTest Library', site_id: 501 }];
    const result = await handleInboundMessenger(parseMessengerWebhook(webhook('HELP', 'SMtest-followup'))!);
    const sends = twilioSends();
    assert.equal(sends.length, 2);
    assert.equal(sends[0].form!.get('Body'), 'From your call with Shade:\nTest Library');
    assert.equal(sends[0].form!.get('To'), `messenger:${PSID}`);
    assert.equal(sends[1].form!.get('Body'), result.reply);
    assert.ok(sqlCalls().some((sql) => /set delivered_at = now\(\)/.test(sql.query) && sql.params[0] === 31));
    assert.ok(sqlCalls().some((sql) => /insert into messages/.test(sql.query) && sql.params[2] === 'From your call with Shade:\nTest Library'));
  });

  it('drops what was held on STOP instead of sending it', async () => {
    db.followups = [{ id: 32, phone_hash: hashMessengerId(PSID), body: 'From your call with Shade:\nTest Library', site_id: 501 }];
    await handleInboundMessenger(parseMessengerWebhook(webhook('STOP', 'SMtest-followup-stop'))!);
    assert.equal(twilioSends().length, 1); // only the STOP confirmation
    assert.ok(sqlCalls().some((sql) => /delete from messenger_followups/.test(sql.query)));
  });
});

describe('mode 3: alerts from readings', () => {
  it('raises a heat-index alert for a zip over the line and sends it to Messenger subscribers there', async () => {
    db.zips = ['92105'];
    db.readings = [{ zip: '92105', heat_index: 106, aqi: null }];
    db.active = [messengerRow()];
    db.lastInbound = new Date(Date.now() - 3600_000).toISOString();
    assert.deepEqual(await checkReadingAlerts(), { zipsChecked: 1, alertsRaised: 1, textsSent: 1 });

    const insert = sqlCalls().find((sql) => /insert into alerts/.test(sql.query))!;
    assert.equal(insert.params[0], 'high_heat_index');
    assert.equal(insert.params[1], null); // not an NWS alert
    assert.deepEqual(JSON.parse(String(insert.params[2])), ['92105']);
    assert.match(twilioSends()[0].form!.get('Body')!, /^⚠️ Heads up from Shade: It is dangerously hot in your area right now \(heat index 106°F\)\.\n\nHere's the nearest (cooling center that's open right now|open place to cool off \(not an official cooling center, so call ahead first\)):\n📍 .*\n🗺️ Map: .*\n\n💧 Stay cool/s);
  });

  it('raises nothing when an alert of that kind went out recently, or readings are under the line', async () => {
    db.zips = ['92105', '92113'];
    db.readings = [
      { zip: '92105', heat_index: 110, aqi: null },
      { zip: '92113', heat_index: 85, aqi: 60 },
    ];
    db.recentAlert = true;
    assert.deepEqual(await checkReadingAlerts(), { zipsChecked: 2, alertsRaised: 0, textsSent: 0 });
    assert.ok(sqlCalls().every((sql) => !/insert into alerts/.test(sql.query)));
  });

  it('raises an AQI alert, worded for smoke', async () => {
    db.zips = ['92105'];
    db.readings = [{ zip: '92105', heat_index: null, aqi: 165 }];
    db.active = [messengerRow()];
    db.lastInbound = new Date(Date.now() - 3600_000).toISOString();
    const summary = await checkReadingAlerts();
    assert.equal(summary.alertsRaised, 1);
    assert.equal(sqlCalls().find((sql) => /insert into alerts/.test(sql.query))!.params[0], 'high_aqi');
    assert.match(twilioSends()[0].form!.get('Body')!, /^⚠️ Heads up from Shade: The air in your area is unhealthy right now \(AQI 165\)/);
  });
});
