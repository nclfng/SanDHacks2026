import type { CallEvent, HelpRequest } from './api';
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

/**
 * Where a caller stands, for the status pill. An open request's status wins: it is the one source for whether help is
 * coming. Before that, the trail only tells "not placed yet" apart from "placed": the agent asks about the caller's
 * condition and location in one stretch before its first find_sites call.
 */
export function stage(events: CallEvent[], status?: HelpRequest['status']): { label: string; pill: string } {
  if (status === 'incoming') return { label: 'Help incoming', pill: 'incoming' };
  if (status === 'requesting') return { label: 'Locating help', pill: 'requesting' };
  const has = (k: CallEvent['kind']) => events.some((e) => e.kind === k);
  if (has('site_suggested') || has('sms_sent')) return { label: 'Suggesting cool zone', pill: 'oncall' };
  if (has('no_site')) return { label: 'Referred to 2-1-1', pill: 'oncall' };
  // A successful locate always logs site_suggested or no_site right after it, so a lone `located` is a failed one.
  if (has('located')) return { label: 'Determining location', pill: 'oncall' };
  return { label: 'Inquiring condition', pill: 'oncall' };
}

/** Scraped URLs: http(s) only, so a `javascript:` link never reaches an href. */
export const href = (u: string | null | undefined) => (/^https?:\/\//.test(u ?? '') ? u! : undefined);
