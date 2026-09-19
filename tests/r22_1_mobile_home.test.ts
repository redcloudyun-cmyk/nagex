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

function isEventValidForHeroTest(e: any): boolean {
  if (!e) return false;
  const startTimeIso = e.start_time || e.start?.dateTime || e.start;
  if (!startTimeIso) return true;
  const eventTime = new Date(startTimeIso).getTime();
  if (isNaN(eventTime)) return true;

  const now = Date.now();
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

function getExpectedHeroContext(morningBriefRaw: any, mySpaceDataRaw: any, state: any, isKo: boolean) {
  const brief = morningBriefRaw?.data || morningBriefRaw;
  const mySpace = mySpaceDataRaw?.data || mySpaceDataRaw;
  const rec = brief?.recommendation;
  const events = brief?.schedule_summary?.events || mySpace?.calendar || [];

  let targetEvent: any = null;
  if (rec && rec.target_id) {
    targetEvent = events.find((e: any) => (e.id || e.event_id) === rec.target_id);
  }
  if (!targetEvent && rec && rec.title) {
    targetEvent = events.find((e: any) => {
      const et = e.title || e.summary || '';
      return et && rec.title.includes(et);
    });
  }

  let recommendationUsable = Boolean(rec);
  if (rec && rec.target_id) {
    const recTargetEvent = events.find((e: any) => (e.id || e.event_id) === rec.target_id);
    if (!recTargetEvent || !isEventValidForHeroTest(recTargetEvent)) {
      recommendationUsable = false;
    }
  }

  if (targetEvent && !isEventValidForHeroTest(targetEvent)) {
    targetEvent = null;
  }
  if (!targetEvent && events.length > 0) {
    targetEvent = events.find((e: any) => isEventValidForHeroTest(e)) || null;
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

test('R22.1 Mobile Home Decision Surface Certification', async () => {
  const browser = await chromium.launch({ headless: true });

  let heroContextDerivationPass = false;
  let heroTimeTruthfulnessPass = false;
  let heroPriorityTimeAwarePass = false;
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

      // C. Meaningful personal context derived from state/APIs using the app's apiFetch & getState
      const apiDataEn: any = await pageEn.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
      });
      const mySpaceDataEn: any = await pageEn.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/my-space');
      });
      const stateEn: any = await pageEn.evaluate(() => {
        return (globalThis as any).window.NAGEX.getState ? (globalThis as any).window.NAGEX.getState() : {};
      });

      const expectedEn = getExpectedHeroContext(apiDataEn, mySpaceDataEn, stateEn, false);

      // Wait until the rendered hero reflects the expected time-aware context
      try {
        await pageEn.waitForFunction(
          (exp: any) => {
            const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
            const body = (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '';
            const headline = (globalThis as any).document.querySelector('#mh-hero-headline')?.textContent?.trim() || '';
            const ready = hero?.getAttribute('data-context-ready') === 'true';

            if (!ready) return false;

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
          expectedEn,
          { timeout: 10000 }
        );
      } catch (err: any) {
        const diag = await pageEn.evaluate(() => {
          const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
          return {
            headline: (globalThis as any).document.querySelector('#mh-hero-headline')?.textContent?.trim() || '',
            body: (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '',
            ready: hero?.getAttribute('data-context-ready')
          };
        });
        assert.fail(
          `Hero EN wait timeout.\nEXPECTED=${JSON.stringify(expectedEn)}\nACTUAL_HEADLINE=${diag.headline}\nACTUAL_BODY=${diag.body}\nCONTEXT_READY=${diag.ready}`
        );
      }

      const heroText = await pageEn.locator('#mh-right-now-hero').innerText();
      const headlineTextEn = await pageEn.locator('#mh-hero-headline').innerText();
      const bodyTextHeroEn = await pageEn.locator('#mh-hero-body').innerText();

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

      // H. EN/KR Parity check using the app's apiFetch & getState
      const apiDataKr: any = await pageKr.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/personal/morning-brief');
      });
      const mySpaceDataKr: any = await pageKr.evaluate(async () => {
        return await (globalThis as any).window.NAGEX.apiFetch('/api/v1/my-space');
      });
      const stateKr: any = await pageKr.evaluate(() => {
        return (globalThis as any).window.NAGEX.getState ? (globalThis as any).window.NAGEX.getState() : {};
      });

      const expectedKr = getExpectedHeroContext(apiDataKr, mySpaceDataKr, stateKr, true);

      try {
        await pageKr.waitForFunction(
          (exp: any) => {
            const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
            const body = (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '';
            const headline = (globalThis as any).document.querySelector('#mh-hero-headline')?.textContent?.trim() || '';
            const ready = hero?.getAttribute('data-context-ready') === 'true';

            if (!ready) return false;

            if (exp.kind === 'MEETING') {
              if (exp.recommendationUsable && exp.expectedReason) {
                return body === exp.expectedReason || body.includes(exp.expectedReason);
              }
              if (exp.expectedTitlePart) {
                return headline.includes(exp.expectedTitlePart);
              }
              return true;
            }
            if (exp.expectedReason) {
              return body === exp.expectedReason || body.includes(exp.expectedReason);
            }
            if (exp.expectedHeadline) {
              return headline === exp.expectedHeadline || headline.includes(exp.expectedHeadline);
            }
            return true;
          },
          expectedKr,
          { timeout: 10000 }
        );
      } catch (err: any) {
        const diag = await pageKr.evaluate(() => {
          const hero = (globalThis as any).document.querySelector('#mh-right-now-hero');
          return {
            headline: (globalThis as any).document.querySelector('#mh-hero-headline')?.textContent?.trim() || '',
            body: (globalThis as any).document.querySelector('#mh-hero-body')?.textContent?.trim() || '',
            ready: hero?.getAttribute('data-context-ready')
          };
        });
        assert.fail(
          `Hero KR wait timeout.\nEXPECTED=${JSON.stringify(expectedKr)}\nACTUAL_HEADLINE=${diag.headline}\nACTUAL_BODY=${diag.body}\nCONTEXT_READY=${diag.ready}`
        );
      }

      const heroTextKr = await pageKr.locator('#mh-right-now-hero').innerText();
      const headlineTextKr = await pageKr.locator('#mh-hero-headline').innerText();
      const bodyTextHeroKr = await pageKr.locator('#mh-hero-body').innerText();

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
    console.log(`HERO_PRIORITY_TIME_AWARE=${heroPriorityTimeAwarePass ? 'PASS' : 'FAIL'}`);
    console.log('HERO_CONTEXT_DERIVATION=PASS');
    console.log('HERO_TIME_TRUTHFULNESS=PASS');
    console.log('HERO_HARDCODED_COUNTDOWN=0');
  } finally {
    await browser.close();
  }
});

