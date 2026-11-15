// Everything the ops dashboard (apps/web) shows, in one read-only snapshot.
// Rows come from Neon when it is configured, otherwise from data/seed/. Both go through buildState.
import type { AlertKind, CallDirection, CallOutcome, Channel, Reading, Site } from '../../../../data/schema/types';
import sitesSeed from '../../../../data/seed/sites.json';
import extrasSeed from '../../../../data/seed/sites.extras.json';
import readingsSeed from '../../../../data/seed/readings.json';
import zipGap from '../../../../data/seed/zip_gap.json';
import { hoursToday } from '../shared/hours';

interface CallRow { id: number; direction: CallDirection; channel: Channel; zip: string | null; site_id: number | null; outcome: CallOutcome | null; started_at: string | Date }
interface AlertRow { id: number; kind: AlertKind; zips: string[]; headline: string | null; onset_at: string | Date | null; expires_at: string | Date | null; texts_sent: number }
// How packed the venue itself is, from Google review mentions (site_review_signals). Unrelated to how many people Shade sent.
interface CrowdRow { site_id: number; scanned: number; crowded: number; spacious: number }
interface Raw { sites: Site[]; readings: Reading[]; calls: CallRow[]; alerts: AlertRow[]; subscribers: { zip: string; n: number }[]; crowd: CrowdRow[] }
export type Source = 'neon' | 'seed';
interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

const DAY_MS = 864e5;
const CENTROID = new Map(zipGap.zips.map((z) => [z.zip, [z.lat, z.lon] as const]));

export function seedRaw(): Raw {
  // The seed has no calls, alerts or subscribers: those only exist once M3/M4 write to Neon.
  const crowd = Object.entries(extrasSeed as Record<string, any>).flatMap(([id, x]) => {
    const g = x.review_signals;
    return g ? [{ site_id: +id, scanned: g.scanned, crowded: g.crowded, spacious: g.spacious }] : [];
  });
  return { sites: sitesSeed as Site[], readings: readingsSeed as Reading[], calls: [], alerts: [], subscribers: [], crowd };
}

export async function neonRaw(db: Queryable, now: Date): Promise<Raw> {
  const q = async (sql: string) => (await db.query(sql, [now])).rows;
  const [sites, readings, calls, alerts, subscribers, crowd] = await Promise.all([
    db.query(`select id, name, kind, tier, confidence, verification, address, zip, lat, lon, hours, capacity_est, last_verified_at from sites where external_key is null or external_key not like 'test:%'`).then((r) => r.rows),
    q(`select time, zip, temp_f, heat_index, aqi, source from readings
       where time between $1::timestamptz - interval '48 hours' and $1::timestamptz + interval '48 hours'`),
    q(`select id, direction, channel, zip, site_id, outcome, started_at from calls
       where started_at > $1::timestamptz - interval '24 hours' and started_at <= $1 order by started_at desc`),
    q(`select id, kind, zips, headline, onset_at, expires_at, texts_sent from alerts
       where detected_at <= $1 and (expires_at is null or expires_at > $1) order by detected_at desc`),
    db.query(`select zip, count(*)::int n from subscribers where opted_out_at is null group by zip`).then((r) => r.rows),
    db.query(`select site_id, sum(reviews_scanned)::int scanned, sum(crowded)::int crowded, sum(spacious)::int spacious
              from site_review_signals where site_id is not null group by site_id`).then((r) => r.rows),
  ]);
  return { sites, readings, calls, alerts, subscribers, crowd };
}

export function buildState(raw: Raw, now: Date, source: Source) {
  const t = now.getTime();
  // Area name per zip: the city before ", CA" in site addresses ("4375 Bonita Rd, Bonita, CA 91902, United States").
  const area = new Map<string, string>();
  for (const s of raw.sites) {
    const parts = s.address.split(',').map((p) => p.trim());
    const city = parts[parts.findIndex((p) => /^CA\b/.test(p)) - 1];
    // Skip "840 Duncan Ranch Road Chula Vista" (no comma after the street); another site in the zip usually has it clean.
    if (s.zip && city && !/\d/.test(city) && !area.has(s.zip)) area.set(s.zip, city);
  }

  const referrals = new Map<number, number>();
  for (const c of raw.calls) if (c.site_id) referrals.set(c.site_id, (referrals.get(c.site_id) ?? 0) + 1);

  const crowd = new Map(raw.crowd.map(({ site_id, ...c }) => [site_id, c]));

  // Per zip, the reading nearest to now (the seed holds forecasts, so "latest" can be in the future).
  const nearest = new Map<string, Reading>();
  const gap = (r: Reading) => Math.abs(new Date(r.time).getTime() - t);
  for (const r of raw.readings) {
    const cur = nearest.get(r.zip);
    if (!cur || gap(r) < gap(cur)) nearest.set(r.zip, r);
  }

  return {
    source,
    generated_at: now.toISOString(),
    // Only sites open right now, by the same rule find_sites uses, so the dashboard lists what the agent would suggest.
    sites: raw.sites.map((s) => ({
      id: s.id, name: s.name, kind: s.kind, tier: s.tier, confidence: s.confidence, address: s.address, zip: s.zip,
      lat: s.lat, lon: s.lon, capacity_est: s.capacity_est, last_verified_at: s.last_verified_at,
      stale: t - new Date(s.last_verified_at).getTime() > DAY_MS, // contracts.md freshness rule
      referrals_24h: referrals.get(s.id) ?? 0,
      crowd: crowd.get(s.id) ?? null, // null: no reviews scanned for this site
      ...hoursToday(s.hours, now, s.tier === 'discovered' && s.verification !== 'confirmed'),
    })).filter((s) => s.open_now),
    readings: [...nearest.values()].map((r) => ({ ...r, area: area.get(r.zip) ?? r.zip })),
    calls: raw.calls.flatMap((c) => {
      const at = c.zip ? CENTROID.get(c.zip) : undefined;
      if (!at) return [];
      // Calls are stored by zip only; spread same-zip calls around the centroid so they don't stack.
      return [{ ...c, lat: at[0] + 0.006 * Math.cos(c.id * 2.4), lon: at[1] + 0.006 * Math.sin(c.id * 2.4) }];
    }),
    alerts: raw.alerts.map((a) => ({ ...a, mock: a.kind === 'mock' })),
    subscribers: raw.subscribers,
  };
}

export type DashboardState = ReturnType<typeof buildState>;
