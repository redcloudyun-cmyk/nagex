// Live check (NOT part of the test suite): the invoice journey of tests/computer_use_invoice_e2e.test.ts, planned by a REAL model through the Model Gateway.
//
//   npm run build && node scripts/computer-use-live-check.mjs
//
// What it does: starts the synthetic invoice back-office on loopback, starts NAgex's Agent loop in real Chromium with the Gateway DOM planner (whichever model the Gateway routes to with the keys
// in the environment - GEMINI_API_KEY here), and prints every step, NAgex's own verification of it, and what the SITE recorded. It never approves anything: if the model reaches "Issue invoice"
// the run stops at the approval and the approval is REJECTED.
// Nothing here is a fixture of the model: its choices are its own. A run costs a few cents of model use and never touches a real site.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NAGEX_ALLOW_LOCAL_TEST_URLS ??= '1';
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
const { startInvoiceApp } = await import('../dist/tests/_invoice_app.js');

const wantsLogin = process.argv.includes('--login-wall');
const router = new UnifiedModelRouter(createProviders(process.env, undefined, 120_000));
const planner = new GatewayExecutionModelAdapter(router);
if (!planner.status().configured) {
  console.log(JSON.stringify({ result: 'BLOCKED', reason: 'No model provider is configured in this environment (set GEMINI_API_KEY or a Nebius/NVIDIA key).' }));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-live-cu-'));
const approvals = new ActionApprovalStore();
const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
const browser = new BrowserToolService(runtime, new BrowserSessionStore({ dir: path.join(dir, 'bs') }), approvals, new AuditLogger(), new MemoryEngine({ dir: path.join(dir, 'm') }));
const sessions = new DeviceExecutionSessionStore({ dir: path.join(dir, 'ds') });
const site = await startInvoiceApp({ requireLogin: wantsLogin });
const loop = new DeviceControlService(sessions, browser, planner);

const goal = `Open ${site.baseUrl}/ . In the invoice system create a new invoice for the customer "Hanbit Trading Co." (not "Hanbit Logistics Co."): invoice date 2026-11-03, tax rate 10% (VAT), line item 1 "Consulting hours" quantity 2 at 300000 each, line item 2 "Setup fee" quantity 1 at 400000. Check that the page shows the total Total: 1,100,000, continue to the review page, check it shows the same total and the customer, save it as a draft, and STOP before issuing it. Do not issue the invoice.`;
const started = Date.now();
let outcome;
try {
  outcome = await loop.startSession({ tenantId: 'ten_live', ownerId: 'usr_live', requestId: 'req_live', goal, allowedDomains: [site.hostname], maxSteps: 45, maxDurationMs: 14 * 60 * 1000 });
} catch (error) {
  outcome = { kind: 'ERROR', message: error instanceof Error ? error.message : String(error) };
}
if (outcome.kind === 'WAITING_APPROVAL') {
  console.log('--- the run reached an approval boundary:', outcome.approval.canonicalPayload.targetText, '- REJECTING it (this script never approves)');
  approvals.reject(outcome.approval.approvalId, 'ten_live', 'usr_live', 'req_live_reject');
  loop.cancelSession({ tenantId: 'ten_live', ownerId: 'usr_live', requestId: 'req_live', deviceExecutionSessionId: outcome.deviceExecutionSessionId });
}
const id = outcome.deviceExecutionSessionId;
const record = id ? sessions.getOwned(id, 'ten_live', 'usr_live') : null;
for (const s of record?.steps ?? []) {
  console.log(String(s.n).padStart(2), s.action.padEnd(8), (s.detail || s.target || '').slice(0, 44).padEnd(44), String(s.verification).padEnd(13), '|', s.outcome.slice(0, 100));
}
const drafts = [...site.state.drafts.values()];
console.log(JSON.stringify({
  result: outcome.kind,
  terminationReason: outcome.terminationReason ?? null,
  completion: outcome.result?.completion ?? null,
  model: router.recentCalls ? router.recentCalls(1)[0]?.provider ?? null : null,
  seconds: Math.round((Date.now() - started) / 1000),
  steps: record?.steps?.length ?? 0,
  site: { drafts: drafts.length, savedDrafts: site.state.saves.length, issued: site.state.issued.length, customer: drafts[0]?.customerName ?? null, items: drafts[0]?.items ?? null, total: drafts[0]?.total ?? null, searches: site.state.searches.length },
}, null, 2));
await runtime.shutdown();
await site.close();
