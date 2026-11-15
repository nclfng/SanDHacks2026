// The county as a still water chart behind the resident pages. Open cool zones from GET /dashboard/state drop onto it
// once, rippling out from the middle of the county; without the API the chart still renders, just without tokens.
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { get, statePath, type DashboardState } from '../api';

// The metro and North County, where nearly every site is. The panel covers the left of a wide screen, so the
// chart is fitted into the space to its right; once data lands the frame widens to keep every official zone in view.
const METRO = L.latLngBounds([32.56, -117.28], [33.22, -116.86]);
const CENTER = L.latLng(32.82, -117.08);
// San Diego County with a margin. A site outside it is a data error or a test row (site 586 is a North Pole, AK test
// site marked official), so it is neither drawn nor counted.
const COUNTY = L.latLngBounds([32.4, -117.7], [33.6, -115.9]);
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/></svg>';

export interface OpenCount { official: number; discovered: number }

export function Chart({ onCount }: { onCount?(c: OpenCount): void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const frame = useRef(METRO);
  const fit = useRef<() => void>(() => {});
  const [sites, setSites] = useState<DashboardState['sites']>([]);

  useEffect(() => {
    const m = L.map(el.current!, {
      zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
      keyboard: false, touchZoom: false, attributionControl: true,
    });
    L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16, attribution: 'USGS The National Map',
    }).addTo(m);
    // Phones: the panel starts at max(36vh, 230px) (home.css), so the frame is fitted into the strip above it.
    fit.current = () => m.fitBounds(frame.current, innerWidth > 900
      ? { paddingTopLeft: [Math.min(620, innerWidth * 0.46), 40], paddingBottomRight: [40, 40] }
      : { paddingTopLeft: [12, 64], paddingBottomRight: [12, innerHeight - Math.max(innerHeight * 0.36, 230) + 16] });
    fit.current();
    const onResize = () => fit.current();
    addEventListener('resize', onResize);
    map.current = m;
    return () => { removeEventListener('resize', onResize); m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    let live = true;
    get<DashboardState>(statePath).then((d) => {
      if (!live) return;
      const inCounty = d.sites.filter((s) => COUNTY.contains([s.lat, s.lon]));
      setSites(inCounty);
      onCount?.({ official: inCounty.filter((s) => s.tier === 'official').length, discovered: inCounty.filter((s) => s.tier !== 'official').length });
    }, () => { /* no API: the chart stays bare and the page says nothing about counts */ });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    if (!m || !sites.length) return;
    const officials = sites.filter((s) => s.tier === 'official');
    if (officials.length) {
      frame.current = L.latLngBounds(METRO.getSouthWest(), METRO.getNorthEast()).extend(L.latLngBounds(officials.map((s) => [s.lat, s.lon])));
      fit.current();
    }
    const layer = L.layerGroup().addTo(m);
    // Official zones on top: the Zone Blue asterisk is the mark the chart is about; discovered places are small rings.
    const ordered = [...sites].sort((a, b) => (a.tier === 'official' ? 1 : 0) - (b.tier === 'official' ? 1 : 0));
    for (const s of ordered) {
      const km = CENTER.distanceTo([s.lat, s.lon]) / 1000;
      const delay = Math.min(km * 28, 1400);   // the ripple: near the middle first, the edges about 1.4 s later
      const official = s.tier === 'official';
      const size = official ? 28 : 11;
      L.marker([s.lat, s.lon], {
        interactive: false, keyboard: false, zIndexOffset: official ? 100 : 0,
        icon: L.divIcon({
          className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          html: `<div class="ztk ${official ? 'off' : 'disc'}" style="--d:${delay}ms">${official ? STAR : ''}</div>`,
        }),
      }).addTo(layer);
    }
    return () => { layer.remove(); };
  }, [sites]);

  return <div id="chart" ref={el} aria-hidden="true" />;
}
