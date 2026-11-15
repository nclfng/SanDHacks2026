---
name: Shade
description: Clear liquid glass over a pale blue water chart, for finding cool air fast.
colors:
  blue: "#0369a1"
  blue-hover: "#075985"
  zone: "#0b74c9"
  zone-tint: "#cfe8fb"
  cool: "#7fe3f2"
  heat: "#f4a765"
  heat-ink: "#2a1806"
  ink: "#0b2540"
  ink-2: "#3f5872"
  paper: "#eaf5fd"
  card: "#fbfdff"
  ground: "#d6eaf8"
  peach: "#f6d3b8"
  sky: "#c9eef4"
  danger: "#b3261e"
  aqi-good: "#a5d68f"
  aqi-moderate: "#ecd670"
  aqi-sensitive: "#f4a765"
  aqi-unhealthy: "#ee7a66"
typography:
  display:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "46px"
    fontWeight: 200
    lineHeight: 1.05
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 300
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 500
  body:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Red Hat Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.01em"
  display-resident:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(40px, 5vw, 62px)"
    fontWeight: 200
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  message:
    fontFamily: "Red Hat Mono, ui-monospace, monospace"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.02em"
rounded:
  chip: "8px"
  inset: "14px"
  panel: "24px"
  pill: "999px"
spacing:
  row-y: "13px"
  panel-x: "22px"
  gap: "16px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
  segment-selected:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "5px 13px"
  chip-need:
    backgroundColor: "rgba(255, 255, 255, .6)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  token-zone:
    backgroundColor: "{colors.zone}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    size: "34px"
  token-request:
    backgroundColor: "{colors.heat}"
    textColor: "{colors.heat-ink}"
    rounded: "{rounded.pill}"
    size: "30px"
  token-zone-overview:
    backgroundColor: "{colors.zone}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    size: "28px"
  token-discovered-overview:
    backgroundColor: "#ffffff"
    textColor: "{colors.zone}"
    rounded: "{rounded.pill}"
    size: "11px"
  resident-action:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    height: "56px"
  call-now:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "0 22px 0 12px"
    height: "72px"
  call-now-hover:
    backgroundColor: "{colors.blue-hover}"
  option-pill:
    backgroundColor: "rgba(255, 255, 255, .6)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 14px 0 10px"
    height: "64px"
  input-pill:
    backgroundColor: "rgba(255, 255, 255, .82)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "56px"
  message-bubble:
    backgroundColor: "{colors.blue}"
    textColor: "#ffffff"
    typography: "{typography.message}"
    rounded: "22px 22px 6px 22px"
    padding: "12px 18px"
---

# Design System: Shade

## Overview

**Creative North Star: "The Water Chart"**

A pale blue chart of the county fills the room. Clear glass instruments rest on it and bend the map beneath them. The map is the workspace and never recedes behind chrome. Staff read the county through liquid glass panels with dark navy type. Residents get the same chart under the same glass, made denser where they read so it stays plain enough to use one-handed in sunlight.

The look is blue, white, and watery, with a material modeled on Apple's Liquid Glass.

**Key Characteristics:**
- Full-bleed map; panels float on it.
- One material, two densities: full liquid glass for staff panels and every top pill; denser, non-refracting glass for resident reading panels.
- Round tokens carry meaning on the map: a blue asterisk is a cool zone, orange is a person asking for help, cyan is help on the way.
- Thin, large numerals for readings; small mono for codes, times, and labels.

## Colors

White and water-blue neutrals. Orange is the only warm signal.

### Primary
- **Deep Water** (blue): actions, selection, focus rings, routes, load bars.

### Secondary
- **Zone Blue** (zone): cool zone tokens and the brand mark. **Zone Tint** (zone-tint) is its pale form for resident chips.
- **Relief Cyan** (cool): help incoming.
- **Ember Orange** (heat): a person requesting help.

### Tertiary
- **Alarm Red** (danger): the resident "Call 911" bar only.
- **AQI ramp** (aqi-good to aqi-unhealthy): AQI chips only, always with the number inside. The "sensitive" step shares the Ember Orange hex.

### Neutral
- **Navy Ink / Ink 2**: primary and secondary text, on glass and on cards.
- **Chart Paper / Card / Ground**: map ground, resident cards, page background.
- **Peach, Sky**: resident chips and notices.

**The One Meaning Rule.** Outside an AQI chip, orange means a person is requesting help. Actions are blue.

## Typography

**Display and Body Font:** Hanken Grotesk (with system-ui)
**Label/Mono Font:** Red Hat Mono

**Character:** One quiet grotesk at many weights, thin when large and medium when small. Its numeral 1 is unmistakable, which matters on a readings panel.

### Hierarchy
- **Display** (200, 46px, 1.05): headline readings.
- **Resident display** (200, fluid 40-62px): the front-door headline on the resident home. The join page steps it down to 300 at 32-42px.
- **Headline** (300, 20px): panel titles.
- **Title** (500, 14.5px): row names.
- **Body** (400, 14px staff, 17px resident, 1.45).
- **Label** (mono, 12-13px): zip codes, clock, mock-data tag, bus times, the live open-count line.
- **Message** (mono 500, 17px): the exact text a resident will send, inside the outgoing bubble. The Shade phone number is also set in mono (500, 14-15px) wherever it is shown.

**The Tabular Rule.** All figures use tabular numerals so columns of readings line up.

## Layout

Staff: fixed full-viewport map; a top bar of pills at 16px inset; two side panels (340px left, 368px right) from 84px down. Below 1000px the map takes 58vh and panels stack beneath it.

Resident directions: single column, max 480px, sticky map (44vh) with the glass card sheet overlapping it by 22px and a fixed 911 bar at the bottom.

Resident home and join: on desktop, one glass panel (max 540px) sits vertically centered on the left over a full-bleed chart; the chart is fitted into the space to the panel's right, and the 911 line is inline at the foot of the panel. Below 900px the chart is a strip on top, the panel becomes a sheet starting at max(36vh, 230px), and the inline 911 line is replaced by the fixed 911 bar at the bottom. Below 520px the two option pills stack.

**The Overview Chart Rule.** The resident chart is a still overview, not a tool: no pan, no zoom, no controls. It shows only sites inside San Diego County; anything outside is neither drawn nor counted.

## Elevation & Depth

Depth is material.

- **Staff glass:** a white-to-pale-blue gradient at 38-62% opacity, with `backdrop-filter` blur, 190% saturation, and a slight brightness lift. A 1px white border, a bright top inner edge, and a soft inner glow form the rim. A `::before` layer adds a specular sweep from the top-left and a cool caustic at the bottom-right. One blue-tinted drop shadow.
- **Refraction:** Chromium adds an SVG displacement filter (`#liquid`) to the backdrop. Other browsers fall back to plain blur.
- **Reduced transparency:** `prefers-reduced-transparency: reduce` swaps the glass for opaque `#f4faff`.
- **Resident reading glass:** resident panels that hold reading text (the home and join panel) use a denser glass: white gradient at 78-86% opacity, plain blur (26px) with 170% saturation, and no `#liquid` displacement, so map labels never read through beside the words. Rim, specular sweep, and shadow match staff glass. The top pills (brand, staff link) keep the full liquid material. Reduced transparency swaps both to opaque.
- **Map:** USGS topo tiles, recolored to blue and white with a CSS filter, under a fine blue survey grid.
- **Map tokens:** a white ring plus a small blue-grey shadow. No colored glows.
- **Resident actions:** filled Deep Water pills carry one soft Deep Water drop beneath them and a faint bright top edge; white-wash pills carry only a 1px inner white rim.

## Shapes

Everything is round or pill-shaped: 24px panels, full pills for bars, buttons, chips, and segments, circles for map tokens. The map carries a fine square survey grid as its only straight-line ornament.

## Components

### Buttons
- **Primary:** Deep Water pill, 36px tall, white text. Hover darkens; press scales to 0.97.
- **Resident actions:** full pills, 56-60px tall, either Deep Water filled with white text or a 60% white wash with Deep Water text; an icon may lead the label. Press scales to 0.98.
- **Call now:** the resident front door's lead action. A 72px Deep Water pill: a phone icon in a 48px translucent white circle on the left, "Call now" (21px, 500) over a pale-blue subtitle, and the Shade number in mono on the right. On phones under 520px it is 68px and the number replaces the subtitle line.
- **Option pills:** 64px, 60% white wash with a white inner rim; a 42px white circle holding a Deep Water icon, a two-line label in Navy Ink and Ink 2, and a Deep Water arrow that nudges right on hover. Used in pairs, side by side, stacking on narrow phones.

### Inputs
- **Pill text field:** 56px, 82% white, 1px blue-grey border, 18px text, placeholder at #586e86. Focus turns the border Deep Water with a soft 3px Deep Water ring. An error turns the border Alarm Red with a faint red ring and puts the message beneath in Alarm Red. The label sits above in 500 weight.

### Message bubble
- **Outgoing message:** a Deep Water bubble, right-aligned, with the bottom-right corner tucked (22/22/6/22), holding the exact message in mono. It updates as the resident types, so what they see is what they send.

### Live count
- **Open-count line:** one mono line under the resident headline, with a small Zone Blue dot before the official count and a white ringed dot before the discovered count, ending in "open now". Counts are numbers in Navy Ink; words are Ink 2.

### Segmented control
- Pill track at 10% blue. The selected segment is Deep Water with white text. Request status segments take their status color when selected (orange Requesting, cyan Incoming).

### Chips
- Needs chips: 60% white pills. "Told to call 911": solid aqi-unhealthy with dark text. AQI chips: ramp color with the number.

### Panels and rows
- Panels have no padding of their own. Rows carry 13px by 22px and are separated by 13% blue hairlines. Hovered rows get a 40% white wash. The row whose detail card is open gets a 9% Deep Water wash and a Deep Water title.

### Map tokens
- Cool zone: 34px Zone Blue disc with a white six-arm asterisk. Discovered sites: white disc with a Zone Blue ring. Closed: blue-grey.
- Help request: 30px orange disc with an expanding ring while Requesting; cyan and still when Incoming. "!" inside when the caller was told to call 911.
- Handled calls: 9px navy dots.
- On the resident overview chart, tokens shrink: official zones are 28px Zone Blue asterisk discs, discovered sites 11px white discs with a Zone Blue ring, official drawn on top. Tokens are visible from the start; on load one Zone Blue ring spreads once from each, nearest the county center first, and none under reduced motion.
- Routes: white casing (8px staff, 9px resident) under a Deep Water line (3.5px staff, 4px resident), dotted for walking.

## Do's and Don'ts

### Do:
- **Do** keep the map visible behind and between panels.
- **Do** keep text on glass at Navy Ink or Ink 2; check contrast where the map shows through.
- **Do** pair every status color with a word or number.
- **Do** label mock data wherever it appears.
- **Do** keep resident tap targets at 56px or taller.

### Don't:
- **Don't** use orange for anything but a person requesting help, except inside an AQI chip.
- **Don't** put refracting (`#liquid`) or thin glass behind resident reading text; resident panels use the denser reading glass so they stay readable in sunlight.
- **Don't** add colored glow shadows or violet.
- **Don't** show a caller's name or phone number; location and stated needs only.
- **Don't** present a discovered site the same way as an official one.
