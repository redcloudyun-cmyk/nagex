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
    const inputMatch = /<input[^>]*id="home-prompt-input"[^>]*>/.exec(html);
    assert.ok(inputMatch, 'expected to find the home prompt input in the served page');
    assert.match(inputMatch![0], /value=""/);
    assert.doesNotMatch(inputMatch![0], /Prepare my next client meeting/);
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

    // Input remains focused after submit.
    assert.match(body, /input\.focus\(\)/);
  });
});

test('Enter submits the composer; Shift+Enter is left alone (no custom newline handling on this single-line input)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /event\.key === 'Enter' && !event\.shiftKey/);
    assert.match(appJs, /submitAmbientComposerInput\(\)/);
  });
});

test('nothing in app.js ever restores the demo sentence into any input value, and nothing clears an input merely on focus', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    // The demo sentence must never again be assigned as an element's .value
    // anywhere in the client bundle — every remaining reference to it is the
    // quick-action/scenario prompt text handed straight to runAmbientTask(),
    // never to an input element.
    assert.doesNotMatch(appJs, /\.value\s*=\s*['"]Prepare my next client meeting/);

    // No focus/focusin handler exists at all — the only way an input's value
    // ever changes in this app is the user typing or a submit clearing it,
    // never a focus event.
    assert.doesNotMatch(appJs, /addEventListener\(\s*['"]focus/);
  });
});
