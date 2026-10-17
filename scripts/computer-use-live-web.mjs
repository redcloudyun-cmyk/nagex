// Live check (NOT part of the test suite): a multi-step task on a REAL public website, planned by a REAL model through the Model Gateway, in real Chromium, judged by NAgex's own verification.
//
//   npm run build && node scripts/computer-use-live-web.mjs
//
// READ-ONLY by construction: the goal asks only for reading (search, open, verify what the page shows); no sign-in, no form that changes anything. The script never approves anything - if the model
// reaches an approval boundary the approval is REJECTED and the session cancelled. Wikipedia is used because it needs no account, has a stable public structure and is meant to be read.
// A run uses a few dozen small model calls (the Gateway routes to whichever provider has a key in the environment; GEMINI_API_KEY here) and a few page loads. Single sample, not a benchmark.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NAGEX_PROVIDER_PRIORITY ??= 'gemini';
process.env.NAGEX_GEMINI_MODEL ??= 'gemini-flash-lite-latest';

const { createProviders } = await import('../dist/src/model-gateway/providers.js');
const { UnifiedModelRouter } = await import('../dist/src/model-gateway/unified-model-router.js');
const { GatewayExecutionModelAdapter } = await import('../dist/src/device-control/gateway-execution-model.adapter.js');
const { DeviceControlService } = await import('../dist/src/device-control/device-control.service.js');
const { DeviceExecutionSessionStore } = await import('../dist/src/device-control/device-execution-session.store.js');
const { ActionApprovalStore } = await import('../dist/src/governance/action-approval.store.js');
const { AuditLogger } = await import('../dist/src/governance/audit.logger.js');
const { MemoryEngine } = await import('../dist/src/context/memory.engine.js');
const { BrowserSessionStore } = await import('../dist/src/modules/browser/browser-session.store.js');
const { PlaywrightBrowserRuntime } = await import('../dist/src/modules/browser/browser.runtime.js');
const { BrowserToolService } = await import('../dist/src/modules/browser/browser.service.js');

const router = new UnifiedModelRouter(createProviders(process.env, undefined, 120_000));
const planner = new GatewayExecutionModelAdapter(router);
if (!planner.status().configured) {
  console.log(JSON.stringify({ result: 'BLOCKED', reason: 'No model provider is configured in this environment (set GEMINI_API_KEY or a Nebius/NVIDIA key).' }));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-live-web-'));
const approvals = new ActionApprovalStore();
const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
const browser = new BrowserToolService(runtime, new BrowserSessionStore({ dir: path.join(dir, 'bs') }), approvals, new AuditLogger(), new MemoryEngine({ dir: path.join(dir, 'm') }));
const sessions = new DeviceExecutionSessionStore({ dir: path.join(dir, 'ds') });
const loop = new DeviceControlService(sessions, browser, planner);

const topic = process.env.LIVE_WEB_TOPIC || '대한민국';
const expected = process.env.LIVE_WEB_EXPECTED || '서울';
const goal = `Open https://ko.wikipedia.org/ . Use the site's search box to search for "${topic}", open the article about it (the encyclopedia article itself, not a disambiguation or search-result page), and then check that the article page shows the word "${expected}". Only read: do not sign in, do not edit anything, do not follow external links. Finish with STOP once you have verified it.`;
const started = Date.now();
let outcome;
try {
  outcome = await loop.startSession({ tenantId: 'ten_live', ownerId: 'usr_live', requestId: 'req_live_web', goal, allowedDomains: ['wikipedia.org'], maxSteps: 25, maxDurationMs: 8 * 60 * 1000 });
} catch (error) {
  outcome = { kind: 'ERROR', message: error instanceof Error ? error.message : String(error) };
}
if (outcome.kind === 'WAITING_APPROVAL') {
  console.log('--- the run reached an approval boundary:', outcome.approval.canonicalPayload.targetText, '- REJECTING it (this script never approves)');
  approvals.reject(outcome.approval.approvalId, 'ten_live', 'usr_live', 'req_live_web_reject');
  loop.cancelSession({ tenantId: 'ten_live', ownerId: 'usr_live', requestId: 'req_live_web', deviceExecutionSessionId: outcome.deviceExecutionSessionId });
}
const id = outcome.deviceExecutionSessionId;
const record = id ? sessions.getOwned(id, 'ten_live', 'usr_live') : null;
for (const s of record?.steps ?? []) {
  console.log(String(s.n).padStart(2), s.action.padEnd(8), (s.detail || s.target || '').slice(0, 44).padEnd(44), String(s.verification).padEnd(13), '|', s.outcome.slice(0, 100));
}
console.log(JSON.stringify({
  result: outcome.kind,
  terminationReason: outcome.terminationReason ?? null,
  completion: outcome.result?.completion ?? null,
  seconds: Math.round((Date.now() - started) / 1000),
  steps: record?.steps?.length ?? 0,
  models: (router.recentCalls ? router.recentCalls(60) : []).reduce((acc, c) => { const k = `${c.actualProvider}/${c.model}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
}, null, 2));
await runtime.shutdown();
