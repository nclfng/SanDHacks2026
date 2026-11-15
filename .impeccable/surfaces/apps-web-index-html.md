---
version: 1
slug: "apps-web-index-html"
primary_target: "apps/web/index.html"
related_targets: ["apps/web/join.html"]
---

# Surface brief: resident home (apps/web/index.html) and join pages (apps/web/join.html)

Scope: the public front door at `/`, plus one join page in two modes (alerts, volunteer). Mode: Persuade, for residents on a phone, often outdoors in heat. The ops dashboard moves to /dashboard.html.

Audience and job: a San Diego County resident who needs cool air now (call), wants to be warned (alerts on Messenger), or wants to help neighbors (volunteer on Messenger). Real numbers: Shade line (619) 393-8334; Messenger Page "Shadoes" (page id 1400747643128537). Commands: JOIN <zip> <phone> and JOIN <zip> <phone> VOLUNTEER (apps/api/src/m4/messenger/join.ts). Never stands in for 911.

## Direction contract

THESIS: The front door is the Water Chart itself: the county's live cool zones on the pale blue chart, with one glass instrument holding three actions. Refuses the stock hero-plus-three-feature-cards landing page.

OWN-WORLD: the Water Chart, extended for residents (DESIGN.md is amended at finish to record resident glass panels, which the directions page already ships, and these components): Chart Paper ground, USGS topo recolored blue under the survey grid, Zone Blue asterisk tokens, liquid glass panel with navy ink, Deep Water pill actions, Hanken Grotesk thin display, Red Hat Mono for the live count, the number and the JOIN message.

STORY: In one glance the visitor sees open cooling centers around them, reads that Shade finds the nearest one by phone, and taps Call now; or chooses alerts or volunteering, types zip and phone, sees the exact message, and sends it in Messenger.

FIRST VIEWPORT: Desktop: full-bleed chart with open zone tokens; glass panel left third, display headline 60px weight 200, one-line explainer, live "N cool zones open now" in mono, Call now as a 64px Deep Water pill with the number, then Alerts and Volunteer side by side at 56px; a 911 line below. Mobile: chart in the top 38vh, the same panel as a sheet overlapping it, Call now within the first screen.

FORM: Extension of the established Water Chart surfaces (resident directions page composition); narrow precise request, no concept roll, no seed key. Signature interaction: zone tokens ripple onto the chart from the county center outward once live data lands; on the join page the Messenger bubble writes the message as you type.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
