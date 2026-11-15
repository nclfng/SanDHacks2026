import { getLatestReading, getMessengerProfileByPhone, getSite, insertCall, setOptedOut } from '../db';
import { env } from '../env';
import { deliverNowIfWindowOpen, queueFollowup } from '../messenger/followups';
import { hashPhone, maskPhone, toE164 } from '../phone';
import { isOptedOut } from '../subscribers/consent';
import { LANGUAGES } from '../types';
import type { AlertChannel, Language, MessengerContact, Reading, SendSmsInput, SendSmsOutput } from '../types';
import { siteMessage, type PartyInfo } from './templates';
import { sendTwilioSms, sendTwilioWhatsApp, TwilioError, type WhatsAppTemplate } from './twilio';

// 'site': one site's details (send_sms). 'alert': alert fan-out. 'reply': text agent answer.
// 'system': opt-in, opt-out and help confirmations. calls has no column for it, so it only shapes log lines.
export type TextPurpose = 'site' | 'alert' | 'reply' | 'system';

export interface SendTextInput {
  to: string; // E.164
  body: string;
  purpose: TextPurpose;
  channel?: AlertChannel; // default 'sms'
  // WhatsApp only: an approved template, for a message more than 24 hours after the person last wrote. body is
  // then only used for logs; the template's text is what is delivered.
  template?: WhatsAppTemplate;
  alertId?: number;
  siteId?: number;
  zip?: string;
  language?: Language;
}

// Twilio rejects a longer body outright.
const MAX_BODY_LENGTH = 1600;
// Twilio's code for "this number replied STOP to Twilio itself".
const TWILIO_RECIPIENT_OPTED_OUT = 21610;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

// The one guarded send path every outbound text goes through. It never throws: a failure comes back as
// { ok: false, error }, with one of invalid_number, invalid_body, opted_out, opt_out_check_failed,
// twilio_<code> or send_failed.
// It enforces opt-out only. Opt-in consent is the caller's job: the alert flow reads active subscribers,
// and a mid-call request counts as consent for that one text.
// It does not dedupe per alert (db.hasAlertText), bump alerts.texts_sent or write to messages.
// Only a text that was sent gets a calls row. A failed send is logged to the console and nowhere else.
export async function sendText(input: SendTextInput): Promise<SendSmsOutput> {
  const to = toE164(input.to);
  if (!to) return { ok: false, error: 'invalid_number' };
  if (!input.body.trim() || input.body.length > MAX_BODY_LENGTH) return { ok: false, error: 'invalid_body' };
  const channel: AlertChannel = input.channel === 'whatsapp' ? 'whatsapp' : 'sms';
  const label = `${input.purpose} ${channel === 'whatsapp' ? 'WhatsApp message' : 'text'} to ${maskPhone(to)}`;

  // Fail closed: with no answer on opt-out, nothing is sent.
  try {
    if (await isOptedOut(to)) return { ok: false, error: 'opted_out' };
  } catch (error) {
    console.warn(`[m4] ${label} not sent: the opt-out check failed (${reason(error)})`);
    return { ok: false, error: 'opt_out_check_failed' };
  }

  try {
    if (channel === 'whatsapp') await sendTwilioWhatsApp({ to, body: input.body, template: input.template });
    else await sendTwilioSms({ to, body: input.body });
  } catch (error) {
    console.warn(`[m4] ${label} not sent: ${reason(error)}`);
    const code = error instanceof TwilioError ? error.code : null;
    // Twilio keeps its own opt-out list. Copy a STOP it knows about, so we stop trying this number.
    if (code === TWILIO_RECIPIENT_OPTED_OUT) {
      await setOptedOut(hashPhone(to), new Date()).catch(() => undefined);
    }
    return { ok: false, error: code ? `twilio_${code}` : 'send_failed' };
  }

  // The text is out. If the log row fails, still report success so the caller does not send it again.
  try {
    await insertCall({
      direction: 'outbound',
      channel,
      phoneHash: hashPhone(to),
      zip: input.zip ?? null,
      language: input.language ?? null,
      siteId: input.siteId ?? null,
      outcome: 'sms_sent',
      alertId: input.alertId ?? null,
    });
  } catch (error) {
    console.error(`[m4] ${label} was sent but its calls row was not written (${reason(error)})`);
  }
  return { ok: true };
}

// What the voice agent tells the caller (SendSmsOutput.note). Instructions to the voice model, which speaks the
// caller's language, so they stay in English.
// Sent now: the caller messaged the Page in the last 24 hours, so Facebook let it go out straight away.
const NOTE_SENT_TO_MESSENGER =
  "Sent to the caller's Facebook Messenger just now. Tell them the address, today's hours and a map link are " +
  'waiting in their Messenger from the Shadoes Page. Do not call it a text message. Offer to read the address out too.';
// Held: they have not messaged the Page in 24 hours, and Facebook only lets the Page reply after they write.
const NOTE_HELD_FOR_MESSENGER =
  "Saved for the caller's Facebook Messenger. Facebook only lets the Shadoes Page reply after they message it, so " +
  'tell them: send any message to the Shadoes Facebook Page, and the address, hours and map link come right back. ' +
  'Do not call it a text message. Offer to read the address out now too.';
const NOTE_NO_MESSENGER =
  'Not sent: Shade cannot send text messages right now. Read the address out so the caller can write it down. Tell ' +
  'them that to get addresses on Facebook Messenger next time, they can message the Shadoes Facebook Page "JOIN", ' +
  'their zip code and this phone number, for example "JOIN 92105 6195551234".';

// The shared contract function. M3's voice agent calls this when a caller asks to be texted a site.
// Builds the site text from site_id. Messenger first: when the caller's number is linked to a Messenger profile
// (JOIN <zip> <phone>), the text is held and sent the next time they message the Page (messenger/followups.ts).
// Otherwise nothing is sent, unless M4_SMS_ENABLED=1, when it goes out by SMS through sendText (or, with
// M4_SMS_DRY_RUN=1, is only logged there).
// No subscriber row is needed: a caller asking for a text mid-call is consent for that one message. An opted-out
// number is still refused. Never throws. Errors on top of sendText's: site_not_found, lookup_failed,
// no_messenger_profile, followup_failed. `note` tells the voice agent what to say about delivery.
export async function sendSms(input: SendSmsInput): Promise<SendSmsOutput> {
  const language = input.language ?? 'en';
  const to = toE164(input.to);
  if (!to) return { ok: false, error: 'invalid_number' };

  let body: string;
  let messengerBody: string;
  let siteId: number;
  try {
    // Group size and assistance from the voice intake, when the agent passed them.
    const party: PartyInfo = {
      size: input.party_size,
      needsAssistance: input.needs_assistance,
      details: input.assistance_details,
    };
    const text = await siteText(input.site_id, language, party);
    if (!text) return { ok: false, error: 'site_not_found' };
    ({ body, messengerBody, siteId } = text);
  } catch (error) {
    console.warn(`[m4] send_sms for site ${input.site_id} failed before sending (${reason(error)})`);
    return { ok: false, error: 'lookup_failed' };
  }

  // Fail closed, as sendText does: with no answer on opt-out, nothing is held or sent.
  let profile: MessengerContact | null;
  try {
    if (await isOptedOut(to)) return { ok: false, error: 'opted_out' };
    profile = await getMessengerProfileByPhone(hashPhone(to));
  } catch (error) {
    console.warn(`[m4] send_sms to ${maskPhone(to)} not handled: a lookup failed (${reason(error)})`);
    return { ok: false, error: 'lookup_failed' };
  }

  if (profile) {
    try {
      // Not deduped: a caller who asks again for a site they got earlier gets it again.
      await queueFollowup({ profile, body: messengerBody, siteId, language, dedupe: false });
      // Out now when Facebook allows it; otherwise it waits for their next message to the Page.
      const sentNow = await deliverNowIfWindowOpen(profile);
      return { ok: true, note: sentNow ? NOTE_SENT_TO_MESSENGER : NOTE_HELD_FOR_MESSENGER };
    } catch (error) {
      console.warn(`[m4] send_sms to ${maskPhone(to)}: follow-up not saved (${reason(error)})`);
      return { ok: false, error: 'followup_failed', note: NOTE_NO_MESSENGER };
    }
  }
  // With M4_SMS_DRY_RUN=1 the SMS path only logs the text, which the demo shows in place of a real text
  // (docs/DEMO.md), so it is allowed through: nothing reaches a phone.
  if (!env.smsEnabled() && !env.smsDryRun()) {
    return { ok: false, error: 'no_messenger_profile', note: NOTE_NO_MESSENGER };
  }

  // zip stays unset: the dashboard reads calls.zip as demand by zip, SendSmsInput does not carry the caller's
  // zip, and site.zip is not the same thing.
  // TODO: Settle with M3 and M2 whether this row should carry site_id at all. M3 already logs the inbound
  //       voice call with the same site_id, so recent_referrals() in the ranking would count it twice.
  return sendText({ to, body, purpose: 'site', siteId, language });
}

// The site text for one site (address, hours today, AQI, map link), or null when there is no such site. Throws on
// a database failure. `body` is the plain SMS layout, `messengerBody` the Messenger one.
async function siteText(
  siteId: number,
  language: Language,
  party?: PartyInfo,
): Promise<{ body: string; messengerBody: string; siteId: number } | null> {
  const site = await getSite(siteId);
  if (!site) return null;
  // A missing air quality reading must not hold the text back.
  const reading: Reading | null = site.zip ? await getLatestReading(site.zip).catch(() => null) : null;
  return {
    body: siteMessage({ site, reading, language, party }),
    messengerBody: siteMessage({ site, reading, language, style: 'messenger', party }),
    siteId: site.id,
  };
}

export type CallFollowupResult =
  | 'sent'
  | 'queued'
  | 'already_queued'
  | 'no_site'
  | 'no_profile'
  | 'opted_out'
  | 'failed';

// Mode 1, automatic: called when a voice call ends (elevenlabs/post-call.ts). When the caller was given a site and
// their number is linked to a Messenger profile (JOIN <zip> <phone>), the site details go to that profile without
// anyone having to ask for a text: linking Messenger is their opt-in to hearing from Shade there. 'sent' when they
// messaged the Page in the last 24 hours, so it went out at once; 'queued' when it waits for their next message.
// Callers without a linked profile get nothing. A site already handled for them in the last 2 hours (send_sms
// during the same call) is not sent twice. Never throws.
export async function followUpAfterCall(args: {
  phoneE164: string;
  siteId: number | null;
  language?: string | null;
}): Promise<CallFollowupResult> {
  const to = toE164(args.phoneE164);
  if (!to || !args.siteId) return 'no_site';
  const language: Language = (LANGUAGES as readonly string[]).includes(args.language ?? '')
    ? (args.language as Language)
    : 'en';
  try {
    if (await isOptedOut(to)) return 'opted_out';
    const profile = await getMessengerProfileByPhone(hashPhone(to));
    if (!profile) return 'no_profile';
    const text = await siteText(args.siteId, language);
    if (!text) return 'no_site';
    const queued = await queueFollowup({ profile, body: text.messengerBody, siteId: text.siteId, language });
    if (!queued) return 'already_queued';
    return (await deliverNowIfWindowOpen(profile)) ? 'sent' : 'queued';
  } catch (error) {
    console.warn(`[m4] follow-up after a call from ${maskPhone(to)} not held (${reason(error)})`);
    return 'failed';
  }
}
