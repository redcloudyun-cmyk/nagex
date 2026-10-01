import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readPublic(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', relPath), 'utf-8');
}

test('A. Home contains a real embedded Canvas workspace container', () => {
  const html = readPublic('index.html');
  assert.ok(/id="home-embedded-canvas"/.test(html), '#home-embedded-canvas must exist in index.html');
  // Must be a child of #view-home's main stack, not a separate view/route.
  const viewHomeIdx = html.indexOf('<div id="view-home"');
  const embeddedIdx = html.indexOf('id="home-embedded-canvas"');
  const viewCanvasIdx = html.indexOf('<div id="view-canvas"');
  assert.ok(embeddedIdx > viewHomeIdx && embeddedIdx < viewCanvasIdx, 'embedded canvas must live inside #view-home, before the standalone #view-canvas');
});

test('B. Home embedded Canvas and Focus Mode Canvas share one rendering implementation (renderArtifactStage), not a fork', () => {
  const src = readPublic('personal-home-view.js');
  const matches = [...src.matchAll(/function renderArtifactStage\(/g)];
  assert.equal(matches.length, 1, 'renderArtifactStage must be defined exactly once');
  assert.ok(/renderArtifactStage\('home-canvas-'/.test(src), 'renderHomeEmbeddedCanvas must call the shared renderArtifactStage');
  assert.ok(/renderArtifactStage\(prefix, artifactType, artifactProjection, window\.NAGEX\._canvasState\.openTarget/.test(src), 'openArtifactInCanvas (Focus Mode) must call the same shared renderArtifactStage');
});

test('C. Home embedded Canvas never mutates window.NAGEX._canvasState — only Focus Mode does', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderHomeEmbeddedCanvas\(model\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  assert.ok(!fn![1].includes('_canvasState'), 'embedded preview must not set canvas state — it is a read-only preview, real "open" only happens via dispatchArtifactOpen on click');
});

test('D. "Open in Canvas" from Home dispatches through the same canonical dispatchArtifactOpen path used by Recent Creations', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderHomeEmbeddedCanvas\(model\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  assert.ok(/window\.NAGEX\.dispatchArtifactOpen\(proj\.artifactType, recent\.sourceRef, recent\)/.test(fn![1]));
});

test('E. No real artifact produces a truthful empty Canvas state, never a fabricated/placeholder artifact', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderHomeEmbeddedCanvas\(model\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  assert.ok(/if \(!recent\)/.test(fn![1]), 'must explicitly branch on no-recent-artifact');
  assert.ok(/homeCanvasEmptyTitle/.test(fn![1]));
});

test('F. Embedded Canvas region exists only once in the desktop HTML (no accidental duplication)', () => {
  const html = readPublic('index.html');
  const count = (html.match(/id="home-embedded-canvas"/g) || []).length;
  assert.equal(count, 1);
});

test('G. Desktop-only: renderHomeEmbeddedCanvas is wired into renderDesktop but not renderMobile (mobile keeps its own dedicated flow, per D.3 §22)', () => {
  const src = readPublic('personal-home-view.js');
  const desktopFn = src.match(/function renderDesktop\(model\) \{([\s\S]*?)\n  \}/);
  const mobileFn = src.match(/function renderMobile\(model\) \{([\s\S]*?)\n  \}/);
  assert.ok(desktopFn && desktopFn[1].includes('renderHomeEmbeddedCanvas(model)'));
  assert.ok(mobileFn && !mobileFn[1].includes('renderHomeEmbeddedCanvas'));
});

test('H. Embedded Canvas toolbar never renders a raw artifact ID (same technical-UI-leak rule as Focus Mode)', () => {
  const src = readPublic('personal-home-view.js');
  const fn = src.match(/function renderHomeEmbeddedCanvas\(model\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn);
  // Only the visible toolbar template (title/type markup) must avoid the
  // raw ID — proj.artifactId legitimately appears elsewhere in this
  // function as of D.4 (window.NAGEX._homeEmbeddedArtifactIdForCert, a
  // non-rendered internal state hook for certification, not UI).
  const toolbarMatch = fn![1].match(/target\.innerHTML = `[\s\S]*?`;/);
  assert.ok(toolbarMatch, 'toolbar template not found');
  assert.ok(!/proj\.artifactId/.test(toolbarMatch![0]), 'must not render the raw artifactId into the toolbar title');
  assert.ok(/proj\.title \|\| c\.untitledArtifact/.test(fn![1]));
});

test('I. Primary blue token was updated from a real sampled mockup value, not left at the D.2 by-eye approximation', () => {
  const css = readPublic('style.css');
  assert.ok(/--primary-blue:\s*#0a56f7/.test(css), 'primary-blue should reflect the D.3 §17 sampled value');
});
