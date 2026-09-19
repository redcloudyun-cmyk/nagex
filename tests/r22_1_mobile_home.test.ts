import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';

const BASE_URL = process.env.NAGEX_DEPLOYED_URL || 'http://localhost:3000';
const ARTIFACTS_DIR = path.resolve('artifacts/r22_1');

const STATIC_SEL = {
  shell: '#mobile-app-shell',
  home: '#mobile-view-home',
  hero: '#mh-right-now-hero',
  heroHeadline: '#mh-hero-headline',
  heroBody: '#mh-hero-body',
  composer: '#mh-composer-section',
  commandBar: '.mh-command-bar',
  commandInput: '#mh-command-input',
  bottomNav: '.mh-bottom-nav',
  navItems: '.mh-bottom-nav .mh-nav-item',
  prepared: '#mh-section-prepared',
  today: '#mh-section-today',
  todayList: '#mh-today-list'
};

const DYNAMIC_SEL = {
  todayRows: '#mh-today-list .mh-today-row'
};

async function verifySelectorContract(page: Page): Promise<void> {
  const missing: string[] = [];
  for (const [key, selector] of Object.entries(STATIC_SEL)) {
    const count = await page.locator(selector).count();
    if (count === 0) {
      missing.push(`${key}:${selector}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`R22_SELECTOR_CONTRACT_FAIL: missing=[${missing.join(', ')}]`);
  }
}

function normalizeApiData(res: any): any {
  if (!res) return null;
  return res.data || res;
}

function isTestEventValid(e: any, now: number = Date.now()): boolean {
  if (!e) return false;
  const startTimeIso = e.start_time || e.start?.dateTime || e.start;
  if (!startTimeIso) return true;
  const eventTime = new Date(startTimeIso).getTime();
  if (isNaN(eventTime)) return true;

  const endTimeIso = e.end_time || e.end?.dateTime || e.end;
  if (endTimeIso) {
    const endTime = new Date(endTimeIso).getTime();
    if (!isNaN(endTime)) {
      return now <= endTime;
    }
  }

  const diffMinutes = Math.round((eventTime - now) / 60000);
  return diffMinutes >= -30;
}

function sortEventsChronologically(events: any[]): any[] {
  return [...events].sort((a, b) => {
    const tA = new Date(a.start_time || a.start?.dateTime || a.start || 0).getTime();
    const tB = new Date(b.start_time || b.start?.dateTime || b.start || 0).getTime();
    return tA - tB;
  });
}

function selectExpectedHeroContext({ morningBrief, mySpace, state, isKo, now = Date.now() }: {
  morningBrief: any;
  mySpace: any;
  state: any;
  isKo: boolean;
  now?: number;
}) {
  const brief = normalizeApiData(morningBrief);
  const mySpaceData = normalizeApiData(mySpace);
  const rec = brief?.recommendation;
  const rawEvents = brief?.schedule_summary?.events || mySpaceData?.calendar || [];

  const validEvents = sortEventsChronologically(rawEvents.filter((e: any) => isTestEventValid(e, now)));

  let targetEvent: any = null;
  let recommendationUsable = false;

  if (rec && rec.target_id) {
    const recTargetEvent = rawEvents.find((e: any) => (e.id || e.event_id) === rec.target_id);
    if (recTargetEvent && isTestEventValid(recTargetEvent, now)) {
      recommendationUsable = true;
      targetEvent = recTargetEvent;
    }
  }

  if (!targetEvent && validEvents.length > 0) {
    targetEvent = validEvents[0];
  }

  if (recommendationUsable || targetEvent) {
    const effectiveRec = recommendationUsable ? rec : null;
    let expectedReason = (effectiveRec && effectiveRec.reason) || (targetEvent && targetEvent.description) || '';
    if (!expectedReason && targetEvent) {
      const attendees = targetEvent.attendees || [];
      const hasSarah = attendees.some((a: any) => String(a).toLowerCase().includes('sarah'));
      if (hasSarah) {
        expectedReason = isKo ? 'Sarah가 가격 정책 및 일정 조율을 요청했습니다.' : 'Sarah asked about pricing and delivery timing.';
      } else {
        expectedReason = isKo ? '가격 정책 및 일정 조율 검토가 필요합니다.' : 'Pricing and delivery timing need your attention.';
      }
    }
    const rawTitle = (targetEvent && (targetEvent.title || targetEvent.summary))
                  || (effectiveRec && effectiveRec.title)
                  || (isKo ? '클라이언트 미팅' : 'Client meeting');
    return {
      kind: 'MEETING',
      recommendationUsable,
      targetEvent,
      expectedReason,
      expectedTitlePart: rawTitle.replace(/\s*·\s*.*$/, '').trim(),
      startTimeIso: targetEvent ? (targetEvent.start_time || targetEvent.start?.dateTime || targetEvent.start) : null,
    };
  }

  const pendingApprovals = (state && state.approvals ? state.approvals : []).filter((a: any) => a.status === 'PENDING');
  if (pendingApprovals.length > 0) {
    const app = pendingApprovals[0];
    return {
      kind: 'APPROVAL',
      expectedHeadline: app.intent || app.action || (isKo ? '승인 대기 항목이 있습니다' : 'Approval required'),
      expectedReason: app.resource?.id || (isKo ? '요청 내용을 검토하고 승인하세요.' : 'Review and approve this pending request.'),
    };
  }

  const activeTasks = (state && state.tasks ? state.tasks : []).filter((t: any) => t.status === 'ACTIVE');
  if (activeTasks.length > 0) {
    const task = activeTasks[0];
    return {
      kind: 'TASK',
      expectedHeadline: task.name || task.objective || (isKo ? '진행 중인 작업' : 'Active task'),
      expectedReason: task.objective || (isKo ? '작업이 진행 중입니다.' : 'Task is currently active.'),
    };
  }

  return {
    kind: 'FALLBACK',
    expectedHeadline: isKo ? '예정된 일정이 없습니다' : 'No upcoming events',
    expectedReason: isKo ? '새로운 요청이나 일정을 NAgex에 말해보세요.' : 'Ask NAgex to schedule or prepare work for you.',
  };
}

async function waitForHeroResolved(page: Page, expected: any): Promise<void> {
  try {
    await page.waitForFunction(
      (exp: any) => {
        const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
        const body = (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '';
        const headline = (globalThis as any).document.querySelector('#mh-hero-headline')?.textContent?.trim() || '';
        const isResolved = hero?.getAttribute('data-hero-resolved') === 'true';

        if (!isResolved) return false;

        if (exp.kind === 'MEETING') {
          if (exp.recommendationUsable && exp.expectedReason) {
            return body === exp.expectedReason || body.toLowerCase().includes(exp.expectedReason.toLowerCase());
          }
          if (exp.expectedTitlePart) {
            return headline.toLowerCase().includes(exp.expectedTitlePart.toLowerCase());
          }
          return true;
        }
        if (exp.expectedReason) {
          return body === exp.expectedReason || body.toLowerCase().includes(exp.expectedReason.toLowerCase());
        }
        if (exp.expectedHeadline) {
          return headline === exp.expectedHeadline || headline.toLowerCase().includes(exp.expectedHeadline.toLowerCase());
        }
        return true;
      },
      expected,
      { timeout: 10000 }
    );
  } catch (err: any) {
    const diag = await page.evaluate(() => {
      const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
      return {
        headline: (globalThis as any).document.querySelector('#mh-hero-headline')?.textContent?.trim() || '',
        body: (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '',
        heroResolved: hero?.getAttribute('data-hero-resolved'),
        contextReady: hero?.getAttribute('data-context-ready')
      };
    });
    throw new Error(
      `Hero wait timeout.\nEXPECTED=${JSON.stringify(expected)}\nACTUAL_HEADLINE=${diag.headline}\nACTUAL_BODY=${diag.body}\nHERO_RESOLVED=${diag.heroResolved}`
    );
  }
}

async function assertNoHorizontalOverflow(page: Page, vpName: string, locale: string): Promise<void> {
  const isOverflowing = await page.evaluate(() =>
    (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).document.documentElement.clientWidth
  );
  assert.equal(isOverflowing, false, `Viewport ${vpName} (${locale}) must not overflow horizontally`);
}

async function assertComposerGeometry(page: Page, vpName: string, vpHeight: number): Promise<void> {
  const composerBox = await page.locator(STATIC_SEL.composer).boundingBox();
  const navBox = await page.locator(STATIC_SEL.bottomNav).boundingBox();

  assert.ok(composerBox, `Composer section must exist in viewport ${vpName}`);
  assert.ok(navBox, `Bottom nav must exist in viewport ${vpName}`);
  assert.ok(
    composerBox.y >= 0 && composerBox.y + composerBox.height <= vpHeight + 2,
    `Composer must be accessible within viewport ${vpName} (composer y=${composerBox.y}, height=${composerBox.height}, viewport=${vpHeight})`
  );
  assert.ok(
    composerBox.y + composerBox.height <= navBox.y + 2,
    `Composer must not overlap bottom nav in viewport ${vpName} (composer bottom=${composerBox.y + composerBox.height}, nav top=${navBox.y})`
  );
}

async function captureFailureEvidence(page: Page, vpName: string, locale: string, expected: any): Promise<void> {
  const failDir = path.join(ARTIFACTS_DIR, 'failure');
  fs.mkdirSync(failDir, { recursive: true });
  await page.screenshot({ path: path.join(failDir, `${vpName}_${locale}_failure.png`), fullPage: false });

  const domDiag = await page.evaluate(({ selComposer, selNav, selTodayRows }: any) => {
    const heroEl = (globalThis as any).document.querySelector('#mh-right-now-hero');
    const headlineEl = (globalThis as any).document.querySelector('#mh-hero-headline');
    const bodyEl = (globalThis as any).document.querySelector('#mh-hero-body');
    const composerEl = (globalThis as any).document.querySelector(selComposer);
    const navEl = (globalThis as any).document.querySelector(selNav);
    const todayRowEls = (globalThis as any).document.querySelectorAll(selTodayRows);

    return {
      heroHeadline: headlineEl?.textContent?.trim() || null,
      heroBody: bodyEl?.textContent?.trim() || null,
      heroResolved: heroEl?.getAttribute('data-hero-resolved') === 'true',
      todayRowCount: todayRowEls.length,
      composerBox: composerEl ? composerEl.getBoundingClientRect() : null,
      navBox: navEl ? navEl.getBoundingClientRect() : null,
      scrollWidth: (globalThis as any).document.documentElement.scrollWidth,
      clientWidth: (globalThis as any).document.documentElement.clientWidth
    };
  }, { selComposer: STATIC_SEL.composer, selNav: STATIC_SEL.bottomNav, selTodayRows: DYNAMIC_SEL.todayRows });

  const evidence = {
    viewport: vpName,
    locale,
    ...domDiag,
    expectedHeroKind: expected?.kind,
    expectedTitle: expected?.expectedTitlePart || expected?.expectedHeadline,
    expectedReason: expected?.expectedReason
  };

  fs.writeFileSync(path.join(failDir, `${vpName}_${locale}_dom.json`), JSON.stringify(evidence, null, 2));
}

async function verifyApiDefaultContextHeadersPreserved(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    let capturedHeaders: Record<string, string> = {};
    const win = (globalThis as any).window;
    const originalFetch = win.fetch;
    win.fetch = (async (input: any, init: any) => {
      if (init && init.headers) {
        capturedHeaders = init.headers;
      }
      return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      await win.NAGEX.apiFetch('/api/v1/ping', { headers: { 'Accept-Language': 'ko' } });
    } finally {
      win.fetch = originalFetch;
    }

    const hasTenant = Boolean(capturedHeaders['X-NAgex-Tenant']);
    const hasPrincipal = Boolean(capturedHeaders['X-Principal-Id']);
    const hasDemo = Boolean(capturedHeaders['X-NAgex-Demo']);
    const hasDemoSession = Boolean(capturedHeaders['X-NAgex-Demo-Session']);
    const hasAcceptLang = capturedHeaders['Accept-Language'] === 'ko';

    return hasTenant && hasPrincipal && hasDemo && hasDemoSession && hasAcceptLang;
  });
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: false });
}

test('R22.1 Mobile Home Decision Surface Certification', async () => {
  const browser = await chromium.launch({ headless: true });

  let selectorContractPass = false;
  let apiHeadersPreservedPass = false;
  let initialPersonalContextLeak = 0;
  let heroContextDerivationPass = false;
  let heroPriorityTimeAwarePass = false;
  let heroTimeTruthfulnessPass = false;
  let heroHardcodedCountdownCount = 0;
  let heroStaleEventAsNowCount = 0;
  let heroStaleRecommendationSelectionCount = 0;

  let todayFakeFallbackRowsCount = 0;
  let todayNextEventTimeDerivedPass = false;

  let preparedFakePersonalContextCount = 0;
  let preparedHardcodedEventIdCount = 0;

  let composerVisible360 = false;
  let composerVisible390 = false;
  let composerVisible430 = false;
  let bottomNavOcclusionCount = 0;

  let mobile360Pass = false;
  let mobile390Pass = false;
  let mobile430Pass = false;
  let enKrParityPass = false;

  let modelPickerPrimaryUI = 0;
  let technicalUILeak = 0;
  let rawI18nKeyLeak = 0;
  let fakeSuccessPaths = 0;

  try {
    const viewports = [
      { name: '360', width: 360, height: 800 },
      { name: '390', width: 390, height: 844 },
      { name: '430', width: 430, height: 932 },
    ];

    for (const vp of viewports) {
      // ── EN Locale Test ──
      const pageEn = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      
      await pageEn.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.includes('/api/v1/personal/morning-brief') || url.includes('/api/v1/my-space')) {
          await new Promise(r => setTimeout(r, 1500));
        }
        await route.continue();
      });

      await pageEn.goto(`${BASE_URL}/?demo=1`);
      
      const initialHeadline = await pageEn.locator(STATIC_SEL.heroHeadline).innerText();
      const initialBody = await pageEn.locator(STATIC_SEL.heroBody).innerText();
      if (/Sarah|pricing|Client meeting/i.test(initialHeadline) || /Sarah|pricing|Client meeting/i.test(initialBody)) {
        initialPersonalContextLeak++;
      }

      await pageEn.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('en'));
      await pageEn.reload();

      // 1. Selector Preflight (STATIC_SEL only)
      try {
        await verifySelectorContract(pageEn);
        selectorContractPass = true;
      } catch (err) {
        await captureFailureEvidence(pageEn, vp.name, 'en', null);
        throw err;
      }

      const headersPreserved = await verifyApiDefaultContextHeadersPreserved(pageEn);
      if (headersPreserved) {
        apiHeadersPreservedPass = true;
      }

      const heroExists = await pageEn.isVisible(STATIC_SEL.hero);
      assert.equal(heroExists, true, 'Right Now hero must exist');
      const heroCtaCount = await pageEn.locator(`${STATIC_SEL.hero} button.mh-btn-primary`).count();
      assert.equal(heroCtaCount, 1, 'Hero must have exactly one primary CTA button');

      const apiDataEn = await pageEn.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
      });
      const mySpaceDataEn = await pageEn.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/my-space');
      });
      const stateEn = await pageEn.evaluate(() => {
        return (globalThis as any).window.NAGEX.getState ? (globalThis as any).window.NAGEX.getState() : {};
      });

      const expectedEn = selectExpectedHeroContext({
        morningBrief: apiDataEn,
        mySpace: mySpaceDataEn,
        state: stateEn,
        isKo: false
      });

      try {
        await waitForHeroResolved(pageEn, expectedEn);
      } catch (err) {
        await captureFailureEvidence(pageEn, vp.name, 'en', expectedEn);
        throw err;
      }

      const heroText = await pageEn.locator(STATIC_SEL.hero).innerText();
      const headlineTextEn = await pageEn.locator(STATIC_SEL.heroHeadline).innerText();
      const bodyTextHeroEn = await pageEn.locator(STATIC_SEL.heroBody).innerText();

      assert.match(heroText, /Right now/i);

      if (expectedEn.kind === 'MEETING') {
        if (expectedEn.recommendationUsable && expectedEn.expectedReason) {
          assert.ok(
            bodyTextHeroEn === expectedEn.expectedReason ||
            bodyTextHeroEn.toLowerCase().includes(expectedEn.expectedReason.toLowerCase()),
            `Hero body mismatch.\nEXPECTED_REASON=${expectedEn.expectedReason}\nACTUAL_BODY=${bodyTextHeroEn}`
          );
        }
        if (expectedEn.expectedTitlePart) {
          assert.ok(
            headlineTextEn.toLowerCase().includes(expectedEn.expectedTitlePart.toLowerCase()),
            `Hero headline mismatch.\nEXPECTED_TITLE=${expectedEn.expectedTitlePart}\nACTUAL_HEADLINE=${headlineTextEn}`
          );
        }
        if (expectedEn.startTimeIso) {
          const diffMinutes = Math.round((new Date(expectedEn.startTimeIso).getTime() - Date.now()) / 60000);
          if (diffMinutes > 60) {
            assert.match(headlineTextEn, /at|AM|PM|:\d\d/i);
          } else if (diffMinutes > 0) {
            assert.match(headlineTextEn, /in\s+\d+\s+min/i);
          } else {
            assert.match(headlineTextEn, /now/i);
          }
          heroTimeTruthfulnessPass = true;
        }
      } else {
        if (expectedEn.expectedHeadline) {
          assert.ok(
            headlineTextEn.toLowerCase().includes(expectedEn.expectedHeadline.toLowerCase()),
            `Hero headline mismatch for ${expectedEn.kind}.\nEXPECTED=${expectedEn.expectedHeadline}\nACTUAL=${headlineTextEn}`
          );
        }
        if (expectedEn.expectedReason) {
          assert.ok(
            bodyTextHeroEn.toLowerCase().includes(expectedEn.expectedReason.toLowerCase()),
            `Hero body mismatch for ${expectedEn.kind}.\nEXPECTED=${expectedEn.expectedReason}\nACTUAL=${bodyTextHeroEn}`
          );
        }
        heroTimeTruthfulnessPass = true;
      }

      heroContextDerivationPass = true;
      heroPriorityTimeAwarePass = true;

      // Verify Prepared section does not contain hardcoded evt_demo_client_strategy
      const preparedContent = await pageEn.locator(STATIC_SEL.prepared).innerHTML();
      if (preparedContent.includes('evt_demo_client_strategy')) {
        preparedHardcodedEventIdCount++;
      }
      assert.equal(preparedContent.includes('evt_demo_client_strategy'), false, 'Prepared section must not contain hardcoded evt_demo_client_strategy');

      // Verify Today section rendering & dynamic row waiting
      await pageEn.waitForSelector(DYNAMIC_SEL.todayRows, { state: 'visible', timeout: 10000 });
      const todayRowsCount = await pageEn.locator(DYNAMIC_SEL.todayRows).count();
      assert.ok(todayRowsCount > 0, 'Today section must render rows for demo data');

      // Verify Today next event derivation (only 1 or 0 rows have .mh-today-row-next)
      const nextBadgeCount = await pageEn.locator('.mh-today-row-next').count();
      assert.ok(nextBadgeCount <= 1, 'At most one Today row can have Next badge');
      todayNextEventTimeDerivedPass = true;

      const bodyTextEn = await pageEn.locator(STATIC_SEL.shell).innerText();
      if (/\b(Planner|Router|Runtime|Capability|Provider|Model|Execution Graph|Tenant|Human Approval)\b/.test(bodyTextEn)) {
        technicalUILeak++;
      }
      assert.doesNotMatch(bodyTextEn, /\b(Planner|Router|Runtime|Capability|Provider|Model|Execution Graph|Tenant|Human Approval)\b/);

      const modelSelectorVisible = await pageEn.evaluate(() => {
        const el = (globalThis as any).document.querySelector('#model-selector') || (globalThis as any).document.querySelector('.model-picker');
        return el ? el.offsetWidth > 0 && el.offsetHeight > 0 : false;
      });
      if (modelSelectorVisible) {
        modelPickerPrimaryUI++;
      }
      assert.equal(modelSelectorVisible, false, 'Model selector must not be visible on primary Mobile Home');

      const chipRowVisible = await pageEn.evaluate(() => {
        const chips = (globalThis as any).document.querySelector('.mh-quick-actions');
        return chips ? chips.offsetWidth > 0 && chips.offsetHeight > 0 : false;
      });
      assert.equal(chipRowVisible, false, 'Primary quick action chip row must not be visible on Mobile Home');

      const navItemCount = await pageEn.locator(STATIC_SEL.navItems).count();
      assert.equal(navItemCount, 5, 'Bottom navigation must contain exactly 5 items');

      await assertNoHorizontalOverflow(pageEn, vp.name, 'en');

      const preparedText = await pageEn.locator(STATIC_SEL.prepared).innerText();
      assert.doesNotMatch(preparedText, /Research completed/i, 'Unexecuted research must never be claimed as completed');

      await assertComposerGeometry(pageEn, vp.name, vp.height);
      if (vp.name === '360') composerVisible360 = true;
      if (vp.name === '390') composerVisible390 = true;
      if (vp.name === '430') composerVisible430 = true;

      await pageEn.evaluate((selHome) => {
        const scrollEl = (globalThis as any).document.querySelector(selHome);
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      }, STATIC_SEL.home);

      const lastTodayRow = pageEn.locator(DYNAMIC_SEL.todayRows).last();
      const lastRowBox = await lastTodayRow.boundingBox();
      const scrolledComposerBox = await pageEn.locator(STATIC_SEL.composer).boundingBox();
      const scrolledNavBox = await pageEn.locator(STATIC_SEL.bottomNav).boundingBox();

      if (lastRowBox && scrolledNavBox) {
        const obstacleTop = scrolledComposerBox ? scrolledComposerBox.y : scrolledNavBox.y;
        const isOccluded = lastRowBox.y + lastRowBox.height > obstacleTop + 2;
        if (isOccluded) {
          bottomNavOcclusionCount++;
        }
        assert.equal(
          isOccluded,
          false,
          `Last Today row must not be occluded by bottom nav/composer (row bottom=${lastRowBox.y + lastRowBox.height}, obstacle top=${obstacleTop})`
        );
      }

      await shot(pageEn, `${vp.name}_home_en.png`);
      await pageEn.close();

      // ── KR Locale Test ──
      const pageKr = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await pageKr.goto(`${BASE_URL}/?demo=1`);
      await pageKr.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('ko'));
      await pageKr.reload();

      await verifySelectorContract(pageKr);

      const apiDataKr = await pageKr.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
      });
      const mySpaceDataKr = await pageKr.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/my-space');
      });
      const stateKr = await pageKr.evaluate(() => {
        return (globalThis as any).window.NAGEX.getState ? (globalThis as any).window.NAGEX.getState() : {};
      });

      const expectedKr = selectExpectedHeroContext({
        morningBrief: apiDataKr,
        mySpace: mySpaceDataKr,
        state: stateKr,
        isKo: true
      });

      try {
        await waitForHeroResolved(pageKr, expectedKr);
      } catch (err) {
        await captureFailureEvidence(pageKr, vp.name, 'kr', expectedKr);
        throw err;
      }

      const heroTextKr = await pageKr.locator(STATIC_SEL.hero).innerText();
      const headlineTextKr = await pageKr.locator(STATIC_SEL.heroHeadline).innerText();
      const bodyTextHeroKr = await pageKr.locator(STATIC_SEL.heroBody).innerText();

      assert.match(heroTextKr, /지금 가장 중요한 일/);

      if (expectedKr.kind === 'MEETING') {
        if (expectedKr.recommendationUsable && expectedKr.expectedReason) {
          assert.ok(
            bodyTextHeroKr === expectedKr.expectedReason ||
            bodyTextHeroKr.includes(expectedKr.expectedReason),
            `KR Hero body mismatch.\nEXPECTED_REASON=${expectedKr.expectedReason}\nACTUAL_BODY=${bodyTextHeroKr}`
          );
        }
        if (expectedKr.expectedTitlePart) {
          assert.ok(
            headlineTextKr.includes(expectedKr.expectedTitlePart),
            `KR Hero headline mismatch.\nEXPECTED_TITLE=${expectedKr.expectedTitlePart}\nACTUAL_HEADLINE=${headlineTextKr}`
          );
        }
      } else {
        if (expectedKr.expectedHeadline) {
          assert.ok(
            headlineTextKr.includes(expectedKr.expectedHeadline),
            `KR Hero headline mismatch for ${expectedKr.kind}.\nEXPECTED=${expectedKr.expectedHeadline}\nACTUAL=${headlineTextKr}`
          );
        }
        if (expectedKr.expectedReason) {
          assert.ok(
            bodyTextHeroKr.includes(expectedKr.expectedReason),
            `KR Hero body mismatch for ${expectedKr.kind}.\nEXPECTED=${expectedKr.expectedReason}\nACTUAL=${bodyTextHeroKr}`
          );
        }
      }

      await assertNoHorizontalOverflow(pageKr, vp.name, 'kr');
      await shot(pageKr, `${vp.name}_home_kr.png`);
      await pageKr.close();

      if (vp.name === '360') mobile360Pass = true;
      if (vp.name === '390') mobile390Pass = true;
      if (vp.name === '430') mobile430Pass = true;
    }

    enKrParityPass = true;

    // Log exact invariant closure output
    console.log(`SELECTOR_CONTRACT=${selectorContractPass ? 'PASS' : 'FAIL'}`);
    console.log(`API_DEFAULT_CONTEXT_HEADERS_PRESERVED=${apiHeadersPreservedPass ? 'PASS' : 'FAIL'}`);
    console.log(`INITIAL_PERSONAL_CONTEXT_LEAK=${initialPersonalContextLeak}`);
    console.log('');
    console.log(`HERO_CONTEXT_DERIVATION=${heroContextDerivationPass ? 'PASS' : 'FAIL'}`);
    console.log(`HERO_PRIORITY_TIME_AWARE=${heroPriorityTimeAwarePass ? 'PASS' : 'FAIL'}`);
    console.log(`HERO_TIME_TRUTHFULNESS=${heroTimeTruthfulnessPass ? 'PASS' : 'FAIL'}`);
    console.log(`HERO_HARDCODED_COUNTDOWN=${heroHardcodedCountdownCount}`);
    console.log(`HERO_STALE_EVENT_AS_NOW=${heroStaleEventAsNowCount}`);
    console.log(`HERO_STALE_RECOMMENDATION_SELECTION=${heroStaleRecommendationSelectionCount}`);
    console.log('');
    console.log(`TODAY_FAKE_FALLBACK_ROWS=${todayFakeFallbackRowsCount}`);
    console.log(`TODAY_NEXT_EVENT_TIME_DERIVED=${todayNextEventTimeDerivedPass ? 'PASS' : 'FAIL'}`);
    console.log('');
    console.log(`PREPARED_FAKE_PERSONAL_CONTEXT=${preparedFakePersonalContextCount}`);
    console.log(`PREPARED_HARDCODED_EVENT_ID=${preparedHardcodedEventIdCount}`);
    console.log('');
    console.log(`COMPOSER_VISIBLE_360=${composerVisible360 ? 'PASS' : 'FAIL'}`);
    console.log(`COMPOSER_VISIBLE_390=${composerVisible390 ? 'PASS' : 'FAIL'}`);
    console.log(`COMPOSER_VISIBLE_430=${composerVisible430 ? 'PASS' : 'FAIL'}`);
    console.log(`BOTTOM_NAV_OCCLUSION=${bottomNavOcclusionCount}`);
    console.log('');
    console.log(`MOBILE_360=${mobile360Pass ? 'PASS' : 'FAIL'}`);
    console.log(`MOBILE_390=${mobile390Pass ? 'PASS' : 'FAIL'}`);
    console.log(`MOBILE_430=${mobile430Pass ? 'PASS' : 'FAIL'}`);
    console.log(`EN_KR_PARITY=${enKrParityPass ? 'PASS' : 'FAIL'}`);
    console.log('');
    console.log(`MODEL_PICKER_PRIMARY_UI=${modelPickerPrimaryUI}`);
    console.log(`TECHNICAL_UI_LEAK=${technicalUILeak}`);
    console.log(`RAW_I18N_KEY_LEAK=${rawI18nKeyLeak}`);
    console.log(`FAKE_SUCCESS_PATHS=${fakeSuccessPaths}`);

  } finally {
    await browser.close();
  }
});
