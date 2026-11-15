import { insertCall, lastInboundAt } from '../db';
import { sendTwilioMessenger, TwilioError } from '../sms/twilio';
import type { Language, MessengerContact, SendSmsOutput } from '../types';
import { hashMessengerId, messengerLogLabel } from './identity';

// Twilio rejects a longer body outright. Messenger's own limit (2,000) is higher.
const MAX_BODY_LENGTH = 1600;

// Facebook lets a Page message someone for this long after their last message. Later messages would need a
// message tag, and none of Facebook's tags covers alerts, so Shade does not send them.
export const MESSENGER_WINDOW_HOURS = 24;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function failure(error: unknown): SendSmsOutput {
  const code = error instanceof TwilioError ? error.code : null;
  return { ok: false, error: code ? `twilio_${code}` : 'send_failed' };
}

// Answers one inbound Messenger message. pageId and psid are bare ids: the inbound To and From, minus
// 'messenger:'. Never throws: a failure comes back as { ok: false, error }, with one of invalid_body,
// twilio_<code> or send_failed.
// It answers a message that just arrived, so it is always inside the 24-hour window and needs no consent check.
// No calls row is written for the reply, as with SMS replies: the inbound row already records the exchange.
export async function sendMessengerReply(args: { pageId: string; psid: string; body: string }): Promise<SendSmsOutput> {
  if (!args.body.trim() || args.body.length > MAX_BODY_LENGTH) return { ok: false, error: 'invalid_body' };
  try {
    await sendTwilioMessenger(args);
    return { ok: true };
  } catch (error) {
    console.warn(`[m4] reply to ${messengerLogLabel(hashMessengerId(args.psid))} not sent: ${reason(error)}`);
    return failure(error);
  }
}

// Sends one message the person did not just ask for (an alert, a neighbor's help request), from the Page they
// joined on. Never throws. On top of sendMessengerReply's errors it returns messenger_window_closed when they have
// not written in the last MESSENGER_WINDOW_HOURS (from the inbound calls rows); an unknown window counts as closed.
// Writes no calls row. `what` names the message in logs.
export async function sendMessengerInWindow(contact: MessengerContact, body: string, what: string): Promise<SendSmsOutput> {
  if (!body.trim() || body.length > MAX_BODY_LENGTH) return { ok: false, error: 'invalid_body' };
  const last = await lastInboundAt(contact.phone_hash, 'messenger').catch(() => null);
  if (!last || Date.now() - last.getTime() >= MESSENGER_WINDOW_HOURS * 3600_000) {
    return { ok: false, error: 'messenger_window_closed' };
  }
  try {
    await sendTwilioMessenger({ pageId: contact.messenger_page_id, psid: contact.messenger_psid, body });
    return { ok: true };
  } catch (error) {
    console.warn(`[m4] ${what} to ${messengerLogLabel(contact.phone_hash)} not sent: ${reason(error)}`);
    return failure(error);
  }
}

// Sends one alert to an opted-in Messenger subscriber through sendMessengerInWindow. Never throws.
// A sent alert gets a calls row (outbound, messenger, outcome sms_sent, alert_id), which is what the per-alert
// and cooldown guards in alerts/dispatch.ts read. The caller has already checked that this person is opted in.
export async function sendMessengerAlert(args: {
  contact: MessengerContact;
  body: string;
  alertId: number;
  siteId?: number;
  zip: string;
  language: Language;
}): Promise<SendSmsOutput> {
  const { contact } = args;
  const label = messengerLogLabel(contact.phone_hash);
  const sent = await sendMessengerInWindow(contact, args.body, `alert ${args.alertId}`);
  if (!sent.ok) return sent;

  // The alert is out. If the log row fails, still report success so it is not sent again.
  await insertCall({
    direction: 'outbound',
    channel: 'messenger',
    phoneHash: contact.phone_hash,
    zip: args.zip,
    language: args.language,
    siteId: args.siteId ?? null,
    outcome: 'sms_sent',
    alertId: args.alertId,
  }).catch((error) => console.error(`[m4] alert ${args.alertId} to ${label} was sent but its calls row was not written (${reason(error)})`));
  return { ok: true };
}
