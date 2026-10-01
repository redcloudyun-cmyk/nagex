import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readPublic(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'public', relPath), 'utf-8');
}

test('A. Canvas toolbar title never falls back to a raw "Artifact: <id>" string (technical-UI-leak regression guard)', () => {
  const src = readPublic('personal-home-view.js');
  assert.ok(!/Artifact:\s*['"`]\s*\+\s*artifactId/.test(src), 'toolbar title must not concatenate a raw artifactId into user-facing text');
  assert.ok(src.includes('COPY[locale()].untitledArtifact'), 'toolbar title must fall back to a truthful generic label, not the ID, when no real title exists');
});

test('B. Canvas Agent Context tab no longer exposes the raw canonical API URL/path', () => {
  const src = readPublic('personal-home-view.js');
  const idx = src.indexOf('canvas-agent-context-fields');
  const region = src.slice(idx, idx + 900);
  assert.ok(!/contextUrl/.test(region), 'Context tab rows must not include the raw canonical-URL field (backend implementation detail, removed per D.1 §7)');
  assert.ok(!/_canvasState\.openTarget/.test(region), 'Context tab must not render the raw API openTarget path');
});

test('C. #view-home HTML structure is well-formed: no stray extra closing </div> prematurely terminating it', () => {
  const html = readPublic('index.html');
  const startIdx = html.indexOf('<div id="view-home"');
  assert.ok(startIdx > -1, '#view-home not found');
  // Walk div depth from the opening tag; #view-home's own close must not
  // occur before the "Explore what NAgex can do" discovery section, which
  // is real Home content that must stay nested inside it (this exact
  // scenario broke on 2026-09-30: an extra </div> here silently moved
  // every other #view-* — including Canvas — outside <main>, collapsing
  // .workspace-grid's height and letting Canvas overlay the sidebar).
  const discoverIdx = html.indexOf('home-discover-section', startIdx);
  assert.ok(discoverIdx > startIdx, 'discovery section must appear after view-home opens');
  const region = html.slice(startIdx, discoverIdx);
  let depth = 0;
  for (const m of region.matchAll(/<div(?![a-zA-Z-])|<\/div>/g)) {
    depth += m[0] === '</div>' ? -1 : 1;
  }
  assert.ok(depth >= 1, `#view-home must still be open (depth>=1) by the time the discovery section starts; got depth=${depth} — a stray extra </div> closed it early`);
});

test('D. #view-canvas is a real descendant of .center-canvas in the parsed DOM structure (not hoisted out by a parsing error)', () => {
  const html = readPublic('index.html');
  const mainOpen = html.indexOf('<main class="center-canvas">');
  const mainClose = html.indexOf('</main>');
  const viewCanvasIdx = html.indexOf('<div id="view-canvas"');
  assert.ok(mainOpen > -1 && mainClose > mainOpen, '<main class="center-canvas"> not found');
  assert.ok(viewCanvasIdx > mainOpen && viewCanvasIdx < mainClose, '#view-canvas must appear between <main> and </main> in source, and (given test C\'s balance check) actually nest inside it');
});

test('E. Create capability catalog still declares icon/tile fields for all 7 capabilities (visual identity requirement, D.1 §4.3)', () => {
  const src = readPublic('personal-home-view.js');
  const match = src.match(/const CREATE_CAPABILITIES = \[([\s\S]*?)\];/);
  assert.ok(match);
  const entries = match![1].split(/\},?\s*\n/).filter((e) => e.includes('id:'));
  assert.equal(entries.length, 7);
  for (const entry of entries) {
    assert.ok(/tile:\s*'/.test(entry), `capability entry missing tile color: ${entry.slice(0, 40)}`);
    assert.ok(/icon:\s*'/.test(entry), `capability entry missing icon: ${entry.slice(0, 40)}`);
  }
});

test('F. Recent Creations filter pills remain client-side only after D.1 changes (no regression)', () => {
  const src = readPublic('personal-home-view.js');
  const match = src.match(/function renderRecentCreations\(target, title, items\) \{([\s\S]*?)\n  \}/);
  assert.ok(match);
  assert.ok(!match![1].includes('apiFetch'));
});
