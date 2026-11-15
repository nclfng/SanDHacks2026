import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CallEvent, HelpRequest, LiveCall, ReadingRow } from './api';
import { Card } from './Card';
import { LANG, SOURCE, clockAt, deg, stamp, stage, whenAt } from './format';

interface Props {
  requests: HelpRequest[]; calls: LiveCall[]; reqError: string | null; req: number | null; fresh: number | null; onReq(id: number): void; onClose(): void;
  readings: ReadingRow[]; generatedAt: string | null; zip: string | null; onZip(zip: string): void;
}

export function SidePanel(p: Props) {
  const r = p.requests.find((x) => x.id === p.req);
  return <>
    <aside className="glass panel" id="side">
      <Requests {...p} />
      <Readings {...p} />
    </aside>
    <Card id="rcard" item={r} label={(x) => x.location} onClose={p.onClose}>{(x) => <RequestDetail key={x.id} r={x} readings={p.readings} />}</Card>
  </>;
}

const meta = (r: HelpRequest, readings: ReadingRow[]) => [readings.find((x) => x.zip === r.zip)?.area ?? r.zip,
  `Call${r.language && LANG[r.language] ? `, ${LANG[r.language]}` : ''}`, clockAt(r.created_at)].filter(Boolean).join(' · ');

/* ---------- help requests (GET /dispatch/requests) ---------- */
function Requests({ requests, calls, reqError, req, fresh, onReq, readings }: Props) {
  const [open, setOpen] = useState(new Set<number>());
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // A request picked on its map marker scrolls into view. Small screens stack the list under the map,
  // so scrolling there would carry the page away from the marker's popup.
  const selRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (req != null && matchMedia('(min-width: 1001px)').matches) selRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [req]);
  const count = (st: string) => requests.filter((r) => r.status === st).length;
  const summary = reqError ? `Can't load help requests (${reqError})`
    : `${calls.length ? `${calls.length} on call, ` : ''}${count('requesting')} locating help, ${count('incoming')} help incoming`;
  const sorted = [...requests].sort((a, b) => +(a.status === 'incoming') - +(b.status === 'incoming'));

  return (
    <section className="scroll" aria-labelledby="qh">
      <div className="head">
        <h2 id="qh">Help requests</h2>
        <p role="status">{summary}</p>
      </div>
      <div>
        {calls.map((c) => (
          <article key={`c${c.id}`} className="req-row call">
            <h3>Call in progress</h3><span className="meta">No help request yet · started {clockAt(c.started_at)}</span>
            <button className="agent live" aria-expanded={open.has(c.id)} title="Show every step of this call" onClick={() => toggle(c.id)}>
              <Step {...stage(c.events)} events={c.events} />
              <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>
            </button>
            {open.has(c.id) && <Log events={c.events} />}
          </article>
        ))}
        {sorted.map((r) => (
          <button key={r.id} ref={req === r.id ? selRef : undefined} className={`req-row ${req === r.id ? 'sel' : ''} ${fresh === r.id ? 'new' : ''}`}
            aria-pressed={req === r.id} onClick={() => onReq(r.id)}>
            <h3>{r.location}</h3>
            <span className="meta">{meta(r, readings)}</span>
            {r.needs.length > 0 && <span className="chips">{r.needs.map((x) => <span key={x} className="chip">{x}</span>)}</span>}
            <span className={`agent ${r.status === 'requesting' ? 'live' : ''}`}><Step {...stage(r.events ?? [], r.status)} events={r.events ?? []} /></span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** The picked request opens in a second panel beside the list; picking another swaps its content in place. */
function RequestDetail({ r, readings }: { r: HelpRequest; readings: ReadingRow[] }) {
  const { pill, label } = stage(r.events ?? [], r.status);
  return (
    <div className="scroll detail">
      <h3>{r.location}</h3>
      <span className="sub">{meta(r, readings)}</span>
      <p className="status"><span className={`st ${pill}`}>{label}</span></p>
      {r.needs.length > 0 && <div className="chips">{r.needs.map((x) => <span key={x} className="chip">{x}</span>)}</div>}
      <p className="said">“{r.said}”</p>
      {r.events?.length ? <Log events={r.events} /> : <p className="dim">No steps recorded</p>}
    </div>
  );
}

/** Status pill and the latest step. A `.live` parent shimmers it while the call or a neighbor's answer is still pending. */
const Step = ({ pill, label, events }: { pill: string; label: string; events: CallEvent[] }) =>
  <><span className={`st ${pill}`}>{label}</span><span className="now">{events.at(-1)?.text ?? 'No steps recorded'}</span></>;

const Log = ({ events }: { events: CallEvent[] }) => (
  <ol className="log" aria-label="Every step of this call, oldest first">
    {events.map((e, i) => <li key={i} style={{ '--i': i } as CSSProperties}>{e.text}<small>{stamp(e.at)}</small></li>)}
  </ol>
);

/* ---------- readings ---------- */
function Readings({ readings, generatedAt, zip, onZip }: Props) {
  const heat = (r: ReadingRow) => r.heat_index ?? r.temp_f ?? -Infinity;
  const all = [...readings].sort((a, b) => heat(b) - heat(a));
  const r = all.find((x) => x.zip === zip) ?? all[0];   // default to the hottest zip
  const shown = all.slice(0, 3);   // the three hottest zips; the selected one is added if it isn't among them
  if (r && !shown.includes(r)) shown.push(r);
  const future = r && generatedAt && new Date(r.time) > new Date(generatedAt);

  return (
    <section className="rule" id="readings" aria-labelledby="rh" style={{ paddingBottom: 8 }}>
      <div className="head">
        <h2 id="rh">Readings</h2>
        <p>{!r ? 'No readings yet' : r.area === r.zip ? r.zip : `${r.area} ${r.zip}`}</p>
      </div>
      {r && <>
        <div className="now" key={r.zip}>
          <div><b>{deg(r.temp_f)}</b><span>Temperature</span></div>
          <div><b>{deg(r.heat_index)}</b><span>Feels like</span></div>
        </div>
        <p className="note">{SOURCE[r.source]} {future ? 'forecast for' : 'reading at'} {whenAt(r.time)}.</p>
        <div className="rrow rhead"><span>Area</span><span>Temp</span><span>Feels</span></div>
        <div>{shown.map((x) => (
          <button key={x.zip} className="rrow" aria-pressed={x.zip === r.zip} onClick={() => onZip(x.zip)}>
            <span className="area">{x.area === x.zip ? '' : x.area}<small className="mono">{x.zip}</small></span>
            <span className="n">{deg(x.temp_f)}</span><span className="n">{deg(x.heat_index)}</span>
          </button>
        ))}</div>
      </>}
    </section>
  );
}
