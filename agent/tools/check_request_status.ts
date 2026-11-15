// Webhook tool: the current status of this call's help request, as a line to read.
// Handled by apps/api/src/requests/requests.ts (handleCheckStatus).

export const checkRequestStatusTool = (apiUrl: string, toolSecret: string) => ({
  tool_config: {
    type: 'webhook',
    name: 'check_request_status',
    description:
      'Check whether a neighbor has said yes to this call\'s help request. Use it only after request_help. ' +
      'Read the say_this line from the result to the caller.',
    response_timeout_secs: 10,
    api_schema: {
      url: `${apiUrl}/el/tools/check-request-status`,
      method: 'POST',
      request_headers: { 'x-shade-tool-secret': toolSecret },
      request_body_schema: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
        },
        required: ['conversation_id'],
      },
    },
  },
});
