// Browser-agent verification / loop / recovery benchmark (NOT part of the product or the test gate). The SAME file runs against two builds:
//   node --require <dist>/tests/_setup.js scratch/browser-verify/bench.cjs <distRoot> <label> <reps> <out.json>
// It drives the real DeviceControlService (the Agent's observe -> propose -> act loop) over the real BrowserToolService + Chromium and deterministic local pages, with a SCRIPTED model
// (no real model: each scenario fixes what the "model" proposes, so only the runtime's behaviour differs between builds). Ground truth is known per scenario (did the page really reach
// the state the task asked for?), so "false success" - the Agent session reporting a completed task that did not happen - is counted, not guessed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.NAGEX_ALLOW_LOCAL_TEST_URLS = '1';
const [, , DIST, LABEL, REPS_RAW, OUT] = process.argv;
const REPS = Number(REPS_RAW || 1);
const req = (p) => require(path.join(DIST, p));
const { BrowserToolService } = req('src/modules/browser/browser.service.js');
const { PlaywrightBrowserRuntime } = req('src/modules/browser/browser.runtime.js');
const { BrowserSessionStore } = req('src/modules/browser/browser-session.store.js');
const { ActionApprovalStore } = req('src/governance/action-approval.store.js');
const { AuditLogger } = req('src/governance/audit.logger.js');
const { MemoryEngine } = req('src/context/memory.engine.js');
const { DeviceControlService } = req('src/device-control/device-control.service.js');
const { DeviceExecutionSessionStore } = req('src/device-control/device-execution-session.store.js');

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const MSG = '<div id="msg"></div>';
const PAGES = {
  '/form-ok': page('Form', `<input id="name" placeholder="Name"><button id="apply" type="button" onclick="msg.textContent='Saved successfully';msg.setAttribute('role','status')">Apply</button>${MSG}`),
  '/form-invalid': page('Form', `<input id="name" required placeholder="Name"><button id="apply" type="button" onclick="if(!document.getElementById('name').reportValidity())return;msg.textContent='Saved successfully';msg.setAttribute('role','status')">Apply</button>${MSG}`),
  '/form-error-message': page('Form', `<input id="name" placeholder="Name"><button id="apply" type="button" onclick="msg.textContent='Error: the server rejected this name';msg.setAttribute('role','alert')">Apply</button>${MSG}`),
  '/nav-ok': page('Home', '<a id="go" href="/details">Open details</a>'),
  '/details': page('Details', '<h1>Details</h1>'),
  '/no-change': page('Static', '<button id="r" type="button">Refresh list</button>'),
  '/loop': page('Loop', '<button id="more" type="button">Load more</button>'),
  '/pagination': page('Pages', '<button id="next" type="button" onclick="n.textContent=Number(n.textContent)+1">Next</button> Page <span id="n">1</span>'),
  '/stale': page('Stale', `<button id="b" type="button" onclick="msg.textContent='Continued'">Continue</button>${MSG}`),
  '/approval': page('Shop', `<button id="buy" type="button" onclick="fetch('/order',{method:'POST'});msg.textContent='Ordered';msg.setAttribute('role','status')">Buy now</button>${MSG}`),
  '/unknown': page('Shop', `<button id="place" type="button" onclick="fetch('/order',{method:'POST'})">Place order</button>${MSG}`),
};
let orders = 0;
function route(request, response) {
  const url = new URL(request.url, 'http://x');
  if (url.pathname === '/order') { orders++; response.statusCode = 200; response.end('ok'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (PAGES[url.pathname]) response.end(PAGES[url.pathname]); else { response.statusCode = 404; response.end(page('Not found', 'Not found')); }
}

const A = (action, selector, extra = {}) => ({ action, ...(selector ? { target: { selector } } : {}), ...extra });
// each policy gets the number of actions proposed so far (n), the prior outcomes and the legacy structuredSnapshot, and returns the next proposal
const SCENARIOS = [
  { id: 'D01', name: 'form submit succeeds (success message appears)', path: '/form-ok', achieved: true, policy: (n) => [A('TYPE', '#name', { value: 'Alice' }), A('CLICK', '#apply'), A('STOP', null, { expectedResult: 'saved' })][n] },
  { id: 'D02', name: 'form submit blocked by validation, model claims success', path: '/form-invalid', achieved: false, policy: (n) => [A('CLICK', '#apply'), A('STOP', null, { expectedResult: 'submitted' })][n] },
  { id: 'D03', name: 'server rejects the submit with an error message, model claims success', path: '/form-error-message', achieved: false, policy: (n) => [A('CLICK', '#apply'), A('STOP', null, { expectedResult: 'saved' })][n] },
  { id: 'D04', name: 'link navigation succeeds', path: '/nav-ok', achieved: true, policy: (n) => [A('CLICK', '#go'), A('STOP', null, { expectedResult: 'details page open' })][n] },
  { id: 'D05', name: 'click with no visible change, model claims success', path: '/no-change', achieved: false, policy: (n) => [A('CLICK', '#r'), A('STOP', null, { expectedResult: 'list refreshed' })][n] },
  { id: 'D06', name: 'the same useless click is proposed again and again', path: '/loop', achieved: false, policy: () => A('CLICK', '#more') },
  { id: 'D07', name: 'legitimate repeated clicks (pagination) must NOT be stopped', path: '/pagination', achieved: true, policy: (n) => (n < 5 ? A('CLICK', '#next') : A('STOP', null, { expectedResult: 'page 6' })) },
  { id: 'D08', name: 'stale locator: the model re-reads the page after a failed click', path: '/stale', achieved: true,
    policy: (n, ctx) => {
      if (n === 0) return A('CLICK', '#a'); // an element that is no longer on the page
      if (n === 1) { const b = (ctx.structuredSnapshot.buttons || []).find((x) => /continue/i.test(x.text)); return A('CLICK', b && b.id ? `#${b.id}` : '#b'); }
      return A('STOP', null, { expectedResult: 'continued' });
    } },
  { id: 'D09', name: 'consequential click: approval required, executed exactly once', path: '/approval', achieved: true, expectOrders: 1, policy: (n) => [A('CLICK', '#buy'), A('STOP', null, { expectedResult: 'ordered' })][n] },
  { id: 'D10', name: 'consequential click whose result cannot be seen', path: '/unknown', achieved: null, expectOrders: 1, policy: (n) => [A('CLICK', '#place'), A('STOP', null, { expectedResult: 'order placed' })][n] },
];

(async () => {
  const server = http.createServer(route);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-verify-bench-'));
  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const results = [];
  try {
    for (let rep = 0; rep < REPS; rep++) {
      for (const sc of SCENARIOS) {
        const tenantId = 'ten_vb'; const ownerId = 'usr_vb'; const requestId = `req_${sc.id}_${rep}`;
        const sessions = new BrowserSessionStore({ dir: path.join(dir, `sessions_${sc.id}_${rep}`) });
        const approvals = new ActionApprovalStore();
        const browser = new BrowserToolService(runtime, sessions, approvals, new AuditLogger(), new MemoryEngine());
        const deviceSessions = new DeviceExecutionSessionStore({ dir: path.join(dir, `device_${sc.id}_${rep}`) });
        let proposals = 0;
        const model = { proposeNextAction: async (ctx) => {
          const n = proposals++;
          if (n === 0) return A('NAVIGATE', null, { value: base + sc.path });
          const next = sc.policy(n - 1, ctx);
          if (!next) throw new Error('script exhausted');
          return next;
        } };
        const service = new DeviceControlService(deviceSessions, browser, model);
        const ordersBefore = orders;
        const started = Date.now();
        let outcome; let error = null; let approvalsGranted = 0;
        try {
          outcome = await service.startSession({ tenantId, ownerId, requestId, goal: sc.name, allowedDomains: ['127.0.0.1'], maxSteps: 20, maxDurationMs: 120000 });
          let guard = 0;
          while (outcome.kind === 'WAITING_APPROVAL' && guard++ < 5) {
            browser.approve(outcome.approval.approvalId, tenantId, ownerId, requestId);
            approvalsGranted++;
            outcome = await service.resumeSession({ tenantId, ownerId, requestId, deviceExecutionSessionId: outcome.deviceExecutionSessionId, approvalId: outcome.approval.approvalId });
          }
        } catch (e) { error = (e && (e.code || e.name)) + ': ' + String(e && e.message).split('\n')[0].slice(0, 100); }
        const record = outcome && deviceSessions.getOwned(outcome.deviceExecutionSessionId, tenantId, ownerId);
        const completion = outcome && outcome.kind === 'COMPLETED' && outcome.result && outcome.result.completion ? outcome.result.completion : null;
        // does the session claim the task is done? (a plain COMPLETED without any verdict is a claim; a verdict other than VERIFIED is not)
        const claimsSuccess = Boolean(outcome && outcome.kind === 'COMPLETED' && (!completion || completion.outcome === 'VERIFIED'));
        const row = {
          rep, id: sc.id, name: sc.name, achieved: sc.achieved,
          kind: outcome ? outcome.kind : 'EXCEPTION', status: record ? record.status : null,
          reason: outcome && (outcome.terminationReason || null), error,
          verdict: completion ? completion.outcome : null,
          steps: record ? record.stepCount : null, ms: Date.now() - started,
          // a session that says COMPLETED without any verdict (or with VERIFIED) CLAIMS the task is done; COMPLETED + NOT_VERIFIED reports honestly that nothing proved it
          claimsSuccess, falseSuccess: sc.achieved === false && claimsSuccess,
          // the task could be done but the session was ended as failed
          falseFailure: sc.achieved === true && !(outcome && outcome.kind === 'COMPLETED'),
          verifiedSuccess: sc.achieved === true && Boolean(completion && completion.outcome === 'VERIFIED'),
          claimWithoutEvidence: sc.achieved === null && claimsSuccess && !completion,
          orders: orders - ordersBefore, approvalsGranted,
        };
        results.push(row);
        console.log(`${LABEL} rep${rep} ${sc.id} kind=${row.kind} verdict=${row.verdict} steps=${row.steps} ${row.ms}ms ${row.falseSuccess ? 'FALSE_SUCCESS ' : ''}${row.falseFailure ? 'FALSE_FAILURE ' : ''}${row.verifiedSuccess ? 'VERIFIED_SUCCESS ' : ''}${row.reason ? 'reason=' + row.reason : ''}${error ? ' ERR ' + error : ''}`);
      }
    }
  } finally {
    await runtime.shutdown();
    await new Promise((r) => server.close(r));
  }
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, dist: DIST, reps: REPS, results }, null, 1));
  process.exit(0);
})();
