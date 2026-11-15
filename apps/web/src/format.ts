export { hoursSpan, to12h } from '../../api/src/shared/hours';

export const KIND: Record<string, string> = { cool_zone: 'Cool zone', library: 'Library', rec_center: 'Rec center', community_center: 'Community center', senior_center: 'Senior center', mall: 'Mall', other: 'Public space' };
export const ALERT: Record<string, string> = { extreme_heat_warning: 'Extreme Heat Warning', heat_advisory: 'Heat Advisory', air_quality_alert: 'Air Quality Alert', mock: 'Mock heat alert' };
export const SOURCE: Record<string, string> = { nws: 'NWS', airnow: 'AirNow', purpleair: 'PurpleAir', mock: 'Mock' };
export const LANG: Record<string, string> = { en: 'English', es: 'Spanish', tl: 'Tagalog', vi: 'Vietnamese', zh: 'Chinese' };
export const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const LA = { timeZone: 'America/Los_Angeles' };
export const clockAt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { ...LA, hour: 'numeric', minute: '2-digit' });
export const stamp = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { ...LA, hour: 'numeric', minute: '2-digit', second: '2-digit' });
export const whenAt = (iso: string) => new Date(iso).toLocaleString('en-US', { ...LA, weekday: 'short', hour: 'numeric', minute: '2-digit' });
export const todayIndex = () => DAY.indexOf(new Date().toLocaleDateString('en-US', { ...LA, weekday: 'short' }));
export const deg = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)}°`);

/** Scraped URLs: http(s) only, so a `javascript:` link never reaches an href. */
export const href = (u: string | null | undefined) => (/^https?:\/\//.test(u ?? '') ? u! : undefined);
