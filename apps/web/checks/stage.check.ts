// npx tsx checks/stage.check.ts  (from apps/web)
import assert from 'node:assert/strict';
import type { CallEvent } from '../src/api';
import { stage } from '../src/format';

const ev = (...kinds: CallEvent['kind'][]) => kinds.map((kind) => ({ at: '', kind, text: '' }));
const label = (events: CallEvent[], status?: 'requesting' | 'incoming') => stage(events, status).label;

assert.equal(label(ev('call_started')), 'Inquiring condition');
assert.equal(label(ev('call_started', 'located')), 'Determining location');
assert.equal(label(ev('call_started', 'located', 'site_suggested')), 'Suggesting cool zone');
assert.equal(label(ev('call_started', 'located', 'located', 'site_suggested', 'sms_sent')), 'Suggesting cool zone');
assert.equal(label(ev('call_started', 'located', 'no_site')), 'Referred to 2-1-1');
assert.equal(label(ev('call_started', 'located', 'site_suggested', 'help_requested'), 'requesting'), 'Locating help');
assert.equal(label(ev('help_requested', 'help_incoming'), 'incoming'), 'Help incoming');
assert.equal(stage(ev(), 'incoming').pill, 'incoming');
assert.equal(stage(ev('call_started')).pill, 'oncall');
console.log('stage: ok');
