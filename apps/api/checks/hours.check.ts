// npx tsx checks/hours.check.ts
// "Open 24 hours" is stored as 00:00-23:59 (ingest/maps.ts). It must never read as "closes 11:59 PM".
import assert from 'node:assert/strict';
import { hoursSpan, hoursToday } from '../src/shared/hours';

const allWeek = { weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' })) };
const at = (local: string) => new Date(`${local}-08:00`); // Pacific standard time

for (const t of ['2026-11-16T03:00', '2026-11-16T15:00', '2026-11-16T23:59']) {
  assert.deepEqual(hoursToday(allWeek as never, at(t)), { open_now: true, closes_at: null, hours_today: 'Open 24 hours' }, t);
}
assert.equal(hoursSpan({ open: '00:00', close: '00:00' }), 'Open 24 hours');
// An unconfirmed discovered site's "Open 24 hours" is ignored, as in find_sites.
assert.deepEqual(hoursToday(allWeek as never, at('2026-11-16T15:00'), true), { open_now: false, closes_at: null, hours_today: 'Closed today' });

// Ordinary and past-midnight hours are unchanged.
const day = { weekly: [{ day: 1, open: '09:00', close: '20:00' }] };
assert.deepEqual(hoursToday(day as never, at('2026-11-16T10:00')), { open_now: true, closes_at: '20:00', hours_today: '9:00 AM - 8:00 PM' });
assert.equal(hoursToday(day as never, at('2026-11-16T21:00')).open_now, false);
const late = { weekly: [{ day: 1, open: '08:00', close: '00:00' }] };
assert.equal(hoursToday(late as never, at('2026-11-16T22:00')).closes_at, '00:00');

console.log('hours ok');
