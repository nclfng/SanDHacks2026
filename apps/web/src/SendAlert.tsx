// Sends a test heat alert to everyone subscribed in one zip: POST /m4/alerts/mock (apps/api/src/m4/mastra/routes.ts).
// The route only answers with the shared secret M4_ALERT_SECRET. The page asks for it once and keeps it in this
// browser's localStorage, so it never ends up in the code, the build or a URL.
import { useEffect, useState } from 'react';
import { API } from './api';

const SECRET_KEY = 'shade.alertSecret';

function storedSecret(): string | null {
  try { return localStorage.getItem(SECRET_KEY); } catch { return null; }
}
function storeSecret(value: string | null) {
  try { value ? localStorage.setItem(SECRET_KEY, value) : localStorage.removeItem(SECRET_KEY); } catch { /* private mode */ }
}

type Result = { ok: boolean; text: string } | null;

export function SendAlert({ zip }: { zip: string | null }) {
  const [value, setValue] = useState(zip ?? '92105');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  // Follow the zip picked on the map or in the readings panel.
  useEffect(() => { if (zip) setValue(zip); }, [zip]);
  // A result stays up for a few seconds.
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 8000);
    return () => clearTimeout(t);
  }, [result]);

  const valid = /^\d{5}$/.test(value);

  const send = async () => {
    if (!valid || busy) return;
    if (!confirm(`Send a test heat alert to everyone subscribed in ${value}? It messages them for real.`)) return;
    let secret = storedSecret();
    if (!secret) {
      secret = prompt('Alert secret (M4_ALERT_SECRET from the server .env)')?.trim() || null;
      if (!secret) return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/m4/alerts/mock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ zips: [value], headline: `Test alert from the dashboard for ${value}` }),
      });
      if (res.status === 401) {
        storeSecret(null);   // wrong or missing on the server: ask again next time
        setResult({ ok: false, text: 'Wrong alert secret. Try again.' });
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({ ok: false, text: body?.error ?? `Failed (HTTP ${res.status})` });
        return;
      }
      storeSecret(secret);
      const sent = Number(body?.alert?.texts_sent ?? 0);
      setResult({
        ok: true,
        text: sent > 0 ? `Sent to ${value}: ${sent} message${sent === 1 ? '' : 's'}` : `Sent to ${value}, but no subscriber there could be reached`,
      });
    } catch {
      setResult({ ok: false, text: `Can't reach the Shade API at ${API}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="glass pill sendalert" onSubmit={(e) => { e.preventDefault(); send(); }} aria-label="Send a test alert by zip code">
      <label htmlFor="alertzip">Test alert</label>
      <input id="alertzip" inputMode="numeric" pattern="\d{5}" maxLength={5} placeholder="Zip" autoComplete="off"
        value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 5))} />
      <button className="btn" type="submit" disabled={!valid || busy}>{busy ? 'Sending…' : 'Send alert'}</button>
      {result && <span className={result.ok ? 'ok' : 'err'} role="status">{result.text}</span>}
    </form>
  );
}
