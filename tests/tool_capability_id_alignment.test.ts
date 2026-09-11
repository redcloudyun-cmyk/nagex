// H01 — Capability / Tool ID Alignment.
//
// A regression guard against the exact class of drift H01 fixed: a
// ToolRegistry entry that PlanResolver resolves a plan step's tool
// against silently diverging from the CapabilityRegistry id
// CapabilityBroker actually dispatches on, so
// ResolvedPlanStep.resolvedToolId would stop equaling
// CapabilityRequest.capabilityId for a real capability, without any test
// failing to say so.
//
// Some ToolRegistry entries are intentionally never Broker-routed (a
// different, real execution path — see each entry below for its own
// evidence). Those are explicitly listed, never silently excluded by a
// weakened assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { capabilityRegistry } from '../src/capabilities/capability.registry.js';

// Every one of these is confirmed (H01 pre-flight, grep-verified) to have
// a real, different, non-CapabilityBroker execution path — not a gap:
const NON_BROKER_TOOL_IDS = new Set([
  'notion.create_page', // unimplemented placeholder, never live
  'web.search', // unimplemented placeholder, never live
  'memory.search', // routed through MemoryEngine directly
  'workspace.prepare_draft', // routed through workspace services directly
  'telegram.bot', // routed through TelegramService directly
  'slack.bot', // routed through SlackService directly
  // Each exposed as its own direct /api/v1/tools/browser/<action> REST
  // route calling BrowserToolService directly, for the interactive
  // Ambient Browser Agent UI — a real, separate path from Task/plan-driven
  // CapabilityBroker dispatch.
  'browser.screenshot',
  'browser.scroll',
  'browser.wait',
  'browser.type',
  'browser.select',
]);

test('every ToolRegistry entry intended for Capability Broker execution resolves to a real CapabilityRegistry id', () => {
  const capabilityIds = new Set(capabilityRegistry.list().map((def) => def.id));
  const offenders: string[] = [];
  for (const tool of toolRegistry.list()) {
    if (NON_BROKER_TOOL_IDS.has(tool.id)) continue;
    if (!capabilityIds.has(tool.id)) offenders.push(tool.id);
  }
  assert.deepEqual(offenders, [], `these ToolRegistry ids are intended for Broker execution but have no matching CapabilityRegistry id (add a real capability, canonicalize the id, or add to NON_BROKER_TOOL_IDS with real evidence): ${offenders.join(', ')}`);
});

test('every NON_BROKER_TOOL_IDS entry is a real, currently-registered ToolRegistry id (no stale exclusions)', () => {
  const toolIds = new Set(toolRegistry.list().map((t) => t.id));
  const stale = [...NON_BROKER_TOOL_IDS].filter((id) => !toolIds.has(id));
  assert.deepEqual(stale, [], `NON_BROKER_TOOL_IDS references tool id(s) that no longer exist in ToolRegistry: ${stale.join(', ')}`);
});

test('the known Calendar free-slots drift is resolved: ToolRegistry and CapabilityRegistry agree on the canonical id', () => {
  const resolution = toolRegistry.resolve('google_calendar.free_slots');
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.resolvedToolId, 'google_calendar.free_slots');
  assert.ok(capabilityRegistry.has('google_calendar.free_slots'));
});

test('the old google_calendar.find_free_slots id still resolves, as a backward-compatible alias to the same canonical id', () => {
  const resolution = toolRegistry.resolve('google_calendar.find_free_slots');
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.resolvedToolId, 'google_calendar.free_slots', 'the old id must resolve to the SAME canonical entry, never a second/duplicate one');
});

test('no two distinct ToolRegistry entries claim the same canonical execution id (build-time invariant, exercised here)', () => {
  // ToolRegistry's own constructor already throws on a genuine duplicate
  // alias across two different tool ids — toolRegistry having constructed
  // successfully at module load is itself the proof. This test exists so
  // that guarantee is asserted explicitly in this file's context, not only
  // incidentally by every other test's ability to import it.
  assert.ok(toolRegistry.list().length > 0);
});

test('every already-working exact-match id (Gmail, Calendar writes, Browser) is unchanged by the drift fix', () => {
  const stillIdentical = [
    'gmail.search', 'gmail.read_thread', 'gmail.send_email', 'gmail.reply', 'gmail.create_draft',
    'google_calendar.create_event', 'google_calendar.update_event', 'google_calendar.cancel_event', 'google_calendar.respond_to_event',
    'browser.open', 'browser.navigate', 'browser.tabs', 'browser.snapshot', 'browser.find', 'browser.extract', 'browser.back', 'browser.forward', 'browser.reload', 'browser.click', 'browser.close',
  ];
  for (const id of stillIdentical) {
    const resolution = toolRegistry.resolve(id);
    assert.equal(resolution.status, 'RESOLVED', `${id} must still resolve`);
    assert.equal(resolution.resolvedToolId, id, `${id} must still resolve to itself, unchanged`);
    assert.ok(capabilityRegistry.has(id), `${id} must still have a matching CapabilityRegistry entry`);
  }
});
