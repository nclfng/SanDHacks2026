// How residents reach Shade. The phone line is the Twilio number ElevenLabs answers; the Messenger Page is "Shadoes",
// the sender POST /m4/twilio/messenger serves. JOIN's grammar is apps/api/src/m4/messenger/join.ts.
export const PHONE_E164 = '+16193938334';
export const PHONE_SHOWN = '(619) 393-8334';
export const MESSENGER_PAGE_ID = '1400747643128537';

export type JoinMode = 'alerts' | 'volunteer';

/** 10 digits for a US number typed any way ("(619) 555-0100", "+1 619 555 0100"), else null. */
export function phoneDigits(typed: string): string | null {
  const d = typed.replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return null;
}

/** The exact message the bot parses: JOIN <zip> [phone] [VOLUNTEER]. */
export function joinMessage(zip: string, phone: string | null, mode: JoinMode): string {
  return ['JOIN', zip || '<ZIP>', phone ?? '', mode === 'volunteer' ? 'VOLUNTEER' : ''].filter(Boolean).join(' ');
}

/** Opens Messenger to the Page with `text` typed in (m.me's text parameter); the person still presses send. */
export const messengerLink = (text: string) => `https://m.me/${MESSENGER_PAGE_ID}?text=${encodeURIComponent(text)}`;
