import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

// Real typing/focus/selection behavior needs a DOM/browser test harness this
// repo does not have (see tests/ambient_modal_wiring.test.ts for the same
// note). What IS verified here, statically, is that: (a) the shipped markup
// starts empty with the example sentence as placeholder-only, driven by
// i18n rather than hardcoded, and (b) app.js never contains code that would
// clear the field on focus, or restore the demo sentence into .value anywhere
// — the two properties a DOM test would otherwise need to exercise directly.
// tests/i18n_strings.test.ts covers the EN/KR dictionary values themselves.

test('the composer starts empty with the example sentence as placeholder only, not a value', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();

    const inputMatch = /<input[^>]*id="ambient-prompt-input"[^>]*>/.exec(html);
    assert.ok(inputMatch, 'expected to find the ambient composer input in the served page');
    const inputTag = inputMatch![0];

    // Initial value must be empty — never the demo sentence.
    assert.match(inputTag, /value=""/);
    assert.doesNotMatch(inputTag, /value="Prepare my next client meeting/);

    // The example sentence appears only as a placeholder, driven by i18n.
    assert.match(inputTag, /placeholder="Prepare my next client meeting and schedule it\."/);
    assert.match(inputTag, /data-i18n-placeholder="ambient\.promptPlaceholder"/);

    // Accessible label, also i18n-driven rather than hardcoded-only.
    assert.match(inputTag, /aria-label="Ask NAgex"/);
    assert.match(inputTag, /data-i18n-aria-label="ambient\.promptAriaLabel"/);
  });
});

test('the Home tab prompt box no longer ships with the demo sentence baked into its value', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const inputMatch = /<(?:input|textarea)[^>]*id="home-prompt-input"[^>]*>/.exec(html);
    assert.ok(inputMatch, 'expected to find the home prompt input in the served page');
    assert.doesNotMatch(inputMatch[0], /Prepare my next client meeting/);
  });
});

test('submitting the composer clears it (placeholder returns) and hands the captured text to the task pipeline', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    const start = appJs.indexOf('function submitAmbientComposerInput(');
    assert.ok(start >= 0, 'expected to find submitAmbientComposerInput in the served app.js');
    const next = appJs.indexOf('\n  function ', start + 1);
    const body = next > start ? appJs.slice(start, next) : appJs.slice(start);

    // Order matters: capture the typed text BEFORE clearing, so nothing
    // submitted is ever lost; then clear (placeholder reappears naturally
    // because the element becomes empty, not because of any special-cased
    // "restore placeholder" step); then run the task with the captured text.
    const captureIdx = body.indexOf('input.value.trim()');
    const clearIdx = body.indexOf("input.value = ''");
    const runIdx = body.indexOf('runAmbientTask(text)');
    assert.ok(captureIdx >= 0 && clearIdx >= 0 && runIdx >= 0, 'expected capture, clear, and run steps in submitAmbientComposerInput');
    assert.ok(captureIdx < clearIdx && clearIdx < runIdx, 'expected capture -> clear -> run order');

    // The composer is disabled for the duration of the request (see
    // runAmbientTask's setAmbientRunControlsDisabled), so focusing it here
    // would be a no-op; focus is restored once runAmbientTask's `finally`
    // re-enables the controls.
    const runTaskStart = appJs.indexOf('async function runAmbientTask(');
    const runTaskNext = appJs.indexOf('\n  async function resolvePlanIntoUi(', runTaskStart + 1);
    const runTaskBody = runTaskNext > runTaskStart ? appJs.slice(runTaskStart, runTaskNext) : appJs.slice(runTaskStart);
    assert.match(runTaskBody, /input\.focus\(\)/);
  });
});

test('Enter submits the composer; Shift+Enter is left alone (no custom newline handling on this single-line input)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /event\.key === 'Enter' && !event\.shiftKey/);
    assert.match(appJs, /submitAmbientComposerInput\(\)/);
  });
});

test('opening the overlay never re-injects the demo sentence, and nothing clears an input merely on focus', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    // openAmbientOverlay() must always leave the composer empty — the demo
    // sentence is only ever placed into it by an explicit, separate user
    // click (initPrimaryScenario's "▶ Run" -> fill-the-composer action,
    // covered in tests/plan_lifecycle_timeline.test.ts), never automatically
    // on open/render/hydration.
    const openStart = appJs.indexOf('function openAmbientOverlay(');
    const openNext = appJs.indexOf('\n  function ', openStart + 1);
    const openBody = openNext > openStart ? appJs.slice(openStart, openNext) : appJs.slice(openStart);
    assert.doesNotMatch(openBody, /Prepare my next client meeting/);
    assert.match(openBody, /input\.value = ''/);

    // No focus/focusin handler exists at all — the only way an input's value
    // ever changes in this app is the user typing, an explicit example-fill
    // click, or a submit clearing it — never a focus event.
    assert.doesNotMatch(appJs, /addEventListener\(\s*['"]focus/);
  });
});
