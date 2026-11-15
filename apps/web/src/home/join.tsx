// /join.html?for=alerts|volunteer: builds the exact JOIN message the Messenger bot parses and opens the Shadoes Page
// with it typed in. Nothing is sent from here; the resident presses send in Messenger.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './home.css';
import { Chart } from './Chart';
import { PHONE_E164, PHONE_SHOWN, joinMessage, messengerLink, phoneDigits, type JoinMode } from './contact';
import { BACK, BUBBLE, CHECK, COPY, STAR } from './icons';
import { SosBar } from './SosBar';

const COPYTEXT: Record<JoinMode, { title: string; lede: string; extra?: string }> = {
  alerts: {
    title: 'Get heat alerts on Messenger',
    lede: 'When extreme heat or wildfire smoke reaches your zip code, the Shadoes Page messages you the nearest cooling center open right now.',
  },
  volunteer: {
    title: 'Sign up to volunteer',
    lede: 'When someone calls Shade and needs a person to come, we message every volunteer with the area they are in. Reply YES and the request number to take it. Only the volunteer who says yes gets their exact location.',
    extra: 'You also get heat alerts for your zip code.',
  },
};

function Join() {
  const mode: JoinMode = new URLSearchParams(location.search).get('for') === 'volunteer' ? 'volunteer' : 'alerts';
  const t = COPYTEXT[mode];
  const [zip, setZip] = useState('');
  const [phone, setPhone] = useState('');
  const [touched, setTouched] = useState({ zip: false, phone: false });
  const [copied, setCopied] = useState(false);

  useEffect(() => { document.title = `Shade - ${t.title}`; }, [t.title]);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(id);
  }, [copied]);

  const zipOk = /^\d{5}$/.test(zip);
  const digits = phoneDigits(phone);
  const phoneOk = phone.trim() === '' || digits !== null;
  const ready = zipOk && phoneOk;
  const message = joinMessage(zipOk ? zip : '', digits, mode);
  const zipErr = touched.zip && !zipOk ? 'Enter your 5-digit zip code.' : '';
  const phoneErr = touched.phone && !phoneOk ? 'Enter a 10-digit US phone number, or leave it blank.' : '';

  const copy = async () => {
    setTouched({ zip: true, phone: true });
    if (!ready) return;
    try { await navigator.clipboard.writeText(message); setCopied(true); } catch { /* the message stays on screen to type */ }
  };

  return <>
    <Chart />
    <header className="top">
      <a className="glass pill brand" href="/"><span className="tk">{STAR}</span><b>Shade</b><span>San Diego County</span></a>
    </header>
    <main className="sheet">
      <section className="glass panel join" aria-labelledby="h">
        <a className="back" href="/"><span>{BACK}</span>Back</a>
        <h1 id="h">{t.title}</h1>
        <p className="lede">{t.lede}{t.extra && <> {t.extra}</>}</p>

        <form className="fields" noValidate onSubmit={(e) => {
          e.preventDefault();
          setTouched({ zip: true, phone: true });
          if (ready) location.href = messengerLink(message);
        }}>
          <label className={zipErr ? 'bad' : ''}>
            <span>Zip code</span>
            <input inputMode="numeric" autoComplete="postal-code" maxLength={5} placeholder="92105" value={zip}
              aria-invalid={!!zipErr} aria-describedby="zip-msg"
              onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={() => setTouched((x) => ({ ...x, zip: true }))} />
            <small id="zip-msg" role={zipErr ? 'alert' : undefined}>{zipErr}</small>
          </label>
          <label className={phoneErr ? 'bad' : ''}>
            <span>Phone number <em>{mode === 'volunteer' ? 'so callers can reach you' : 'optional'}</em></span>
            <input type="tel" inputMode="tel" autoComplete="tel-national" placeholder="(619) 555-0123" value={phone}
              aria-invalid={!!phoneErr} aria-describedby="phone-msg"
              onChange={(e) => setPhone(e.target.value.slice(0, 20))}
              onBlur={() => setTouched((x) => ({ ...x, phone: true }))} />
            <small id="phone-msg" role={phoneErr ? 'alert' : undefined}>
              {phoneErr || (mode === 'volunteer'
                ? 'When you say yes to a request, the caller gets this number so they can reach you.'
                : 'The number you call Shade from. Directions from a call then reach you on Messenger.')}
            </small>
          </label>

          <div className="preview" aria-live="polite">
            <span className="label">Your message</span>
            <p className="bubble"><span className="msg">{message}</span></p>
          </div>

          <button className="act fill" type="submit" aria-disabled={!ready}>
            <span className="ic">{BUBBLE}</span>Open Messenger
          </button>
          <button className="act" type="button" onClick={copy} aria-disabled={!ready}>
            <span className="ic">{copied ? CHECK : COPY}</span>{copied ? 'Copied' : 'Copy message'}
          </button>
        </form>

        <p className="fine">
          Messenger opens the Shadoes Page with your message typed in. Press send. Send STOP anytime to stop messages.
        </p>
        <p className="fine">No Messenger? Call <a href={`tel:${PHONE_E164}`}>{PHONE_SHOWN}</a>.</p>
        <p className="sos">Confused, fainting, or no longer sweating in the heat? <a href="tel:911">Call 911</a>.</p>
      </section>
    </main>
    <SosBar />
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Join /></StrictMode>);
