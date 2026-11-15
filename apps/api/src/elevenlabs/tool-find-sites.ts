// ElevenLabs server tool -> shared find_sites (owned by M2).
import { z } from 'zod';
import type { FindSitesOutput } from '../../../../data/schema/types';
import { findSites } from '../shared/find-sites';
import { logEvent } from '../requests/events';
import { to12h } from '../shared/hours';
import { updateCallState } from './call-state';

const FALLBACK = "I couldn't find an open site near you right now. You can call 2 1 1 any time. They can help, and they can arrange a free ride.";

export const findSitesBody = z.object({
  location: z.string().min(1),
  has_car: z.boolean().optional(),
  mobility_issues: z.boolean().optional(),
  needs_clean_air: z.boolean().optional(),
  language: z.enum(['en', 'es', 'tl', 'vi', 'zh']).optional().catch(undefined),
  conversation_id: z.string().optional(),
});

const PRECISE = new Set(['address', 'intersection', 'landmark']);

// When the caller was only placed by zip, street or area, distances are measured from the middle of that area.
// The model tends to read them out anyway ("a four-minute walk"), so don't hand them over. The agent can ask for
// a cross street instead (system prompt).
function forTheAgent(result: FindSitesOutput) {
  if (!result.location_precision || PRECISE.has(result.location_precision)) return result;
  return {
    ...result,
    sites: result.sites.map(({ travel_minutes: _t, distance_miles: _d, ...site }) => site),
    note: 'Location is approximate (area or zip only): do not tell the caller distances or walking times.',
  };
}

// Zip only: a caller who never asks for help leaves no stated location behind (calls are stored by zip too).
const HOW: Record<string, string> = { address: 'an address', intersection: 'cross streets', landmark: 'a landmark', street: 'a street name', area: 'a neighborhood', zip: 'a zip code' };
async function logTrail(conversationId: string | undefined, result: FindSitesOutput) {
  const how = result.location_precision ? ` (from ${HOW[result.location_precision]})` : '';
  await logEvent(conversationId, 'located', result.resolved_zip ? `Placed the caller in ${result.resolved_zip}${how}` : 'Could not place the caller yet. Asking for a cross street');
  const top = result.sites[0];
  const open = top?.hours_today.includes('Open 24 hours') ? ', open 24 hours' : top?.closes_at ? `, open until ${to12h(top.closes_at)}` : '';
  if (top) await logEvent(conversationId, 'site_suggested', `Suggested ${top.name}${open}`);
  else if (result.resolved_zip) await logEvent(conversationId, 'no_site', 'No open cool zone nearby. Gave the 2-1-1 line');
}

export async function handleFindSites(body: z.infer<typeof findSitesBody>): Promise<FindSitesOutput | ReturnType<typeof forTheAgent>> {
  const { conversation_id, location, language, ...needs } = body;
  try {
    const result = await findSites({ location, language, needs });
    updateCallState(conversation_id, {
      firstSiteId: result.sites[0]?.site_id,
      zip: result.resolved_zip ?? undefined,
      language,
      noSiteFound: result.sites.length === 0,
    });
    void logTrail(conversation_id, result);
    if (result.sites.length === 0 && !result.fallback_message) {
      return { ...result, fallback_message: FALLBACK };
    }
    return forTheAgent(result);
  } catch (err) {
    console.error('[el find_sites] failed', err);
    updateCallState(conversation_id, { toolError: true });
    // Return a usable answer instead of an HTTP error so the agent can still help the caller.
    return { sites: [], resolved_zip: null, fallback_message: FALLBACK };
  }
}
