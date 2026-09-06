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

// These checks confirm the dismissibility wiring is actually shipped in the
// served page/scripts. Real click/keydown simulation would need a DOM/browser
// test harness (jsdom or similar), which this repo does not have and this
// fix does not warrant adding; tests/modal_behavior.test.ts covers the
// underlying focus-trap and scroll-lock LOGIC directly and exhaustively, and
// this file covers that the markup and event wiring the UX spec requires are
// present in what actually gets served.

test('Plan Preview modal is an accessible dialog with a visible close control', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();

    assert.match(html, /id="ambient-sheet-modal"[^>]*role="dialog"/);
    assert.match(html, /id="ambient-sheet-modal"[^>]*aria-modal="true"/);
    assert.match(html, /id="ambient-sheet-modal"[^>]*aria-labelledby="ambient-modal-title"/);
    assert.match(html, /id="ambient-modal-title"[^>]*data-i18n="ambient\.modalTitle"/);
    assert.match(html, /id="ambient-modal-status"/);

    // The X button: an aria-label (it has no visible text) driven by i18n.
    assert.match(html, /id="btn-close-ambient"[^>]*data-i18n-aria-label="ambient\.close"/);

    // Sticky footer: secondary "Close" button + an Esc hint, both i18n-driven.
    assert.match(html, /class="ambient-sheet-footer"/);
    assert.match(html, /id="btn-ambient-cancel"[^>]*data-i18n="ambient\.close"/);
    assert.match(html, /data-i18n="ambient\.pressEscToClose"/);

    assert.match(html, /src="modal-behavior\.js\?v=/);
  });
});

test('the modal has independent body scrolling capped to the viewport, and the close button meets minimum hit-area sizes', async () => {
  await withServer(async (origin) => {
    const css = await (await fetch(`${origin}/style.css`)).text();

    assert.match(css, /max-height:\s*calc\(100vh - 32px\)/);

    const modalBlockStart = css.indexOf('.ambient-sheet-modal {');
    assert.ok(modalBlockStart >= 0);
    const modalBlock = css.slice(modalBlockStart, modalBlockStart + 500);
    assert.match(modalBlock, /display:\s*flex/);
    assert.match(modalBlock, /flex-direction:\s*column/);

    const bodyBlockStart = css.indexOf('.ambient-sheet-body {');
    assert.ok(bodyBlockStart >= 0);
    const bodyBlock = css.slice(bodyBlockStart, bodyBlockStart + 300);
    assert.match(bodyBlock, /overflow-y:\s*auto/);

    const closeBtnBlockStart = css.indexOf('.ambient-close-btn {');
    assert.ok(closeBtnBlockStart >= 0);
    const closeBtnBlock = css.slice(closeBtnBlockStart, closeBtnBlockStart + 400);
    assert.match(closeBtnBlock, /width:\s*40px/);
    assert.match(closeBtnBlock, /height:\s*40px/);

    const mediaStart = css.indexOf('@media (max-width: 768px)');
    assert.ok(mediaStart >= 0);
    const mobileBlock = css.slice(mediaStart, mediaStart + 1200);
    assert.match(mobileBlock, /\.ambient-sheet-modal/);
    assert.match(mobileBlock, /\.ambient-close-btn/);
    assert.match(mobileBlock, /44px/);
  });
});

test('app.js wires Escape, backdrop-click, and a focus trap to the modal, and never approves/executes on close', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    assert.match(appJs, /event\.key === 'Escape'/);
    assert.match(appJs, /event\.key === 'Tab'/);
    assert.match(appJs, /isBackdropSelfClick/);
    assert.match(appJs, /computeFocusTrapTarget/);
    assert.match(appJs, /document\.body\.style\.overflow/);
    assert.match(appJs, /NAGEX_MODAL_BEHAVIOR/);

    // The X and footer Close buttons both wire directly to closeAmbientOverlay
    // and nothing else — neither ever calls approve/reject/execute.
    assert.match(appJs, /btnClose\.onclick = closeAmbientOverlay/);
    assert.match(appJs, /btnCancel\.onclick = closeAmbientOverlay/);

    const start = appJs.indexOf('function closeAmbientOverlay(');
    assert.ok(start >= 0, 'expected to find closeAmbientOverlay in the served app.js');
    const next = appJs.indexOf('\n  function ', start + 1);
    const body = next > start ? appJs.slice(start, next) : appJs.slice(start);
    assert.ok(!/apiFetch\s*\(/.test(body), 'closeAmbientOverlay must never call the API layer');
    assert.ok(!/\bfetch\s*\(/.test(body), 'closeAmbientOverlay must never call fetch directly either');
    assert.ok(!/\/approve|\/reject|create-event/.test(body), 'closeAmbientOverlay must never reference an approval/execution endpoint');
  });
});

test('the modal-behavior.js module is served fresh (no-store) alongside the other mutable frontend scripts', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/modal-behavior.js`);
    const text = await res.text();
    assert.equal(text.length > 0, true);
    assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  });
});
