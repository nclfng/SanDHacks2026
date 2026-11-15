// npx tsx --env-file=../../.env checks/send-test-request.ts  (outside src/ so the Mastra deploy skips it)
// Files one clearly-labeled TEST help request, as request_help would on a call, and messages every volunteer on
// Messenger. The caller is the 415 test phone, so a YES sends the "a neighbor is coming" follow-up there.
import { db } from '../src/shared/db';
import { handleRequestHelp } from '../src/requests/requests';

const conversation_id = `test-${Date.now()}`;
const result = await handleRequestHelp({
  said: 'TEST from the Shade team: please ignore, or reply YES to try the flow.',
  location: 'Fairmont Village, UC San Diego 92093',
  needs: ['TEST', 'no car'],
  caller_id: process.env.TEST_PHONE_NUMBER || '+14156889097',
  conversation_id,
});
console.log('request_help ->', JSON.stringify(result));
await new Promise((r) => setTimeout(r, 6000));   // the blast runs after request_help returns
const { rows: [row] } = await db!.query(`select id, zip, status, neighbors_messaged from requests where conversation_id = $1`, [conversation_id]);
console.log('request row ->', JSON.stringify(row));
await db!.end();
