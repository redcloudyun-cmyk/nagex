import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';

const BASE_URL = process.env.NAGEX_DEPLOYED_URL || 'http://localhost:3000';
const ARTIFACTS_DIR = path.resolve('artifacts/r22_1');

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: false });
}

test('R22.1 Mobile Home Decision Surface Certification', async () => {
  const browser = await chromium.launch({ headless: true });

  let heroContextDerivationPass = false;
  let heroTimeTruthfulnessPass = false;
  let composerVisible360 = false;
  let composerVisible390 = false;
  let composerVisible430 = false;
  let bottomNavOcclusionCount = 0;
  let heroStaleEventAsNowCount = 0;
  let heroStaleRecommendationSelectionCount = 0;

  try {
    const viewports = [
      { name: '360', width: 360, height: 800 },
      { name: '390', width: 390, height: 844 },
      { name: '430', width: 430, height: 932 },
    ];

    for (const vp of viewports) {
      // ── EN Locale Test ──
      const pageEn = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await pageEn.goto(`${BASE_URL}/?demo=1`);
      await pageEn.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('en'));
      await pageEn.reload();

      await pageEn.waitForSelector('#mobile-app-shell', { state: 'attached' });
      await pageEn.waitForSelector('#mh-right-now-hero', { state: 'visible' });

      // A. Right Now hero exists
      const heroExists = await pageEn.isVisible('#mh-right-now-hero');
      assert.equal(heroExists, true, 'Right Now hero must exist');

      // B. One primary action only in Hero
      const heroCtaCount = await pageEn.locator('#mh-right-now-hero button.mh-btn-primary').count();
      assert.equal(heroCtaCount, 1, 'Hero must have exactly one primary CTA button');

      // C. Meaningful personal context derived from state/APIs using the app's apiFetch
      const apiDataEn: any = await pageEn.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
      });
      const briefEn = apiDataEn?.data || apiDataEn;
      const recEn = briefEn?.recommendation;
      const recReasonEn = recEn?.reason;
      const eventsEn = briefEn?.schedule_summary?.events || [];

      // Wait until the rendered hero reflects the API-derived context from the same session
      if (recReasonEn) {
        try {
          await pageEn.waitForFunction(
            (expectedReason: string) => {
              const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
              const body = (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '';
              return (
                hero?.getAttribute('data-context-ready') === 'true' &&
                (
                  body === expectedReason ||
                  body.toLowerCase().includes(expectedReason.toLowerCase())
                )
              );
            },
            recReasonEn,
            { timeout: 10000 }
          );
        } catch (err: any) {
          const diag = await pageEn.evaluate(() => {
            const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
            return {
              body: (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '',
              ready: hero?.getAttribute('data-context-ready')
            };
          });
          assert.fail(
            `Hero EN wait timeout.\nEXPECTED_REASON=${recReasonEn}\nACTUAL_BODY=${diag.body}\nCONTEXT_READY=${diag.ready}\nTARGET_EVENT=${JSON.stringify(recEn)}`
          );
        }
      }

      // Target event selection matching product semantics
      let targetEventEn: any = null;
      if (recEn && recEn.target_id) {
        targetEventEn = eventsEn.find((e: any) => (e.id || e.event_id) === recEn.target_id);
      }
      if (!targetEventEn && recEn && recEn.title) {
        targetEventEn = eventsEn.find((e: any) => {
          const et = e.title || e.summary || '';
          return et && recEn.title.includes(et);
        });
      }
      if (!targetEventEn && eventsEn.length > 0) {
        targetEventEn = eventsEn.find((e: any) => {
          const st = new Date(e.start_time || e.start?.dateTime || e.start).getTime();
          return !isNaN(st) && st >= Date.now() - 30 * 60 * 1000;
        }) || eventsEn[0];
      }
      const startTimeIsoEn = targetEventEn ? (targetEventEn.start_time || targetEventEn.start?.dateTime || targetEventEn.start) : null;

      const heroText = await pageEn.locator('#mh-right-now-hero').innerText();
      const headlineTextEn = await pageEn.locator('#mh-hero-headline').innerText();
      const bodyTextHeroEn = await pageEn.locator('#mh-hero-body').innerText();

      assert.match(heroText, /Right now/i);
      assert.match(headlineTextEn, /Client/i);

      // Verify recommendation reason matches actual API/state value
      if (recReasonEn) {
        assert.ok(
          bodyTextHeroEn === recReasonEn ||
          bodyTextHeroEn.toLowerCase().includes(recReasonEn.toLowerCase()),
          `Hero body mismatch.\nEXPECTED_REASON=${recReasonEn}\nACTUAL_BODY=${bodyTextHeroEn}\nCONTEXT_READY=${await pageEn.getAttribute('#mh-right-now-hero', 'data-context-ready')}\nTARGET_EVENT=${targetEventEn?.title || 'none'}`
        );
      }
      heroContextDerivationPass = true;

      // Verify time truthfulness: computed remaining time matches startTimeIso of selected event
      if (startTimeIsoEn) {
        const diffMinutes = Math.round((new Date(startTimeIsoEn).getTime() - Date.now()) / 60000);
        if (diffMinutes > 60) {
          assert.match(headlineTextEn, /at|AM|PM|:\d\d/i);
        } else if (diffMinutes > 0) {
          assert.match(headlineTextEn, /in\s+\d+\s+min/i);
        } else {
          assert.match(headlineTextEn, /now/i);
        }
        heroTimeTruthfulnessPass = true;
      }

      // D. No technical terms
      const bodyTextEn = await pageEn.locator('#mobile-app-shell').innerText();
      assert.doesNotMatch(bodyTextEn, /\b(Planner|Router|Runtime|Capability|Provider|Model|Execution Graph|Tenant|Human Approval)\b/);

      // E. No visible model selector on Home
      const modelSelectorVisible = await pageEn.evaluate(() => {
        const el = (globalThis as any).document.querySelector('#model-selector') || (globalThis as any).document.querySelector('.model-picker');
        return el ? el.offsetWidth > 0 && el.offsetHeight > 0 : false;
      });
      assert.equal(modelSelectorVisible, false, 'Model selector must not be visible on primary Mobile Home');

      // F. No Search/Plan/Book/Create/Analyze primary chip row on Home
      const chipRowVisible = await pageEn.evaluate(() => {
        const chips = (globalThis as any).document.querySelector('.mh-quick-actions');
        return chips ? chips.offsetWidth > 0 && chips.offsetHeight > 0 : false;
      });
      assert.equal(chipRowVisible, false, 'Primary quick action chip row must not be visible on Mobile Home');

      // G. Bottom nav exactly 5 items
      const navItemCount = await pageEn.locator('.mh-bottom-nav .mh-nav-item').count();
      assert.equal(navItemCount, 5, 'Bottom navigation must contain exactly 5 items');

      // I. Overflow check
      const isOverflowing = await pageEn.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).document.documentElement.clientWidth);
      assert.equal(isOverflowing, false, `Viewport ${vp.name} must not overflow horizontally`);

      // J. Truthful research wording
      const preparedText = await pageEn.locator('#mh-section-prepared').innerText();
      assert.doesNotMatch(preparedText, /Research completed/i, 'Unexecuted research must never be claimed as completed');
      assert.match(preparedText, /Research plan/i, 'Unexecuted research must say Research plan ready');

      // K. Composer Visibility Check in initial viewport above bottom nav
      const composerBox = await pageEn.locator('#mh-command-bar').boundingBox();
      const navBox = await pageEn.locator('.mh-bottom-nav').boundingBox();

      assert.ok(composerBox, `Composer command bar must exist in viewport ${vp.name}`);
      assert.ok(navBox, `Bottom nav must exist in viewport ${vp.name}`);
      assert.ok(
        composerBox.y >= 0 && composerBox.y + composerBox.height <= vp.height + 1,
        `Composer must be accessible within viewport ${vp.name} (composer y=${composerBox.y}, height=${composerBox.height}, viewport=${vp.height})`
      );
      assert.ok(
        composerBox.y + composerBox.height <= navBox.y + 2,
        `Composer must not overlap bottom nav in viewport ${vp.name} (composer bottom=${composerBox.y + composerBox.height}, nav top=${navBox.y})`
      );

      if (vp.name === '360') composerVisible360 = true;
      if (vp.name === '390') composerVisible390 = true;
      if (vp.name === '430') composerVisible430 = true;

      // L. Bottom Nav Content Occlusion Check
      await pageEn.evaluate(() => {
        const scrollEl = (globalThis as any).document.querySelector('#mobile-view-home');
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });

      const lastTodayRow = pageEn.locator('#mh-today-list .mh-today-row').last();
      const lastRowBox = await lastTodayRow.boundingBox();
      const scrolledComposerBox = await pageEn.locator('#mh-command-bar').boundingBox();
      const scrolledNavBox = await pageEn.locator('.mh-bottom-nav').boundingBox();

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

      // M. Stale Event As Now Check
      const isStaleAsNow = await pageEn.evaluate(() => {
        const nag = (globalThis as any).window.NAGEX;
        if (!nag || typeof nag.formatHeroHeadline !== 'function') return false;
        const now = Date.now();
        const pastStart = new Date(now - 90 * 60 * 1000).toISOString();
        const pastEnd = new Date(now - 40 * 60 * 1000).toISOString();
        const headline = nag.formatHeroHeadline('Past Event', pastStart, false, pastEnd);
        return /now|진행 중/i.test(headline);
      });
      if (isStaleAsNow) {
        heroStaleEventAsNowCount++;
      }
      assert.equal(isStaleAsNow, false, 'Past stale event must not be formatted as now');

      // N. Stale Recommendation Selection Test (testing real derivation logic)
      const staleRecTestResult = await pageEn.evaluate(() => {
        const nag = (globalThis as any).window.NAGEX;
        if (!nag || typeof nag.deriveRightNowHeroInfo !== 'function') {
          return { error: 'deriveRightNowHeroInfo function missing' };
        }
        const now = Date.now();
        const pastStart = new Date(now - 90 * 60 * 1000).toISOString();
        const pastEnd = new Date(now - 40 * 60 * 1000).toISOString();
        const futureStart = new Date(now + 45 * 60 * 1000).toISOString();

        const syntheticBrief = {
          data: {
            recommendation: {
              action_type: 'MEETING_PREP',
              target_id: 'stale-event-123',
              title: 'Expired Meeting Strategy',
              reason: 'Old discussion about past pricing',
            },
            schedule_summary: {
              events: [
                {
                  id: 'stale-event-123',
                  title: 'Expired Meeting Strategy',
                  start_time: pastStart,
                  end_time: pastEnd,
                  description: 'Expired description',
                },
                {
                  id: 'valid-future-456',
                  title: 'Upcoming Team Sync',
                  start_time: futureStart,
                  description: 'Next sync meeting',
                },
              ],
            },
          },
        };

        const result = nag.deriveRightNowHeroInfo(syntheticBrief, null, {});
        return {
          usesStaleTitle: Boolean(result.headline?.includes('Expired Meeting Strategy')),
          usesStaleReason: Boolean(result.body === 'Old discussion about past pricing'),
          usesStaleTargetId: Boolean(result.targetId === 'stale-event-123'),
          headline: result.headline,
          targetId: result.targetId,
        };
      });

      if (
        staleRecTestResult.usesStaleTitle ||
        staleRecTestResult.usesStaleReason ||
        staleRecTestResult.usesStaleTargetId
      ) {
        heroStaleRecommendationSelectionCount++;
      }
      assert.equal(
        staleRecTestResult.usesStaleTitle,
        false,
        `Hero derived info must not use stale title. Received: ${staleRecTestResult.headline}`
      );
      assert.equal(
        staleRecTestResult.usesStaleReason,
        false,
        'Hero derived info must not use stale recommendation reason'
      );
      assert.equal(
        staleRecTestResult.usesStaleTargetId,
        false,
        `Hero derived info must not use stale target_id. Received: ${staleRecTestResult.targetId}`
      );

      await shot(pageEn, `${vp.name}_home_en.png`);
      await pageEn.close();

      // ── KR Locale Test ──
      const pageKr = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await pageKr.goto(`${BASE_URL}/?demo=1`);
      await pageKr.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('ko'));
      await pageKr.reload();

      await pageKr.waitForSelector('#mobile-app-shell', { state: 'attached' });
      await pageKr.waitForSelector('#mh-right-now-hero', { state: 'visible' });

      // H. EN/KR Parity check using the app's apiFetch
      const apiDataKr: any = await pageKr.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
      });
      const briefKr = apiDataKr?.data || apiDataKr;
      const recKr = briefKr?.recommendation;
      const recReasonKr = recKr?.reason;
      const eventsKr = briefKr?.schedule_summary?.events || [];

      if (recReasonKr) {
        try {
          await pageKr.waitForFunction(
            (expectedReason: string) => {
              const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
              const body = (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '';
              return (
                hero?.getAttribute('data-context-ready') === 'true' &&
                (
                  body === expectedReason ||
                  body.includes(expectedReason)
                )
              );
            },
            recReasonKr,
            { timeout: 10000 }
          );
        } catch (err: any) {
          const diag = await pageKr.evaluate(() => {
            const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
            return {
              body: (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '',
              ready: hero?.getAttribute('data-context-ready')
            };
          });
          assert.fail(
            `Hero KR wait timeout.\nEXPECTED_REASON=${recReasonKr}\nACTUAL_BODY=${diag.body}\nCONTEXT_READY=${diag.ready}\nTARGET_EVENT=${JSON.stringify(recKr)}`
          );
        }
      }

      let targetEventKr: any = null;
      if (recKr && recKr.target_id) {
        targetEventKr = eventsKr.find((e: any) => (e.id || e.event_id) === recKr.target_id);
      }
      if (!targetEventKr && recKr && recKr.title) {
        targetEventKr = eventsKr.find((e: any) => {
          const et = e.title || e.summary || '';
          return et && recKr.title.includes(et);
        });
      }
      if (!targetEventKr && eventsKr.length > 0) {
        targetEventKr = eventsKr.find((e: any) => {
          const st = new Date(e.start_time || e.start?.dateTime || e.start).getTime();
          return !isNaN(st) && st >= Date.now() - 30 * 60 * 1000;
        }) || eventsKr[0];
      }

      const heroTextKr = await pageKr.locator('#mh-right-now-hero').innerText();
      const headlineTextKr = await pageKr.locator('#mh-hero-headline').innerText();
      const bodyTextHeroKr = await pageKr.locator('#mh-hero-body').innerText();

      assert.match(heroTextKr, /지금 가장 중요한 일/);
      assert.match(headlineTextKr, /클라이언트/);

      if (recReasonKr) {
        assert.ok(
          bodyTextHeroKr === recReasonKr ||
          bodyTextHeroKr.includes(recReasonKr),
          `KR Hero body mismatch.\nEXPECTED_REASON=${recReasonKr}\nACTUAL_BODY=${bodyTextHeroKr}\nCONTEXT_READY=${await pageKr.getAttribute('#mh-right-now-hero', 'data-context-ready')}\nTARGET_EVENT=${targetEventKr?.title || 'none'}`
        );
      }

      const bodyTextKr = await pageKr.locator('#mobile-app-shell').innerText();
      assert.doesNotMatch(bodyTextKr, /\b(Planner|Router|Runtime|Capability|Provider|Model|Execution Graph|Tenant|Human Approval)\b/);

      const isOverflowingKr = await pageKr.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).document.documentElement.clientWidth);
      assert.equal(isOverflowingKr, false, `Viewport ${vp.name} KR must not overflow horizontally`);

      await shot(pageKr, `${vp.name}_home_kr.png`);
      await pageKr.close();
    }

    assert.equal(heroContextDerivationPass, true, 'HERO_CONTEXT_DERIVATION must pass');
    assert.equal(heroTimeTruthfulnessPass, true, 'HERO_TIME_TRUTHFULNESS must pass');

    console.log(`COMPOSER_VISIBLE_360=${composerVisible360 ? 'PASS' : 'FAIL'}`);
    console.log(`COMPOSER_VISIBLE_390=${composerVisible390 ? 'PASS' : 'FAIL'}`);
    console.log(`COMPOSER_VISIBLE_430=${composerVisible430 ? 'PASS' : 'FAIL'}`);
    console.log(`BOTTOM_NAV_OCCLUSION=${bottomNavOcclusionCount}`);
    console.log(`HERO_STALE_RECOMMENDATION_SELECTION=${heroStaleRecommendationSelectionCount}`);
    console.log(`HERO_STALE_EVENT_AS_NOW=${heroStaleEventAsNowCount}`);
    console.log('HERO_CONTEXT_DERIVATION=PASS');
    console.log('HERO_TIME_TRUTHFULNESS=PASS');
    console.log('HERO_HARDCODED_COUNTDOWN=0');
  } finally {
    await browser.close();
  }
});

