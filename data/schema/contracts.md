# Contracts

The interfaces between the four workstreams. Types live in `types.ts`, tables in `schema.sql`.

## Table ownership

| Table | Writes | Reads |
|---|---|---|
| `sites` | M2 | M1, M3, M4 |
| `readings` | M2 | M1, M3, M4 |
| `calls` | M3 (inbound voice), M4 (outbound + sms) | M1, `find_sites` ranking |
| `subscribers` | M4 | M4; M1 aggregate counts only |
| `alerts` | M4 | M1, M2 |
| `messages` | M4 | M4 |

Only the writer changes rows in a table. Everyone else treats it as read-only.

## Shared tools

### `find_sites(FindSitesInput) -> FindSitesOutput`
- One implementation, imported by the voice tool endpoint (M3) and the text agent (M4).
- **Owner: M2** (it's a database read plus ranking, so it lives with the data). M3 and M4 call it and don't reimplement it.
- Ranking formula is in `docs/PROJECT.md`. It must exclude sites with stale `last_verified_at` and sites whose hours aren't open now.
- Returns at most 2 sites. `spoken_summary` carries the honesty rules: official vs discovered wording, "call ahead" for discovered.
- `location` can be a street address, cross streets ("Main St & Magnolia Ave, El Cajon"), a landmark, a neighborhood or a zip. The output reports `resolved_location` and `location_precision` (`address | intersection | landmark | street | area | zip`) so the agent can confirm the spot or ask for a cross street.
- Writes nothing. The caller logs the `calls` row.

### `send_sms(SendSmsInput) -> SendSmsOutput`
- **Owner: M4** (Twilio sender). M3 calls it from the voice agent's server tool.
- Builds the message from `site_id` (address, hours today, map link, AQI) in the requested language.
- Optional `party_size`, `needs_assistance`, `assistance_details` (from the voice intake) add a group line and, only when assistance is needed, an assistance line to the message.
- Must not send to a number whose subscriber row has `opted_out_at` set. A caller who asks for a text during a call counts as consent for that one message.

## Conventions

- **Phone numbers:** E.164 in transit, `sha256(PHONE_SALT + e164)` at rest. Add `PHONE_SALT` to env. Never log raw numbers. The one exception at rest is `subscribers.phone_e164`: an alert needs a number to send to, so M4 stores it on opt-in and clears it on STOP. Only M4 reads it; everything else keys on `phone_hash`.
- **Time:** timestamps are UTC `timestamptz`. Hours are local `America/Los_Angeles`.
- **Zip:** 5-digit text, never int.
- **Language codes:** `en | es | tl | vi | zh`.
- **Freshness:** a site is recommendable only if `last_verified_at` is within 24h (configurable via `SITE_MAX_AGE_HOURS`, default 24).
- **Mock data:** use `source = 'mock'` for readings, `kind = 'mock'` for alerts. Dashboard and demo may include them; never mix mock rows into official numbers silently.
- **Schema changes:** edit `schema.sql` and `types.ts` together in one PR, tag all four members. Prefer additive changes (new nullable columns).

## Seed data

M2 owns `data/seed/` with a cached snapshot of real sites and a few demo zips (El Cajon 92020, La Jolla 92037, City Heights 92105). Everyone develops against the seed until live ingest works, which keeps the four streams unblocked.
