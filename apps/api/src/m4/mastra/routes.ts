import { timingSafeEqual } from 'node:crypto';
import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { triggerMockAlert } from '../alerts/dispatch';
import { checkReadingAlerts } from '../alerts/readings';
import { env } from '../env';
import { validateTwilioSignature } from '../sms/twilio';
import { handleInboundSms } from '../subscribers/inbound';
import { handleInboundMessenger, parseMessengerWebhook } from '../messenger/inbound';
import { fromWhatsAppAddress } from '../phone';

// M4's HTTP surface. Custom routes mount at the server root, so the paths below are the full paths.
// They cannot start with the server's apiPrefix (default /api), which Mastra reserves for its built-in routes.

const TWILIO_SMS_PATH = '/m4/twilio/sms';
const TWILIO_MESSENGER_PATH = '/m4/twilio/messenger';
const TWILIO_WHATSAPP_PATH = '/m4/twilio/whatsapp';
const MOCK_ALERT_PATH = '/m4/alerts/mock';
const CHECK_READINGS_PATH = '/m4/alerts/check-readings';

// The fields read from Twilio's form post. The signature check still covers every field Twilio sent.
const twilioSmsParams = z.object({
  From: z.string().min(1),
  Body: z.string().default(''),
  MessageSid: z.string().min(1),
});

const mockAlertBody = z.object({
  zips: z.array(z.string().regex(/^\d{5}$/)).min(1),
  headline: z.string().min(1).optional(),
});

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// TwiML for the webhook response: one <Message> when there is a reply, an empty <Response/> otherwise.
function twiml(reply: string | null): string {
  const header = '<?xml version="1.0" encoding="UTF-8"?>';
  return reply
    ? `${header}<Response><Message>${escapeXml(reply)}</Message></Response>`
    : `${header}<Response/>`;
}

// The string fields of a Twilio webhook's form post, or null when X-Twilio-Signature does not match them.
// Twilio signs the public URL it called (PUBLIC_BASE_URL + path + query string), not the local one behind the
// tunnel, and the signature covers every field it sent.
function verifiedTwilioParams(args: {
  form: Record<string, unknown>;
  path: string;
  requestUrl: string;
  signature: string | undefined;
}): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.form)) {
    if (typeof value === 'string') params[key] = value;
  }
  const url = env.publicBaseUrl().replace(/\/+$/, '') + args.path + new URL(args.requestUrl).search;
  if (!args.signature || !validateTwilioSignature({ signature: args.signature, url, params })) return null;
  return params;
}

// Twilio inbound-message webhook. Twilio cannot log in, so Mastra auth is off and the signature is the gate.
const twilioSmsRoute = registerApiRoute(TWILIO_SMS_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    const params = verifiedTwilioParams({
      form: await c.req.parseBody(),
      path: TWILIO_SMS_PATH,
      requestUrl: c.req.url,
      signature: c.req.header('x-twilio-signature'),
    });
    if (!params) {
      c.get('mastra').getLogger()?.warn('Rejected Twilio SMS webhook: missing or invalid signature');
      return c.text('Forbidden', 403);
    }

    const parsed = twilioSmsParams.safeParse(params);
    if (!parsed.success) return c.text('Bad Request', 400);

    // Twilio gives up on a webhook after about 15 seconds (error 11200). The reply goes back in the TwiML response:
    // agent turns measured 3 to 7 seconds, and the agent run is cut off at 11 (AGENT_TIMEOUT_MS in agent/reply.ts),
    // which still leaves time for the fallback text. If that stops holding, answer with an empty <Response/> right
    // away and send the reply through sendText instead.
    // handleInboundSms does not throw: when something fails it returns a "try again, or call 211" reply instead,
    // because a 500 here would mean silence for the texter.
    const { reply } = await handleInboundSms({
      from: parsed.data.From,
      body: parsed.data.Body,
      messageSid: parsed.data.MessageSid,
    });
    return c.body(twiml(reply), 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  },
});

// Twilio's WhatsApp webhook, for the WhatsApp sender. Same gate and same reply path as SMS (a TwiML <Message>,
// which Twilio delivers back over WhatsApp). From is `whatsapp:+<E.164>`: the number goes through the SMS flow
// with channel 'whatsapp', so JOIN signs the person up for WhatsApp alerts. Never point WhatsApp at the SMS route:
// there the prefix would be dropped and a WhatsApp JOIN would become an SMS subscription.
const twilioWhatsAppRoute = registerApiRoute(TWILIO_WHATSAPP_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    const logger = c.get('mastra').getLogger();
    const params = verifiedTwilioParams({
      form: await c.req.parseBody(),
      path: TWILIO_WHATSAPP_PATH,
      requestUrl: c.req.url,
      signature: c.req.header('x-twilio-signature'),
    });
    if (!params) {
      logger?.warn('Rejected Twilio WhatsApp webhook: missing or invalid signature');
      return c.text('Forbidden', 403);
    }

    const parsed = twilioSmsParams.safeParse(params);
    // Never logs the fields themselves: From holds the person's phone number.
    const from = parsed.success ? fromWhatsAppAddress(parsed.data.From) : null;
    if (!parsed.success || !from) {
      logger?.warn('Rejected Twilio WhatsApp webhook: From is not a whatsapp: address, or a field is missing');
      return c.text('Bad Request', 400);
    }

    // Twilio's 15-second limit applies as for SMS; see the SMS route above.
    const { reply } = await handleInboundSms({
      from,
      body: parsed.data.Body,
      messageSid: parsed.data.MessageSid,
      channel: 'whatsapp',
    });
    return c.body(twiml(reply), 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  },
});

// Twilio's Facebook Messenger webhook, for the Page's Messenger sender. Separate from the SMS route because the
// sender is a page-scoped Messenger id, not a phone number. Same gate: the signature, checked against
// PUBLIC_BASE_URL + TWILIO_MESSENGER_PATH.
// It answers Twilio with an empty <Response/> straight away and sends the reply through the Messages API
// (messenger:<page id> -> messenger:<psid>), so the agent turn never races Twilio's 15-second limit.
const twilioMessengerRoute = registerApiRoute(TWILIO_MESSENGER_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    const logger = c.get('mastra').getLogger();
    const params = verifiedTwilioParams({
      form: await c.req.parseBody(),
      path: TWILIO_MESSENGER_PATH,
      requestUrl: c.req.url,
      signature: c.req.header('x-twilio-signature'),
    });
    if (!params) {
      logger?.warn('Rejected Twilio Messenger webhook: missing or invalid signature');
      return c.text('Forbidden', 403);
    }

    // Never logs the fields themselves: From holds the person's Messenger id.
    const msg = parseMessengerWebhook(params);
    if (!msg) {
      logger?.warn('Rejected Twilio Messenger webhook: From or To is not a messenger: address, or MessageSid is missing');
      return c.text('Bad Request', 400);
    }

    // Not awaited. handleInboundMessenger does not throw; the catch is only a backstop.
    void handleInboundMessenger(msg).catch((error) =>
      logger?.error(`Messenger message not handled: ${error instanceof Error ? error.message : 'unknown error'}`),
    );
    return c.body(twiml(null), 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  },
});

// True when the request carries `Authorization: Bearer <M4_ALERT_SECRET>`. False whenever the secret is unset.
function hasAlertSecret(header: string | undefined): boolean {
  const secret = process.env.M4_ALERT_SECRET;
  const given = header?.match(/^Bearer (.+)$/)?.[1];
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Demo trigger for M1's dashboard button: creates a kind = 'mock' alert and texts subscribers in the given zips.
// It can text every subscriber, so it checks its own shared secret instead of Mastra auth, and refuses everything
// while M4_ALERT_SECRET is unset. Authorization is in Mastra's default CORS allowHeaders, so a browser can send it.
const mockAlertRoute = registerApiRoute(MOCK_ALERT_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (!hasAlertSecret(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);

    const parsed = mockAlertBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

    try {
      const alert = await triggerMockAlert(parsed.data);
      return c.json({ alert }, 201);
    } catch (error) {
      c.get('mastra').getLogger()?.error(`Mock alert failed: ${error instanceof Error ? error.message : error}`);
      return c.json({ error: 'Mock alert failed' }, 500);
    }
  },
});

// Runs the reading-based alert check now (mode 3; alerts/readings.ts), for the dashboard or a cron outside the app.
// It can message every subscriber in a zip, so it takes the same M4_ALERT_SECRET as the mock alert.
const checkReadingsRoute = registerApiRoute(CHECK_READINGS_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (!hasAlertSecret(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
    try {
      return c.json(await checkReadingAlerts(), 200);
    } catch (error) {
      c.get('mastra').getLogger()?.error(`Reading check failed: ${error instanceof Error ? error.message : error}`);
      return c.json({ error: 'Reading check failed' }, 500);
    }
  },
});

export const m4ApiRoutes: ApiRoute[] = [
  twilioSmsRoute,
  twilioWhatsAppRoute,
  twilioMessengerRoute,
  mockAlertRoute,
  checkReadingsRoute,
];
