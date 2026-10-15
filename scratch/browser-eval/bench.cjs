// Browser Runtime before/after benchmark (NOT part of the product or the test gate). The SAME file runs against two builds:
//   node --require <dist>/tests/_setup.js scratch/browser-eval/bench.cjs <distRoot> <label> <reps> <out.json> [--live]
// It drives the real BrowserToolService + PlaywrightBrowserRuntime (real Chromium) over deterministic local fixture pages, with a fixed scripted agent policy that uses ONLY the public tool
// results (find, structuredSnapshot, type, select, click, approve, executeApprovedClick). Per scenario it records success (from the final page state), the error code, wall time and tool calls.
// A human approval is simulated for consequential clicks (approve + executeApprovedClick) - exactly the flow the product requires - so the approval path is part of what is measured.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.NAGEX_ALLOW_LOCAL_TEST_URLS = '1';
const [, , DIST, LABEL, REPS_RAW, OUT, ...FLAGS] = process.argv;
const REPS = Number(REPS_RAW || 1);
const LIVE = FLAGS.includes('--live');
const { BrowserToolService } = require(path.join(DIST, 'src/modules/browser/browser.service.js'));
const { PlaywrightBrowserRuntime } = require(path.join(DIST, 'src/modules/browser/browser.runtime.js'));
const { BrowserSessionStore } = require(path.join(DIST, 'src/modules/browser/browser-session.store.js'));
const { ActionApprovalStore } = require(path.join(DIST, 'src/governance/action-approval.store.js'));
const { AuditLogger } = require(path.join(DIST, 'src/governance/audit.logger.js'));
const { MemoryEngine } = require(path.join(DIST, 'src/context/memory.engine.js'));

// ---------------------------------------------------------------- fixture pages
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const OUTPUT = '<div id="out"></div>';
const PAGES = {
  '/s01': page('Guides', '<h1>Guides</h1><a href="/s01-dest">Read the guide</a>'),
  '/s01-dest': page('Guide', '<h1>Guide content</h1>'),
  '/s02': page('Login', '<h1>Login</h1><form method="get" action="/login-result"><input type="email" name="email" placeholder="Email address"><input type="password" name="password" placeholder="Password"><button type="submit">Sign in</button></form>'),
  '/s03': page('Login (controlled)', `<h1>Login</h1><input type="email" placeholder="Email address"><input type="password" placeholder="Password"><button onclick="const i=document.querySelectorAll('input');out.textContent=i[1].value==='pw123'?'Welcome '+i[0].value:'Denied'">Sign in</button>${OUTPUT}`),
  '/s04': page('Profile', `<label for="a1">Full name</label><input id="a1" type="text"><label for="a2">Phone number</label><input id="a2" type="tel"><button onclick="out.textContent='Saved: '+a1.value+' / '+a2.value">Save profile</button>${OUTPUT}`),
  '/s05': page('Email', `<input id="user:email" type="text" placeholder="Email"><button id="go" onclick="out.textContent='Hello '+document.getElementById('user:email').value">Continue</button>${OUTPUT}`),
  '/s06': page('Dialog', '<div id="dlg">Dialog open</div><button aria-label="Close dialog" onclick="dlg.textContent=\'Dialog closed\'"><svg width="10" height="10"></svg></button>'),
  '/s07': page('Greeting', `<button onclick="out.textContent='Greeted'">Say "Hello" now</button>${OUTPUT}`),
  '/s08': page('Shop', `<div class="card"><h3>Product A</h3><button onclick="out.textContent='Cart: A'">Add to cart</button></div><div class="card"><h3>Product B</h3><button onclick="out.textContent='Cart: B'">Add to cart</button></div><div class="card"><h3>Product C</h3><button onclick="out.textContent='Cart: C'">Add to cart</button></div>${OUTPUT}`),
  '/s09': page('Search', `<button id="m" style="display:none" onclick="out.textContent='mobile'">Search</button><button id="d" onclick="out.textContent='desktop'">Search</button>${OUTPUT}`),
  '/s10': page('Wizard', `<button disabled>Next</button><button onclick="out.textContent='step 2'">Next</button>${OUTPUT}`),
  '/s11': page('Reports', `<div style="cursor:pointer" onclick="out.textContent='downloaded'">Download report</div>${OUTPUT}`),
  '/s12': page('Country', `<label for="c">Country</label><select id="c" onchange="out.textContent='Country: '+this.value"><option value="us">United States</option><option value="kr">Korea</option></select>${OUTPUT}`),
  '/s13': page('로그인', `<label for="k1">이메일</label><input id="k1" placeholder="name@example.com"><button onclick="out.textContent='환영 '+k1.value">로그인</button>${OUTPUT}`),
  '/s14': page('Shop', `<button id="buy-icon" aria-label="Buy now" onclick="out.textContent='ordered'"><svg width="10" height="10"></svg></button>${OUTPUT}`),
  '/s16': page('주문', `<button onclick="out.textContent='결제 완료'">결제하기</button>${OUTPUT}`),
  '/s15': page('Catalog', '<h1>Catalog</h1><form method="get" action="/s15-results"><input name="q" placeholder="Search products"><button type="submit">Search</button></form>'),
};
function route(req, res) {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/login-result') {
    const ok = url.searchParams.get('password') === 'pw123';
    res.end(page('Result', `<p>${ok ? 'Welcome ' + url.searchParams.get('email') : 'Denied'}</p>`));
  } else if (url.pathname === '/s15-results') {
    res.end(page('Results', `<h1>Results for ${url.searchParams.get('q')}</h1><a href="/s15-item">Item: Widget Pro</a><a href="/s15-item2">Item: Widget Lite</a>`));
  } else if (url.pathname === '/s15-item') {
    res.end(page('Widget Pro', '<h1>Widget Pro</h1><p>Price: 42</p>'));
  } else if (PAGES[url.pathname]) res.end(PAGES[url.pathname]);
  else { res.statusCode = 404; res.end(page('Not found', 'Not found')); }
}

// ---------------------------------------------------------------- the scripted agent (identical for every build)
function makeAgent(service, input, counters) {
  const call = async (name, args) => { counters[name] = (counters[name] || 0) + 1; return service[name]({ ...input, ...args }); };
  // legacy data only: what a capable agent can derive from structuredSnapshot when find() finds nothing
  const fromSnapshot = (snap, query) => {
    const q = query.toLowerCase();
    for (const i of snap.inputs || []) {
      const hay = [i.label, i.name, i.placeholder].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) return i.name ? `[name="${i.name}"]` : i.label ? `#${i.label}` : null;
    }
    for (const b of snap.buttons || []) if ((b.text || '').toLowerCase().includes(q)) return b.id ? `#${b.id}` : `button:has-text("${b.text}")`;
    for (const l of snap.links || []) if ((l.text || '').toLowerCase().includes(q)) return `a:has-text("${l.text}")`;
    return null;
  };
  const locate = async (query, ctxHint) => {
    const r = await call('find', { query });
    let pick = r.bestMatch;
    if (!pick && ctxHint) pick = r.candidates.find((c) => (c.context || '').toLowerCase().includes(ctxHint.toLowerCase()));
    if (!pick && r.candidates.length > 0) pick = r.candidates[0];
    if (pick) return pick.selector;
    const snap = await call('structuredSnapshot', {});
    const derived = fromSnapshot(snap, query);
    if (!derived) throw Object.assign(new Error('no way to target: ' + query), { code: 'AGENT_NO_TARGET' });
    return derived;
  };
  const clickSelector = async (selector) => {
    const r = await call('click', { selector });
    if (r.status === 'APPROVAL_REQUIRED') {
      counters.approvalRequested = (counters.approvalRequested || 0) + 1;
      service.approve(r.approval.approvalId, input.tenantId, input.ownerId, input.requestId);
      return call('executeApprovedClick', { approvalId: r.approval.approvalId, selector });
    }
    return r;
  };
  return {
    call,
    typeInto: async (query, text, ctx) => call('type', { selector: await locate(query, ctx), text }),
    clickOn: async (query, ctx) => clickSelector(await locate(query, ctx)),
    selectIn: async (query, value) => call('select', { selector: await locate(query), value }),
    clickSelector,
    locate,
    text: async () => (await call('snapshot', {})).text,
  };
}

const SCENARIOS = [
  { id: 'S01', name: 'plain link navigation (control)', path: '/s01', run: async (a) => { await a.clickOn('Read the guide'); return (await a.text()).includes('Guide content'); } },
  { id: 'S02', name: 'login form: placeholder-only inputs with name attributes + approved sign-in', path: '/s02', run: async (a) => { await a.typeInto('Email', 'alice@example.com'); await a.typeInto('Password', 'pw123'); await a.clickOn('Sign in'); return (await a.text()).includes('Welcome alice@example.com'); } },
  { id: 'S03', name: 'login form: placeholder-only inputs, no name/id (controlled inputs)', path: '/s03', run: async (a) => { await a.typeInto('Email', 'alice@example.com'); await a.typeInto('Password', 'pw123'); await a.clickOn('Sign in'); return (await a.text()).includes('Welcome alice@example.com'); } },
  { id: 'S04', name: '<label for> inputs without aria-label/placeholder', path: '/s04', run: async (a) => { await a.typeInto('Full name', 'Alice Kim'); await a.typeInto('Phone number', '010-1234'); await a.clickOn('Save profile'); return (await a.text()).includes('Saved: Alice Kim / 010-1234'); } },
  { id: 'S05', name: 'input id with a colon (user:email)', path: '/s05', run: async (a) => { await a.typeInto('Email', 'a@b.co'); await a.clickOn('Continue'); return (await a.text()).includes('Hello a@b.co'); } },
  { id: 'S06', name: 'icon-only button named by aria-label', path: '/s06', run: async (a) => { await a.clickOn('Close dialog'); return (await a.text()).includes('Dialog closed'); } },
  { id: 'S07', name: 'button text containing double quotes', path: '/s07', run: async (a) => { await a.clickOn('Hello'); return (await a.text()).includes('Greeted'); } },
  { id: 'S08', name: 'three identical "Add to cart" buttons, target Product B', path: '/s08', run: async (a) => { await a.clickOn('Add to cart', 'Product B'); return (await a.text()).includes('Cart: B'); } },
  { id: 'S09', name: 'hidden duplicate "Search" button before the visible one', path: '/s09', run: async (a) => { await a.clickOn('Search'); return (await a.text()).includes('desktop'); } },
  { id: 'S10', name: 'disabled "Next" before the enabled "Next"', path: '/s10', run: async (a) => { await a.clickOn('Next'); return (await a.text()).includes('step 2'); } },
  { id: 'S11', name: 'clickable div (onclick + pointer cursor, no role)', path: '/s11', run: async (a) => { await a.clickOn('Download report'); return (await a.text()).includes('downloaded'); } },
  { id: 'S12', name: 'select named by <label for>', path: '/s12', run: async (a) => { await a.selectIn('Country', 'kr'); return (await a.text()).includes('Country: kr'); } },
  { id: 'S13', name: 'Korean label + placeholder-only email + Korean button', path: '/s13', run: async (a) => { await a.typeInto('이메일', 'a@b.kr'); await a.clickOn('로그인'); return (await a.text()).includes('환영 a@b.kr'); } },
  { id: 'S14', name: 'SAFETY: icon-only "Buy now" (aria-label) must require approval', path: '/s14', safety: true, run: async (a, ctx) => {
      const r = await a.call('click', { selector: '#buy-icon' });
      ctx.requiredApproval = r.status === 'APPROVAL_REQUIRED';
      const changedBeforeApproval = (await a.text()).includes('ordered');
      return ctx.requiredApproval && !changedBeforeApproval;
    } },
  { id: 'S16', name: 'SAFETY: Korean "결제하기" (pay) must require approval', path: '/s16', safety: true, run: async (a, ctx) => {
      const selector = await a.locate('결제하기');
      const r = await a.call('click', { selector });
      ctx.requiredApproval = r.status === 'APPROVAL_REQUIRED';
      return ctx.requiredApproval && !(await a.text()).includes('결제 완료');
    } },
  { id: 'S15', name: 'multi-step: search -> results -> open item -> read price', path: '/s15', run: async (a) => { await a.typeInto('Search products', 'widget'); await a.clickOn('Search'); await a.clickOn('Widget Pro'); return (await a.text()).includes('Price: 42'); } },
];

(async () => {
  const server = http.createServer(route);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-browser-bench-'));
  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'sessions') });
  const service = new BrowserToolService(runtime, sessions, new ActionApprovalStore(), new AuditLogger(), new MemoryEngine());
  const results = [];
  try {
    for (let rep = 0; rep < REPS; rep++) {
      for (const sc of SCENARIOS) {
        const input = { tenantId: 'ten_bench', ownerId: 'usr_bench', requestId: `req_${sc.id}_${rep}` };
        const counters = {};
        const started = Date.now();
        const ctx = {};
        let ok = false; let error = null;
        let sessionId = null;
        try {
          const s = await service.open(input);
          sessionId = s.browserSessionId;
          const scoped = { ...input, browserSessionId: sessionId };
          await service.navigate({ ...scoped, url: base + sc.path });
          const agent = makeAgent(service, scoped, counters);
          ok = Boolean(await sc.run(agent, ctx));
        } catch (e) { error = (e && (e.code || e.name)) + ': ' + String(e && e.message).split('\n')[0].slice(0, 110); }
        finally { if (sessionId) await service.close({ ...input, browserSessionId: sessionId }).catch(() => {}); }
        const toolCalls = Object.values(counters).reduce((x, y) => x + (typeof y === 'number' ? y : 0), 0) - (counters.approvalRequested || 0);
        results.push({ rep, id: sc.id, name: sc.name, safety: Boolean(sc.safety), ok, error, ms: Date.now() - started, toolCalls, calls: counters, ...ctx });
        console.log(`${LABEL} rep${rep} ${sc.id} ${ok ? 'PASS' : 'FAIL'} ${Date.now() - started}ms calls=${toolCalls}${error ? ' ERR ' + error : ''}`);
      }
      if (LIVE) {
        const input = { tenantId: 'ten_bench', ownerId: 'usr_bench', requestId: `req_live_${rep}` };
        const counters = {}; const started = Date.now(); let ok = false; let error = null; let sessionId = null;
        try {
          const s = await service.open(input); sessionId = s.browserSessionId;
          const scoped = { ...input, browserSessionId: sessionId };
          await service.navigate({ ...scoped, url: 'https://en.wikipedia.org/wiki/Main_Page' });
          const agent = makeAgent(service, scoped, counters);
          await agent.typeInto('Search Wikipedia', 'Nemotron');
          await agent.call('keypress', { key: 'Enter' });
          await new Promise((r) => setTimeout(r, 2500));
          const snap = await agent.call('snapshot', {});
          ok = /Nemotron/i.test(snap.url + ' ' + snap.title);
        } catch (e) { error = (e && (e.code || e.name)) + ': ' + String(e && e.message).split('\n')[0].slice(0, 110); }
        finally { if (sessionId) await service.close({ ...input, browserSessionId: sessionId }).catch(() => {}); }
        const toolCalls = Object.values(counters).reduce((x, y) => x + (typeof y === 'number' ? y : 0), 0);
        results.push({ rep, id: 'L01', name: 'LIVE en.wikipedia.org: type into "Search Wikipedia" + Enter', safety: false, ok, error, ms: Date.now() - started, toolCalls, calls: counters, live: true });
        console.log(`${LABEL} rep${rep} L01 ${ok ? 'PASS' : 'FAIL'} ${Date.now() - started}ms calls=${toolCalls}${error ? ' ERR ' + error : ''}`);
      }
    }
  } finally {
    await runtime.shutdown();
    await new Promise((r) => server.close(r));
  }
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, dist: DIST, reps: REPS, results }, null, 1));
  process.exit(0);
})();
