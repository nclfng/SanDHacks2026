import { useEffect, useRef, useState } from 'react';
import { API, statePath, usePoll, type DashboardState, type Inbox } from './api';
import { ALERT, clockAt } from './format';
import { AST, MapView } from './MapView';
import { SendAlert } from './SendAlert';
import { SidePanel } from './SidePanel';
import { ZonesPanel } from './ZonesPanel';

export function App() {
  const st = usePoll<DashboardState>(statePath);
  const inbox = usePoll<Inbox>('/dispatch/requests');
  const [zone, setZone] = useState<number | null>(null);
  const [req, setReq] = useState<number | null>(null);
  const [zip, setZip] = useState<string | null>(null);

  const d = st.data, sites = d?.sites ?? [], readings = d?.readings ?? [];
  const requests = inbox.data?.requests ?? [];

  // Flash a request that arrived since the last poll (not the ones already there on first load).
  const [fresh, setFresh] = useState<number | null>(null);
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!inbox.data) return;
    const ids = new Set(requests.map((r) => r.id));
    if (seen.current) setFresh(requests.find((r) => !seen.current!.has(r.id))?.id ?? null);
    seen.current = ids;
  }, [inbox.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickZone = (id: number) => {
    setZone(id); setReq(null);
    const z = sites.find((x) => x.id === id);
    if (z?.zip && readings.some((r) => r.zip === z.zip)) setZip(z.zip);
  };
  const pickReq = (id: number) => { setReq((cur) => (cur === id ? null : id)); setZone(null); };

  const a = d?.alerts[0];
  return <>
    <MapView sites={sites} calls={d?.calls ?? []} requests={requests} zone={zone} req={req} onZone={pickZone} onReq={pickReq} />
    <header className="top">
      <a className="glass pill brand" href="/" title="Shade home page">
        <div className="tk" dangerouslySetInnerHTML={{ __html: AST }} />
        <b>Shade</b><span>County operations</span>
      </a>
      {a && <div className="glass pill alert" role="status">
        <i></i><b>{ALERT[a.kind] + (d.alerts.length > 1 ? ` +${d.alerts.length - 1} more` : '')}</b>
        <span>{[`${a.zips.length} zip${a.zips.length === 1 ? '' : 's'}`, a.expires_at && `until ${clockAt(String(a.expires_at))}`].filter(Boolean).join(', ')}</span>
      </div>}
      <SendAlert zip={zip} />
      <a className="glass pill nav" href="/">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>Home page
      </a>
    </header>
    <ZonesPanel sites={sites} zone={zone} onZone={pickZone} onClear={() => setZone(null)}
      summary={st.error ? `Can't reach the Shade API at ${API}` : d?.source === 'seed' ? 'Seed data, not live' : ''} summaryTitle={st.error ?? undefined} />
    <SidePanel requests={requests} calls={inbox.data?.calls ?? []} reqError={inbox.error} req={req} fresh={fresh} onReq={pickReq}
      readings={readings} generatedAt={d?.generated_at ?? null} zip={zip} onZip={setZip} />
  </>;
}
