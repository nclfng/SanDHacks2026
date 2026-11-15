-- Shade: Neon Postgres schema (source of truth).
-- Changes go through a PR that all four members review. See README.md.

create type site_kind as enum (
  'cool_zone', 'library', 'rec_center', 'community_center', 'senior_center', 'mall', 'other'
);
create type site_tier as enum ('official', 'discovered');
create type site_access as enum ('open_to_all', 'students_only', 'members_only', 'residents_only', 'age_restricted', 'unknown');
create type site_verification as enum ('confirmed', 'conflict', 'single_source', 'web_only');
create type call_direction as enum ('inbound', 'outbound');
-- messenger: Facebook Messenger through Twilio (M4). Existing databases: alter type channel add value 'messenger';
-- whatsapp: WhatsApp through Twilio (M4). Existing databases: alter type channel add value 'whatsapp';
create type channel as enum ('voice', 'sms', 'messenger', 'whatsapp');
create type call_outcome as enum (
  'site_given', 'sms_sent', 'no_site_found', 'escalated_911', 'abandoned', 'error'
);
-- high_heat_index / high_aqi: raised by M4 from our own readings crossing a threshold, not by NWS (nws_id null).
create type alert_kind as enum (
  'extreme_heat_warning', 'heat_advisory', 'air_quality_alert', 'mock', 'high_heat_index', 'high_aqi'
);
create type reading_source as enum ('airnow', 'nws', 'purpleair', 'mock');

-- Written by: M2 (ingest). Read by: everyone.
create table sites (
  id               serial primary key,
  name             text not null,
  kind             site_kind not null,
  tier             site_tier not null,
  confidence       real check (confidence between 0 and 1),  -- Gemini extraction confidence; null for official
  address          text not null,
  zip              text,
  lat              double precision not null,
  lon              double precision not null,
  hours            jsonb not null,                           -- see types.ts: SiteHours
  hours_confirmed_on_source boolean not null default false,  -- today's hours found on the site's own page
  has_ac           boolean,                                  -- null = unknown
  has_filtration   boolean,                                  -- null = unknown; true only if a source says so
  capacity_est     int,
  phone            text,
  source_url       text not null,
  last_verified_at timestamptz not null,
  created_at       timestamptz not null default now(),
  -- M2 provenance and access (existing databases: migrations/20261114_m2_sites_provenance.sql)
  access_level     site_access       not null default 'unknown', -- who may enter; find_sites skips students/members/residents/age-restricted
  access_notes     text,                                         -- e.g. 'Seniors 60+'
  requires_id      boolean,                                      -- null = unknown
  has_fee          boolean,                                      -- null = unknown; find_sites skips true
  verification     site_verification not null default 'single_source', -- confirmed = 2+ independent sources agree on hours
  conflicts        jsonb             not null default '[]',      -- human-readable source disagreements
  evidence         text,                                         -- verbatim quote from the source supporting hours/access
  source_urls      text[]            not null default '{}',
  maps_place_id    text,                                         -- Google Maps place id
  external_key     text,                                         -- stable natural key (maps:/county:/web:), the upsert key for ingest
  pet_policy       text,
  official_name    text,                                         -- the official listing's name; name stays the short public name
  ac_source        text,                                         -- where has_ac comes from: official_program | site_page | reviews (null = unknown)
  category         text                                          -- source category, e.g. 'Cafe', 'Public library' (existing databases: migrations/20261114c)
);
create unique index on sites (external_key);
create unique index on sites (maps_place_id);
create index on sites (zip);
create index on sites (lat, lon);

-- Written by: M4 (opt-in / STOP handling). Read by: M4, M1 (aggregates only).
create table subscribers (
  id          serial primary key,
  phone_hash  text unique not null,       -- sha256(salt + e164), or the Messenger hash; what calls and messages match on
  phone_e164  text,                       -- raw number so alerts can be sent; set on opt-in, null after STOP. M4 only
  language    text not null default 'en', -- en | es | tl | vi | zh
  zip         text not null,
  needs       jsonb not null default '{}',-- see types.ts: CallerNeeds
  consent_at  timestamptz not null,
  opted_out_at timestamptz,
  -- Where alerts go: the channel the person opted in on. null = 'sms'.
  alert_channel text constraint subscribers_alert_channel_check
                check (alert_channel in ('sms', 'whatsapp', 'messenger')),
  -- Messenger subscribers only: the page-scoped id and the Page it wrote to, so an alert can be sent. Like
  -- phone_e164, set on opt-in and null after STOP. M4 only; never logged.
  messenger_psid    text,
  messenger_page_id text,
  -- Messenger profiles: the phone number the person gave with JOIN <zip> <phone>, as sha256(salt + e164) only (the
  -- raw number is not stored), so their Messenger can be found from a phone number. One profile per number.
  linked_phone_hash text,
  -- The name on their Facebook profile, read at JOIN when a Page token is set; null otherwise. M4 only; never
  -- logged. Cleared on STOP.
  display_name      text,
  -- Set by JOIN <zip> VOLUNTEER, cleared by a JOIN without it: they get neighbors' help requests in their zip.
  volunteer_at      timestamptz
  -- Existing databases: data/schema/migrations/20261115_m3_volunteers.sql, and: data/schema/migrations/20261114d_m4_messenger_phone_link.sql, and:
  --   alter table subscribers add column if not exists alert_channel text;
  --   alter table subscribers drop constraint if exists subscribers_alert_channel_check;
  --   alter table subscribers add constraint subscribers_alert_channel_check
  --     check (alert_channel in ('sms', 'whatsapp', 'messenger'));
  --   alter table subscribers add column if not exists messenger_psid text;
  --   alter table subscribers add column if not exists messenger_page_id text;
);
create index on subscribers (zip) where opted_out_at is null;
create index on subscribers (linked_phone_hash) where linked_phone_hash is not null;

-- Written by: M3 (inbound voice), M4 (outbound + sms). Read by: M1, ranking.
create table calls (
  id          serial primary key,
  direction   call_direction not null,
  channel     channel not null,
  phone_hash  text,                        -- messenger rows: sha256(salt + 'messenger:' + page-scoped id), never the raw id
  zip         text,
  language    text,
  site_id     int references sites,
  outcome     call_outcome,
  alert_id    int,                         -- set for outbound texts triggered by an alert (fk added below)
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index on calls (site_id, started_at desc);  -- recent_referrals()
create index on calls (zip, started_at desc);

-- Written by: M2 (AirNow/NWS pollers). Read by: M1, ranking, M3/M4 for AQI in replies.
create table readings (
  time       timestamptz not null,
  zip        text not null,
  temp_f     real,
  heat_index real,
  aqi        int,
  source     reading_source not null
);
create index on readings (zip, time desc);

-- Written by: M4 (alert workflow). Read by: M1, M2 (re-crawl trigger).
create table alerts (
  id          serial primary key,
  kind        alert_kind not null,
  nws_id      text unique,                 -- null for mock alerts
  zips        text[] not null,
  headline    text,
  onset_at    timestamptz,
  expires_at  timestamptz,
  detected_at timestamptz not null default now(),
  texts_sent  int not null default 0
);
alter table calls add foreign key (alert_id) references alerts (id);

-- Written by: M4 (text agent memory). Read by: M4.
create table messages (
  id          serial primary key,
  phone_hash  text not null,              -- or the Messenger hash, as in calls.phone_hash
  role        text not null check (role in ('user', 'assistant')),
  body        text not null,
  created_at  timestamptz not null default now()
);
create index on messages (phone_hash, created_at desc);

-- Written by: M4. Site details a voice caller asked to have "texted" (send_sms), held for their linked Messenger
-- profile until they next message the Page: Facebook only lets the Page write within 24 hours of their last
-- message, and a phone call does not count. Delivered first thing on their next message, dropped on STOP.
create table messenger_followups (
  id           serial primary key,
  phone_hash   text not null,               -- the Messenger profile's hash (subscribers.phone_hash)
  body         text not null,
  site_id      int references sites,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  delivered_at timestamptz
);
create index on messenger_followups (phone_hash) where delivered_at is null;

-- Written by: M2 (ingest). One row per fetch of a source page; a new content_hash means the page changed.
create table source_page_versions (
  id                 serial primary key,
  url                text        not null,
  fetched_at         timestamptz not null default now(),
  status             int         not null,            -- the target site's real HTTP status
  ok                 boolean     not null,
  content_hash       text,                            -- hash of normalized text; null when the fetch failed
  chars              int         not null default 0,
  error              text,
  blocked_by_policy  boolean     not null default false
);
create index on source_page_versions (url, fetched_at desc);

-- Written by: M2. Read by: M1 (ops dashboard). Cooling-gap analysis per ZIP: NWS heat forecast x Census residents at risk x sites within 5 km.
create table zip_gap (
  zip text primary key, name text, population int, age65plus int, households_no_vehicle int, below_poverty int,
  residents_at_risk int, sites_within_5km int, official_within_5km int, nearest_site_km real, nearest_site text,
  forecast_zone text, peak_temp_f real, peak_heat_index real, peak_time timestamptz, hours_90f_plus_72h int,
  heat_factor real, gap_score int, scenario_heat_index real, generated_at timestamptz
);

-- Written by: M2 (ingest). Read by: find_sites. Named places with coordinates so a caller can say "I'm at Geisel Library"
-- instead of giving a ZIP. Existing databases: migrations/20261114b_m2_landmarks_places_signals.sql
create table landmarks (
  id     serial primary key,
  name   text             not null,
  lat    double precision not null,
  lon    double precision not null,
  kind   text             not null,
  weight int              not null
);
create index on landmarks (lat, lon);

create table places (
  kind text             not null check (kind in ('zip', 'town')),
  key  text             not null,
  lat  double precision not null,
  lon  double precision not null,
  primary key (kind, key)
);

-- Written by: M2. AC and crowding signals from reviews, each count backed by verbatim excerpts.
create table site_review_signals (
  maps_place_id   text primary key,
  site_id         int references sites (id) on delete set null,
  reviews_scanned int  not null,
  window_days     int  not null,
  ac_positive     int  not null default 0,
  ac_negative     int  not null default 0,
  crowded         int  not null default 0,
  spacious        int  not null default 0,
  quotes          jsonb not null default '[]',
  scanned_at      timestamptz not null
);
create index on site_review_signals (site_id);

create table news_items (
  link       text primary key,
  title      text not null,
  source     text,
  date_text  text,
  fetched_at timestamptz not null default now()
);

-- Written by: M3 (request_help tool, neighbor replies, needs extraction). Read by: M1 through GET /dispatch/requests only.
create type request_status as enum ('requesting', 'incoming', 'declined', 'closed');
create type help_type as enum ('volunteer_pickup', 'ride_211', 'wellness_check');
create table requests (
  id              serial primary key,
  conversation_id text unique,                -- ElevenLabs conversation; one request per call
  status          request_status not null default 'requesting',  -- 'incoming' only when a neighbor replies YES <id>
  help_type       help_type,                  -- unused since the dispatcher was dropped
  said            text not null,              -- the caller's own words
  location        text not null,              -- where the caller said they are; sent only to the neighbor who said yes
  zip             text,
  lat             double precision,
  lon             double precision,
  needs           text[] not null default '{}', -- short English facts; the agent's list, overwritten by extraction. Dashboard chips
  neighbors_messaged int,                     -- how many neighbors the blast reached; null until it has run
  volunteer_hash  text,                       -- subscribers.phone_hash of the neighbor who said yes
  language        text,
  phone_e164      text,                       -- raw callback number while the request is open; null after decline or close
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on requests (status, created_at);

-- Written by: M3 (tool handlers, call webhooks, dispatcher endpoints). Read by: M1 through GET /dispatch/requests only.
-- The step-by-step trail of a call. No phone numbers; before a help request exists, events carry the zip only.
create table call_events (
  id              bigserial primary key,
  conversation_id text not null,              -- ElevenLabs conversation; joins requests.conversation_id
  at              timestamptz not null default now(),
  kind            text not null,              -- see types.ts: CallEventKind
  text            text not null               -- one short line for the dispatcher
);
create index on call_events (conversation_id, at);
create unique index on call_events (conversation_id) where kind = 'call_started';

-- "What changed" feed (migrations/20261114d_m2_site_changes.sql)
create table site_changes (
  id          text primary key,
  detected_at timestamptz not null,
  kind        text not null check (kind in ('hours_changed', 'new_closure')),
  url         text not null,
  site_ids    int[] not null default '{}',
  site_names  text[] not null default '{}',
  summary     text not null,
  before      jsonb not null default '[]',
  after       jsonb not null default '[]'
);
create index on site_changes (detected_at desc);
