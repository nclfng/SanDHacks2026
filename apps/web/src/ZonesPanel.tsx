import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { get, type SiteDetail, type Zone } from './api';
import { Card } from './Card';
import { DAY, KIND, hoursSpan, href, to12h, todayIndex } from './format';

const Tag = ({ z }: { z: Zone }) => z.tier === 'official' ? <span className="ztag cz">Cool Zone</span> : <span className="ztag ps">Public Space</span>;
// The state only carries open sites, so a null closes_at means open 24 hours.

interface Props { sites: Zone[]; summary: string; summaryTitle?: string; zone: number | null; onZone(id: number): void; onClear(): void }

export function ZonesPanel({ sites, summary, summaryTitle, zone, onZone, onClear }: Props) {
  const [q, setQ] = useState('');
  const z = sites.find((x) => x.id === zone);
  const needle = q.trim().toLowerCase();
  const official = (x: Zone) => +(x.tier === 'official');
  const rows = sites.filter((x) => x.name.toLowerCase().includes(needle))
    .sort((a, b) => official(b) - official(a) || b.referrals_24h - a.referrals_24h || a.name.localeCompare(b.name));

  return <>
    <section className="glass panel" id="zones" aria-labelledby="zh">
      <div className="head">
        <h2 id="zh">Cool zones</h2>
        <p title={summaryTitle}>{summary}</p>
        <input type="search" placeholder="Search by name" aria-label="Search cool zones by name" autoComplete="off"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="scroll" id="zlist">
        {rows.length ? rows.map((x) => (
          <button key={x.id} className={`zrow ${zone === x.id ? 'sel' : ''}`} aria-pressed={zone === x.id} title={`${x.address}. Today: ${x.hours_today}`} onClick={() => onZone(x.id)}>
            <span><h3>{x.name}</h3><span className="sub"><Tag z={x} />{KIND[x.kind]}</span></span>
            <span className="closes">{x.closes_at ? <>{to12h(x.closes_at)}<small>closes</small></> : <>24 hours<small>open</small></>}</span>
          </button>
        )) : <p className="none">{needle ? 'No open cool zone matches that name.' : 'No cool zones are open right now.'}</p>}
      </div>
      <div className="legend rule">
        <p><svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>Caller markers on the map</p>
        <i className="tk req"></i><span>Locating help: waiting for a neighbor to say yes</span>
        <i className="tk req incoming"></i><span>Help incoming: a neighbor said yes</span>
        <i className="dot"></i><span>People who called or texted in from this zip, last 24h</span>
      </div>
    </section>
    {/* The selected zone opens in a second panel beside the list; switching zones swaps its content in place. */}
    <Card id="zcard" item={z} label={(x) => x.name} onClose={onClear}>{(x) => <ZoneDetail key={x.id} z={x} />}</Card>
  </>;
}

/** GET /dashboard/sites/:id adds what the snapshot leaves out, and Google Places. */
function ZoneDetail({ z }: { z: Zone }) {
  const [d, setD] = useState<SiteDetail | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    get<SiteDetail>(`/dashboard/sites/${z.id}`).then((r) => live && setD(r), () => live && setD('failed'));
    return () => { live = false; };
  }, [z.id]);

  const det = d && d !== 'failed' ? d : null, g = det?.google;
  const today = todayIndex();
  const note = g?.status && g.status !== 'OPERATIONAL' ? `Google lists this place as ${g.status.toLowerCase().replace(/_/g, ' ')}.` : '';
  const maps = href(g?.maps_url) ?? href(det?.maps_url), web = href(g?.website) ?? href(det?.source_url);
  const tel = det?.phone?.replace(/[^+\d]/g, '');
  const row = (k: string, v: ReactNode) => v ? <><dt>{k}</dt><dd>{v}</dd></> : null;

  return (
    <div className="scroll detail">
      {href(g?.photo) && <img src={href(g?.photo)} alt="" onLoad={(e) => e.currentTarget.classList.add('loaded')} />}
      <h3>{z.name}</h3>
      <span className="sub"><Tag z={z} />{det?.category || KIND[z.kind]}{g?.rating ? ` · ★ ${g.rating} (${g.ratings} on Google)` : ''}</span>
      <p className="status">{z.closes_at ? `Open until ${to12h(z.closes_at)}` : 'Open 24 hours'}</p>
      {note && <p className="dim">{note}</p>}
      {g?.summary && <p className="dim" style={{ marginTop: 8 }}>{g.summary}</p>}
      <dl style={{ marginTop: 14 }}>
        {row('Address', z.address)}
        {row('Phone', det?.phone && <a href={`tel:${tel}`}>{det.phone}</a>)}
        {row('Access', det?.access_notes)}
        {row('Pets', det?.pet_policy)}
      </dl>
      {det ? <>
        <h4 className="late">Hours</h4>
        <dl className="late">{[1, 2, 3, 4, 5, 6, 0].map((n) => {
          const v = det.hours.weekly.filter((i) => i.day === n).map(hoursSpan).join(', ') || 'Closed';
          const cls = n === today ? 'today' : undefined;
          return <Fragment key={n}><dt className={cls}>{DAY[n]}</dt><dd className={cls}>{v}</dd></Fragment>;
        })}</dl>
      </> : <p className="dim" style={{ marginTop: 14 }}>{d === 'failed' ? 'Could not load more details.' : 'Loading details…'}</p>}
      <div className="links">
        {maps && <a className="btn" href={maps} target="_blank" rel="noopener">Open in Google Maps</a>}
        {web && <a className="btn ghost" href={web} target="_blank" rel="noopener">Website</a>}
      </div>
    </div>
  );
}
