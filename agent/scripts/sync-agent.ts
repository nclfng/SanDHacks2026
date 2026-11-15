// Create or update the Shade agent and its webhook tools from the config in this folder.
// Idempotent: tools are matched by name, the agent by ELEVENLABS_AGENT_ID.
//   cd apps/api && npm run el:sync
import { buildAgentBody } from '../agent.config.ts';
import { checkRequestStatusTool } from '../tools/check_request_status.ts';
import { findSitesTool } from '../tools/find_sites.ts';
import { requestHelpTool } from '../tools/request_help.ts';
import { sendSmsTool } from '../tools/send_sms.ts';
import { el, env } from './el.ts';

const apiUrl = env('PUBLIC_API_URL').replace(/\/$/, '');
const toolSecret = env('EL_TOOL_SECRET');

async function upsertTools(): Promise<string[]> {
  const defs = [
    findSitesTool(apiUrl, toolSecret), sendSmsTool(apiUrl, toolSecret), requestHelpTool(apiUrl, toolSecret),
    checkRequestStatusTool(apiUrl, toolSecret),
  ];
  const existing = await el<{ tools: { id: string; tool_config: { name: string } }[] }>('GET', '/v1/convai/tools');
  const ids: string[] = [];
  for (const def of defs) {
    const match = existing.tools.find((t) => t.tool_config.name === def.tool_config.name);
    if (match) {
      await el('PATCH', `/v1/convai/tools/${match.id}`, def);
      console.log(`updated tool ${def.tool_config.name} (${match.id})`);
      ids.push(match.id);
    } else {
      const created = await el<{ id: string }>('POST', '/v1/convai/tools', def);
      console.log(`created tool ${def.tool_config.name} (${created.id})`);
      ids.push(created.id);
    }
  }
  return ids;
}

const toolIds = await upsertTools();
const body = buildAgentBody(toolIds);
const agentId = env('ELEVENLABS_AGENT_ID', false);

if (agentId) {
  await el('PATCH', `/v1/convai/agents/${agentId}`, body);
  console.log(`updated agent ${agentId}`);
} else {
  const created = await el<{ agent_id: string }>('POST', '/v1/convai/agents/create', body);
  console.log(`created agent. Add this to the root .env:\nELEVENLABS_AGENT_ID=${created.agent_id}`);
}
