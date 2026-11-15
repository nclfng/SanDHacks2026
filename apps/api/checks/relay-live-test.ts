// npx tsx --env-file=<repo>/.env checks/relay-live-test.ts  (outside src/ so the Mastra deploy skips it)
// Live check of the volunteer <-> caller relay on the real database, sending nothing. It makes a TEST request that a
// temporary volunteer has taken, and a temporary caller profile linked to the request's (fake 555) phone. Neither
// has written to the Page, so Facebook's window is closed and every relayed message is held, not sent. Everything
// it made is deleted afterwards.
import assert from 'node:assert/strict';
import { getSubscriber } from '../src/m4/db';
import { relayMessage } from '../src/requests/relay';
import { db } from '../src/shared/db';
import { hashPhone } from '../src/shared/phone';

const stamp = Date.now();
const volunteerHash = `relay-test-vol-${stamp}`;
const callerHash = `relay-test-caller-${stamp}`;
const callerPhone = '+16195550199';
const conversationId = `relay-test-${stamp}`;
let requestId: number | null = null;
try {
  await db!.query(
    `insert into subscribers (phone_hash, zip, consent_at, volunteer_at, alert_channel, messenger_psid, messenger_page_id)
     values ($1, '92093', now(), now(), 'messenger', 'test-psid-vol', 'test-page')`, [volunteerHash]);
  await db!.query(
    `insert into subscribers (phone_hash, zip, consent_at, alert_channel, messenger_psid, messenger_page_id, linked_phone_hash)
     values ($1, '92105', now(), 'messenger', 'test-psid-caller', 'test-page', $2)`, [callerHash, hashPhone(callerPhone)]);
  const { rows: [r] } = await db!.query(
    `insert into requests (conversation_id, said, location, zip, status, volunteer_hash, phone_e164)
     values ($1, 'TEST relay check', 'TEST 100 Example St', '92105', 'incoming', $2, $3) returning id`,
    [conversationId, volunteerHash, callerPhone]);
  requestId = r.id;
  const volunteer = (await getSubscriber(volunteerHash))!;
  const caller = (await getSubscriber(callerHash))!;

  const fromVolunteer = await relayMessage(volunteer, volunteerHash, "I'm 10 minutes out");
  console.log('volunteer ->', fromVolunteer);
  assert.match(fromVolunteer!.reply!, /^The person you're helping hasn't written to Shade.*\(619\) 555-0199/s);

  const fromCaller = await relayMessage(caller, callerHash, "Thank you, I'm by the bus stop");
  console.log('caller ->', fromCaller);
  assert.match(fromCaller!.reply!, /Your volunteer hasn't written/);

  const emergency = await relayMessage(caller, callerHash, 'my mom fainted');
  console.log('caller, emergency ->', emergency);
  assert.equal(emergency!.outcome, 'escalated_911');

  assert.equal(await relayMessage(caller, callerHash, 'SHADE is there a cooling center near me?'), null);
  assert.equal(await relayMessage({ ...caller, linked_phone_hash: null }, callerHash, 'hello'), null);

  const { rows: held } = await db!.query(
    `select phone_hash, body from messenger_followups where phone_hash = any($1) order by id`, [[volunteerHash, callerHash]]);
  console.log('held:', held.map((h) => `${h.phone_hash === callerHash ? 'for caller' : 'for volunteer'}: ${h.body}`));
  assert.equal(held.length, 3);
  assert.match(held[0].body, /^💬 Your volunteer: I'm 10 minutes out$/);
  assert.match(held[2].body, /🚨 This may be an emergency/);

  // Closed requests stop relaying.
  await db!.query(`update requests set status = 'closed', phone_e164 = null where id = $1`, [requestId]);
  assert.equal(await relayMessage(volunteer, volunteerHash, 'still there?'), null);
  assert.equal(await relayMessage(caller, callerHash, 'still there?'), null);
  console.log('relay ok');
} finally {
  const hashes = [volunteerHash, callerHash];
  await db!.query(`delete from messenger_followups where phone_hash = any($1)`, [hashes]);
  await db!.query(`delete from messages where phone_hash = any($1)`, [hashes]);
  await db!.query(`delete from call_events where conversation_id = $1`, [conversationId]);
  if (requestId) await db!.query(`delete from requests where id = $1`, [requestId]);
  await db!.query(`delete from subscribers where phone_hash = any($1)`, [hashes]);
  await db!.end();
}
