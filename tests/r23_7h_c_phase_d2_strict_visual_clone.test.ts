import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readPublic(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', relPath), 'utf-8');
}

test('A. Mobile header never hardcodes a mock identity name ("Alex") in production UI', () => {
  const mobileJs = readPublic('mobile/mobile-home.js');
  assert.ok(!/Alex/.test(mobileJs), 'mobile-home.js must not contain a hardcoded mock name — greeting must be identity-neutral or sourced from real profile data');
  const html = readPublic('index.html');
  assert.ok(!/Good afternoon, Alex|안녕하세요, Alex/.test(html), 'index.html static fallback text must not hardcode a mock name');
  const i18n = readPublic('i18n.js');
  assert.ok(!/, Alex/.test(i18n), 'i18n.js translation strings must not hardcode a mock name');
});

test('B. nagex-sr-only screen-reader-only utility is a real global class, not scoped to desktop only', () => {
  const css = readPublic('desktop/desktop-home.css');
  assert.ok(/^\.nagex-sr-only\s*\{/m.test(css), 'a bare, unscoped .nagex-sr-only rule must exist so mobile (outside .nagex-desktop-home) gets it too');
});

test('C. Canvas workspace/stage use the converged blue-tinted surface tokens, not the old flat-white background', () => {
  const css = readPublic('style.css');
  const workspaceMatch = css.match(/\.canvas-workspace \{[\s\S]*?\n\}/);
  assert.ok(workspaceMatch);
  assert.ok(/nagex-surface-blue/.test(workspaceMatch![0]), 'canvas-workspace should use the pale-blue surface token');
});

test('D. Recent Creations non-image artifacts get a real type-specific thumbnail, not a blank row', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/window\.NAGEX\.renderArtifactThumbnail = function \(proj\) \{([\s\S]*?)\n  \};/);
  assert.ok(fn);
  assert.ok(fn![1].includes("previewKind === 'TEXT'"), 'thumbnail function must handle the TEXT previewKind (DOCUMENT/RESEARCH/ANALYSIS), not only IMAGE');
});

test('E. D.1 fixes are preserved: no unconditional display on .canvas-workspace, width/height still 100%, .mh-canvas-view still gated on [hidden]', () => {
  const style = readPublic('style.css');
  const workspaceMatch = style.match(/\.canvas-workspace \{[\s\S]*?\n\}/);
  assert.ok(workspaceMatch);
  assert.ok(!/\n\s*display:\s*flex/.test(workspaceMatch![0]), 'display must remain controlled by .tab-view/.active-view only');
  assert.ok(/width:\s*100%/.test(workspaceMatch![0]));
  assert.ok(/height:\s*100%/.test(workspaceMatch![0]));

  const mobileCss = readPublic('mobile/mobile-home.css');
  assert.ok(/\.mh-canvas-view:not\(\[hidden\]\)\s*\{\s*\n\s*display:\s*flex/.test(mobileCss), 'mobile canvas view display must stay gated behind :not([hidden])');
});

test('F. Canonical 8-item nav still matches between app.js and index.html (no D.2 drift)', () => {
  const appJs = readPublic('app.js');
  const html = readPublic('index.html');
  const navMatch = appJs.match(/window\.NAGEX_PRIMARY_NAV = \[([\s\S]*?)\];/);
  assert.ok(navMatch);
  const jsTabs = [...navMatch![1].matchAll(/tab:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  const navMenuMatch = html.match(/<ul class="nav-menu">([\s\S]*?)<\/ul>/);
  assert.ok(navMenuMatch);
  const htmlTabs = [...navMenuMatch![1].matchAll(/data-tab="([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(htmlTabs, jsTabs);
});
