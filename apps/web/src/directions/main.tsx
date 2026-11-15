// Resident directions page. Entirely mock: destination, steps, bus times and updates are hardcoded (no directions endpoint yet).
import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './directions.css';
import { LINE } from './route';

const STAR = '<svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>';
const IC = {
  walk: <svg viewBox="0 0 24 24"><circle cx="13" cy="4.5" r="1.8" /><path d="M10 21l2-6-2.5-2.5L11 8l3 3 3 1M11 8l-3 1.5-1 3.5M14 21l-1.5-4" /></svg>,
  bus: <svg viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="13.5" rx="2.5" /><path d="M5 11h14M8 20v-3M16 20v-3M8.5 14h.01M15.5 14h.01" /></svg>,
  car: <svg viewBox="0 0 24 24"><path d="M4 16v-3.5L6 7.5A2 2 0 018 6h8a2 2 0 012 1.5l2 5V16M4 16h16M4 16v2M20 16v2M7.5 13h.01M16.5 13h.01" /></svg>,
  star: <svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" /></svg>,
};
const clock = (min: number) => new Date(Date.now() + min * 6e4).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

type Mode = 'bus' | 'walk' | 'drive';
type Step = [cls: '' | 'ride' | 'arrive', ic: keyof typeof IC, head: string, sub: ReactNode];
const ARRIVE: Step = ['arrive', 'star', 'You are there', '201 E Douglas Ave. Cool air inside until 8:00 PM.'];
const MODES: Record<Mode, { label: string; min: string; travel: string; steps: () => Step[] }> = {
  bus: { label: 'Bus', min: '19 min', travel: 'transit', steps: () => [
    ['', 'walk', 'Walk to the bus stop', 'N Magnolia Ave & Fletcher Pkwy · 3 min'],
    ['ride', 'bus', 'Take Bus 874 toward El Cajon Transit Center', <>6 stops · 9 min · air-conditioned<br /><span className="mono">Next at {clock(8)}, then {clock(23)}</span></>],
    ['', 'walk', 'Get off at N Magnolia Ave & Rea Ave', 'Walk down Rea Ave to the library · 4 min'],
    ARRIVE] },
  walk: { label: 'Walk', min: '27 min', travel: 'walking', steps: () => [
    ['', 'walk', 'Head south on N Magnolia Ave', '0.8 mi · stay on the shaded east side'],
    ['', 'walk', 'Turn left on Rea Ave', '0.1 mi to the library'],
    ARRIVE] },
  drive: { label: 'Drive', min: '4 min', travel: 'driving', steps: () => [
    ['ride', 'car', 'Take Fletcher Pkwy to N Magnolia Ave', 'Turn right and head south · 0.9 mi'],
    ['ride', 'car', 'Turn left on Rea Ave', 'Free parking behind the library on Sulzfield Way'],
    ARRIVE] },
};

function RouteMap({ mode }: { mode: Mode }) {
  const el = useRef<HTMLDivElement>(null);
  const route = useRef<L.LayerGroup>(null);

  useEffect(() => {
    // No attribution control: the 911 bar would cover it, so the fine print credits USGS instead.
    const map = L.map(el.current!, { zoomControl: false, scrollWheelZoom: false, attributionControl: false, zoomSnap: .25 });
    L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(map);
    // The map fills the viewport; keep the route in the strip between the top pills and the sheet (main's padding-top).
    map.fitBounds(L.latLngBounds(LINE), { paddingTopLeft: [40, 84], paddingBottomRight: [40, innerHeight - Math.max(innerHeight * .42, 250) + 24] });
    const icon = (html: string, w: number, h = w) => L.divIcon({ className: '', html, iconSize: [w, h], iconAnchor: [w / 2, h / 2] });
    L.marker(LINE[0], { icon: icon('<div class="tk you"></div>', 22), title: 'You are here' }).addTo(map);
    L.marker(LINE[0], { icon: L.divIcon({ className: '', html: '<div class="lbl mono">You</div>', iconSize: [0, 0], iconAnchor: [0, -18] }), interactive: false }).addTo(map);
    L.marker(LINE.at(-1)!, { icon: icon(`<div class="tk end">${STAR}</div>`, 40), title: 'El Cajon Library' }).addTo(map);
    route.current = L.layerGroup().addTo(map);
    return () => { map.remove(); route.current = null; };
  }, []);

  useEffect(() => {
    const r = route.current!;
    r.clearLayers();
    const seg = (pts: L.LatLngExpression[], dotted: boolean) => {
      L.polyline(pts, { color: '#ffffff', weight: 9 }).addTo(r);
      L.polyline(pts, { color: '#0369a1', weight: 4, lineCap: 'round', dashArray: dotted ? '1 8' : undefined }).addTo(r);
    };
    // Bus mode: first and last stretch are on foot (dotted), the middle is the ride.
    if (mode === 'bus') { seg(LINE.slice(0, 13), true); seg(LINE.slice(12, -14), false); seg(LINE.slice(-15), true); }
    else seg(LINE, mode === 'walk');
  }, [mode]);

  return <div id="map" ref={el} aria-label="Map of your route to El Cajon Library" />;
}

function Directions() {
  const [mode, setMode] = useState<Mode>('bus');
  const m = MODES[mode];
  return <>
    <RouteMap mode={mode} />

    <header className="top">
      <div className="glass pill brand">
        <div className="tk">{IC.star}</div>
        <b>Shade</b><span>Directions</span>
      </div>
      <div className="glass pill mono">Mock data</div>
    </header>

    <main>
      <section className="glass">
        <h1>El Cajon Library</h1>
        <p className="facts">201 E Douglas Ave, El Cajon</p>
        <div className="chips mono">
          <span className="chip">Open until 8:00 PM</span>
          <span className="chip">Official cooling center</span>
          <span className="chip">101° outside</span>
        </div>

        <div className="seg" role="group" aria-label="How are you getting there?">
          {(Object.keys(MODES) as Mode[]).map((k) =>
            <button key={k} aria-pressed={k === mode} onClick={() => setMode(k)}><b>{MODES[k].label}</b><small>{MODES[k].min}</small></button>)}
        </div>
        <p className="warn" hidden={mode !== 'walk'}><i></i><span><b>Walking this far is not safe in today's heat.</b> Take the bus, or call 211 for a free ride.</span></p>
      </section>

      <section className="glass" aria-labelledby="sh">
        <h2 id="sh">Your route</h2>
        <ol>
          {m.steps().map(([cls, ic, head, sub]) =>
            <li key={head} className={`step ${cls}`}><div className="ic">{IC[ic]}</div><div><b>{head}</b><span>{sub}</span></div></li>)}
        </ol>
      </section>

      <section className="glass" aria-labelledby="uh">
        <h2 id="uh">Updates</h2>
        <div className="upd"><time className="mono">{clock(-4)}</time><p><b>The library is filling up.</b> There is still room for about 14 people. If it fills, we will text you a new place and this page will change.</p></div>
        <div className="upd"><time className="mono">12:10 PM</time><p><b>Extreme Heat Warning until 8:00 PM.</b> Stay indoors and drink water even if you are not thirsty.</p></div>
      </section>

      <section className="glass">
        <div className="acts">
          <a className="act fill" href={`https://www.google.com/maps/dir/?api=1&destination=201+E+Douglas+Ave%2C+El+Cajon%2C+CA&travelmode=${m.travel}`}>Open in Google Maps
            <svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8" /></svg></a>
          <a className="act" href="tel:211">No ride? Call 211 for a free one
            <svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" /></svg></a>
        </div>
        <p className="fine">Bus times and site details on this page are sample data for the demo. Reply STOP to the text to stop messages. Map: USGS The National Map.</p>
      </section>
    </main>

    <div className="sos">
      <a className="glass" href="tel:911"><span>Dizzy, confused, or sick to your stomach?<small>That can be heat illness. Do not wait.</small></span><b>Call 911</b></a>
    </div>
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Directions /></StrictMode>);
