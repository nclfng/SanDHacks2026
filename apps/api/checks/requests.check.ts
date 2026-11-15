// npx tsx --env-file=../../.env checks/requests.check.ts  (outside src/ so the Mastra deploy skips it)
// The database part writes and deletes one test request and three test subscribers, so it runs only with REQUESTS_CHECK_DB=1.
import assert from 'node:assert/strict';
import { db } from '../src/shared/db';
import { answerNeighbor, blastMessage, parseYes } from '../src/requests/neighbors';
import { blastArea, handleCheckStatus, handleRequestHelp, INBOX_COLUMNS, listOpenRequests, requestHelpBody, sayThis } from '../src/requests/requests';

// The caller's words and a location are required; a bad needs list is dropped, not fatal.
assert.equal(requestHelpBody.safeParse({ said: ' ', location: 'El Cajon' }).success, false);
assert.equal(requestHelpBody.safeParse({ said: 'I need a ride' }).success, false);
assert.equal(requestHelpBody.parse({ said: 'I need a ride', location: 'El Cajon', needs: 'no car' }).needs, undefined);

// Only 'incoming' says help is coming, and nothing promises a time.
assert.match(sayThis('requesting'), /No neighbor has said yes/);
assert.match(sayThis('requesting', 0), /2 1 1/);
assert.match(sayThis('incoming'), /come help you/);
for (const s of ['requesting', 'declined', 'closed'] as const) assert.doesNotMatch(sayThis(s), /on the way|will be there|come help you/i);
for (const s of ['requesting', 'incoming', 'closed'] as const) assert.doesNotMatch(sayThis(s), /minute|hour|soon/i);

// A neighbor takes a request only with its id; a bare "yes" goes to the text agent.
assert.equal(parseYes('YES 12'), 12);
assert.equal(parseYes(' si #7! '), 7);
assert.equal(parseYes('Sí 3'), 3);
assert.equal(parseYes('yes'), null);
assert.equal(parseYes('yes, is there one closer? 12'), null);

// The blast never carries a street address.
assert.equal(blastArea({ label: '123 Main St, El Cajon', precision: 'address' }, '92020'), 'in 92020');
assert.equal(blastArea({ label: 'Main St & Magnolia Ave', precision: 'intersection' }, '92020'), 'near Main St & Magnolia Ave');
assert.equal(blastArea(null, null), 'near you');
assert.match(blastMessage(12, 'in 92020', ['2 people'], 'en'), /Reply YES 12.*911/);
assert.match(blastMessage(12, 'in 92020', [], 'es'), /Responda SI 12/);

// The inbox never selects the callback number.
assert.ok(!INBOX_COLUMNS.includes('phone'));

if (db && process.env.REQUESTS_CHECK_DB === '1') {
  const conversation_id = `check-${Date.now()}`;
  // Borrego Springs, not a demo zip: the request's blast goes to real subscribers there.
  const body = { said: 'No car, really thirsty.', location: 'Borrego Springs 92004', needs: ['no car'], caller_id: '+16195550100', conversation_id };
  try {
    const first = await handleRequestHelp(body);
    const again = await handleRequestHelp(body);
    assert.equal(first.ok, true);
    assert.equal(first.status, 'requesting');
    assert.equal(again.request_id, first.request_id); // one request per call
    const mine = (await listOpenRequests()).find((r) => r.id === first.request_id);
    assert.ok(mine && mine.lat != null);
    assert.ok(!('phone_e164' in mine));

    const zip = (await db.query(`select zip from requests where id = $1`, [first.request_id])).rows[0].zip;
    const sub = (phone_hash: string, z = zip) => ({ phone_hash, zip: z, language: 'en' as const, opted_out_at: null });
    // check-a and check-b are volunteers in the zip; check-c is a subscriber there who never volunteered.
    for (const [h, v] of [['check-a', true], ['check-b', true], ['check-c', false]] as const) {
      await db.query(`insert into subscribers (phone_hash, zip, consent_at, volunteer_at) values ($1, $2, now(), $3)`,
        [h, zip, v ? new Date() : null]);
    }
    // Someone who never sent JOIN, or a subscriber who never volunteered, learns nothing.
    assert.equal(await answerNeighbor(null, `YES ${first.request_id}`), null);
    assert.doesNotMatch((await answerNeighbor(sub('check-c'), `YES ${first.request_id}`))!, /Borrego/);
    // The first volunteer's YES wins and gets the location; the second does not.
    const [ra, rb] = await Promise.all([
      answerNeighbor(sub('check-a'), `YES ${first.request_id}`), answerNeighbor(sub('check-b'), `YES ${first.request_id}`),
    ]);
    const winner = ra!.includes('Go to:') ? ra! : rb!;
    const loser = winner === ra ? rb! : ra!;
    assert.match(winner, /Borrego Springs 92004/);
    assert.match(loser, /already said yes/);
    assert.equal((await handleCheckStatus({ conversation_id })).status, 'incoming');
    console.log('requests db ok: request', first.request_id);
  } finally {
    await new Promise((r) => setTimeout(r, 3000)); // let the blast finish writing before cleanup
    await db.query(`delete from requests where conversation_id = $1`, [conversation_id]);
    await db.query(`delete from call_events where conversation_id = $1`, [conversation_id]);
    await db.query(`delete from subscribers where phone_hash = any($1)`, [['check-a', 'check-b', 'check-c']]);
    await db.end();
  }
} else {
  await db?.end();
  console.log('requests ok (database part skipped: set REQUESTS_CHECK_DB=1)');
}
