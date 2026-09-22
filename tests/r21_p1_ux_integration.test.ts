import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(process.cwd());
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

test('FAKE_SUCCESS_PATHS: ambient Vault success requires a persisted vaultItemId', () => {
  const app = read('public/app.js');
  assert.match(app, /api\/v1\/workspace\/vault/);
  assert.match(app, /saved && saved\.vaultItemId && !saved\.error/);
  assert.doesNotMatch(app, /setTimeout\([^)]*showSuccess/);
});

test('QUICK_WAKE_UI: real context endpoint gates the proactive card', () => {
  const html = read('public/desktop-quickwake.html');
  const js = read('public/desktop-quickwake.js');
  assert.match(html, /id="qw-proactive-card"/);
  assert.match(js, /api\/v1\/personal\/quick-wake/);
  assert.match(js, /state\.quickWake && state\.quickWake\.proactive_suggestion/);
  assert.match(js, /grounded_on/);
});

test('MEETING_PREP: ambient context comes from the real backend and has an honest error state', () => {
  const app = read('public/app.js');
  assert.match(app, /api\/v1\/personal\/meeting-prep/);
  assert.match(app, /renderGroundedMeetingContext/);
  assert.match(app, /I couldn't load related context/);
});

test('PERSONAL_HOME_ATTENTION: Needs Attention is rendered from canonical PersonalHomeService aggregation', () => {
  const home = read('public/desktop/desktop-home.js');
  assert.match(home, /api\/v1\/personal\/home/);
  assert.match(home, /renderNeedsAttentionSection\(data\.needsAttention\)/);
  assert.doesNotMatch(home, /const count = activity\.filter/);
  assert.doesNotMatch(home, /const groups = \{ Now: \[\], Today: \[\], Later: \[\] \}/);
  assert.doesNotMatch(home, /renderNeedsAttentionSection\((?:state\.)?(?:notifications|activity|fakeData)/);
});

test('NOTIFICATION_BELL: unread count remains a separate notification concern', () => {
  const home = read('public/desktop/desktop-home.js');
  assert.match(home, /const notifications = \(state\.notifications && state\.notifications\.items\) \|\| \[\]/);
  assert.match(home, /const count = notifications\.filter\(\(item\) => !item\.read\)\.length/);
});

test('LATENCY_MEASURED: required hero metrics are recorded from performance timestamps', () => {
  const sources = read('public/hero-brief.js') + read('public/desktop-quickwake.js') + read('public/meeting-prep-view.js');
  for (const metric of ['HOME_INITIAL_RENDER_MS', 'MORNING_BRIEF_RENDER_MS', 'QUICK_WAKE_RESPONSE_MS', 'MEETING_PREP_FIRST_FEEDBACK_MS', 'MEETING_PREP_RESULT_MS', 'APPROVAL_TO_RESULT_MS']) {
    assert.match(sources, new RegExp(metric));
  }
  assert.match(sources, /performance\.now\(\)/);
});

test('truthful non-executed flows do not expose sample research sources as live results', () => {
  const app = read('public/app.js');
  assert.match(app, /Results will appear after the sources are actually checked/);
  assert.match(app, /Add the document you want me to analyze/);
  assert.match(app, /The result will appear here after it is generated/);
});
