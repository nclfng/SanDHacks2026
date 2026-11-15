// find_sites (owner: M2). Given where a caller is, return the best 1-2 cooling spaces that are open NOW.
//
//   location  -> resolveLocation(): lat/lon, 5-digit ZIP, town name, or address (ZIP/town resolve instantly offline)
//   catalog   -> Neon `sites` over its HTTP SQL endpoint (no extra dependency); falls back to the seed files when the
//                database is unreachable or empty, so the voice line never depends on the network to answer
//   filter    -> fresh (SITE_MAX_AGE_HOURS), open now incl. holiday exceptions, enough time left to get there, accessible
//   rank      -> travel time + penalties for low trust (docs/PROJECT.md formula); returns at most 2
//   speak     -> spoken_summary honors the tier rules: official vs discovered, "call ahead", disagreeing hours
// Writes nothing. The caller logs the `calls` row. No crawling happens here: this is a read.
import type { FindSitesInput, FindSitesOutput, SiteHours, SiteResult } from '../../../../data/schema/types';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { liveCheckMany, type LiveCheck } from './live-check';

const TZ = 'America/Los_Angeles';
// 30 days by default so the demo never goes silent on stale data; the daily re-crawl keeps hours fresh. Override with SITE_MAX_AGE_HOURS.
const MAX_AGE_H = Number(process.env.SITE_MAX_AGE_HOURS ?? 720);
const DB_URL = (process.env.SITES_DATABASE_URL ?? process.env.NEON_DATABASE_URL ?? '').replace(/^"|"$/g, '');
const CATALOG_TTL_MS = 60_000;

type Pt = { lat: number; lon: number };
interface Row {
  id: number; name: string; kind: SiteResult['kind']; tier: SiteResult['tier']; confidence: number | null;
  address: string; zip: string | null; lat: number; lon: number; hours: SiteHours;
  hours_confirmed_on_source: boolean; has_ac: boolean | null; has_filtration: boolean | null; capacity_est: number | null;
  phone: string | null; last_verified_at: string;
  access_level: string; verification: string; ac_source: string | null; has_fee: boolean | null; category: string | null;
  source_url: string | null; evidence: string | null; external_key: string | null;
}

// ---------------------------------------------------------------- North Pole test fixture (OFF unless asked for)
// Everything is closed at night while we work on this, so a 24/7 fake site sits at Santa Claus House in North Pole, Alaska.
// Off by default: rows whose external_key starts with 'test:' are dropped everywhere, so nobody in San Diego County can be
// sent to it. Run with FIND_SITES_TEST_NORTH_POLE=1 and a caller who says "North Pole" is placed there and sees only it.
// Seed or remove the row in Neon with ingest/north-pole-test.ts.
const TEST_KEY_PREFIX = 'test:';
const testMode = (): boolean => process.env.FIND_SITES_TEST_NORTH_POLE === '1';
const isTestSite = (r: Row): boolean => r.external_key?.startsWith(TEST_KEY_PREFIX) === true;
const NORTH_POLE_AK: Pt = { lat: 64.7511, lon: -147.3494 }; // the middle of North Pole, Alaska
const NORTH_POLE_ASK = /\bnorth pole\b|\bsanta claus house\b/i;
const nearNorthPole = (p: Pt): boolean => km(p, NORTH_POLE_AK) < 50;

// ---------------------------------------------------------------- catalog (Neon first, seed as the safety net)

async function readSeed(file: string): Promise<unknown | null> {
  const dirs = [process.env.SITES_SEED_DIR, resolve(process.cwd(), 'data/seed'), resolve(process.cwd(), '../../data/seed'), resolve(process.cwd(), '../data/seed')];
  for (const d of dirs) {
    if (!d) continue;
    try { return JSON.parse(await readFile(resolve(d, file), 'utf8')); } catch { /* try next */ }
  }
  return null;
}

// One SQL read over Neon's HTTP endpoint (no driver dependency). Returns null on any failure so callers fall back to the seed files.
async function sqlRows(query: string, timeoutMs: number): Promise<Record<string, unknown>[] | null> {
  if (!DB_URL) return null;
  try {
    const host = new URL(DB_URL).hostname;
    const res = await fetch(`https://${host}/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': DB_URL },
      body: JSON.stringify({ query, params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { rows?: Record<string, unknown>[] };
    return j.rows && j.rows.length ? j.rows : null; // empty table -> treated as missing
  } catch { return null; }
}

async function neonRows(): Promise<Row[] | null> {
  // 5 s: a deployed server waking from sleep can take longer than 2 s for this first ~1 MB read.
  const rows = await sqlRows('select * from sites', 5000);
  return rows ? rows.map(normalize) : null;
}

function normalize(r: Record<string, unknown>): Row {
  const hours = typeof r.hours === 'string' ? (JSON.parse(r.hours) as SiteHours) : (r.hours as SiteHours);
  return {
    id: Number(r.id), name: String(r.name), kind: r.kind as Row['kind'], tier: r.tier as Row['tier'],
    confidence: r.confidence == null ? null : Number(r.confidence),
    address: String(r.address), zip: r.zip == null ? null : String(r.zip), lat: Number(r.lat), lon: Number(r.lon), hours,
    hours_confirmed_on_source: Boolean(r.hours_confirmed_on_source),
    has_ac: r.has_ac == null ? null : Boolean(r.has_ac), has_filtration: r.has_filtration == null ? null : Boolean(r.has_filtration),
    capacity_est: r.capacity_est == null ? null : Number(r.capacity_est), phone: r.phone == null ? null : String(r.phone),
    last_verified_at: String(r.last_verified_at),
    access_level: r.access_level == null ? 'unknown' : String(r.access_level),
    verification: r.verification == null ? 'single_source' : String(r.verification),
    ac_source: r.ac_source == null ? null : String(r.ac_source),
    has_fee: r.has_fee == null ? null : Boolean(r.has_fee),
    category: r.category == null ? null : String(r.category),
    source_url: r.source_url == null ? null : String(r.source_url),
    evidence: r.evidence == null ? null : String(r.evidence),
    external_key: r.external_key == null ? null : String(r.external_key),
  };
}

async function seedRows(): Promise<Row[]> {
  const sites = (await readSeed('sites.json')) as Record<string, unknown>[] | null;
  const extras = ((await readSeed('sites.extras.json')) ?? {}) as Record<string, Record<string, unknown>>;
  return (sites ?? []).map((s) => {
    const x = extras[String(s.id)] ?? {};
    return normalize({ ...s, access_level: x.access_level, verification: x.verification, ac_source: x.ac_from, has_fee: x.has_fee, category: x.category, evidence: x.evidence });
  });
}

let cache: { at: number; rows: Row[]; source: 'neon' | 'seed' } | null = null;
async function catalog(): Promise<{ rows: Row[]; source: 'neon' | 'seed' }> {
  if (cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache;
  const db = await neonRows();
  if (db) {
    cache = { at: Date.now(), rows: db, source: 'neon' };
    return cache;
  }
  // Neon missed: keep serving the last good catalog rather than falling back. The seed files are not in the deployed
  // bundle, so the fallback there is empty; never cache an empty fallback, so the next call tries Neon again.
  if (cache?.source === 'neon') return cache;
  const seed = await seedRows();
  if (seed.length) cache = { at: Date.now(), rows: seed, source: 'seed' };
  return { rows: seed, source: 'seed' };
}

// ---------------------------------------------------------------- where is the caller?

interface Places { zips: Record<string, Pt>; places: Record<string, Pt> }
let placesCache: Places | null = null;
async function places(): Promise<Places> {
  if (placesCache) return placesCache;
  const rows = await sqlRows('select kind, key, lat, lon from places', 3000);
  if (rows) {
    const out: Places = { zips: {}, places: {} };
    for (const r of rows) (r.kind === 'zip' ? out.zips : out.places)[String(r.key)] = { lat: Number(r.lat), lon: Number(r.lon) };
    return (placesCache = out);
  }
  // Not cached when Neon missed: the seed file is absent when deployed, and caching that would break zip and town
  // lookups until the server restarts.
  return ((await readSeed('places.json')) as Places | null) ?? { zips: {}, places: {} };
}

const km = (a: Pt, b: Pt): number => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const inCounty = (p: Pt) => p.lat >= 32.5 && p.lat <= 33.52 && p.lon >= -117.62 && p.lon <= -116.07;

const geoCache = new Map<string, Pt | null>();
async function geocode(text: string): Promise<Pt | null> {
  const key = text.toLowerCase().trim();
  if (geoCache.has(key)) return geoCache.get(key) ?? null;
  let out: Pt | null = null;
  try {
    if (/\d{2,5}\s+\w+/.test(text)) { // street address: Census geocoder
      const q = /\bCA\b|California/i.test(text) ? text : `${text}, San Diego County, CA`;
      const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`, { signal: AbortSignal.timeout(2000) });
      const m = ((await r.json()) as { result?: { addressMatches?: { coordinates: { x: number; y: number } }[] } }).result?.addressMatches?.[0];
      if (m) out = { lat: m.coordinates.y, lon: m.coordinates.x };
    }
    // Town, landmark, intersection: OpenStreetMap. Prefer a San Diego County match; if there is none, take the plain
    // result so a caller outside the county is told so instead of "I can't tell where you are".
    for (const q of out ? [] : [`${text}, San Diego County, California`, text]) {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'shade-find-sites/1.0' }, signal: AbortSignal.timeout(2000) });
      const j = (await r.json()) as { lat: string; lon: string }[];
      if (j[0]) { out = { lat: Number(j[0].lat), lon: Number(j[0].lon) }; break; }
    }
  } catch { return null; } // do not cache a transient failure
  geoCache.set(key, out);
  return out;
}

// ---- Google Geocoding (only when GOOGLE_MAPS_API_KEY is set): addresses and cross streets ("Main St & Magnolia Ave"),
// which neither Census (full addresses only) nor the landmark index can place. Returns how precise the match was.
type Precision = NonNullable<FindSitesOutput['location_precision']>;
const GOOGLE_PRECISION: [string, Precision][] = [
  ['street_address', 'address'], ['premise', 'address'], ['subpremise', 'address'], ['intersection', 'intersection'],
  ['point_of_interest', 'landmark'], ['establishment', 'landmark'], ['transit_station', 'landmark'], ['route', 'street'],
  ['neighborhood', 'area'], ['sublocality', 'area'], ['locality', 'area'], ['postal_code', 'zip'],
];
interface GoogleHit { pt: Pt; label: string; precision: Precision; zip: string | null }
const googleCache = new Map<string, GoogleHit | null>();
async function googleGeocode(text: string): Promise<GoogleHit | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey || !text.trim()) return null;
  const k = text.toLowerCase().trim();
  if (googleCache.has(k)) return googleCache.get(k) ?? null;
  try {
    const q = new URLSearchParams({
      address: text, key: apiKey, region: 'us',
      components: 'country:US|administrative_area:CA',
      bounds: '32.5,-117.62|33.52,-116.07', // bias toward San Diego County
    });
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${q}`, { signal: AbortSignal.timeout(2500) });
    const j = (await r.json()) as { status: string; results?: { types: string[]; formatted_address: string; geometry: { location: { lat: number; lng: number } }; address_components: { types: string[]; short_name: string }[] }[] };
    const top = j.results?.[0];
    let hit: GoogleHit | null = null;
    const precision = top && GOOGLE_PRECISION.find(([t]) => top.types.includes(t))?.[1];
    if (top && precision) {
      const pt = { lat: top.geometry.location.lat, lon: top.geometry.location.lng };
      const zip = top.address_components.find((c) => c.types.includes('postal_code'))?.short_name ?? null;
      if (inCounty(pt)) hit = { pt, label: top.formatted_address.replace(/, USA$/, ''), precision, zip };
    }
    if (j.status === 'OK' || j.status === 'ZERO_RESULTS') googleCache.set(k, hit); // do not cache quota/transient errors
    return hit;
  } catch { return null; }
}
const PRECISE = new Set<Precision>(['address', 'intersection', 'landmark']);
const CROSS_STREETS = /&|\band\b|\bcorner\b/i;

// ---- landmarks: "I'm in Geisel Library", "outside the Price Center", "at Westfield UTC" ----------------------------
// data/seed/landmarks.json holds ~5,000 named places (OpenStreetMap + every site we hold). A caller's words are matched
// by token RARITY, so "Geisel" counts for far more than "library", and nobody has to give a ZIP or a city.
interface Landmark { name: string; lat: number; lon: number; kind: string; weight: number; tokens: string[] }
let lmIndex: { items: Landmark[]; df: Map<string, number> } | null | undefined;
const STOP = new Set(['the', 'a', 'an', 'at', 'in', 'on', 'of', 'near', 'by', 'to', 'my', 'im', 'i', 'am', 'is', 'its', 'it', 'so', 'very', 'really', 'hot', 'here', 'where', 'can', 'go', 'right', 'now', 'please', 'help', 'need', 'looking', 'for', 'around', 'next', 'outside', 'inside', 'front', 'nearby', 'close', 'and', 'or', 'with', 'no', 'car', 'currently', 'standing', 'sitting', 'walking', 'stuck', 'somewhere', 'cool', 'place', 'ucsd', 'uc', 'campus', 'university', 'california', 'ca']);
const GENERIC = new Set(['san', 'diego', 'county', 'la', 'jolla', 'city']);                  // geography words that never identify a place on their own
const toTokens = (t: string): string[] => t.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)); // drops "i'm" -> "m" and "it's" -> "s" fragments

async function landmarks() {
  if (lmIndex !== undefined) return lmIndex;
  const rows = await sqlRows('select name, lat, lon, kind, weight from landmarks', 6000);
  const raw: [string, number, number, string, number][] | null = rows
    ? rows.map((r) => [String(r.name), Number(r.lat), Number(r.lon), String(r.kind), Number(r.weight)])
    : ((await readSeed('landmarks.json')) as [string, number, number, string, number][] | null);
  if (!raw) return null; // not cached: try Neon again on the next call
  const df = new Map<string, number>();
  const items: Landmark[] = raw.map(([name, lat, lon, kind, weight]) => {
    const tokens = [...new Set(toTokens(name))];
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
    return { name, lat, lon, kind, weight, tokens };
  }).filter((l) => l.tokens.length);
  return (lmIndex = { items, df });
}

async function matchLandmark(text: string): Promise<{ pt: Pt; name: string } | null> {
  const idx = await landmarks();
  if (!idx) return null;
  const words = new Set(toTokens(text));
  if (!words.size) return null;
  const lower = text.toLowerCase();
  const onCampus = /\b(ucsd|uc san diego|campus|geisel|price center)\b/.test(lower);
  const inLaJolla = /\bla jolla\b/.test(lower);
  const idf = (t: string) => Math.log(1 + idx.items.length / (idx.df.get(t) ?? 1));
  let best: { l: Landmark; score: number } | null = null;
  for (const l of idx.items) {
    let have = 0, total = 0, distinctive = false, rare = false, matched = 0;
    for (const t of l.tokens) {
      const w = idf(t), d = idx.df.get(t) ?? 99;
      total += w;
      if (words.has(t)) { have += w; matched++; if (!GENERIC.has(t)) distinctive = true; if (d <= 8) rare = true; }
    }
    if (!have || !distinctive) continue;                           // "san diego" alone never identifies a place
    const cov = have / total;
    if (!(cov >= 0.999 || (rare && cov >= 0.3 && matched / words.size > 0.5))) continue; // all of its words, or its distinctive word covering most of what was said
    let score = cov * 10 + have * 0.4 + (matched / words.size) * 4 + l.weight * 0.6; // fuller match, more of what they said, our own sites win
    if (onCampus && l.lat > 32.835 && l.lat < 32.905 && l.lon > -117.3 && l.lon < -117.195) score += 3;
    if (inLaJolla && l.lat > 32.82 && l.lat < 32.91 && l.lon > -117.30 && l.lon < -117.17) score += 2;
    if (!best || score > best.score) best = { l, score };
  }
  return best ? { pt: { lat: best.l.lat, lon: best.l.lon }, name: best.l.name } : null;
}

const STREET_ADDRESS = /\b\d{2,5}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.' ]{2,28}\b(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|parkway|cir|circle|ter|terrace)\b/i;

interface Resolved { pt: Pt; zip: string | null; byZip?: boolean; place?: string; label: string; precision: Precision }

export async function resolveLocation(input: FindSitesInput): Promise<Resolved | null> {
  const p = await places();
  const nearestZip = (pt: Pt): string | null => {
    let best: string | null = null, d = 15; // km
    for (const [z, c] of Object.entries(p.zips)) { const k = km(pt, c); if (k < d) { d = k; best = z; } }
    return best;
  };
  const text = input.location ?? '';
  if (testMode() && NORTH_POLE_ASK.test(text)) return { pt: NORTH_POLE_AK, zip: '99705', label: 'North Pole, Alaska (test)', precision: 'landmark' };
  if (typeof input.lat === 'number' && typeof input.lon === 'number') { const pt = { lat: input.lat, lon: input.lon }; return { pt, zip: nearestZip(pt), label: text, precision: 'address' }; }

  // 1. a street address or cross streets is the most precise thing a caller can say. Google first (handles both),
  //    accepted only if it found that precise a spot; then Census for plain addresses.
  const isAddress = STREET_ADDRESS.test(text);
  if (isAddress || CROSS_STREETS.test(text)) {
    const gg = await googleGeocode(text);
    if (gg && PRECISE.has(gg.precision) && gg.precision !== 'landmark') return { pt: gg.pt, zip: gg.zip ?? nearestZip(gg.pt), label: gg.label, precision: gg.precision };
  }
  if (isAddress) { const g = await geocode(text); if (g) return { pt: g, zip: nearestZip(g), label: text, precision: 'address' }; }
  // 2. a named place ("Geisel Library", "Price Center", "Westfield UTC"): instant, offline, no ZIP or city needed
  const lm = await matchLandmark(text);
  if (lm) return { pt: lm.pt, zip: nearestZip(lm.pt), place: lm.name, label: lm.name, precision: 'landmark' };
  // 3. a ZIP code
  const zip = text.match(/\b(9[12]\d{3})\b/)?.[1];
  if (zip && p.zips[zip]) return { pt: p.zips[zip], zip, byZip: true, label: zip, precision: 'zip' };
  // 4. a town or neighborhood
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ')} `;
  const hit = Object.keys(p.places).filter((n) => lower.includes(` ${n} `)).sort((a, b) => b.length - a.length)[0];
  if (hit) return { pt: p.places[hit], zip: nearestZip(p.places[hit]), label: hit.replace(/\b\w/g, (c) => c.toUpperCase()), precision: 'area' };
  // 5. anything else: ask an online geocoder (slow, so last). Google says how precise it was; OpenStreetMap doesn't, so
  //    treat its answer as approximate (the agent then won't quote distances).
  const withCampus = /\b(ucsd|uc san diego)\b/i.test(text) ? `${text} La Jolla` : text;
  const gg = await googleGeocode(withCampus);
  if (gg) return { pt: gg.pt, zip: gg.zip ?? nearestZip(gg.pt), label: gg.label, precision: gg.precision };
  const g = text.trim() ? (await geocode(withCampus)) ?? (await geocode(toTokens(withCampus).join(' '))) : null; // raw words first, then without the filler
  return g ? { pt: g, zip: nearestZip(g), label: text, precision: 'area' } : null;
}

// ---------------------------------------------------------------- is it open, and for how long?

function localNow(now: Date): { dow: number; date: string; min: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dow, date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number): string => { const x = m % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

// "Open 24 hours" in minutes: 00:00-23:59 as stored, or 00:00-00:00 read as [0, 1440].
const allDay = ([o, c]: [number, number]): boolean => o === 0 && c >= 1439;

interface Status { open: boolean; closesMin: number | null; nextOpenMin: number | null; intervals: [number, number][]; note: string | null }
function status(h: SiteHours, now: { dow: number; date: string; min: number }, ignoreAllDay = false): Status {
  // Minutes since midnight. An interval whose close is at or before its open runs PAST midnight ("7 AM - 2 AM"); a close of
  // 00:00 means midnight (1440). Such intervals can exceed 1440, and yesterday's late-night tail counts from 00:00 today.
  const day = (d: number) => h.weekly.filter((i) => i.day === d).map((i) => [toMin(i.open), toMin(i.close)] as [number, number]);
  let intervals: [number, number][] = [];
  for (const [o, c] of day(now.dow)) intervals.push(c > o ? [o, c] : c === 0 ? [o, 1440] : [o, 1440 + c]);
  for (const [o, c] of day((now.dow + 6) % 7)) if (c <= o && c > 0) intervals.push([0, c]); // still open after midnight from last night
  // Google's "open 24 hours" (00:00-23:59) on a place we only know from Maps is almost always wrong for a building: ignore it there.
  if (ignoreAllDay) intervals = intervals.filter((i) => !allDay(i));
  const ex = h.exceptions?.find((e) => e.date === now.date);
  let note: string | null = null;
  if (ex?.closed) { intervals = []; note = ex.note ? `closed today for ${ex.note}` : 'closed today'; }
  else if (ex?.close) { const cap = toMin(ex.close); intervals = intervals.map(([o, c]) => [o, Math.min(c, cap)] as [number, number]).filter(([o, c]) => c > o); note = ex.note ?? 'closing early today'; }
  const cur = intervals.find(([o, c]) => now.min >= o && now.min < c);
  const later = intervals.filter(([o]) => o > now.min).sort((a, b) => a[0] - b[0])[0];
  return { open: !!cur, closesMin: cur ? cur[1] : null, nextOpenMin: later ? later[0] : null, intervals, note };
}

// ---------------------------------------------------------------- words a person can hear

const ABBR: [RegExp, string][] = [[/\bAve\b\.?/gi, 'Avenue'], [/\bBlvd\b\.?/gi, 'Boulevard'], [/\bSt\b\.?(?!\s*[A-Z][a-z]+'?s)/g, 'Street'], [/\bDr\b\.?/gi, 'Drive'], [/\bRd\b\.?/gi, 'Road'], [/\bLn\b\.?/gi, 'Lane'], [/\bCt\b\.?/gi, 'Court'], [/\bPl\b\.?/gi, 'Place'], [/\bHwy\b\.?/gi, 'Highway'], [/\bE\b\.?(?=\s)/g, 'East'], [/\bW\b\.?(?=\s)/g, 'West'], [/\bN\b\.?(?=\s)/g, 'North'], [/\bS\b\.?(?=\s)/g, 'South']];
function speakAddress(addr: string): string {
  const clean = addr.replace(/,?\s*CA\s*9\d{4}(-\d{4})?\s*$/i, '').replace(/\b(?!(?:NE|NW|SE|SW)\b)[A-Z]{4,}\b/g, '').replace(/\s{2,}/g, ' ').trim(); // drop state/zip and stray ALL-CAPS junk ("PARKING")
  const [street, city] = clean.split(',').map((s) => s.trim());
  let s = ABBR.reduce((t, [re, w]) => t.replace(re, w), street ?? clean);
  s = s.replace(/\b(\d{3,5})\b/, (n) => n.split('').join(' ')); // "201" -> "2 0 1" so it is read digit by digit
  return city && !/^\d/.test(city) ? `${s} in ${city}` : s;
}
function speakTime(min: number, relativeTo: number): string {
  if (min >= 23 * 60 + 55 && min <= 1440) return 'midnight';
  if (min > 1440) { const m = min - 1440, h12 = Math.floor(m / 60) % 12 || 12; return `${h12}${m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''} in the morning`; }
  const h24 = Math.floor(min / 60), m = min % 60, h12 = h24 % 12 || 12;
  const t = m ? `${h12} ${String(m).padStart(2, '0')}` : `${h12}`;
  const part = h24 >= 17 ? (relativeTo >= 17 * 60 ? 'tonight' : 'this evening') : h24 >= 12 ? 'this afternoon' : 'this morning';
  return `${t} ${part}`;
}
const clock = (min: number): string => { const x = min % 1440, h24 = Math.floor(x / 60), m = x % 60; return `${h24 % 12 || 12}:${String(m).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`; };

// ---------------------------------------------------------------- evidence a caller can hear or read

const isCheckable = (u: string | null): boolean => !!u && /^https?:/.test(u) && !/google\.[a-z.]+\/maps|maps\.app\.goo/i.test(u);
const shortDate = (iso: string): string => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(iso));
// "the county's Cool Zone list" for the official program, otherwise the site's own host ("sdcl.org").
function sourceLabel(r: Row): string | null {
  if (r.ac_source === 'official_program') return "the county's Cool Zone list";
  if (!isCheckable(r.source_url)) return null;
  try { return `the page at ${new URL(r.source_url!).hostname.replace(/^www\./, '')}`; } catch { return null; }
}

// ---------------------------------------------------------------- the tool

const NOT_ALLOWED = new Set(['students_only', 'members_only', 'residents_only', 'age_restricted']);
// Cafes are free to sit in but staff may expect a purchase: allowed, ranked behind free public spaces, and worded honestly.
const isCafe = (r: Row): boolean => /\b(cafe|café|coffee|espresso|tea house|bakery)\b/i.test(r.category ?? '');

// Overall deadline so a slow geocoder or database never leaves a caller in silence (the voice tool budget is 10 s).
// On timeout the caller gets a spoken fallback that asks for a ZIP code, which resolves instantly from the gazetteer.
const DEADLINE_MS = Number(process.env.FIND_SITES_DEADLINE_MS ?? 7000);
export async function findSites(input: FindSitesInput): Promise<FindSitesOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<FindSitesOutput>((done) => {
    timer = setTimeout(() => done({ sites: [], resolved_zip: null, fallback_message: "I'm taking too long to look that up. Could you give me your zip code or the nearest cross streets? If it's an emergency, call 9 1 1, and 2 1 1 can help find a cooling space." }), DEADLINE_MS);
  });
  try { return await Promise.race([findSitesCore(input), slow]); } finally { clearTimeout(timer); }
}

async function findSitesCore(input: FindSitesInput): Promise<FindSitesOutput> {
  const catalogReady = catalog(); // read the database while the caller's location is being resolved (voice tool budget is 10 s)
  const loc = await resolveLocation(input);
  if (!loc) return { sites: [], resolved_zip: null, fallback_message: "I couldn't tell where you are. Could you give me your zip code or the nearest cross streets?" };
  const testZone = testMode() && nearNorthPole(loc.pt);
  if (!testZone && !inCounty(loc.pt)) return { sites: [], resolved_zip: loc.zip, fallback_message: "I can only look up cooling spaces in San Diego County. For help anywhere else, call 2 1 1." };

  const now = input.now ? new Date(input.now) : new Date();
  const lt = localNow(now);
  const noCar = input.needs?.has_car === false || input.needs?.mobility_issues === true;
  const maxTravel = input.needs?.max_travel_minutes ?? (noCar ? 45 : 40);
  const { rows } = await catalogReady;
  if (loc.byZip) {
    const inZip = rows.filter((r) => r.zip === loc.zip);
    if (inZip.length) loc.pt = { lat: inZip.reduce((a, r) => a + r.lat, 0) / inZip.length, lon: inZip.reduce((a, r) => a + r.lon, 0) / inZip.length };
  }

  const cands: { r: Row; miles: number; travel: number; st: Status; score: number; mode: 'car' | 'walk' | 'transit' }[] = [];
  const later: { r: Row; miles: number; st: Status }[] = [];
  for (const r of rows) {
    if (isTestSite(r) !== testZone) continue;                                            // hard filter: test callers see only the test site, everyone else never sees it
    if (now.getTime() - Date.parse(r.last_verified_at) > MAX_AGE_H * 3600_000) continue; // stale: never present as open
    if (NOT_ALLOWED.has(r.access_level)) continue;                                       // students / members / residents / age-restricted
    if (r.has_fee === true) continue;                                                    // free public spaces only
    if (r.tier === 'discovered') {
      if (r.kind === 'other' && r.has_ac !== true && !isCafe(r)) continue;               // parks, attractions: not known to be cool (cafes are allowed)
      if (/\b(museum|zoo|aquarium|gallery|theat(?:er|re)|cinema)\b/i.test(r.name)) continue; // usually paid admission
      const allDay = r.hours.weekly.length >= 5 && r.hours.weekly.every((i) => i.open === '00:00' && i.close >= '23:59');
      if (allDay && r.verification !== 'confirmed') continue;                            // Maps "open 24 hours" is almost always an outdoor place
    }
    const miles = km(loc.pt, r) * 0.621371 * 1.3;                                        // straight line x road factor
    const mode: 'car' | 'walk' | 'transit' = !noCar ? 'car' : miles <= 1 ? 'walk' : 'transit';
    const travel = Math.round(mode === 'car' ? 3 + (miles / 22) * 60 : mode === 'walk' ? miles * 20 : 10 + (miles / 12) * 60);
    if (travel > maxTravel) continue;
    const st = status(r.hours, lt, r.tier === 'discovered' && r.verification !== 'confirmed');
    if (!st.open) { if (st.nextOpenMin !== null) later.push({ r, miles, st }); continue; }
    if (st.closesMin! - lt.min < travel + 10) continue;                                  // would close before or just after arrival
    const trust = r.tier === 'discovered' ? 20 * (1 - (r.confidence ?? 0.5)) : 0;       // low-trust penalty (docs/PROJECT.md)
    const score = travel + trust + (r.verification === 'conflict' ? 10 : 0) - (r.hours_confirmed_on_source ? 2 : 0) + (isCafe(r) ? 8 : 0); // free public spaces first
    cands.push({ r, miles, travel, st, score, mode });
  }
  cands.sort((a, b) => a.score - b.score);

  // Live path: Bright Data fetches the hours page of the best candidates we have NOT confirmed on their own page, under one
  // hard cap (LIVE_CHECK_MS, default 3 s). A same-day closure drops the site; a timeout or block keeps the stored data.
  const liveByUrl = new Map<string, LiveCheck>();
  if (process.env.LIVE_CHECK !== '0') {
    const toCheck = cands.slice(0, 5).filter((c) => !c.r.hours_confirmed_on_source && isCheckable(c.r.source_url));
    for (const [u, v] of await liveCheckMany(toCheck.map((c) => c.r.source_url!), lt.date)) liveByUrl.set(u, v);
    for (let i = cands.length - 1; i >= 0; i--) {
      const v = cands[i].r.source_url ? liveByUrl.get(cands[i].r.source_url!) : undefined;
      if (v?.status === 'closed') cands.splice(i, 1);
    }
  }

  const picked: typeof cands = [];
  const seen = new Set<string>();
  for (const c of cands) {                                                                // top 2, no duplicate places
    const key = c.r.address.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (seen.has(key)) continue;
    if (isCafe(c.r) && picked.some((p) => isCafe(p.r))) continue;                         // never offer two cafes
    seen.add(key); picked.push(c);
    if (picked.length === 2) break;
  }

  if (!picked.length) {
    const soon = later.map((l) => ({ ...l, d: l.miles })).sort((a, b) => a.d - b.d)[0];
    return {
      sites: [], resolved_zip: loc.zip,
      fallback_message: soon
        ? `Nothing near you is open right now. The closest, ${soon.r.name}, opens at ${clock(soon.st.nextOpenMin!)} today. You can also call 2 1 1 for help finding a cool place.`
        : 'I could not find a cooling space near you that is open right now. Please call 2 1 1 and they can help find one. If anyone feels faint, confused, or very ill from the heat, call 9 1 1.',
    };
  }

  const sites: SiteResult[] = picked.map((c, i) => {
    const { r, st } = c;
    const closes = st.closesMin!;
    const coolZone = r.ac_source === 'official_program';
    const callAhead = r.tier === 'discovered' || r.verification === 'conflict';
    const until = st.intervals.some(allDay) && closes >= 1439 ? 'open 24 hours' : `open until ${speakTime(closes, lt.min)}`;
    const nm = r.name === r.name.toUpperCase() ? r.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : r.name; // read ALL-CAPS names naturally
    const here = c.miles < 0.06;                                                         // the caller is standing at this very place
    const lead = i === 0 ? (loc.place && !here ? `From ${loc.place}, the closest option is` : 'The closest option is') : 'Another option is';
    let said: string;
    if (here && i === 0) {
      said = `You're right at ${nm}, and it's ${until}.${r.has_ac ? ' It should be air conditioned.' : ''}${isCafe(r) ? ' It is a café, so they may expect you to buy something.' : ''}`;
    } else if (r.tier === 'official') {
      said = `${lead} ${nm} at ${speakAddress(r.address)}. ${coolZone ? 'It is an official county Cool Zone' : 'It is an official city or county facility'}, ${until}.`;
    } else if (isCafe(r)) {
      said = `${lead} ${nm}, a café at ${speakAddress(r.address)}. They may expect you to buy something. It's not an official cooling center, but it should be ${until}. You may want to call ahead.`;
    } else {
      said = `${lead} ${nm} at ${speakAddress(r.address)}. It's not an official cooling center, but it should be ${r.has_ac ? 'air conditioned and ' : ''}${until}. You may want to call ahead.`;
    }
    if (r.verification === 'conflict') said += ' The hours listed for it differ between sources, so please call ahead.';
    if (st.note) said += ` Note: it is ${st.note}.`;
    if (c.mode === 'transit') said += ' If you do not have a ride, 2 1 1 can help arrange free transportation to a cooling space.';
    const q = encodeURIComponent(`${r.name} ${r.address}`);
    const live = r.source_url ? liveByUrl.get(r.source_url) : undefined;
    const liveOk = live?.status === 'open_ok';
    const verifiedAt = liveOk ? live!.checked_at : r.last_verified_at;
    const label = sourceLabel(r);
    if (label) said += liveOk ? ` I just checked ${label} and it shows no closure notice. Hours were last verified ${shortDate(r.last_verified_at)}.` : ` Hours verified ${shortDate(r.last_verified_at)} from ${label}.`;
    return {
      site_id: r.id, name: r.name, kind: r.kind, tier: r.tier, address: r.address,
      open_now: true, closes_at: hhmm(closes),
      hours_today: st.intervals.map((i) => (allDay(i) ? 'Open 24 hours' : `${clock(i[0])} - ${clock(i[1])}`)).join(', '),
      travel_minutes: c.travel, distance_miles: Math.round(c.miles * 10) / 10,
      aqi: null, // AirNow is not wired yet; the contract allows null
      has_filtration: r.has_filtration, confidence: r.confidence, call_ahead: callAhead,
      map_url: `https://www.google.com/maps/search/?api=1&query=${q}`,
      spoken_summary: said,
      evidence: r.evidence, source_url: r.source_url, source_label: label, hours_verified_at: verifiedAt, live_checked: liveOk,
    };
  });
  return { sites, resolved_zip: loc.zip, resolved_location: loc.label, location_precision: loc.precision, ...(loc.place ? { resolved_place: loc.place } : {}) };
}

// Load the catalog, places and landmark index in the background when the server starts, so the first call is already fast.
export function warmFindSites(): void {
  void catalog().catch(() => undefined);
  void places().catch(() => undefined);
  void landmarks().catch(() => undefined);
}
warmFindSites();
