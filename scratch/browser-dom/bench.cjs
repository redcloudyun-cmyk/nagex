// Browser Runtime advanced-DOM benchmark (NOT part of the product or the test gate). The SAME file runs against two builds:
//   node --require <dist>/tests/_setup.js scratch/browser-dom/bench.cjs <distRoot> <label> <reps> <out.json>
// Real BrowserToolService + Chromium over deterministic local pages, with a fixed scripted agent that uses ONLY public tool results (find, structuredSnapshot, type, click, approve).
// Scenarios: open Shadow DOM, same-origin iframes (also nested), a cross-origin iframe (the honest outcome is a stated limit, never a guess), duplicate labels in different places, and a large page.
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

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const many = Array.from({ length: 3000 }, (_, i) => `<button type="button">Filler ${i}</button>`).join('');
let crossPort = 0;
const PAGES = {
  '/w01': page('start', `<button type="button" onclick="document.title='opened'">Open settings</button>`),
  '/w02': page('start', `<x-card></x-card><script>customElements.define('x-card', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<button type="button" id="inner">Open settings</button>'; r.getElementById('inner').addEventListener('click',()=>{document.title='opened';}); } });</script>`),
  '/w03': page('start', `<x-outer></x-outer><script>
    customElements.define('x-inner', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<input placeholder="Email address"><button type="button" id="go">Continue</button>'; r.getElementById('go').addEventListener('click',()=>{document.title='email:'+r.querySelector('input').value;}); } });
    customElements.define('x-outer', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<section><h2>Account</h2><x-inner></x-inner></section>'; } });</script>`),
  '/w04': page('start', `<h1>Search page</h1><iframe src="/frame-form" title="search frame" style="width:400px;height:160px"></iframe>`),
  '/frame-form': page('frame', `<input placeholder="Search" id="q"><button type="button" onclick="parent.document.title='go:'+document.getElementById('q').value">Go</button>`),
  '/w05': page('start', `<iframe src="/frame-outer" style="width:500px;height:260px"></iframe>`),
  '/frame-outer': page('outer', `<p>outer frame</p><iframe src="/frame-inner" style="width:420px;height:160px"></iframe>`),
  '/frame-inner': page('inner', `<button type="button" onclick="top.document.title='deep'">Open details</button>`),
  '/w06': () => page('start', `<iframe src="http://127.0.0.1:${crossPort}/cross" style="width:400px;height:160px"></iframe>`),
  '/w07': page('start', `<div class="card"><h3>Card A</h3><button type="button" onclick="document.title='A'">Open</button></div><x-b></x-b><script>customElements.define('x-b', class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:'open'}); r.innerHTML='<div class="card"><h3>Card B</h3><button type="button" id="b">Open</button></div>'; r.getElementById('b').addEventListener('click',()=>{document.title='B';}); } });</script>`),
  '/w08': page('start', `${many}<button type="button" onclick="document.title='found'">Needle button</button>`),
};
const CROSS = page('cross', `<button type="button" onclick="parent.postMessage('x','*')">Cross origin button</button>`);

function router(request, response) {
  const url = new URL(request.url, 'http://x');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const entry = PAGES[url.pathname];
  if (url.pathname === '/cross') { response.end(CROSS); return; }
  if (entry) response.end(typeof entry === 'function' ? entry() : entry); else { response.statusCode = 404; response.end('not found'); }
}

// ---------------------------------------------------------------- the scripted agent (identical for every build)
function makeAgent(service, input, counters) {
  const call = async (name, args) => { counters[name] = (counters[name] || 0) + 1; return service[name]({ ...input, ...args }); };
  const locate = async (query, ctxHint) => {
    const r = await call('find', { query });
    let pick = r.bestMatch;
    if (!pick && ctxHint) pick = r.candidates.find((c) => (c.context || '').toLowerCase().includes(ctxHint.toLowerCase()));
    if (!pick && r.candidates.length > 0) pick = r.candidates[0];
    if (pick) return { selector: pick.selector, limits: r.limits };
    throw Object.assign(new Error('no way to target: ' + query), { code: 'AGENT_NO_TARGET', limits: r.limits });
  };
  return {
    call, locate,
    typeInto: async (query, text, ctx) => call('type', { selector: (await locate(query, ctx)).selector, text }),
    clickOn: async (query, ctx) => call('click', { selector: (await locate(query, ctx)).selector }),
    title: async () => (await call('snapshot', {})).title,
  };
}

const SCENARIOS = [
  { id: 'W01', name: 'control: plain button in the page', path: '/w01', run: async (a) => { await a.clickOn('Open settings'); return (await a.title()) === 'opened'; } },
  { id: 'W02', name: 'button inside an open Shadow DOM', path: '/w02', run: async (a) => { await a.clickOn('Open settings'); return (await a.title()) === 'opened'; } },
  { id: 'W03', name: 'input + button inside nested open Shadow DOM (2 levels)', path: '/w03', run: async (a) => { await a.typeInto('Email address', 'a@b.co'); await a.clickOn('Continue'); return (await a.title()) === 'email:a@b.co'; } },
  { id: 'W04', name: 'input + button inside a same-origin iframe', path: '/w04', run: async (a) => { await a.typeInto('Search', 'nemotron'); await a.clickOn('Go'); return (await a.title()) === 'go:nemotron'; } },
  { id: 'W05', name: 'button inside an iframe inside an iframe (depth 2)', path: '/w05', run: async (a) => { await a.clickOn('Open details'); return (await a.title()) === 'deep'; } },
  { id: 'W06', name: 'cross-origin iframe: the runtime must STATE the limit', path: '/w06', run: async (a, ctx) => {
      try { await a.locate('Cross origin button'); ctx.targeted = true; return false; }
      catch (e) { ctx.limitStated = Array.isArray(e.limits) && e.limits.some((l) => /CROSS_ORIGIN/.test(l)); return ctx.limitStated; }
    } },
  { id: 'W07', name: 'two "Open" buttons, one in a Shadow DOM card: pick Card B by context', path: '/w07', run: async (a) => { await a.clickOn('Open', 'Card B'); return (await a.title()) === 'B'; } },
  { id: 'W08', name: 'the one matching button after 3000 other controls', path: '/w08', run: async (a) => { await a.clickOn('Needle button'); return (await a.title()) === 'found'; } },
];

(async () => {
  const server = http.createServer(router);
  const cross = http.createServer(router);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => cross.listen(0, '127.0.0.1', r));
  crossPort = cross.address().port;
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-dom-bench-'));
  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'sessions') });
  const service = new BrowserToolService(runtime, sessions, new ActionApprovalStore(), new AuditLogger(), new MemoryEngine());
  const results = [];
  try {
    for (let rep = 0; rep < REPS; rep++) {
      for (const sc of SCENARIOS) {
        const input = { tenantId: 'ten_dom', ownerId: 'usr_dom', requestId: `req_${sc.id}_${rep}` };
        const counters = {}; const ctx = {};
        const started = Date.now();
        let ok = false; let error = null; let sessionId = null;
        try {
          const s = await service.open(input); sessionId = s.browserSessionId;
          const scoped = { ...input, browserSessionId: sessionId };
          await service.navigate({ ...scoped, url: base + sc.path });
          ok = Boolean(await sc.run(makeAgent(service, scoped, counters), ctx));
        } catch (e) { error = (e && (e.code || e.name)) + ': ' + String(e && e.message).split('\n')[0].slice(0, 100); }
        finally { if (sessionId) await service.close({ ...input, browserSessionId: sessionId }).catch(() => {}); }
        const toolCalls = Object.values(counters).reduce((x, y) => x + y, 0);
        results.push({ rep, id: sc.id, name: sc.name, ok, error, ms: Date.now() - started, toolCalls, ...ctx });
        console.log(`${LABEL} rep${rep} ${sc.id} ${ok ? 'PASS' : 'FAIL'} ${Date.now() - started}ms calls=${toolCalls}${error ? ' ERR ' + error : ''}`);
      }
    }
  } finally {
    await runtime.shutdown();
    await new Promise((r) => server.close(r));
    await new Promise((r) => cross.close(r));
  }
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, dist: DIST, reps: REPS, results }, null, 1));
  process.exit(0);
})();
