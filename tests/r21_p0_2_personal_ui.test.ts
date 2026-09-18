import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// R21 P0.2 — Remove Enterprise Controls from NAgex Personal UI Unit Test Suite
// Verifies that NAgex is presented cleanly as a Personal AI Agent (PRODUCT_TARGET=PERSONAL)
// while preserving all Enterprise backend capabilities (ENTERPRISE_FEATURE_EXPANSION=FROZEN).

test('CREATE_ORGANIZATION_HIDDEN_PERSONAL: Header switchers group is hidden by default in Personal Mode', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.match(html, /id="header-switchers-group"[^>]*style="display:\s*none;"/);
});

test('CREATE_WORKSPACE_HIDDEN_PERSONAL: Workspace switcher is hidden by default in normal Personal mode', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  assert.match(appJs, /function applyEnterpriseUiGate\(\)/);
  assert.match(appJs, /switchersGroup\.style\.display\s*=\s*isEnt\s*\?\s*'flex'\s*:\s*'none';/);
});

test('DEBUG_MODE_ENABLES_ENTERPRISE_UI: isEnterpriseUiMode does NOT read debug query param or debug mode', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // isEnterpriseUiMode function must strictly look for 'enterprise', state.enterpriseUiMode, or window.NAGEX_ENTERPRISE_UI
  const entFuncMatch = appJs.match(/function isEnterpriseUiMode\(\)\s*\{[\s\S]*?\}/);
  assert.ok(entFuncMatch, 'isEnterpriseUiMode function should exist');

  const entFuncCode = entFuncMatch[0];
  assert.doesNotMatch(entFuncCode, /params\.get\('debug'\)/, '?debug=1 must NOT trigger enterprise UI mode');
  assert.doesNotMatch(entFuncCode, /state\.debugMode/, 'debugMode must NOT trigger enterprise UI mode');
  assert.doesNotMatch(entFuncCode, /NAGEX_DEBUG/, 'NAGEX_DEBUG must NOT trigger enterprise UI mode');
});

test('DEBUG_MODE_SHOWS_INTERNAL_DIAGNOSTICS: isDebugMode reads debug query param or flag', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  const debugFuncMatch = appJs.match(/function isDebugMode\(\)\s*\{[\s\S]*?\}/);
  assert.ok(debugFuncMatch, 'isDebugMode function should exist');

  const debugFuncCode = debugFuncMatch[0];
  assert.match(debugFuncCode, /params\.get\('debug'\)\s*===\s*'1'/);
  assert.match(debugFuncCode, /window\.NAGEX_DEBUG\s*===\s*true/);
});

test('ENTERPRISE_FLAG_SHOWS_ENTERPRISE_UI: Gating helper responds to enterprise query parameter or flag', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(appJs, /function isEnterpriseUiMode\(\)/);
  assert.match(appJs, /params\.get\('enterprise'\)\s*===\s*'1'/);
  assert.match(appJs, /window\.NAGEX_ENTERPRISE_UI\s*===\s*true/);
});

test('PERSONAL_MODE_ENTERPRISE_UI_HIDDEN: Enterprise nav & settings tabs are gated by isEnterpriseUiMode()', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // Organization settings tab hidden by default
  assert.match(html, /id="cat-tab-organization"[^>]*style="display:\s*none;"/);
  assert.match(appJs, /catTabOrg\.style\.display\s*=\s*isEnt\s*\?\s*'inline-block'\s*:\s*'none';/);
});

test('LEGACY_ENTERPRISE_TESTS_WITH_ENTERPRISE_FLAG: Legacy browser tests pass enterprise=1 query param', () => {
  const orgTest = fs.readFileSync(path.join(process.cwd(), 'tests', 'organization_real_browser.test.ts'), 'utf8');
  const rbacTest = fs.readFileSync(path.join(process.cwd(), 'tests', 'rbac_real_browser.test.ts'), 'utf8');
  const eiTest = fs.readFileSync(path.join(process.cwd(), 'tests', 'enterprise_identity_real_browser.test.ts'), 'utf8');

  assert.match(orgTest, /index\.html\?enterprise=1/);
  assert.match(rbacTest, /index\.html\?enterprise=1/);
  assert.match(eiTest, /index\.html\?enterprise=1/);
});

test('PERSONAL_HOME_ENTERPRISE_TERMS: Personal Home contains zero forced enterprise setup terms', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const homeViewMatch = html.match(/id="view-home"[\s\S]*?<\/div>\s*<!-- VIEW:/);
  assert.ok(homeViewMatch, 'view-home block should exist');

  const homeHtml = homeViewMatch[0];
  assert.doesNotMatch(homeHtml, /Create Organization/);
  assert.doesNotMatch(homeHtml, /Create Workspace/);
  assert.doesNotMatch(homeHtml, /Configure SCIM/);
  assert.doesNotMatch(homeHtml, /Configure SSO Provider/);
});

test('TENANT_ISOLATION_REGRESSION: Backend organization and workspace routes remain active', () => {
  const orgUiJs = fs.readFileSync(path.join(process.cwd(), 'public', 'org-ui.js'), 'utf8');

  assert.match(orgUiJs, /\/api\/v1\/organizations/);
  assert.match(orgUiJs, /\/api\/v1\/organizations\/\$\{.*\}\/workspaces/);
});

test('DEFAULT_PERSONAL_CONTEXT_CREATED: Personal user context auto-initializes without forced org setup', () => {
  const orgUiJs = fs.readFileSync(path.join(process.cwd(), 'public', 'org-ui.js'), 'utf8');

  // loadOrgContext gracefully handles empty org list without throwing
  assert.match(orgUiJs, /async function loadOrgContext\(\)/);
});

test('EN_KR: Bilingual dictionaries exist for personal header and settings items', () => {
  const i18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');

  assert.match(i18n, /'nav\.home': 'Home'/);
  assert.match(i18n, /'nav\.home': '홈'/);
});

test('MOBILE: Header and switcher elements include responsive gate handlers', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(appJs, /mhOrgBtn\.style\.display\s*=\s*isEnt\s*\?\s*'inline-flex'\s*:\s*'none';/);
});

test('ACCESSIBILITY: Header logo and search target provide proper aria labels', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /id="btn-header-search"/);
  assert.match(html, /role="search"/);
});
