# Shade

**One phone number that finds the nearest cool, clean-air place that's open right now.**

## Inspiration

San Diego County runs free cooling centers called Cool Zones. They closed for the season on October 31st, and then
it hit 90 degrees again. Most people don't know these places exist, and the list is scattered across a PDF, a map
layer and dozens of city pages, with hours that change and nothing saying who is allowed in. The people who need a
cool room most are the ones least able to dig through that: older residents, people without a car, people without
a smartphone or without English. We wanted something that works for them on any phone, with no app.

## What it does

**You call Shade and say where you are.** "I'm in El Cajon, I don't have a car." "I'm at Parkway Plaza." A cross
street, a landmark, or a zip all work. An AI voice agent finds the closest place that is **open now** with enough
time left to get there, tells you how far it is on foot or by bus, says whether it's an official cooling center or
a place we found that you should call ahead to, and offers to send you the details. It speaks English, Spanish and
Chinese on the same number.

**You can keep going on Facebook Messenger.** Send the Shadoes Page `JOIN 92105 6195551234` and your Messenger is
linked to your phone. After a call, the address, today's hours and a map link are waiting for you there. You can
ask follow-ups ("I don't have a car", "something closer?", "en español") and a text agent answers with the same
site data as the phone line.

**Shade reaches out first.** A workflow watches the National Weather Service for heat and air-quality alerts, and
our own readings for dangerous heat index or AQI in a zip. Everyone signed up there gets a message with their
nearest open site before they're in trouble.

**The county gets a live dashboard.** Open cool zones, heat and AQI by zip, where calls are coming from, the gaps
where seniors and car-free households have no site nearby, and help requests from callers who need more than
directions. Those go to every Shade volunteer on Messenger, and the first to reply YES gets the exact location.

**It's careful.** Heat-illness symptoms ("my mom passed out", "I can't breathe") get "call 911" from a fixed list
before any model runs. Shade always says it's an AI. Phone numbers are stored only as salted hashes, and we keep no
names.

## How we built it

- **Voice:** an **ElevenLabs** agent on a **Twilio** phone number, with Gemini 2.5 Flash as its LLM and language
  detection. When it needs an answer it calls tools on our **Mastra** server by webhook: `find_sites` and
  `send_sms`.
- **Finding sites:** `find_sites` resolves the caller's location (addresses and cross streets through **Google
  Geocoding**, plus nearly 7,000 landmarks), keeps only sites open now with time to spare (weekly hours, holiday
  closures, access rules), and ranks them by travel time for someone with or without a car, with honest wording
  baked in ("call ahead" for anything not official).
- **The data:** no list existed, so we built one. **Bright Data** scraped the county's official Cool Zone pages,
  Google Maps listings for every library, rec center and senior center, and over 2,000 Google reviews (for AC and
  crowding signals). **Gemini** read each site's own web page for hours, closures and who may enter. Everything
  lands in **Neon Postgres**: 563 sites across 93 zips, 120 official and 443 discovered.
- **Trust, in code:** every record the model extracts must quote its source page verbatim, and the code checks the
  quote is really there (96% pass, the rest are dropped). Hours from a site's own page are compared against Google
  Maps hours in code, not by a model, and disagreements are flagged "call ahead". Every scraped page is versioned so
  changes are caught, and an NWS alert triggers a re-crawl of the affected zips.
- **Messenger and alerts:** **Twilio**'s Facebook Messenger channel posts to signed webhooks on the Mastra server.
  A **Claude** text agent answers with the same `find_sites` tool. JOIN, STOP and HELP are handled in code, and
  Mastra workflows send NWS and reading-based alerts.
- **Dashboard:** a **React + TypeScript** (Vite) app on a pale-blue map that polls the Mastra API, which reads
  Neon, with NWS forecasts and US Census data for the cooling-gap view and the help-request inbox. It
  imports its response types from the API, so a contract change breaks the build instead of the screen.

## Challenges we ran into

- **SMS was blocked.** US carriers won't deliver texts from a new number without A2P 10DLC business registration,
  and Twilio still reports those texts as sent. We moved the whole text side to **Facebook Messenger** through
  Twilio's Messenger channel.
- **WhatsApp too.** We built WhatsApp support, but Meta restricted the unverified business account and refused
  every outbound message. It's parked, ready for when that's lifted.
- **Messenger's 24-hour rule.** A Page can only message someone within 24 hours of their last message, and a phone
  call doesn't count. So a follow-up from a call is held and delivered the next time the person writes to the
  Page, and alerts go to subscribers who've written recently. We said so in the signup message instead of
  pretending otherwise.
- **Scraping that lies about success.** Bright Data's unlocker returns HTTP 200 even when the target failed or the
  domain is refused (it refuses .gov). We read the real target status and error header, log refusals, and send
  government pages through a second fetcher. About 60% of search results came back as redirect links, so we
  rebuild the real URL when it's complete and drop it otherwise.
- **"Open now" is hard.** Overnight hours, holiday closures, intervals that wrap past midnight, and sources that
  disagree. We'd rather say "call ahead" than send someone to a locked door.
- **Hackathon plumbing.** Free tunnels that die mid-test, webhooks pointed at the wrong sender, and four
  workstreams sharing one database schema.

## Accomplishments that we're proud of

- A real phone number you can call that answers with a place that's actually open, in your language.
- A verified dataset of 563 public cooling spaces built from the open web in a weekend, where no single list existed.
- Model output is never trusted on its own: verbatim-quote checks and in-code cross-source comparison.
- Privacy and safety built in, not bolted on: hashed numbers, no names, opt-in alerts, 911 screening before any model.

## What we learned

- The hardest part of "find a cooling center" isn't the AI, it's knowing which places exist and when they're open.
- Messaging channels have real rules (carrier registration, Meta review, 24-hour windows) that shape the product as
  much as the code does.
- Honest wording ("call ahead", "not an official site", "verified Nov 14") is a feature people can trust.

## What's next

- Carrier registration so Shade can text any phone, and WhatsApp once Meta lifts the restriction.
- An AQI data source, so smoke alerts come from live air quality, not only NWS.
- Tagalog and Vietnamese, then the rest of San Diego's most-spoken languages.
- Matching volunteers by distance instead of messaging every volunteer, once there are enough of them.
- Working with the county so Cool Zones, extended hours and closures feed Shade directly.

## Built with

ElevenLabs · Twilio · Mastra · Neon · Bright Data · Gemini · Claude · Google Geocoding · National Weather Service ·
US Census · TypeScript · Node.js · React · Vite · Postgres · Leaflet · Cloudflare Tunnel
