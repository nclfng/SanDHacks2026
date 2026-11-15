// Is a site open right now, and what are its hours today? Hours are local America/Los_Angeles (types.ts: SiteHours).
// An interval whose close is at or before its open runs past midnight (e.g. 07:00-02:00).
import type { HoursInterval, SiteHours } from '../../../../data/schema/types';

export interface HoursToday {
  open_now: boolean;
  closes_at: string | null; // "HH:MM" close of the interval open now; null when closed or open 24 hours
  hours_today: string;      // "9:00 AM - 8:00 PM", or "Closed today"
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LA = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function local(now: Date) {
  const p = Object.fromEntries(LA.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: DAYS.indexOf(p.weekday), hm: `${p.hour}:${p.minute}` };
}

export const to12h = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h % 24 < 12 ? 'AM' : 'PM'}`;
};

const overnight = (i: { open: string; close: string }) => i.close <= i.open;

/** Google's "Open 24 hours" is stored as 00:00-23:59 (ingest/maps.ts); 00:00-00:00 means the same. */
export const isAllDay = (i: { open: string; close: string }) => i.open === '00:00' && (i.close === '23:59' || i.close === '00:00');

/** One interval as people read it: "9:00 AM - 8:00 PM", or "Open 24 hours". */
export const hoursSpan = (i: { open: string; close: string }) => (isAllDay(i) ? 'Open 24 hours' : `${to12h(i.open)} - ${to12h(i.close)}`);

/**
 * `ignoreAllDay` drops "Open 24 hours" intervals, as find_sites does for an unconfirmed discovered site: Google
 * lists many places as open 24 hours that are not (find-sites.ts, status()).
 */
export function hoursToday(hours: SiteHours, now = new Date(), ignoreAllDay = false): HoursToday {
  const { date, day, hm } = local(now);
  const ex = hours.exceptions?.find((e) => e.date === date);
  const today: Pick<HoursInterval, 'open' | 'close'>[] = ex?.closed
    ? []
    : ex?.open && ex.close
      ? [{ open: ex.open, close: ex.close }]
      : hours.weekly.filter((i) => i.day === day && !(ignoreAllDay && isAllDay(i))).sort((a, b) => a.open.localeCompare(b.open));
  // Yesterday's overnight interval still running this morning.
  const spill = ex?.closed ? undefined : hours.weekly.find((i) => i.day === (day + 6) % 7 && overnight(i) && hm < i.close);
  const current = spill ?? today.find((i) => isAllDay(i) || (hm >= i.open && (overnight(i) || hm < i.close)));
  return {
    open_now: !!current,
    closes_at: current && !isAllDay(current) ? current.close : null,
    hours_today: today.length ? today.map(hoursSpan).join(', ') : 'Closed today',
  };
}
