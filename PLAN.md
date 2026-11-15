# Project Plan

## Goal

Turn Shade from a directions-only voice agent into a neighbor-help line. The agent asks whether the caller needs someone to come or just directions. A caller who needs someone gets a help request. Gemini turns the caller's words into short need facts for the dashboard. Registered neighbors in the caller's zip get a message, and the first to reply YES takes the request. The agent, still on the line, tells the caller only what the request record supports.

Product context: `PRODUCT.md`. Architecture: `docs/PROJECT.md`.

## Locked implementation decisions

- **No dispatcher.** A neighbor's YES is the only thing that confirms help. No model output changes status.
- **Request status:** `requesting -> incoming` when the first neighbor in the request's zip replies `YES <id>` (one atomic update). `declined` and `closed` stay in the enum, unused. Dashboard labels stay "Requesting" and "Incoming".
- **Who gets asked:** volunteers. A Messenger subscriber opts in with `JOIN <zip> VOLUNTEER` (or `VOLUNTARIO`), which sets `subscribers.volunteer_at`. A JOIN without it turns volunteering off; START keeps what is on file. Only a volunteer from the request's zip can take it.
- **Blast:** on `request_help`, every volunteer in the caller's zip, except the caller's own linked profile, gets one message with the area and needs. Messenger only: SMS is carrier-blocked and WhatsApp is parked (`apps/api/src/m4/AGENTS.md`). Only volunteers who wrote to the Page in the last 24 hours can be reached.
- **Location privacy:** the blast names an intersection, landmark or neighborhood, else the zip, never a street address. The exact location, needs and the caller's words go only to the neighbor who said yes. A YES from another zip learns nothing.
- **Reply format:** `YES <id>` (or `SI <id>`). A bare "yes" goes to the text agent, so a reply to the agent's own question never takes a request.
- **Templates:** every request tool result carries a `say_this` line chosen in code from the status. "Help is coming" wording exists only in the `incoming` template. Templates promise no arrival time. When the blast reached nobody, the line sends the caller to 211.
- **Caller follow-up:** on every YES, the caller also gets a Messenger message that a neighbor is coming, through their linked profile (JOIN <zip> <phone>): at once inside the 24-hour window, else held until they next write. This covers a YES after the call ended. Callers with no linked profile get nothing: SMS is carrier-blocked.
- **Hold:** the agent keeps the caller on the line and calls `check_request_status` on each quiet turn, up to 12 checks, then sends them to 211. Our ElevenLabs plan cannot push into a live call, so polling is the only way the agent hears about a YES.
- **Needs:** `requests.needs text[]` is the one place needs live: short English facts, one chip each on the dashboard, quoted in the blast and the volunteer's message. The agent fills it from the call; extraction (T4) overwrites it. No separate structured record.
- **911:** emergency signs keep the immediate "hang up and call 9 1 1" rule in `agent/prompts/system.md`. The agent does not call `request_help` first.
- **Callback number:** `requests.phone_e164` holds the raw number while the request is open. No endpoint returns it, and neighbors never see it.
- **Gemini calls:** use the Mastra model router already installed in `apps/api`. Add no new SDK.
- **Table owner:** `requests` belongs to M3 (voice).

## Out of scope

- Calling the caller back by phone when a YES arrives after the call ended. The Messenger follow-up covers it.
- Volunteer vetting, ratings and arrival estimates.
- Help requests from the SMS, WhatsApp and Messenger channels.
- Custom-LLM output filter between ElevenLabs and Gemini. Add it only if T7 shows promise leaks.

## Tickets

### T1: Spike - read the call transcript during a call
**Status:** in-progress (research done; the live poll test needs an ElevenLabs key)
**Blocked by:** None (can start immediately)
**What it delivers:** A written answer: can `apps/api` read the ElevenLabs transcript of a call that is still in progress, and with what delay. Sets whether T4 reads the whole call or only `said`.
**Acceptance:**
- [ ] `docs/M3.md` records the method tried, the result, and the measured delay.
**Verification:**
- manual: start a call with `npm run el:call`, run `npm run el:transcript` while the call is live, and record the result in `docs/M3.md`.

### T2: Caller's help request reaches the dashboard
**Status:** in-progress (code written; needs the migrations applied and one simulated call)
**Blocked by:** None (can start immediately)
**What it delivers:** A caller who needs someone says so. The agent calls `request_help`. The request shows on the staff dashboard as Requesting with the caller's words, location and needs.
**Acceptance:**
- [ ] `POST /el/tools/request-help` creates one row per conversation. A repeat call in the same conversation returns the existing row.
- [ ] `GET /dispatch/requests` returns open requests and never returns `phone_e164`.
- [ ] The dashboard Help requests panel shows live rows.
**Verification:**
- `cd apps/api && npm run typecheck`
- `cd apps/api && npx tsx --env-file=../../.env checks/requests.check.ts` (add `REQUESTS_CHECK_DB=1` for the database part)
- manual: `npm run el:simulate -- pickup`; the request appears in the dashboard panel within one poll.

### T3: Neighbor blast and the first YES
**Status:** in-progress (code written on `neighbor-assist-blast`; needs migration `20261114f_m3_neighbor_blast.sql` and a two-phone test)
**Blocked by:** T2
**What it delivers:** Neighbors in the caller's zip get a Messenger message with the area and needs. The first to reply `YES <id>` gets the exact location and the request turns Incoming on the dashboard.
**Acceptance:**
- [x] `request_help` starts the blast after it returns and stores `neighbors_messaged`; the trail shows how many neighbors it reached.
- [x] The blast never contains a street address.
- [x] Two simultaneous YES replies: one gets the location, the other gets "already said yes". A non-volunteer or another zip gets no details.
- [x] `JOIN <zip> VOLUNTEER` marks a volunteer and the confirmation says so; a plain JOIN invites them to volunteer.
- [x] A bare "yes" still goes to the text agent.
- [x] The winning YES sends the caller a Messenger follow-up, held until they write if their window is closed.
**Verification:**
- `cd apps/api && REQUESTS_CHECK_DB=1 npx tsx --env-file=../../.env checks/requests.check.ts`
- `cd apps/api && npx tsx --test src/m4/messenger/messenger.test.ts src/m4/whatsapp.test.ts`
- manual: phone B sends `JOIN 92105 VOLUNTEER`; phone A sends `JOIN 92105 <phone A number>`, then calls from phone A and asks for help; phone B gets the blast, replies `YES <id>`, and gets the location; phone A's Messenger gets the follow-up.

### T4: Need facts from the caller's words (friend's part)
**Status:** blocked
**Blocked by:** T2
**What it delivers:** A smaller Gemini model reads the caller's words and writes short need facts the dashboard shows as chips.
**Acceptance:**
- [ ] Runs after `request_help` returns, keyed by `conversation_id`. `request_help` response time does not include the Gemini call.
- [ ] Writes `requests.needs` as short English facts the caller stated, for example `["2 people", "uses a wheelchair", "no car"]`. Nothing guessed; unknowns are left out.
- [ ] A Gemini error leaves the agent's `needs` in place and the request visible.
**Verification:**
- `cd apps/api && npm run typecheck`
- `cd apps/api && npx tsx checks/extract.check.ts` (fixture quotes, asserts no invented facts)

### T5: Hold and the caller hears the truth
**Status:** in-progress (prompt and `check_request_status` written; needs `npm run el:sync` and a live call)
**Blocked by:** T3
**What it delivers:** The agent asks "someone to come, or directions?", files the request, keeps the caller on the line and checks status. When a neighbor says yes, it tells the caller to hold tight. After 12 checks with no YES, it sends them to 211.
**Acceptance:**
- [x] `POST /el/tools/check-request-status` returns the status and its `say_this` line. Only `incoming` says help is coming.
- [x] `agent/prompts/system.md` asks help-or-directions, asks people count and needs once, and bounds the checks.
- [ ] Emergency signs still produce the 911 line without a `request_help` call.
**Verification:**
- `cd apps/api && npm run el:sync && npm run el:simulate -- pickup`
- `cd apps/api && npm run el:simulate -- emergency`
- manual: during `npm run el:call`, reply `YES <id>` from phone B; the agent then says a neighbor is coming. Before the YES, it does not.

### T6: Pressure evals
**Status:** blocked
**Blocked by:** T5
**What it delivers:** A repeatable check that the agent does not promise help under pressure.
**Acceptance:**
- [ ] `agent/scripts/simulate.ts` has scenarios `pressure`, `false_premise` and `injection`.
- [ ] A Gemini Pro pass flags any line that implies help is coming while the status is `requesting`.
- [ ] The script exits non-zero when a line is flagged.
**Verification:**
- `cd apps/api && npm run el:simulate -- pressure`

## Done

## Open conflicts

- `PRODUCT.md` says help requests are mock and that nothing on screen identifies a caller beyond location and needs. Neighbors now receive the exact location after YES. Update with `/project-init product`.
- `data/schema/contracts.md` has no `requests` table and allows a raw number only in `subscribers.phone_e164`. The schema-change rule requires a PR that tags all four members.
