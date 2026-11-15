// Test fixture: a fake 24/7 site at Santa Claus House, North Pole, Alaska, so find_sites can be tested at night
// when every real site is closed. Rows with external_key 'test:*' are hidden from callers and the dashboard unless the
// API runs with FIND_SITES_TEST_NORTH_POLE=1 (apps/api/src/shared/find-sites.ts).
//   node --env-file=.env ingest/north-pole-test.ts            add or refresh the row (refresh keeps it inside the freshness window)
//   node --env-file=.env ingest/north-pole-test.ts --remove   delete it
// Targets NEON_DATABASE_URL_UNPOOLED (what the running API reads).
import { createRequire } from "node:module";

const { Client } = createRequire(import.meta.url)("pg");
const url = (process.env.NEON_DATABASE_URL_UNPOOLED ?? process.env.NEON_DATABASE_URL)?.replace(/^"|"$/g, "");
if (!url) throw new Error("Set NEON_DATABASE_URL_UNPOOLED");
const KEY = "test:north-pole-santa-claus-house";

const db = new Client({ connectionString: url });
await db.connect();
if (process.argv.includes("--remove")) {
  const r = await db.query("delete from sites where external_key = $1", [KEY]);
  console.log(`removed ${r.rowCount} row(s)`);
} else {
  const hours = { weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" })), exceptions: [] };
  const r = await db.query(
    `insert into sites (name, kind, tier, confidence, address, zip, lat, lon, hours, hours_confirmed_on_source, has_ac,
       source_url, last_verified_at, access_level, has_fee, verification, evidence, source_urls, external_key, category)
     values ($1,'other','official',1,$2,'99705',64.7556,-147.3447,$3,true,true,
       'https://www.santaclaushouse.com',now(),'open_to_all',false,'confirmed','TEST FIXTURE: not a real cooling center',
       '{}',$4,'TEST FIXTURE')
     on conflict (external_key) do update set hours = excluded.hours, last_verified_at = now()
     returning id`,
    ["Santa Claus House (TEST)", "101 St Nicholas Dr, North Pole, AK 99705", JSON.stringify(hours), KEY],
  );
  console.log(`test site id ${r.rows[0].id} is in Neon (hidden unless FIND_SITES_TEST_NORTH_POLE=1)`);
}
await db.end();
