// Webhook tool: text the caller directions to a site.
// The phone number comes from the call itself (system__caller_id), never from the LLM.
// Handled by apps/api/src/elevenlabs/tool-send-sms.ts.

export const sendSmsTool = (apiUrl: string, toolSecret: string) => ({
  tool_config: {
    type: 'webhook',
    name: 'send_sms',
    description:
      "Send the caller the address, today's hours, and a map link for one site (on Facebook Messenger when linked). " +
      'Only call this after the caller says yes. Always include the group size and whether anyone needs assistance.',
    response_timeout_secs: 10,
    api_schema: {
      url: `${apiUrl}/el/tools/send-sms`,
      method: 'POST',
      request_headers: { 'x-shade-tool-secret': toolSecret },
      request_body_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'integer', description: 'The site_id returned by find_sites.' },
          language: { type: 'string', description: 'Language for the text: en, es, tl, vi, or zh.' },
          party_size: {
            type: 'integer',
            description: 'How many people are in the caller\'s group, including the caller. Omit if they did not say.',
          },
          needs_assistance: {
            type: 'boolean',
            description: 'True if anyone in the group needs assistance (wheelchair, walker, trouble walking, a medical need). False if the caller said no one does.',
          },
          assistance_details: {
            type: 'string',
            description: 'Only when needs_assistance is true: what kind, in the caller\'s own words, short, in the language of the call (for example "uses a wheelchair"). Omit otherwise.',
          },
          caller_id: { type: 'string', dynamic_variable: 'system__caller_id' },
          conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
        },
        required: ['site_id'],
      },
    },
  },
});
