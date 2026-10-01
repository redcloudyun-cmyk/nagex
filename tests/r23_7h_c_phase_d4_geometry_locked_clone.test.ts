import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readPublic(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', relPath), 'utf-8');
}

test('A. Home workspace grid does not use align-items:stretch (the cause of the 735px Canvas-requires-scroll regression found this pass)', () => {
  // R23.7H-C D4.6 — .home-primary-workspace (Canvas+Agent+ContextRail only)
  // was replaced by .home-workspace-grid, the shared parent for the whole
  // main-work column (creation row + Canvas) and the Agent rail column,
  // fixing the D4.5 finding that the creation row had no shared column
  // contract with the row below it. The underlying safety property this
  // test guards — never let the context rail's real content height
  // stretch-cascade onto Canvas/Agent — still applies to the new class.
  const css = readPublic('desktop/desktop-home.css');
  const match = css.match(/\.home-workspace-grid \{[\s\S]*?\n\}/);
  assert.ok(match);
  assert.ok(!/align-items:\s*stretch/.test(match![0]), 'stretch cascades the context rail\'s real content height onto Canvas/Agent — must use start instead');
});

test('B. Home Agent panel does not inherit Focus Mode\'s fixed 320px width (the cause of a confirmed 60px overlap with the context rail found this pass)', () => {
  const css = readPublic('desktop/desktop-home.css');
  const match = css.match(/\.home-agent-panel \{[\s\S]*?\}/);
  assert.ok(match);
  assert.ok(/width:\s*100%/.test(match![0]), 'must override the shared .canvas-agent-panel width:320px to respect its grid track');
});

test('C. Home context rail scrolls internally rather than forcing the whole workspace row taller than its cap', () => {
  const css = readPublic('desktop/desktop-home.css');
  // Anchored to the base (non-media-query, non-descendant) rule specifically.
  const match = css.match(/\n\.home-context-rail \{[^}]*\}/);
  assert.ok(match);
  assert.ok(/overflow-y:\s*auto/.test(match![0]));
});

test('D. Right Now is no longer a full-width primary section above Create/Canvas — it lives inside the context rail', () => {
  const html = readPublic('index.html');
  const railMatch = html.match(/<aside class="home-context-rail"[\s\S]*?<\/aside>/);
  assert.ok(railMatch, 'home-context-rail must exist');
  assert.ok(railMatch![0].includes('id="home-section-right-now"'), 'Right Now must be inside the context rail, not a standalone full-width section');
});

test('E. renderSection hides a truly empty section instead of rendering an empty bordered strip (D.4 §16)', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderSection\(target, title, items, id\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  assert.ok(/if \(!items \|\| !items\.length\) \{\s*\n\s*target\.hidden = true;/.test(fn![1]), 'must hide (not render an empty card for) sections with zero items');
});

test('F. Home Agent panel exists beside the embedded Canvas and is hidden when there is no artifact (no empty Agent shell beside an empty Canvas)', () => {
  const html = readPublic('index.html');
  assert.ok(/id="home-agent-panel"/.test(html));
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderHomeEmbeddedCanvas\(model\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  assert.ok(/agentPanel\.hidden = true/.test(fn![1]), 'Agent must be hidden in the no-artifact branch');
  assert.ok(/agentPanel\.hidden = false/.test(fn![1]), 'Agent must be shown once a real artifact exists');
});

test('G. Home Agent Chat tab has no persistent TYPE/TITLE/UPDATED metadata block (D.4 §12) — that lives only in the Context tab', () => {
  const html = readPublic('index.html');
  const homeAgentMatch = html.match(/<aside class="canvas-agent-panel home-agent-panel"[\s\S]*?<\/aside>/);
  assert.ok(homeAgentMatch);
  const chatPanelMatch = homeAgentMatch![0].match(/data-agent-panel="chat">([\s\S]*?)<\/div>\s*<div class="canvas-agent-tab-panel" data-agent-panel="context"/);
  assert.ok(chatPanelMatch);
  assert.ok(!/canvas-agent-context-fields|<dl/.test(chatPanelMatch![1]), 'Chat tab body must not contain the metadata <dl> — Context tab is the correct home for it');
});

test('H. Agent Context-tab renderer is shared (renderArtifactContext) between Home embedded and Focus Mode — no second implementation', () => {
  const src = readPublic('personal-home-view.js');
  const defs = [...src.matchAll(/function renderArtifactContext\(/g)];
  assert.equal(defs.length, 1);
  assert.ok(/renderArtifactContext\('home-canvas-'/.test(src));
});

test('I. Certification identity matching is exposed as real state (window.NAGEX._homeEmbeddedArtifactIdForCert), not inferred from Recent Creations list position (D.4 §24)', () => {
  const src = readPublic('personal-home-view.js');
  assert.ok(/window\.NAGEX\._homeEmbeddedArtifactIdForCert = proj\.artifactId/.test(src));
});

test('J. Capability tiles stay within the compact D.4 §8 target band (no large dashboard-widget tiles)', () => {
  const css = readPublic('desktop/desktop-home.css');
  const match = css.match(/\.ph-capability-tile \{[^}]*\}/);
  assert.ok(match);
  const minHeightMatch = match![0].match(/min-height:\s*(\d+)px/);
  assert.ok(minHeightMatch);
  const minHeight = Number(minHeightMatch[1]);
  assert.ok(minHeight >= 52 && minHeight <= 76, `capability tile min-height ${minHeight}px must keep Create with NAgex as a compact launcher, not a tall card area`);
});

test('O. D.4 final certification script records per-element clipping acceptance, not just document overflow', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'take_d4_screenshots.mjs'), 'utf-8');
  assert.ok(/RIGHT_RAIL_TEXT_CLIPPING/.test(src));
  assert.ok(/RIGHT_RAIL_BUTTON_CLIPPING/.test(src));
  assert.ok(/AGENT_COMPOSER_CLIPPING/.test(src));
  assert.ok(/CREATE_TILE_CLIPPING/.test(src));
  assert.ok(/scrollWidth > el\.clientWidth/.test(src), 'must inspect individual element clipping');
});

test('K. Home embedded Canvas and Focus Mode both remain wired to the single shared renderArtifactStage (D.3 architecture preserved, not forked this pass)', () => {
  const src = readPublic('personal-home-view.js');
  const defs = [...src.matchAll(/function renderArtifactStage\(/g)];
  assert.equal(defs.length, 1);
});

test('L. Mobile header truthfulness (no hardcoded identity) and .nagex-sr-only global fix remain intact after D.4 changes', () => {
  const mobileJs = readPublic('mobile/mobile-home.js');
  assert.ok(!/Alex/.test(mobileJs));
  const css = readPublic('desktop/desktop-home.css');
  assert.ok(/^\.nagex-sr-only\s*\{/m.test(css));
});

test('M. Recent Creations remains real-data-only and dispatches through the canonical shared Canvas path (no new duplication introduced this pass)', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderRecentCreations\(target, title, items\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  assert.ok(!fn![1].includes('apiFetch'), 'still client-side filtering only');
});

test('N. Sampled reference palette (primary blue) remains applied after D.4', () => {
  const css = readPublic('style.css');
  assert.ok(/--primary-blue:\s*#0a56f7/.test(css));
});
