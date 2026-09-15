import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';

// Cosmetic/UI-state regression for #composer-drop-zone: it carries
// class="composer-file-drop-zone hidden" and app.js toggles exactly the
// "hidden" class (never touches style.display directly), but style.css
// previously had no rule making a bare "hidden" class do anything for this
// element — the class name alone has no built-in browser meaning (only the
// HTML "hidden" attribute does). The fix is a single scoped CSS rule
// (.composer-file-drop-zone.hidden { display: none; }).
//
// This is a static/HTTP-level check, not a real-browser one, by deliberate
// choice: a real Playwright session (as used in tests/ambient_composer_
// recovery.test.ts) was tried first and did prove the fix works correctly
// (fresh load hidden+display:none, toggle on -> visible+typeable, toggle
// off -> hidden+display:none again — see that manual verification in the
// implementation's own completion report). But adding a second real-
// browser test file to this suite measurably degraded the existing
// ambient_composer_recovery.test.ts under node:test's default file
// concurrency (consistently reproducing a ~45s timeout there across
// repeated full-suite runs, where it was previously fast and reliable) —
// i.e. the "existing browser test infrastructure" the directive's own
// Section 7 conditions a browser test on turned out NOT to be low-friction
// for a second concurrent user in this environment. The actual defect
// class this bug represents (a missing/renamed CSS rule) is fully caught
// by asserting on the real served markup, CSS, and script text directly,
// without launching another Chromium instance.
async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (typeof (instance as any).closeIdleConnections === 'function') {
      (instance as any).closeIdleConnections();
    }
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

test('the served markup still carries the composer-drop-zone hidden-by-default class contract', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const elementMatch = /<div[^>]*id="composer-drop-zone"[^>]*>/.exec(html);
    assert.ok(elementMatch, 'expected to find #composer-drop-zone in the served page');
    const tag = elementMatch![0];
    assert.match(tag, /class="[^"]*\bcomposer-file-drop-zone\b[^"]*\bhidden\b[^"]*"/, 'the element must start with both composer-file-drop-zone and hidden classes');
  });
});

test('style.css defines a rule that actually hides .composer-file-drop-zone.hidden', async () => {
  await withServer(async (origin) => {
    const css = await (await fetch(`${origin}/style.css`)).text();
    const ruleMatch = /\.composer-file-drop-zone\.hidden\s*\{([^}]*)\}/.exec(css);
    assert.ok(ruleMatch, 'expected a .composer-file-drop-zone.hidden rule in style.css');
    assert.match(ruleMatch![1], /display\s*:\s*none\s*;?/, 'the rule must set display: none');

    // Guard against accidentally reintroducing a global .hidden rule as
    // part of "fixing" this — the directive explicitly required the
    // scoped selector unless a full inventory proved a generic rule safe,
    // which this correction never did.
    assert.doesNotMatch(css, /(?:^|[^.\w])\.hidden\s*\{/, 'no generic .hidden rule should exist without a real safety inventory');
  });
});

test('app.js still toggles exactly the hidden class on composer-drop-zone (mechanism unchanged by this CSS-only fix)', async () => {
  await withServer(async (origin) => {
    const js = await (await fetch(`${origin}/app.js`)).text();
    assert.match(
      js,
      /getElementById\('composer-drop-zone'\)[\s\S]{0,200}?classList\.toggle\('hidden'\)/,
      'expected the existing composer-drop-zone hidden-class toggle to be present and unmodified'
    );
  });
});
