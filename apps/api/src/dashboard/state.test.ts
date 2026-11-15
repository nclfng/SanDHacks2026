// npx tsx --test src/dashboard/state.test.ts  (from apps/api)
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CallOutcome } from '../../../../data/schema/types';
import { buildState, seedRaw } from './state';

type Row = { direction?: 'inbound' | 'outbound'; zip: string | null; who?: string | null; outcome?: CallOutcome | null; at?: string };
let id = 0;
const counts = (...rows: Row[]) => {
  const calls = rows.map((r) => ({
    id: ++id, direction: r.direction ?? 'inbound', channel: 'messenger' as const, phone_hash: r.who === undefined ? `p${id}` : r.who,
    zip: r.zip, site_id: null, outcome: r.outcome ?? null, started_at: r.at ?? '2026-11-15T10:00:00Z',
  }));
  return Object.fromEntries(buildState({ ...seedRaw(), calls }, new Date('2026-11-15T12:00:00Z'), 'seed').calls.map((c) => [c.zip, c.n]));
};

it('counts people who reached out, not messages, and leaves out texts Shade sent', () => {
  assert.deepEqual(counts(
    { zip: '92105', who: 'a' }, { zip: '92105', who: 'a' }, { zip: '92105', who: 'b' },
    { zip: '92105', who: null }, { zip: '92105', who: null },   // no hash: each row is its own person
    { zip: '92105', direction: 'outbound' }, { zip: '92113', direction: 'outbound' },
    { zip: null }, { zip: '00000' },                            // no zip, or one off the map
  ), { '92105': 4 });
});

it('puts a person where the lookup placed them, not where a later "thanks" row says', () => {
  assert.deepEqual(counts(
    { zip: '92105', who: 'a', at: '2026-11-15T09:00:00Z' },                          // "hi", zip on file
    { zip: '92101', who: 'a', outcome: 'site_given', at: '2026-11-15T09:01:00Z' },    // "I'm at Balboa Park"
    { zip: '92105', who: 'a', at: '2026-11-15T09:02:00Z' },                          // "thanks", zip on file
  ), { '92101': 1 });
});

it('uses the latest lookup when a person moved, and the latest row when there was none', () => {
  assert.deepEqual(counts(
    { zip: '92101', who: 'a', outcome: 'site_given', at: '2026-11-15T09:00:00Z' },
    { zip: '92113', who: 'a', outcome: 'no_site_found', at: '2026-11-15T10:00:00Z' },
    { zip: '92105', who: 'b', at: '2026-11-15T09:00:00Z' },
    { zip: '92102', who: 'b', at: '2026-11-15T10:00:00Z' },
  ), { '92113': 1, '92102': 1 });
});
