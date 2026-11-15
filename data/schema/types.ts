// Shared TypeScript types. Mirrors schema.sql and contracts.md.
// Import these; don't redefine them locally.

export type SiteKind =
  | 'cool_zone' | 'library' | 'rec_center' | 'community_center'
  | 'senior_center' | 'mall' | 'other';
export type SiteTier = 'official' | 'discovered';
export type SiteAccess = 'open_to_all' | 'students_only' | 'members_only' | 'residents_only' | 'age_restricted' | 'unknown';
export type SiteVerification = 'confirmed' | 'conflict' | 'single_source' | 'web_only';
export type Language = 'en' | 'es' | 'tl' | 'vi' | 'zh';
/** messenger: Facebook Messenger through Twilio (M4). whatsapp: WhatsApp through Twilio (M4). */
export type Channel = 'voice' | 'sms' | 'messenger' | 'whatsapp';
/** subscribers.alert_channel: where a subscriber's alerts go. null in the database means 'sms'. */
export type AlertChannel = 'sms' | 'whatsapp' | 'messenger';
export type CallDirection = 'inbound' | 'outbound';
export type CallOutcome =
  | 'site_given' | 'sms_sent' | 'no_site_found' | 'escalated_911' | 'abandoned' | 'error';
/** high_heat_index / high_aqi: raised by M4 from readings crossing a threshold (not NWS). */
export type AlertKind =
  | 'extreme_heat_warning' | 'heat_advisory' | 'air_quality_alert' | 'mock' | 'high_heat_index' | 'high_aqi';

/** Times are 24h "HH:MM" in America/Los_Angeles. day: 0 = Sunday ... 6 = Saturday. */
export interface HoursInterval { day: number; open: string; close: string }
export interface HoursException {
  date: string;              // "YYYY-MM-DD", local date
  closed?: boolean;
  open?: string;
  close?: string;
  note?: string;
}
export interface SiteHours {
  weekly: HoursInterval[];   // multiple intervals per day allowed
  exceptions?: HoursException[];
  raw_text?: string;         // original text the hours were parsed from, for debugging
}

export interface Site {
  id: number;
  name: string;
  kind: SiteKind;
  tier: SiteTier;
  confidence: number | null;
  address: string;
  zip: string | null;
  lat: number;
  lon: number;
  hours: SiteHours;
  hours_confirmed_on_source: boolean;
  has_ac: boolean | null;
  has_filtration: boolean | null;
  capacity_est: number | null;
  phone: string | null;
  source_url: string;
  last_verified_at: string;  // ISO 8601
  // M2 provenance and access (additive; present on rows from the database)
  access_level?: SiteAccess;
  access_notes?: string | null;
  requires_id?: boolean | null;
  has_fee?: boolean | null;
  verification?: SiteVerification;
  conflicts?: string[];
  evidence?: string | null;
  source_urls?: string[];
  maps_place_id?: string | null;
  external_key?: string | null;
  pet_policy?: string | null;
  official_name?: string | null;
  ac_source?: 'official_program' | 'site_page' | 'reviews' | null;
  category?: string | null;
}

export interface ZipGap {
  zip: string; name: string | null; population: number; age65plus: number; households_no_vehicle: number; below_poverty: number;
  residents_at_risk: number; sites_within_5km: number; official_within_5km: number; nearest_site_km: number | null; nearest_site: string | null;
  forecast_zone: string | null; peak_temp_f: number | null; peak_heat_index: number | null; peak_time: string | null;
  hours_90f_plus_72h: number | null; heat_factor: number; gap_score: number; scenario_heat_index: number | null; generated_at: string;
}

export interface CallerNeeds {
  has_car?: boolean;
  mobility_issues?: boolean;
  needs_clean_air?: boolean;   // smoke event rather than heat
  max_travel_minutes?: number;
}

export interface Reading {
  time: string;
  zip: string;
  temp_f: number | null;
  heat_index: number | null;
  aqi: number | null;
  source: 'airnow' | 'nws' | 'purpleair' | 'mock';
}

// ---- Tool contracts (see contracts.md) ----

export interface FindSitesInput {
  location: string;            // zip, neighborhood, address, or cross streets (free text)
  lat?: number;                // pass if already geocoded
  lon?: number;
  needs?: CallerNeeds;
  language?: Language;
  now?: string;                // ISO; override for demos/tests, default = current time
}

export interface SiteResult {
  site_id: number;
  name: string;
  kind: SiteKind;
  tier: SiteTier;
  address: string;
  open_now: boolean;
  closes_at: string | null;       // "HH:MM" local, today
  hours_today: string;            // human readable, e.g. "9:00 AM - 8:00 PM"
  travel_minutes: number;
  distance_miles: number;
  aqi: number | null;
  has_filtration: boolean | null;
  confidence: number | null;
  call_ahead: boolean;            // true for discovered sites
  map_url: string;
  spoken_summary: string;         // ready-to-read sentence honoring tier honesty rules
  // Evidence the caller can be shown (SMS / Messenger / dashboard). All optional.
  evidence?: string | null;       // verbatim quote from the source page behind the hours
  source_url?: string | null;     // the page the hours came from
  source_label?: string | null;   // human name for the source, e.g. "the county's Cool Zone list"
  hours_verified_at?: string | null; // ISO: live check time if we fetched the page just now, else the last crawl
  live_checked?: boolean;         // true when Bright Data fetched the hours page during this call
}

/** How precisely find_sites placed the caller. */
export type LocationPrecision = 'address' | 'intersection' | 'landmark' | 'street' | 'area' | 'zip';

export interface FindSitesOutput {
  sites: SiteResult[];            // top 2, best first; may be empty
  resolved_zip: string | null;
  resolved_place?: string;        // the landmark we understood, e.g. "Geisel Library"; lets the agent confirm instead of asking for a ZIP
  resolved_location?: string;     // what the location was understood as, e.g. "Main St & Magnolia Ave, El Cajon, CA" or "Geisel Library"
  location_precision?: LocationPrecision;
  fallback_message?: string;      // set when sites is empty (e.g. "call 211")
}

export interface SendSmsInput {
  to: string;                     // E.164
  site_id: number;
  language?: Language;
  party_size?: number;            // people in the caller's group, including the caller
  needs_assistance?: boolean;     // someone in the group needs help (wheelchair, walker, medical need...)
  assistance_details?: string;    // what kind, in the caller's words, e.g. "uses a wheelchair"; only with needs_assistance
}
/**
 * note: what the voice agent should tell the caller about delivery, when it is not a plain text. M4 sets it when the
 * site details are held for the caller's Messenger, or when they have no linked Messenger profile.
 */
export interface SendSmsOutput { ok: boolean; error?: string; note?: string }

// ---- Help requests (M3) ----

export type RequestStatus = 'requesting' | 'incoming' | 'declined' | 'closed';
export type HelpType = 'volunteer_pickup' | 'ride_211' | 'wellness_check';
/** What the dispatcher inbox sees. The callback number never leaves the database. */
export interface HelpRequest {
  id: number;
  status: RequestStatus;
  help_type: HelpType | null;
  said: string;
  location: string;
  zip: string | null;
  lat: number | null;
  lon: number | null;
  needs: string[];
  language: string | null;
  created_at: string;           // ISO 8601
  events: CallEvent[];          // what happened on the call, oldest first
}
/** One step in a call's trail (call_events). Written by apps/api/src/requests/events.ts. */
export type CallEventKind =
  | 'call_started' | 'located' | 'site_suggested' | 'no_site' | 'sms_sent'
  | 'help_requested' | 'help_incoming' | 'declined' | 'closed' | 'call_ended';
export interface CallEvent { at: string; kind: CallEventKind; text: string }
/** `say_this` is chosen in code from the request status. The agent reads it and adds no status claim of its own. */
export interface RequestHelpOutput { ok: boolean; request_id?: number; status?: RequestStatus; say_this: string }
