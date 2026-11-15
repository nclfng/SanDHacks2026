// Resident home at /: the county's open cool zones on the chart, and the three ways in (call, alerts, volunteer).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './home.css';
import { Chart, type OpenCount } from './Chart';
import { PHONE_E164, PHONE_SHOWN } from './contact';
import { ARROW, BELL, HANDS, PHONE, STAR } from './icons';
import { SosBar } from './SosBar';

function Home() {
  const [open, setOpen] = useState<OpenCount | null>(null);
  return <>
    <Chart onCount={setOpen} />
    <header className="top">
      <a className="glass pill brand" href="/"><span className="tk">{STAR}</span><b>Shade</b><span>San Diego County</span></a>
      <a className="glass pill nav" href="/dashboard.html">Ops dashboard<span className="go">{ARROW}</span></a>
    </header>
    <main className="sheet">
      <section className="glass panel hero" aria-labelledby="h">
        <h1 id="h">Cool air is one call&nbsp;away.</h1>
        <p className="lede">
          In extreme heat or wildfire smoke, call Shade and say where you are. We find the nearest cooling center
          that's open right now and tell you how to get there.
        </p>
        {open && open.official + open.discovered > 0 && (
          <p className="live">
            {/* each legend dot stays with its label when the line wraps */}
            {open.official > 0 && <span className="grp"><i className="dot off" aria-hidden="true" /><span><b>{open.official}</b> cooling {open.official === 1 ? 'center' : 'centers'}</span></span>}
            {open.discovered > 0 && <span className="grp"><i className="dot disc" aria-hidden="true" /><span><b>{open.discovered}</b> {open.official > 0 ? 'other ' : ''}cool {open.discovered === 1 ? 'place' : 'places'}</span></span>}
            <span className="now">open now</span>
          </p>
        )}

        <a className="call" href={`tel:${PHONE_E164}`}>
          <span className="ic">{PHONE}</span>
          <span className="say"><b>Call now</b><small className="sub">Any phone, any language</small><small className="numline">{PHONE_SHOWN}</small></span>
          <span className="num">{PHONE_SHOWN}</span>
        </a>

        <nav className="pair" aria-label="Messenger">
          <a className="opt" href="/join.html?for=alerts">
            <span className="ic">{BELL}</span>
            <span className="say"><b>Get heat alerts</b><small>On Messenger</small></span>
            <span className="go">{ARROW}</span>
          </a>
          <a className="opt" href="/join.html?for=volunteer">
            <span className="ic">{HANDS}</span>
            <span className="say"><b>Volunteer</b><small>Help neighbors</small></span>
            <span className="go">{ARROW}</span>
          </a>
        </nav>

        <p className="sos">
          Confused, fainting, or no longer sweating in the heat? <a href="tel:911">Call 911</a>.
          Shade is not an emergency service.
        </p>
      </section>
    </main>
    <SosBar />
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Home /></StrictMode>);
