// HTTP endpoints ElevenLabs calls. Registered in src/mastra/index.ts under server.apiRoutes.
// They skip Mastra auth and check their own secrets instead (see auth.ts).
import { registerApiRoute } from '@mastra/core/server';
import { isValidToolSecret, isValidWebhookSignature } from './auth';
import { logEvent } from '../requests/events';
import { checkStatusBody, handleCheckStatus, handleRequestHelp, requestHelpBody } from '../requests/requests';
import { handlePostCall } from './post-call';
import { findSitesBody, handleFindSites } from './tool-find-sites';
import { handleSendSms, sendSmsBody } from './tool-send-sms';

export const elevenLabsRoutes = [
  registerApiRoute('/el/tools/find-sites', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      if (!isValidToolSecret(c.req.header('x-shade-tool-secret'))) return c.json({ error: 'unauthorized' }, 401);
      const parsed = findSitesBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'location is required' }, 400);
      return c.json(await handleFindSites(parsed.data));
    },
  }),

  registerApiRoute('/el/tools/send-sms', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      if (!isValidToolSecret(c.req.header('x-shade-tool-secret'))) return c.json({ error: 'unauthorized' }, 401);
      const parsed = sendSmsBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ ok: false, error: 'site_id is required' }, 400);
      return c.json(await handleSendSms(parsed.data));
    },
  }),

  registerApiRoute('/el/tools/request-help', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      if (!isValidToolSecret(c.req.header('x-shade-tool-secret'))) return c.json({ error: 'unauthorized' }, 401);
      const parsed = requestHelpBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'said and location are required' }, 400);
      return c.json(await handleRequestHelp(parsed.data));
    },
  }),

  registerApiRoute('/el/tools/check-request-status', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      if (!isValidToolSecret(c.req.header('x-shade-tool-secret'))) return c.json({ error: 'unauthorized' }, 401);
      const parsed = checkStatusBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'conversation_id is required' }, 400);
      return c.json(await handleCheckStatus(parsed.data));
    },
  }),

  // Conversation initiation webhook: ElevenLabs posts here as an inbound Twilio call connects, before the agent speaks.
  // It starts the dispatcher's trail. Set it up in ElevenLabs (agent/README.md) with the tool secret as a header.
  registerApiRoute('/el/webhooks/call-start', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      if (!isValidToolSecret(c.req.header('x-shade-tool-secret'))) return c.json({ error: 'unauthorized' }, 401);
      const body = await c.req.json().catch(() => null);
      void logEvent(typeof body?.conversation_id === 'string' ? body.conversation_id : null, 'call_started', '');
      return c.json({ type: 'conversation_initiation_client_data', dynamic_variables: {} }); // the call waits on this
    },
  }),

  registerApiRoute('/el/webhooks/post-call', {
    method: 'POST',
    requiresAuth: false,
    handler: async (c) => {
      const raw = await c.req.text();
      if (!isValidWebhookSignature(raw, c.req.header('elevenlabs-signature'))) {
        return c.json({ error: 'bad signature' }, 401);
      }
      try {
        await handlePostCall(JSON.parse(raw));
      } catch (err) {
        console.error('[el post-call] failed', err); // still 200 so ElevenLabs doesn't disable the webhook
      }
      return c.json({ ok: true });
    },
  }),
];
