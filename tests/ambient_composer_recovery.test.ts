import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { createServerInstance } from '../src/server_web.js';

// This project's tsconfig deliberately has no "DOM" lib entry (it is a
// Node-only server codebase) — these declarations are scoped to just this
// one browser-regression-test file rather than adding "DOM" to the global
// tsconfig, which would risk colliding with @types/node's own fetch/
// Response typings used throughout src/. The identifiers below are only
// ever referenced inside Playwright page.evaluate/$eval/waitForFunction
// callbacks, which actually execute in the real browser, not in this
// TS-compiled Node process — so intentionally-loose `any` typing here is
// correct, not a shortcut.
declare const window: any;
declare const document: any;
type HTMLTextAreaElement = any;
type HTMLButtonElement = any;
type HTMLElement = any;

const TEST_TIMEOUT_MS = 300;

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

// One shared browser process for the whole file (launched once in
// before(), closed once in after()) rather than one per test — this suite
// already runs many real-browser tests (Browser Agent / URL understanding)
// across parallel test files under node:test's default file concurrency,
// and this is the first test file to also drive the app's own UI directly;
// minimizing how many extra Chromium processes this file itself spins up
// keeps it from compounding that contention further. Each test still gets
// its own fresh page/context, so there is no state leakage between tests.
let sharedBrowser: Browser;
before(async () => {
  sharedBrowser = await chromium.launch();
});
after(async () => {
  await sharedBrowser.close();
});

async function withBrowserPage(origin: string, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await sharedBrowser.newContext();
  const page = await context.newPage();
  try {
    await page.addInitScript((ms) => {
      (window as unknown as Record<string, unknown>).__NAGEX_TEST_AMBIENT_TIMEOUT_MS__ = ms;
    }, TEST_TIMEOUT_MS);
    await page.route('**/api/v1/workspace/route-input', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 200, data: { primaryIntent: 'ASK' } }),
      });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    await run(page);
    assert.deepEqual(pageErrors, [], `expected no uncaught page errors, got: ${JSON.stringify(pageErrors)}`);
  } finally {
    await page.close();
    await context.close();
  }
}

async function waitForComposerDisabledState(
  page: Page,
  expectedDisabled: boolean,
  timeoutMs: number,
  stepName: string
): Promise<void> {
  const pendingRequests: string[] = [];
  const requestListener = (req: any) => pendingRequests.push(`${req.method()} ${req.url()}`);
  const responseListener = (res: any) => {
    const idx = pendingRequests.indexOf(`${res.request().method()} ${res.request().url()}`);
    if (idx !== -1) pendingRequests.splice(idx, 1);
  };
  page.on('request', requestListener);
  page.on('response', responseListener);

  try {
    await page.waitForFunction(
      (target) => {
        const input = document.getElementById('home-prompt-input') as HTMLTextAreaElement | null;
        return input ? input.disabled === target : false;
      },
      expectedDisabled,
      { timeout: timeoutMs }
    );
  } catch (err) {
    const diag = await page.evaluate(() => {
      const input = document.getElementById('home-prompt-input') as HTMLTextAreaElement | null;
      const sendBtn = document.getElementById('btn-home-prompt-send') as HTMLButtonElement | null;
      const quickActions = Array.from(document.querySelectorAll('.quick-action-chip')).map((el) => ({
        text: (el as HTMLElement).innerText?.trim(),
        disabled: (el as HTMLButtonElement).disabled,
      }));
      const resultCard = document.getElementById('ambient-result-card');
      const ambientGuardState = (window as any).__NAGEX_AMBIENT_GUARD_BUSY__ ?? null;
      const timeoutOverride = (window as any).__NAGEX_TEST_AMBIENT_TIMEOUT_MS__ ?? null;

      return {
        inputDisabled: input ? input.disabled : 'NOT_FOUND',
        inputValue: input ? input.value : '',
        sendDisabled: sendBtn ? sendBtn.disabled : 'NOT_FOUND',
        quickActionsDisabledCount: quickActions.filter((q) => q.disabled).length,
        quickActionsTotal: quickActions.length,
        resultCardDisplay: resultCard ? resultCard.style.display : 'NOT_FOUND',
        ambientGuardBusy: ambientGuardState,
        testTimeoutOverrideMs: timeoutOverride,
        activeElement: document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id}` : 'NONE',
        currentUrl: window.location.href,
      };
    }).catch((evalErr) => ({ evalError: String(evalErr) }));

    console.error(`\n[DIAGNOSTIC FAILURE - ${stepName}] Expected disabled === ${expectedDisabled}, timed out after ${timeoutMs}ms:`);
    console.error(`  Pending HTTP requests in page: ${JSON.stringify(pendingRequests)}`);
    console.error(`  Page DOM/State Diagnostics: ${JSON.stringify(diag, null, 2)}\n`);
    throw err;
  } finally {
    page.off('request', requestListener);
    page.off('response', responseListener);
  }
}

test('a stalled ambient/intent request recovers: composer, Send, and Quick Actions all re-enable after the bounded timeout, and accept real input again', { timeout: 90000 }, async () => {
  await withServer(async (origin) => {
    await withBrowserPage(origin, async (page) => {
      // Never fulfills — the exact real-world condition (a hung backend /
      // model provider call with no bound of its own) that produced the
      // reported permanent-disabled bug.
      await page.route('**/api/v1/ambient/intent', async () => {
        await new Promise(() => {});
      });

      // 1-2. Load Home, type into the composer.
      await page.fill('#home-prompt-input', 'diagnose the hang bug');
      assert.equal(await page.$eval('#home-prompt-input', (el) => (el as HTMLTextAreaElement).disabled), false);

      // 5. Submit.
      await page.click('#btn-home-prompt-send');

      // 6. Assert textarea becomes disabled while the request is active.
      await waitForComposerDisabledState(page, true, 45000, 'Test 1: Wait for disabled===true on submit');

      const sendDisabledWhileInFlight = await page.$eval('#btn-home-prompt-send', (el) => (el as HTMLButtonElement).disabled);
      assert.equal(sendDisabledWhileInFlight, true, 'Send control must be disabled while the request is in flight');

      // 7-8. Wait for timeout + a real margin, then assert recovery.
      await waitForComposerDisabledState(page, false, TEST_TIMEOUT_MS + 45000, 'Test 1: Wait for disabled===false after timeout');

      const sendDisabledAfterTimeout = await page.$eval('#btn-home-prompt-send', (el) => (el as HTMLButtonElement).disabled);
      assert.equal(sendDisabledAfterTimeout, false, 'Send control must recover once the request settles via timeout');

      await page.click('#btn-close-ambient');

      // 9-11. Focus textarea, type new text, assert it is actually present.
      await page.click('#home-prompt-input');
      await page.keyboard.type('can I type now');
      const valueAfterRecovery = await page.$eval('#home-prompt-input', (el) => (el as HTMLTextAreaElement).value);
      assert.equal(valueAfterRecovery, 'can I type now');

      // Quick Action controls must also be usable again.
      let secondAmbientRequestSeen = false;
      await page.unroute('**/api/v1/ambient/intent');
      await page.route('**/api/v1/ambient/intent', async (route) => {
        secondAmbientRequestSeen = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requestId: 'req_test_recovery',
            provider: 'test',
            model: 'test-model',
            latencyMs: 5,
            plan: { steps: [], summary: 'recovery test plan' },
          }),
        });
      });
      await page.locator('.quick-action-chip').first().click();
      await page.waitForTimeout(500);
      assert.equal(
        secondAmbientRequestSeen,
        true,
        'a Quick Action chip must be able to start a fresh generation once the guard was released by the timeout'
      );
    });
  });
});

test('a normal, responding ambient/intent request is unaffected by the new timeout: disables during, re-enables and renders on completion', { timeout: 70000 }, async () => {
  await withServer(async (origin) => {
    await withBrowserPage(origin, async (page) => {
      // The response is gated behind a promise the test controls, rather
      // than resolving immediately, so the disabled===true observation
      // below is deterministic — not a race against how fast route.fulfill
      // happens to settle under whatever CPU/IO contention the full suite
      // is under. Without this gate, a near-instant mocked response could
      // transition disabled -> enabled before the assertion ever polled,
      // producing a full-suite-only false timeout despite correct app
      // behavior.
      let releaseResponse: () => void = () => {};
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      await page.route('**/api/v1/ambient/intent', async (route) => {
        await responseGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requestId: 'req_test_happy',
            provider: 'test',
            model: 'test-model',
            latencyMs: 42,
            plan: { steps: [{ step: 1, title: 'Step one', reasoning: 'because', skill: 'test.unknown_skill' }], summary: 'A test plan summary' },
          }),
        });
      });

      await page.fill('#home-prompt-input', 'plan my day');
      await page.click('#btn-home-prompt-send');

      // Must disable promptly on submit (unchanged pre-existing behavior).
      // The mocked response is still being held open at this point, so
      // there is no window in which it could have already re-enabled.
      await waitForComposerDisabledState(page, true, 45000, 'Test 2: Wait for disabled===true on submit');

      // Now let the held-open request resolve, and assert re-enable.
      releaseResponse();
      await waitForComposerDisabledState(page, false, 45000, 'Test 2: Wait for disabled===false on completion');

      const resultVisible = await page.evaluate(() => {
        const c1 = document.getElementById('ambient-result-card');
        const c2 = document.getElementById('ambient-understanding-card');
        return (c1 && c1.style.display !== 'none') || (c2 && c2.style.display !== 'none');
      });
      assert.equal(resultVisible, true, 'the plan result card or canonical understanding card should render on a normal successful response');
    });
  });
});

// A2 — #composer-drop-zone previously didn't exist in the served markup at
// all (a real drift: the toggle handler and CSS rule both still referenced
// it, but getElementById returned null, making the file button's click a
// silent no-op). This proves the real, current DOM element genuinely
// changes visibility on a real click (the file-affordance button is a
// currently-unreachable "hidden-affordance" control per its own markup —
// see public/index.html — so the click is dispatched directly on the
// button element itself, exactly as a future "reveal hidden affordances"
// entry point would, rather than depending on that separate, out-of-scope
// feature existing yet), and that selecting a real file through it drives
// the same real upload pipeline the voice-memo recorder already uses.
test('composer file button click makes the real #composer-drop-zone visible, and selecting a file uploads through the real capture pipeline', { timeout: 30000 }, async () => {
  await withServer(async (origin) => {
    await withBrowserPage(origin, async (page) => {
      const isHiddenAndInvisible = async () => page.evaluate(() => {
        const el = document.getElementById('composer-drop-zone');
        if (!el) return null;
        return el.classList.contains('hidden') && window.getComputedStyle(el).display === 'none';
      });
      const isVisible = async () => page.evaluate(() => {
        const el = document.getElementById('composer-drop-zone');
        if (!el) return false;
        return !el.classList.contains('hidden') && window.getComputedStyle(el).display !== 'none';
      });

      assert.equal(await isHiddenAndInvisible(), true, 'the drop zone must start hidden-by-default, both by class and by real computed style');

      await page.evaluate(() => document.getElementById('btn-afford-file').click());
      assert.equal(await isVisible(), true, 'a real click on the file button must make the real drop zone visible, not just toggle an inert class');

      let uploadRequestBody: any = null;
      await page.route('**/api/v1/workspace/upload', async (route) => {
        uploadRequestBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ captureId: 'cap_test_composer_file', status: 'READY' }),
        });
      });

      await page.setInputFiles('#composer-file-input', {
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('a real composer file upload'),
      });
      await page.waitForFunction(
        () => document.getElementById('composer-drop-zone')?.classList.contains('hidden') === true,
        undefined,
        { timeout: 5000 },
      );

      assert.ok(uploadRequestBody, 'selecting a file must actually call the real upload endpoint, not a fake/parallel path');
      assert.equal(uploadRequestBody.type, 'FILE');
      assert.equal(uploadRequestBody.filename, 'note.txt');
      assert.ok(typeof uploadRequestBody.base64 === 'string' && uploadRequestBody.base64.length > 0, 'the real file content must be sent, not a stub');

      assert.equal(await isHiddenAndInvisible(), true, 'the drop zone must hide itself again once the upload completes');

      const inboxTabActive = await page.evaluate(() => document.getElementById('view-home')?.classList.contains('active-view') === false);
      assert.equal(inboxTabActive, true, 'a successful upload must hand off to the Inbox, matching the existing voice-memo capture behavior');

      await page.evaluate(() => document.getElementById('btn-afford-file').click());
    });
  });
});

// R22.D1 — public/app.js previously declared both renderInbox and
// renderCandidateActionControls TWICE at the same top-level scope. Under
// standard JS function-declaration hoisting the SECOND declaration of each
// silently won at runtime: a no-op boolean stub for renderInbox (the real
// implementation — which actually fetches /approvals, /workspace/inbox,
// /candidates and writes #inbox-items-list — never ran), and a broken
// stub for renderCandidateActionControls (expects a bare `action` object
// but the one real call site passes the whole `candidate`, and its Retry
// button has no onclick at all). Both dead duplicates have been removed,
// leaving only the real implementations. This proves the canonical
// functions now genuinely perform the interactions the rest of the suite
// already assumed they did.
test('canonical renderInbox and renderCandidateActionControls actually render real content (no dead-duplicate shadowing)', { timeout: 30000 }, async () => {
  await withServer(async (origin) => {
    await withBrowserPage(origin, async (page) => {
      await page.route('**/api/v1/approvals', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvals: [] }) });
      });
      await page.route('**/api/v1/workspace/inbox', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{
              captureId: 'cap_test_d1',
              status: 'FAILED',
              source: 'WEB',
              createdAt: new Date().toISOString(),
              metadata: { extractedTitle: 'D1 regression capture', errorMessage: 'Simulated failure for D1 test', retryable: true },
            }],
          }),
        });
      });
      await page.route('**/api/v1/candidates', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: [{
              candidateId: 'cand_test_d1',
              type: 'TASK',
              status: 'ACCEPTED',
              title: 'D1 regression candidate',
              action: { status: 'NOT_STARTED' },
              createdAt: new Date().toISOString(),
            }],
          }),
        });
      });

      await page.evaluate(() => window.NAGEX.switchTab('tab-inbox'));
      await page.waitForFunction(
        () => (document.getElementById('inbox-items-list')?.textContent || '').includes('D1 regression capture'),
        undefined,
        { timeout: 10000 },
      );

      // renderInbox (canonical, 1245) must have actually written real,
      // fetched content into the DOM — not the dead stub's no-op.
      const itemsListText = await page.$eval('#inbox-items-list', (el) => el.textContent || '');
      assert.match(itemsListText, /D1 regression capture/, 'the real capture title must be rendered, proving renderInbox actually fetched and wrote content');
      assert.match(itemsListText, /Simulated failure for D1 test/, 'the real error message must be rendered');

      // renderCandidateActionControls (canonical, 1467) is reached through
      // renderCandidateReviewQueue -> renderCandidateReviewCard, whose only
      // real triggers are the toggle/modify handlers — exercise the real
      // toggleResolvedCandidates handler (a PROPOSED candidate is visible
      // regardless of the toggle's own on/off state) rather than calling
      // an internal render function directly.
      await page.evaluate(() => window.NAGEX.toggleResolvedCandidates());

      const candidateButton = await page.$eval('#inbox-candidates-list', (el) => {
        const btn = el.querySelector('button[onclick*="executeCandidateAction"]');
        return btn ? { text: btn.textContent, onclick: btn.getAttribute('onclick') } : null;
      });
      assert.ok(candidateButton, 'expected a real Apply button wired via executeCandidateAction — the dead stub never rendered a working button at all');
      assert.ok(candidateButton!.onclick!.includes('cand_test_d1'), 'the button must be wired to the real candidateId, proving renderCandidateActionControls received the real candidate object');
    });
  });
});
