import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readPublic(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', relPath), 'utf-8');
}

test('A. CREATE_CAPABILITIES catalog matches the directive-required truthful status table exactly', () => {
  const src = readPublic('personal-home-view.js');
  const match = src.match(/const CREATE_CAPABILITIES = \[([\s\S]*?)\];/);
  assert.ok(match, 'CREATE_CAPABILITIES literal not found');
  const body = match![1];
  const expected: Record<string, string> = {
    REPORT: 'LIVE', SLIDES: 'PLANNED', IMAGE: 'LIVE', VIDEO: 'PLANNED', RESEARCH: 'LIVE', PLAN: 'PARTIAL', CODE: 'PLANNED',
  };
  for (const [id, status] of Object.entries(expected)) {
    const re = new RegExp(`id:\\s*'${id}',\\s*status:\\s*'${status}'`);
    assert.ok(re.test(body), `${id} must be status:'${status}'`);
  }
  // Exactly these 7, no more, no fewer.
  const ids = [...body.matchAll(/id:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), Object.keys(expected).sort());
});

test('B. PLANNED capabilities never dispatch a real creation call — only the truthful "planned" alert path', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function activateCreateCapability\(id\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn, 'activateCreateCapability not found');
  const body = fn![1];
  // REPORT, IMAGE, RESEARCH, PLAN must each have an explicit real-dispatch branch.
  for (const id of ['REPORT', 'IMAGE', 'RESEARCH', 'PLAN']) {
    assert.ok(body.includes(`id === '${id}'`), `activateCreateCapability must explicitly branch on ${id}`);
  }
  // SLIDES/VIDEO/CODE fall through to the shared truthful alert — none of
  // them may appear as an explicit early-return branch of their own
  // (that would mean someone wired a fake/real dispatch for a PLANNED
  // capability).
  for (const id of ['SLIDES', 'VIDEO', 'CODE']) {
    assert.ok(!body.includes(`id === '${id}'`), `${id} is PLANNED — must not have its own dispatch branch`);
  }
  assert.ok(/planned for a future update/.test(body), 'fallback path must use the truthful planned-capability message');
});

test('C. Recent Creations filter pills never fabricate artifacts for PLAN/CODE (both map to zero real ArtifactType values)', () => {
  const src = readPublic('personal-home-view.js');
  const match = src.match(/const RECENT_FILTER_TYPE_MAP = \{([\s\S]*?)\};/);
  assert.ok(match, 'RECENT_FILTER_TYPE_MAP not found');
  const body = match![1];
  assert.match(body, /PLAN:\s*\[\]/, 'PLAN must map to an empty real-type list — no real Plan artifacts exist yet');
  assert.match(body, /CODE:\s*\[\]/, 'CODE must map to an empty real-type list — no real Code artifacts exist yet');
  // REPORT/IMAGE/RESEARCH must map to real ArtifactType members, not invented ones.
  assert.match(body, /REPORT:\s*\['DOCUMENT'\]/);
  assert.match(body, /IMAGE:\s*\['IMAGE'\]/);
});

test('D. Recent Creations filtering is client-side only — no apiFetch call inside renderRecentCreations', () => {
  const src = readPublic('personal-home-view.js');
  const match = src.match(/function renderRecentCreations\(target, title, items\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'renderRecentCreations not found');
  assert.ok(!match![1].includes('apiFetch'), 'filtering must not trigger a network request — client-side array filter only');
});

test('E. Canvas Agent panel Context tab only ever reads real _canvasState/artifactProjection fields, never fabricates content', () => {
  const src = readPublic('personal-home-view.js');
  // R23.7H-C Phase D.4 §11 — the Context-tab renderer is now the shared
  // renderArtifactContext(prefix, ...) function (used by both Home's
  // embedded Agent and Focus Mode's), not a literal 'canvas-agent-
  // context-fields' string — it's built as `prefix + 'agent-context-
  // fields'` at runtime.
  const idx = src.indexOf('function renderArtifactContext');
  assert.ok(idx > -1);
  const region = src.slice(idx, idx + 900);
  assert.ok(region.includes("prefix + 'agent-context-fields'"));
  assert.ok(region.includes('artifactProjection'), 'Context tab must source real artifactProjection data');
  assert.ok(!/lorem|sample|placeholder text|fake/i.test(region), 'Context tab must not contain fabricated placeholder content');
});

test('F. Canonical primary nav (NAGEX_PRIMARY_NAV) and the desktop sidebar data-tab set match exactly (no IA drift)', () => {
  const appJs = readPublic('app.js');
  const html = readPublic('index.html');
  const navMatch = appJs.match(/window\.NAGEX_PRIMARY_NAV = \[([\s\S]*?)\];/);
  assert.ok(navMatch, 'NAGEX_PRIMARY_NAV not found in app.js');
  const jsTabs = [...navMatch![1].matchAll(/tab:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();

  const navMenuMatch = html.match(/<ul class="nav-menu">([\s\S]*?)<\/ul>/);
  assert.ok(navMenuMatch, 'sidebar nav-menu not found in index.html');
  const htmlTabs = [...navMenuMatch![1].matchAll(/data-tab="([a-z0-9-]+)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(htmlTabs, jsTabs, 'sidebar data-tab set must exactly match NAGEX_PRIMARY_NAV');
  assert.deepEqual(jsTabs, ['tab-approvals', 'tab-canvas', 'tab-create', 'tab-home', 'tab-inbox', 'tab-knowledge', 'tab-settings', 'tab-tasks'].sort());
});

test('G. Activity and Vault routes/views still exist after nav promotion (no deletion of real functionality)', () => {
  const html = readPublic('index.html');
  assert.ok(html.includes('id="view-executions"'), 'Activity view must still exist');
  assert.ok(html.includes('id="view-vault"'), 'Vault view must still exist');
  const appJs = readPublic('app.js');
  assert.ok(appJs.includes("'tab-executions': '#activity'"), 'Activity hash route must still exist');
  assert.ok(appJs.includes("'tab-vault': '#vault'"), 'Vault hash route must still exist');
});

test('H. Mobile bottom nav is a subset of NAGEX_PRIMARY_NAV (single canonical definition, no conflicting IA list)', () => {
  const appJs = readPublic('app.js');
  const html = readPublic('index.html');
  const navMatch = appJs.match(/window\.NAGEX_PRIMARY_NAV = \[([\s\S]*?)\];/);
  const jsTabs = new Set([...navMatch![1].matchAll(/tab:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));

  const bottomNavMatch = html.match(/<nav class="mh-bottom-nav">([\s\S]*?)<\/nav>/);
  assert.ok(bottomNavMatch, 'mobile bottom nav not found');
  const mobileTabs = [...bottomNavMatch![1].matchAll(/data-tab="([a-z0-9-]+)"/g)].map((m) => m[1]);
  for (const tab of mobileTabs) {
    assert.ok(jsTabs.has(tab), `mobile bottom nav tab "${tab}" must be part of the canonical NAGEX_PRIMARY_NAV`);
  }
});
