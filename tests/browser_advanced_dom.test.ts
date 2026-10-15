// The element map used to see only the top document's light DOM and its first few hundred controls. A button inside an open Shadow DOM, a field inside an iframe, or the one matching control after
// three thousand others simply did not exist for the Agent - and a light-DOM selector that was unique became AMBIGUOUS the moment a shadow root held the same label. This file pins the advanced-DOM
// support: open shadow roots (nested), same-origin iframes (nested), a stated limit instead of a guess for frames NAgex must not enter (cross-origin, sandboxed), bounded scanning, correct identity
// of duplicates, safe re-resolution of a re-rendered control - and that none of it reads a password, mutates the page, or weakens approval. Real Chromium over deterministic local pages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { PlaywrightBrowserRuntime, splitFramePath } from '../src/modules/browser/browser.runtime.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { DeviceControlService } from '../src/device-control/device-control.service.js';
import { DeviceExecutionSessionStore } from '../src/device-control/device-execution-session.store.js';
import type { ProposedDeviceAction } from '../src/device-control/device-action.types.js';
import type { ProposeNextActionInput, VisualExecutionModelPort } from '../src/device-control/visual-execution-model.port.js';

process.env.NAGEX_ALLOW_LOCAL_TEST_URLS = '1';

const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const defineShadow = (tag: string, inner: string, script = '') => `<script>customElements.define('${tag}', class extends HTMLElement { constructor(){ super(); const r = this.attachShadow({mode:'open'}); r.innerHTML = ${JSON.stringify(inner)}; ${script} } });</script>`;
let crossPort = 0;
let orders = 0;
// The /replace pages swap their control only when the test says so (a page timer raced the model's observation on a slow runner: once the control was swapped BEFORE it was observed, there was nothing stale to re-resolve).
let swapAllowed = false;
let swapped = false;
const AWAIT_SWAP = `function awaitSwap(fn){ (function poll(){ fetch('/swap-gate').then(function(r){ return r.text(); }).then(function(v){ if (v === '1') { fn(); fetch('/swapped'); } else { setTimeout(poll, 40); } }); })(); }`;
let mutationRecords = 0;
const hugeList = Array.from({ length: 3000 }, (_, i) => `<button type="button">Filler ${i}</button>`).join('');
const vastList = Array.from({ length: 30000 }, (_, i) => `<button type="button">Item ${i}</button>`).join('');
const PAGES: Record<string, () => string> = {
  '/shadow': () => html('start', `<x-card></x-card>${defineShadow('x-card', '<button type="button" id="inner">Open settings</button>', "r.getElementById('inner').addEventListener('click',()=>{document.title='opened';});")}`),
  '/shadow-nested': () => html('start', `<x-outer></x-outer>
    ${defineShadow('x-inner', '<input placeholder="Email address"><input type="password" placeholder="Password" value="hunter2-secret"><button type="button" id="go">Continue</button>', "r.getElementById('go').addEventListener('click',()=>{document.title='email:'+r.querySelector('input').value;});")}
    ${defineShadow('x-outer', '<section><h2>Account</h2><x-inner></x-inner></section>')}`),
  '/shadow-closed': () => html('start', `<x-closed></x-closed><script>customElements.define('x-closed', class extends HTMLElement { constructor(){ super(); const r = this.attachShadow({mode:'closed'}); r.innerHTML = '<button type="button">Hidden from script</button>'; } });</script><button type="button">Visible button</button>`),
  '/iframe': () => html('start', `<h1>Search page</h1><iframe src="/frame-form" title="search frame" style="width:420px;height:170px"></iframe><iframe srcdoc="<button onclick=&quot;parent.document.title='srcdoc'&quot;>Open from srcdoc</button>" style="width:300px;height:80px"></iframe>`),
  '/frame-form': () => html('frame', `<input placeholder="Search" id="q"><input type="password" placeholder="Frame password" value="frame-secret"><button type="button" onclick="parent.document.title='go:'+document.getElementById('q').value">Go</button>`),
  '/iframe-nested': () => html('start', `<iframe src="/frame-outer" style="width:520px;height:280px"></iframe>`),
  '/frame-outer': () => html('outer', `<p>outer frame</p><iframe src="/frame-inner" style="width:420px;height:170px"></iframe>`),
  '/frame-inner': () => html('inner', `<button type="button" onclick="top.document.title='deep'">Open details</button>`),
  '/iframe-deep': () => html('start', `<iframe src="/d1" style="width:600px;height:400px"></iframe>`),
  '/d1': () => html('d1', `<iframe src="/d2" style="width:500px;height:300px"></iframe>`),
  '/d2': () => html('d2', `<iframe src="/d3" style="width:400px;height:200px"></iframe>`),
  '/d3': () => html('d3', `<iframe src="/d4" style="width:300px;height:100px"></iframe>`),
  '/d4': () => html('d4', `<button type="button">Too deep</button>`),
  '/iframe-cross': () => html('start', `<button type="button">Top button</button><iframe src="http://127.0.0.1:${crossPort}/cross" style="width:400px;height:160px"></iframe>`),
  '/iframe-sandbox': () => html('start', `<iframe sandbox src="/frame-inner" style="width:420px;height:170px"></iframe>`),
  '/duplicates': () => html('start', `<div class="card"><h3>Card A</h3><button type="button" onclick="document.title='A'">Open</button></div><x-b></x-b>
    ${defineShadow('x-b', '<div class="card"><h3>Card B</h3><button type="button" id="b">Open</button></div>', "r.getElementById('b').addEventListener('click',()=>{document.title='B';});")}
    <iframe srcdoc="<div><h3>Card C</h3><button onclick=&quot;parent.document.title='C'&quot;>Open</button></div>" style="width:300px;height:100px"></iframe>`),
  '/huge': () => html('start', `${hugeList}<button type="button" onclick="document.title='found'">Needle button</button>`),
  '/vast': () => html('start', `${vastList}<button type="button">Needle at the very end</button>`),
  '/mutation': () => html('start', `<script>let n=0;new MutationObserver(function(r){n+=r.length;fetch('/beacon?n='+n)}).observe(document,{subtree:true,attributes:true,childList:true,characterData:true});</script><x-m></x-m>${defineShadow('x-m', '<button type="button">Shadow action</button>')}<iframe src="/frame-inner" style="width:300px;height:100px"></iframe>`),
  '/replace': () => html('start', `<div id="host"><button id="old" type="button" onclick="document.title='clicked-old'">Continue</button></div><script>${AWAIT_SWAP}awaitSwap(function(){ document.getElementById('host').innerHTML='<button id="fresh" type="button" onclick="document.title=\\'clicked-new\\'">Continue</button>'; });</script>`),
  '/replace-twice': () => html('start', `<div id="host"><button id="old" type="button">Continue</button></div><script>${AWAIT_SWAP}awaitSwap(function(){ document.getElementById('host').innerHTML='<button id="a" type="button" onclick="document.title=\\'a\\'">Continue</button><button id="b" type="button" onclick="document.title=\\'b\\'">Continue</button>'; });</script>`),
  '/replace-buy': () => html('start', `<div id="host"><button id="old" type="button">Buy now</button></div><script>${AWAIT_SWAP}awaitSwap(function(){ document.getElementById('host').innerHTML='<button id="fresh" type="button" onclick="fetch(\\'/order\\',{method:\\'POST\\'});document.title=\\'ordered\\'">Buy now</button>'; });</script>`),
};
const CROSS = html('cross', '<button type="button">Cross origin button</button>');

let server: http.Server;
let cross: http.Server;
let base = '';
let runtime: PlaywrightBrowserRuntime;
let tmp = '';
let counter = 0;

const handler = (isCross: boolean) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/beacon') { mutationRecords = Math.max(mutationRecords, Number(url.searchParams.get('n') || 0)); res.statusCode = 204; res.end(); return; }
  if (url.pathname === '/order') { orders++; res.end('ok'); return; }
  if (url.pathname === '/swap-gate') { res.end(swapAllowed ? '1' : '0'); return; }
  if (url.pathname === '/swapped') { swapped = true; res.statusCode = 204; res.end(); return; }
  if (url.pathname.startsWith('/replace')) { swapAllowed = false; swapped = false; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (isCross || url.pathname === '/cross') { res.end(CROSS); return; }
  const page = PAGES[url.pathname];
  if (!page) { res.statusCode = 404; res.end('not found'); return; }
  res.end(page());
};

before(async () => {
  server = http.createServer(handler(false));
  cross = http.createServer(handler(true));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => cross.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  crossPort = (cross.address() as { port: number }).port;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-adv-dom-'));
  runtime = new PlaywrightBrowserRuntime(false, path.join(tmp, 'profiles'));
});

after(async () => {
  await runtime.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => cross.close(() => resolve()));
});

function rig() {
  const sessions = new BrowserSessionStore({ dir: fs.mkdtempSync(path.join(tmp, 'sessions-')) });
  return new BrowserToolService(runtime, sessions, new ActionApprovalStore(), new AuditLogger(), new MemoryEngine());
}

async function open(pagePath: string, service = rig()) {
  const input = { tenantId: 'ten_dom', ownerId: 'usr_dom', requestId: `req_dom_${++counter}` };
  const session = await service.open(input);
  const scoped = { ...input, browserSessionId: session.browserSessionId };
  await service.navigate({ ...scoped, url: base + pagePath });
  return { service, scoped, close: () => service.close(scoped), title: async () => (await service.snapshot(scoped)).title };
}

describe('the frame path notation', () => {
  it('splits frame segments, but never inside a quoted attribute value', () => {
    assert.deepEqual(splitFramePath('button#go'), ['button#go']);
    assert.deepEqual(splitFramePath('iframe#a ⟫ iframe[title="b"] ⟫ button#go'), ['iframe#a', 'iframe[title="b"]', 'button#go']);
    assert.deepEqual(splitFramePath('iframe[title="a ⟫ b"] ⟫ button'), ['iframe[title="a ⟫ b"]', 'button']);
    assert.deepEqual(splitFramePath("iframe[title='x ⟫ y'] ⟫ button"), ["iframe[title='x ⟫ y']", 'button']);
    assert.deepEqual(splitFramePath('[name="q\\" ⟫ r"] ⟫ a'), ['[name="q\\" ⟫ r"]', 'a']);
  });
});

describe('open Shadow DOM', () => {
  it('a button inside an open shadow root is found and clicked; so is an input two shadow roots deep; the flat page is what a person sees', async () => {
    const p = await open('/shadow');
    try {
      const found = await p.service.find({ ...p.scoped, query: 'Open settings' });
      assert.equal(found.candidates.length, 1);
      assert.equal(found.bestMatch?.inShadow, true);
      assert.equal(found.limits, undefined, 'nothing was left out');
      const result = await p.service.click({ ...p.scoped, selector: found.bestMatch!.selector });
      assert.equal(result.status, 'EXECUTED');
      assert.equal(await p.title(), 'opened');
    } finally { await p.close(); }
    const n = await open('/shadow-nested');
    try {
      const email = await n.service.find({ ...n.scoped, query: 'Email address' });
      assert.ok(email.bestMatch?.inShadow);
      await n.service.type({ ...n.scoped, selector: email.bestMatch!.selector, text: 'a@b.co' });
      const go = await n.service.find({ ...n.scoped, query: 'Continue' });
      assert.ok(go.bestMatch?.context?.includes('Account'), `context carries the section: ${go.bestMatch?.context}`);
      await n.service.click({ ...n.scoped, selector: go.bestMatch!.selector });
      assert.equal(await n.title(), 'email:a@b.co');
    } finally { await n.close(); }
  });

  it('a closed shadow root is not reachable from script: its controls are not listed, and nothing breaks', async () => {
    const p = await open('/shadow-closed');
    try {
      assert.equal((await p.service.find({ ...p.scoped, query: 'Hidden from script' })).candidates.length, 0);
      assert.equal((await p.service.find({ ...p.scoped, query: 'Visible button' })).candidates.length, 1);
    } finally { await p.close(); }
  });

  it('a password inside a shadow root or an iframe is listed as a password field but its content never appears anywhere', async () => {
    const shadow = await open('/shadow-nested');
    const frame = await open('/iframe');
    try {
      const a = JSON.stringify({ snap: await shadow.service.structuredSnapshot(shadow.scoped), find: await shadow.service.find({ ...shadow.scoped, query: 'Password' }) });
      const b = JSON.stringify({ snap: await frame.service.structuredSnapshot(frame.scoped), find: await frame.service.find({ ...frame.scoped, query: 'Frame password' }) });
      assert.doesNotMatch(a, /hunter2-secret/);
      assert.doesNotMatch(b, /frame-secret/);
      assert.match(a, /"type":"password"/);
      assert.match(b, /"type":"password"/);
    } finally { await shadow.close(); await frame.close(); }
  });
});

describe('same-origin iframes', () => {
  it('a field and a button inside an iframe, and a control inside an srcdoc iframe, are found, typed into and clicked through a frame-qualified selector', async () => {
    const p = await open('/iframe');
    try {
      const search = await p.service.find({ ...p.scoped, query: 'Search' });
      assert.ok(search.bestMatch?.frame, 'the control says which frame it is in');
      assert.match(search.bestMatch!.selector, / ⟫ /);
      await p.service.type({ ...p.scoped, selector: search.bestMatch!.selector, text: 'nemotron' });
      const go = await p.service.find({ ...p.scoped, query: 'Go' });
      await p.service.click({ ...p.scoped, selector: go.bestMatch!.selector });
      assert.equal(await p.title(), 'go:nemotron');
      const srcdoc = await p.service.find({ ...p.scoped, query: 'Open from srcdoc' });
      await p.service.click({ ...p.scoped, selector: srcdoc.bestMatch!.selector });
      assert.equal(await p.title(), 'srcdoc');
    } finally { await p.close(); }
  });

  it('an iframe inside an iframe works; frames deeper than the bound are not entered and the limit says so', async () => {
    const p = await open('/iframe-nested');
    try {
      const found = await p.service.find({ ...p.scoped, query: 'Open details' });
      assert.equal((found.bestMatch!.selector.match(/ ⟫ /g) ?? []).length, 2, 'two frame hops');
      await p.service.click({ ...p.scoped, selector: found.bestMatch!.selector });
      assert.equal(await p.title(), 'deep');
    } finally { await p.close(); }
    const deep = await open('/iframe-deep');
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200)); // the nested frames load after the top document
      const found = await deep.service.find({ ...deep.scoped, query: 'Too deep' });
      assert.equal(found.candidates.length, 0);
      assert.ok(found.limits?.includes('FRAME_DEPTH_LIMIT'), JSON.stringify(found.limits));
    } finally { await deep.close(); }
  });

  it('the snapshot lists the controls of frames and shadow roots with where they are, and its limits', async () => {
    const p = await open('/iframe');
    try {
      const snap = await p.service.structuredSnapshot(p.scoped);
      const inFrame = (snap.interactive ?? []).filter((e) => e.frame);
      assert.ok(inFrame.length >= 3, 'search field, password field, Go button and the srcdoc button');
      assert.equal(snap.interactiveLimits, undefined);
    } finally { await p.close(); }
  });
});

describe('frames NAgex must not enter', () => {
  it('a cross-origin iframe is not entered; its controls are not listed; the limit is stated; a crafted frame path into it is refused', async () => {
    const p = await open('/iframe-cross');
    try {
      const top = await p.service.find({ ...p.scoped, query: 'Top button' });
      assert.equal(top.candidates.length, 1);
      assert.ok(top.limits?.includes('CROSS_ORIGIN_FRAMES:1'), JSON.stringify(top.limits));
      const inside = await p.service.find({ ...p.scoped, query: 'Cross origin button' });
      assert.equal(inside.candidates.length, 0);
      assert.ok(inside.limits?.includes('CROSS_ORIGIN_FRAMES:1'));
      const iframeSelector = 'iframe';
      await assert.rejects(() => p.service.click({ ...p.scoped, selector: `${iframeSelector} ⟫ button` }), (e: any) => e.code === 'BROWSER_FRAME_NOT_ACCESSIBLE');
      const snap = await p.service.structuredSnapshot(p.scoped);
      assert.ok(snap.interactiveLimits?.includes('CROSS_ORIGIN_FRAMES:1'));
    } finally { await p.close(); }
  });

  it('a sandboxed iframe (opaque origin) is not entered either', async () => {
    const p = await open('/iframe-sandbox');
    try {
      const found = await p.service.find({ ...p.scoped, query: 'Open details' });
      assert.equal(found.candidates.length, 0);
      assert.ok(found.limits?.includes('OPAQUE_ORIGIN_FRAMES:1'), JSON.stringify(found.limits));
    } finally { await p.close(); }
  });
});

describe('duplicates, identity and large pages', () => {
  it('"Open" in the light DOM, in a shadow root and in an iframe: three candidates, three distinct selectors, each opens its own card', async () => {
    const p = await open('/duplicates');
    try {
      const found = await p.service.find({ ...p.scoped, query: 'Open' });
      assert.equal(found.candidates.length, 3);
      assert.equal(found.bestMatch, undefined, 'three equals: nothing is guessed');
      assert.equal(new Set(found.candidates.map((c) => c.selector)).size, 3);
      for (const card of ['A', 'B', 'C']) {
        const candidate = found.candidates.find((c) => (c.context ?? '').includes(`Card ${card}`))!;
        assert.ok(candidate, `context tells card ${card} apart`);
        const result = await p.service.click({ ...p.scoped, selector: candidate.selector });
        assert.equal(result.status, 'EXECUTED');
        assert.equal(await p.title(), card);
      }
    } finally { await p.close(); }
  });

  it('a light-DOM selector stays unique even when a shadow root holds the same label (the incident: it used to turn ambiguous)', async () => {
    const p = await open('/duplicates');
    try {
      const found = await p.service.find({ ...p.scoped, query: 'Open' });
      for (const candidate of found.candidates) {
        assert.equal((await runtime.resolveSelector(p.scoped.browserSessionId, candidate.selector)).count, 1, candidate.selector);
      }
    } finally { await p.close(); }
  });

  it('the one matching control after three thousand others is found (the query narrows the scan; the old fixed cut-off lost it)', async () => {
    const p = await open('/huge');
    try {
      const started = Date.now();
      const found = await p.service.find({ ...p.scoped, query: 'Needle button' });
      assert.equal(found.bestMatch?.name, 'Needle button');
      assert.equal(found.limits, undefined);
      assert.ok(Date.now() - started < 8000, `find took ${Date.now() - started} ms`);
      await p.service.click({ ...p.scoped, selector: found.bestMatch!.selector });
      assert.equal(await p.title(), 'found');
    } finally { await p.close(); }
  });

  it('on a page far larger than any bound the scan stays bounded and says it stopped short', async () => {
    const p = await open('/vast');
    try {
      const started = Date.now();
      const found = await p.service.find({ ...p.scoped, query: 'Item' });
      const elapsed = Date.now() - started;
      assert.ok(found.candidates.length <= 10);
      assert.ok(found.limits?.includes('SCAN_TRUNCATED'), JSON.stringify(found.limits));
      assert.ok(elapsed < 15000, `bounded: ${elapsed} ms`);
    } finally { await p.close(); }
  });

  it('finding across shadow roots and frames changes nothing on the page', async () => {
    const p = await open('/mutation');
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterLoad = mutationRecords;
      await p.service.find({ ...p.scoped, query: 'Shadow action' });
      await p.service.find({ ...p.scoped, query: 'Open details' });
      await p.service.structuredSnapshot(p.scoped);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(mutationRecords, afterLoad);
    } finally { await p.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------- re-resolution in the Agent loop

class Scripted implements VisualExecutionModelPort {
  public proposals = 0;
  public readonly seen: ProposeNextActionInput[] = [];
  constructor(private readonly pagePath: string, private readonly policy: (n: number, ctx: ProposeNextActionInput) => ProposedDeviceAction | undefined) {}
  public async proposeNextAction(ctx: ProposeNextActionInput): Promise<ProposedDeviceAction> {
    this.seen.push(ctx);
    const n = this.proposals++;
    if (n === 0) return { action: 'NAVIGATE', value: base + this.pagePath };
    const next = this.policy(n - 1, ctx);
    if (!next) throw new Error('script exhausted');
    return next;
  }
}
const A = (action: ProposedDeviceAction['action'], selector?: string, extra: Partial<ProposedDeviceAction> = {}): ProposedDeviceAction => ({ action, ...(selector ? { target: { selector } } : {}), ...extra });

async function runAgent(pagePath: string, policy: (n: number, ctx: ProposeNextActionInput) => ProposedDeviceAction | undefined, options: { approve?: boolean } = {}) {
  const service = rig();
  const deviceSessions = new DeviceExecutionSessionStore({ dir: fs.mkdtempSync(path.join(tmp, 'device-')) });
  const model = new Scripted(pagePath, policy);
  const agent = new DeviceControlService(deviceSessions, service, model);
  const ident = { tenantId: 'ten_dom', ownerId: 'usr_dom' };
  let outcome = await agent.startSession({ ...ident, requestId: `req_adom_${++counter}`, goal: 'test', allowedDomains: ['127.0.0.1'], maxSteps: 20, maxDurationMs: 120_000 });
  while (outcome.kind === 'WAITING_APPROVAL' && options.approve) {
    service.approve(outcome.approval.approvalId, ident.tenantId, ident.ownerId, 'req_adom_approve');
    outcome = await agent.resumeSession({ ...ident, requestId: `req_adom_resume_${++counter}`, deviceExecutionSessionId: outcome.deviceExecutionSessionId, approvalId: outcome.approval.approvalId });
  }
  const record = 'deviceExecutionSessionId' in outcome ? deviceSessions.getOwned(outcome.deviceExecutionSessionId, ident.tenantId, ident.ownerId) : null;
  return { outcome, model, service, browserSessionId: record?.browserSessionId ?? '' };
}

describe('a control that was re-rendered between looking and acting', () => {
  // proposal 1 waits until the page has replaced the control (the model "thinks" for a while); its selector comes from the observation it was shown
  const staleClick = (afterSelector: ProposedDeviceAction) => (n: number, ctx: ProposeNextActionInput) => {
    if (n === 0) {
      const seen = (ctx.structuredSnapshot.interactive ?? []).find((e) => /^(continue|buy now)$/i.test(e.name));
      // the observation above is the old control; only now may the page swap it, and the click is proposed once the swap has happened
      swapAllowed = true;
      return (async () => {
        const deadline = Date.now() + 15_000;
        while (!swapped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(swapped, true, 'the page swapped the control');
        return A('CLICK', seen?.selector);
      })() as unknown as ProposedDeviceAction;
    }
    return n === 1 ? afterSelector : undefined;
  };

  it('the same control found again (same kind, same name, exactly one) is acted on once, and the model is told', async () => {
    const r = await runAgent('/replace', staleClick(A('STOP', undefined, { expectedResult: 'continued' })) as any);
    assert.equal(r.outcome.kind, 'COMPLETED');
    const told = r.model.seen[r.model.seen.length - 1].priorActions.map((p) => p.outcome).join('\n');
    assert.match(told, /RE-RESOLVED: the same control \(button "Continue"\) was found again/);
    const page = await r.service.snapshot({ tenantId: 'ten_dom', ownerId: 'usr_dom', requestId: 'req_after', browserSessionId: r.browserSessionId });
    assert.equal(page.title, 'clicked-new', 'the control that exists now was clicked, not a guess');
  });

  it('two equally good replacements are NOT guessed between: the failure goes back to the model', async () => {
    const r = await runAgent('/replace-twice', staleClick(A('STOP', undefined, { expectedResult: 'x' })) as any);
    const told = r.model.seen[r.model.seen.length - 1].priorActions.map((p) => p.outcome).join('\n');
    assert.match(told, /FAILED: BROWSER_SELECTOR_NOT_FOUND/);
    assert.doesNotMatch(told, /RE-RESOLVED/);
  });

  it('a re-resolved CONSEQUENTIAL control still waits for a human, shows the new target, and runs once only when approved', async () => {
    const ordersBefore = orders;
    const waiting = await runAgent('/replace-buy', staleClick(A('STOP', undefined, { expectedResult: 'ordered' })) as any, { approve: false });
    assert.equal(waiting.outcome.kind, 'WAITING_APPROVAL');
    assert.equal(orders, ordersBefore, 'nothing was ordered while waiting');
    const approval = (waiting.outcome as any).approval;
    assert.equal(approval.canonicalPayload.targetText, 'Buy now');
    assert.match(String(approval.canonicalPayload.selector), /fresh/, 'the approval names the control that exists now');
    const done = await runAgent('/replace-buy', staleClick(A('STOP', undefined, { expectedResult: 'ordered' })) as any, { approve: true });
    assert.equal(done.outcome.kind, 'COMPLETED');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(orders, ordersBefore + 1, 'exactly one order');
  });
});
