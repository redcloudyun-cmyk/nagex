// R24.8B — source/markup contract for UI truthfulness and i18n completeness (the behavior itself is certified in
// real Chromium by r24_8b_entry_truthful_ui_browser and through the real routes by r24_8b_plan_integrity).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const PUBLIC_FILES = ['public/index.html', 'public/app.js', 'public/personal-home-view.js', 'public/mobile/mobile-home.js', 'public/desktop/desktop-home.js', 'public/i18n.js', 'public/auth-ui.js', 'public/plan-resolution-view.js'];

function loadI18n(): { t: (k: string) => string; setLocale: (l: string) => void } {
  const context: any = { window: {}, document: { readyState: 'loading', addEventListener() {}, documentElement: {}, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' }, CustomEvent: class {} };
  vm.createContext(context);
  vm.runInContext(read('public/i18n.js'), context);
  return context.window.NAGEX_I18N;
}

// Lines that are code/markup a user can see (not // or * comments, not HTML comment lines).
function userFacingLines(src: string): Array<{ n: number; line: string }> {
  const out: Array<{ n: number; line: string }> = [];
  let inHtmlComment = false;
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (inHtmlComment) { if (t.includes('-->')) inHtmlComment = false; return; }
    if (t.startsWith('<!--')) { if (!t.includes('-->')) inHtmlComment = true; return; }
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    out.push({ n: i + 1, line });
  });
  return out;
}

describe('R24.8B — no user-visible mojibake or malformed markup in the product UI sources', () => {
  const BAD = /�|\?\?[^\s?.,;:)\]]|\?\?(?=\s*<)|[㐀-䶿一-鿿豈-﫿]|\?[ㄱ-힣]|>\?\?|\?\?\/[a-z]+>/;
  for (const file of PUBLIC_FILES) {
    it(`${file} contains none outside comments`, () => {
      const hits = userFacingLines(read(file)).filter(({ line }) => BAD.test(line) && !/\?\?\s*[=:)]|\?\? \w+\)/.test(line)).map(({ n, line }) => `${n}: ${line.trim().slice(0, 90)}`);
      assert.deepEqual(hits, [], hits.join('\n'));
    });
  }
  it('the shortcut chip names a shortcut that really exists (Alt+N), and the page title is clean', () => {
    const html = read('public/index.html');
    assert.match(html, /<kbd>Alt\+N<\/kbd>/);
    assert.match(html, /<title>NAgex — Personal AI Control Center<\/title>/);
    assert.match(read('public/app.js'), /e\.altKey && \(e\.key === 'n' \|\| e\.key === 'N'\)/);
  });
  it('the Korean "Continue working" heading is real Korean', () => {
    assert.match(read('public/mobile/mobile-home.js'), /isKo \? '이어서 작업하기' : 'Continue working'/);
  });
});

describe('R24.8B — fabricated demo data is gone from the committed views', () => {
  const html = read('public/index.html');
  const live = userFacingLines(html).map((l) => l.line).join('\n');
  it('Plans: no sample plan, no fabricated statistics, no fake execution timeline, no dead "Create a new plan" button', () => {
    for (const forbidden of [/Acme Corp/, /Prepare Client Meeting/, /Understand meeting context/, /2 in progress/, /4 completed/, /Open plans/, /Memory loaded/, /Research completed with Perplexity/, /plan-execute-split-layout/, /mockup-steps-table/, /5 of 8 steps completed/]) assert.doesNotMatch(live, forbidden);
    assert.match(live, /id="btn-plans-ask"[^>]*onclick="window\.NAGEX\.openAsk\(\)"/);
    assert.match(live, /id="plans-list-container"/);
  });
  it('Approvals: no hardcoded count and no dead History/Pending filter buttons; the label is filled from real state', () => {
    assert.doesNotMatch(live, /Pending \(\d+\)/);
    assert.doesNotMatch(live, /data-appr-filter/);
    assert.match(live, /id="approvals-count-label"/);
    assert.match(read('public/app.js'), /approvalSections[\s\S]*apprData\.pending/);
  });
  it('Create: no sample reference images with made-up artifact ids', () => {
    assert.doesNotMatch(live, /ref_img_neon_city|ref_img_portrait_sketch|Neon City Ref|Portrait Ref|create-reference-selector/);
  });
  it('the production shell has no fabricated personal progress or capability promo meter', () => {
    assert.doesNotMatch(live, /A more capable you, every day\./);
    assert.doesNotMatch(live, /promo-progress-fill/);
    assert.doesNotMatch(live, /width:\s*75%/);
  });
  it('Tasks render real status text, not an arbitrary percent progress bar', () => {
    const app = read('public/app.js');
    const renderTasks = app.slice(app.indexOf('function renderTasks('), app.indexOf('// ─── Helper & Section Anchors', app.indexOf('function renderTasks(')));
    assert.doesNotMatch(renderTasks, /task\.progress\.percent/);
    assert.doesNotMatch(renderTasks, /progress-bar-small/);
    assert.doesNotMatch(renderTasks, /\$\{percent\}%/);
    assert.match(renderTasks, /task\.lastRunStatus \|\| task\.status/);
  });
  it('the idle Ask sheet hides its sample task/request/progress cards until a real request runs', () => {
    const app = read('public/app.js');
    assert.match(app, /function applyAmbientIdleAndModeUi/);
    assert.match(app, /function showAmbientRequestCards/);
    assert.match(app, /showAmbientRequestCards\(promptText\);\n\s+try \{/);
  });
  it('no step of the plan card claims work that has not run', () => {
    const app = read('public/app.js');
    assert.equal((app.match(/ambientTruthfulSteps\(t, isKr\)/g) || []).length, 4);
    assert.doesNotMatch(app, /Checked your availability|Found related notes and emails|Examined document structure|Extracted key clauses|Searching trusted sources|Reading recent updates|Generating visual asset|Analyzed prompt recipe/);
  });
});

describe('R24.8B — entry points are wired to the canonical runtime (no second router)', () => {
  const app = read('public/app.js');
  const home = read('public/personal-home-view.js');
  const mobile = read('public/mobile/mobile-home.js');
  it('the header Ask control opens the same Ask sheet as Quick Wake; the Create tiles open it in a mode', () => {
    assert.match(app, /getElementById\('btn-header-search'\);\n\s+if \(btnSearch\) btnSearch\.onclick = \(\) => openAmbientOverlay\(\)/);
    assert.match(app, /window\.NAGEX\.openAsk = \(mode\) => openAmbientOverlay\(mode\)/);
    assert.match(home, /window\.NAGEX\.openAsk\('REPORT'\)/);
    assert.match(home, /window\.NAGEX\.openAsk\('RESEARCH'\)/);
  });
  it('Report/Research from the sheet use the existing submitReport / submitResearch, not a new router', () => {
    const fn = app.slice(app.indexOf('async function submitAmbientCreation'), app.indexOf('// Dismisses the Ambient Assistant'));
    assert.match(fn, /home\.submitReport\(text\)/);
    assert.match(fn, /home\.submitResearch\(text, \{ quiet: true \}\)/);
    assert.doesNotMatch(fn, /apiFetch\(/);
  });
  it('a created report opens in Canvas with its REAL projection (title, Ask support), not an empty one', () => {
    const fn = home.slice(home.indexOf('async function submitReport'), home.indexOf('function activateCreationAction'));
    assert.match(fn, /\/api\/v1\/artifacts\//);
    assert.match(fn, /openArtifactInCanvas\(result\.artifactId, 'DOCUMENT', projection \? projection\.canvasTarget : undefined, result\.openTarget, projection\)/);
    assert.doesNotMatch(fn, /result\.openTarget, null\)/);
  });
  it('the Mobile composer routes REPORT (it used to ignore the mode) and explains failures', () => {
    assert.match(mobile, /creationMode === 'REPORT'[\s\S]{0,200}submitReport\(text\)/);
    assert.match(mobile, /explainCreationFailure\('RESEARCH', result\)/);
    assert.match(mobile, /explainCreationFailure\('REPORT', result\)/);
  });
});

describe('R24.8B — i18n: every statically referenced key resolves in EN and KR', () => {
  const i18n = loadI18n();
  const referenced = new Set<string>();
  for (const file of PUBLIC_FILES.filter((f) => f !== 'public/i18n.js')) {
    const src = read(file);
    for (const m of src.matchAll(/data-i18n(?:-placeholder|-aria-label|-value|-title)?="([a-zA-Z][\w.]*)"/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w]*\.[\w.]*)'\s*[,)]/g)) referenced.add(m[1]);
  }
  for (const mode of ['Report', 'Research']) for (const part of ['Title', 'Placeholder']) referenced.add(`ambient.mode${mode}${part}`);
  const SEVEN = ['tasks.viewActivityHistory', 'knowledge.openVault', 'canvas.agentSuggestionsEmpty', 'canvas.emptyState', 'workspace.noPlansYet', 'workspace.noApprovalsPending', 'workspace.reviewDetails'];
  it('the seven formerly leaking keys exist with real EN and KR text', () => {
    const en = Object.fromEntries(SEVEN.map((k) => [k, i18n.t(k)]));
    i18n.setLocale('ko');
    const ko = Object.fromEntries(SEVEN.map((k) => [k, i18n.t(k)]));
    i18n.setLocale('en');
    for (const k of SEVEN) {
      assert.notEqual(en[k], k, `${k} missing in EN`);
      assert.notEqual(ko[k], k, `${k} missing in KR`);
      assert.match(ko[k], /[가-힣]/, `${k} must be Korean in KR (got ${ko[k]})`);
      assert.doesNotMatch(en[k], /[가-힣]/);
    }
  });
  it('no referenced key is undefined in EN or in KR', () => {
    const missingEn = [...referenced].filter((k) => i18n.t(k) === k);
    i18n.setLocale('ko');
    const missingKo = [...referenced].filter((k) => i18n.t(k) === k);
    i18n.setLocale('en');
    assert.deepEqual(missingEn, [], `undefined in EN: ${missingEn.join(', ')}`);
    assert.deepEqual(missingKo, [], `undefined in KR: ${missingKo.join(', ')}`);
    assert.ok(referenced.size > 300, `scan looks too small (${referenced.size})`);
  });
  it('the empty-state renderers no longer hide a missing key behind an English fallback', () => {
    const app = read('public/app.js');
    assert.doesNotMatch(app, /t\('workspace\.noPlansYet'\) \|\|/);
    assert.doesNotMatch(app, /t\('workspace\.noApprovalsPending'\) \|\|/);
    assert.doesNotMatch(app, /t\('workspace\.reviewDetails'\) \|\|/);
  });
});

describe('R24.8B — plan routes: server owns identity and execution state (source guard)', () => {
  const src = read('src/http/routes/plan.routes.ts');
  const code = src.replace(/\/\/[^\n]*/g, '');
  it('POST generates the id server-side and never reads a client id/owner/tenant/status', () => {
    assert.match(code, /id: `plan_\$\{randomUUID\(\)\}`/);
    for (const forbidden of [/b\.id\b/, /b\.userId/, /b\.tenantId/, /b\.status/, /b\.createdAt/]) assert.doesNotMatch(code.slice(code.indexOf("method === 'POST'"), code.indexOf("method === 'GET'", code.indexOf("method === 'POST'"))), forbidden);
  });
  it('mutations resolve identity from the authenticated session record only', () => {
    assert.match(code, /resolveAuthenticatedIdentity\(headers/);
    assert.match(code, /AUTHENTICATION_REQUIRED/);
    const mutations = code.slice(code.indexOf("pathname === '/api/v1/plans' && method === 'POST'"));
    assert.doesNotMatch(mutations.replace(/readTenant|readUser/g, ''), /x-principal-id|x-nagex-tenant|default-tenant|default-user/);
  });
});
