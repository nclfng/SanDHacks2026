// npx tsx --env-file=<repo>/.env checks/handoff-live-test.ts <request id>  (outside src/ so the Mastra deploy skips it)
// Live end-to-end check of the volunteer hand-off on one open TEST request. A temporary volunteer (no Messenger ids,
// fake 555 phone) says YES and then DONE. The only real messages are the caller's follow-ups ("a volunteer is
// coming, their number ...", then "marked as done"), sent to the caller's linked Messenger. The temporary
// volunteer row is deleted afterwards.
import { db } from '../src/shared/db';
import { answerNeighbor } from '../src/requests/neighbors';
import { handleCheckStatus } from '../src/requests/requests';

const id = Number(process.argv[2]);
const hash = `handoff-test-${Date.now()}`;
const vol = { phone_hash: hash, zip: '92093', language: 'en' as const, opted_out_at: null };
try {
  const { rows: [req] } = await db!.query(`select status, conversation_id, said from requests where id = $1`, [id]);
  if (!req || req.status !== 'requesting' || !/TEST/.test(req.said)) throw new Error(`request ${id} is not an open TEST request`);
  await db!.query(`insert into subscribers (phone_hash, phone_e164, zip, consent_at, volunteer_at) values ($1, '+16195550142', '92093', now(), now())`, [hash]);

  console.log('--- volunteer sends YES', id);
  console.log(await answerNeighbor(vol, `YES ${id}`));
  await new Promise((r) => setTimeout(r, 4000));   // the caller follow-up runs after the reply
  console.log('--- the voice agent checks status');
  console.log((await handleCheckStatus({ conversation_id: req.conversation_id })).say_this);
  console.log('--- a second volunteer replying YES gets');
  console.log(await answerNeighbor({ ...vol, phone_hash: 'not-a-volunteer' }, `YES ${id}`));
  console.log('--- volunteer sends DONE', id);
  console.log(await answerNeighbor(vol, `DONE ${id}`));
  await new Promise((r) => setTimeout(r, 4000));   // and so does the caller's "marked as done"
  const { rows: [after] } = await db!.query(`select status, phone_e164 is null as number_dropped from requests where id = $1`, [id]);
  console.log('request after DONE:', JSON.stringify(after));
} finally {
  await db!.query(`delete from subscribers where phone_hash = $1`, [hash]);
  await db!.end();
}
