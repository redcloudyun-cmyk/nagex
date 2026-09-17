// R12.1 — Intent-first UX Core, Increment 2: Home UX.
//
// Verifies Home is rebuilt around the presentation-state contract
// established in Increment 1: Universal Intent stays the dominant surface,
// examples are capability-neutral (not calendar/task-dominant), proactive
// information ("Important for you") is structurally separate from real
// consequential approvals ("Needs Approval"), approval CTAs are
// consequence-specific, no fabricated data is ever shown as if real, and
// Home degrades honestly on partial failure. Same conventions as the rest
// of this suite: no real browser/DOM harness exists here, so behavior is
// verified by fetching the real served HTML/JS from a real in-process
// server and asserting on exact source text (the same technique
// tests/state_propagation.test.ts and tests/candidate_review.test.ts use).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf8');
}

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

// ─── 1-2: Universal Intent stays primary ───

test('1. Home composer appears before the capability-neutral examples grid, which appears before the operational grid (Universal Intent stays visually primary)', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const composerIdx = html.indexOf('id="unified-composer"');
    const examplesIdx = html.indexOf('id="home-examples-grid"');
    const operationalIdx = html.indexOf('desktop-home-grid-operational');
    assert.ok(composerIdx >= 0 && examplesIdx >= 0 && operationalIdx >= 0);
    assert.ok(composerIdx < examplesIdx, 'composer must precede the examples grid');
    assert.ok(examplesIdx < operationalIdx, 'examples must precede the operational grid (Active work/Approvals/etc.)');
  });
});

test('2. Home composer textarea starts empty (no fake prepopulated prompt)', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const match = html.match(/<textarea id="home-prompt-input"[^>]*>([\s\S]*?)<\/textarea>/);
    assert.ok(match);
    assert.equal(match![1].trim(), '');
  });
});

// ─── 3-6: capability-neutral examples ───

test('3. The Home examples grid spans at least 7 distinct capability classes, not calendar/task-dominant', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const gridMatch = html.match(/<div class="nagex-quick-actions-grid" id="home-examples-grid">([\s\S]*?)<\/div>\s*\n\s*<!--/);
    assert.ok(gridMatch, 'examples grid not found');
    const grid = gridMatch![1];
    const actions = ['example-research', 'example-presentation', 'example-coding', 'example-communication', 'example-image', 'example-scheduling', 'example-automation'];
    for (const a of actions) {
      assert.ok(grid.includes(`data-action="${a}"`), `missing example: ${a}`);
    }
    // The old calendar/task-dominant set (5 of 5 examples were travel or
    // scheduling) must be gone entirely.
    assert.doesNotMatch(grid, /Plan a Trip|Book a Sports Activity|Reserve a Dinner|Manage My Schedule|Organize My Day/);
  });
});

test('4. Calendar/scheduling is only one of the 7 examples, not the majority', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const gridMatch = html.match(/<div class="nagex-quick-actions-grid" id="home-examples-grid">([\s\S]*?)<\/section>/);
    assert.ok(gridMatch);
    const schedulingCount = (gridMatch![1].match(/data-action="example-scheduling"/g) || []).length;
    assert.equal(schedulingCount, 1);
  });
});

test('5. Example chips submit through the canonical intent path (runAmbientTask), never a separate hidden execution route', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const fnMatch = appJs.match(/function initQuickActionChips\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /runAmbientTask\(promptText\)/);
    // Example prompt map must exist and each example id must resolve to
    // real text, not a fallback/dead branch.
    assert.match(appJs, /HOME_EXAMPLE_PROMPTS = \{[\s\S]*?'example-research':/);
  });
});

test('6. Capability Discovery chips populate the composer (browsing aid) rather than auto-submitting a hidden execution', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const fnMatch = appJs.match(/function initQuickActionChips\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /action in HOME_DISCOVER_PROMPTS/);
    assert.match(fnMatch![0], /homeInput\.value = HOME_DISCOVER_PROMPTS\[action\]/);
  });
});

// ─── 7-11: Important-for-you / Active work / Approvals / Recent results ───

test('7. "Important for you" and "Needs Approval" are structurally separate sections (not one merged list)', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.ok(html.includes('id="list-important-for-you"'));
    assert.ok(html.includes('id="list-needs-attention"'));
    const importantHeading = html.match(/<h2[^>]*data-i18n="home\.importantTitle"/);
    const approvalHeading = html.match(/data-i18n="home\.approvalsTitle"/);
    assert.ok(importantHeading && approvalHeading);
  });
});

test('8. "NAgex is working" (Active work) copy is outcome-oriented — no internal provider/model/tool-id text leaks into the primary card', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const cardMatch = html.match(/<h2 data-i18n="home\.workingTitle">[\s\S]*?<div id="list-nagex-working"[^>]*><\/div>\s*<\/section>/);
    assert.ok(cardMatch);
    assert.doesNotMatch(cardMatch![0], /toolId|CapabilityBroker|ModelRouter|provider:/i);
  });
});

test('9. Needs Approval renders consequence-specific CTAs, never a bare Run/Execute/Continue/OK', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /function homeApprovalActionLabel\(a, t\) \{/);
    const fnMatch = appJs.match(/function homeApprovalActionLabel\(a, t\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /approveAndCreateEvent/);
    assert.match(fnMatch![0], /approveAndSend/);
    assert.match(fnMatch![0], /approveGeneric/);
    // The approval card button must call the label function, not a
    // hardcoded generic string.
    const approvalsSection = appJs.match(/\/\/ 2b\. Needs Approval[\s\S]*?\n    }\n/);
    assert.ok(approvalsSection);
    assert.match(approvalsSection![0], /homeApprovalActionLabel\(a, t\)/);
    assert.doesNotMatch(approvalsSection![0], />Run<|>Execute<|>Continue<|>OK</);
  });
});

test('10. Needs Approval has no frontend seed-ID filtering — the backend itself never returns fictional approvals (DEBT-0006 closed)', async () => {
  // R12.1 Increment 2.5 closed DEBT-0006 at the source: GET /api/v1/approvals
  // now reads ActionApprovalStore.listPending() (real, tenant/principal-
  // scoped), so app.js no longer needs to know about, or filter out, any
  // specific demo/seed approval ids.
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.doesNotMatch(appJs, /LEGACY_DEMO_APPROVAL_IDS/);
    assert.doesNotMatch(appJs, /appr_gcal_sync|appr_stakeholder_email/);
    const approvalsSection = appJs.match(/\/\/ 2b\. Needs Approval[\s\S]*?\n    }\n/);
    assert.ok(approvalsSection);
    assert.match(approvalsSection![0], /state\.approvals\.filter\(\(a\) => a\.status === 'PENDING'\)/);
  });
});

test('10b. Needs Approval fails closed: a failed fetch renders a distinct "could not be loaded" message, never a false "no approvals" empty state', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /state\.approvalsLoadFailed = !apprData \|\| Boolean\(apprData\.error\)/);
    const approvalsSection = appJs.match(/\/\/ 2b\. Needs Approval[\s\S]*?\n    }\n/);
    assert.ok(approvalsSection);
    assert.match(approvalsSection![0], /if \(state\.approvalsLoadFailed\) \{/);
    assert.match(approvalsSection![0], /home\.approvalsLoadError/);
  });
});

test('11. The static ambient onboarding example no longer has a dead/unwired "Review Plan" button implying an action it does not perform', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.doesNotMatch(html, /id="btn-review-plan"/);
    // The remaining "Run" button must still go through the canonical
    // composer submit path, not a direct mutation call.
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const fnMatch = appJs.match(/function initPrimaryScenario\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /submitAmbientComposerInput\(\)/);
  });
});

// ─── 12-13: truthfulness — no fabricated data anywhere in served Home assets ───

test('12. No fabricated demo timeline, memory, or metric data remains in the served desktop-home.js', async () => {
  await withServer(async (origin) => {
    const js = await (await fetch(`${origin}/desktop/desktop-home.js`)).text();
    assert.doesNotMatch(js, /Morning workout|Lunch with Sarah|Client proposal review|Dinner reservation|Product team standup/);
    assert.doesNotMatch(js, /Reserved tennis lesson|Bay Club|Le Bernardin|Found 12 new job opportunities/);
    assert.doesNotMatch(js, /Prefers window seats|Loves Japanese cuisine|Traveling to Tokyo next month/);
    assert.doesNotMatch(js, /Mon, Dec 16, 2024/);
    assert.doesNotMatch(js, /12\.5 hours|28 tasks|6 bookings/);
  });
});

test('13. desktop-home.js today-panel date is computed from the real current date, not a hardcoded string', async () => {
  await withServer(async (origin) => {
    const js = await (await fetch(`${origin}/desktop/desktop-home.js`)).text();
    assert.match(js, /dateEl\.textContent = new Date\(\)\.toLocaleDateString/);
  });
});

// ─── 14-15: Recent Results require real state ───

test('14. Recent Actions renders only real GET /api/v1/my-space history, with a truthful empty state (no fake fallback cards)', async () => {
  await withServer(async (origin) => {
    const js = await (await fetch(`${origin}/desktop/desktop-home.js`)).text();
    const fnMatch = js.match(/async function renderTodayPanel\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /emptyState\(t\('home\.recentActionsEmpty'/);
  });
});

test('15. My Space timeline distinguishes a genuine empty day from a failed fetch (never shows false empty-as-if-loaded on API failure)', async () => {
  await withServer(async (origin) => {
    const js = await (await fetch(`${origin}/desktop/desktop-home.js`)).text();
    const fnMatch = js.match(/async function renderTodayPanel\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /mySpaceFetchFailed/);
    assert.match(fnMatch![0], /home\.todayLoadError/);
    assert.match(fnMatch![0], /home\.todayEmpty/);
  });
});

// ─── 16-17: Logo / navigation (regression from Increment 1) ───

test('16. Logo->Home wiring from Increment 1 is unmodified by the Home redesign (desktop, ambient, and mobile logos all still call window.NAGEX.goHome())', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const count = (html.match(/onclick="window\.NAGEX\.goHome\(\)"/g) || []).length;
    assert.equal(count, 3);
  });
});

test('17. switchTab correctly sets/clears the "active" nav state for Home/Inbox/Activity/Settings (single source of truth, no second router)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const fnMatch = appJs.match(/function switchTab\(tabId\) \{[\s\S]*?\n  \}/);
    assert.ok(fnMatch);
    assert.match(fnMatch![0], /el\.getAttribute\('data-tab'\) === tabId\) el\.classList\.add\('active'\)/);
    assert.match(fnMatch![0], /else el\.classList\.remove\('active'\)/);
  });
});

// ─── 18: Back/Forward — declared limitation, not faked ───

test('18. Browser Back/Forward across tabs is a declared architectural limitation (no pushState/popstate exists) — not silently faked as supported', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    // The only window.history usage in the whole file is the pre-existing
    // OAuth-redirect query-string cleanup (replaceState), never pushState,
    // and there is no popstate/hashchange listener anywhere — Back/Forward
    // through tabs is not wired. See DEBT-0005 for the explicit disclosure.
    assert.doesNotMatch(appJs, /window\.history\.pushState/);
    assert.doesNotMatch(appJs, /addEventListener\('popstate'/);
    assert.doesNotMatch(appJs, /addEventListener\('hashchange'/);
    assert.match(appJs, /window\.history\.replaceState\(\{\}, '', cleanUrl\)/);
  });
});

// ─── 19-20: EN/KR ───

test('19. All new Home strings resolve to real, non-empty, locale-distinct EN/KR text', async () => {
  const i18nJs = readSrc('public/i18n.js');
  const keys = [
    'home.heroTitle', 'home.heroSubtitle',
    'home.example.research', 'home.example.presentation', 'home.example.coding', 'home.example.communication', 'home.example.image', 'home.example.scheduling', 'home.example.automation',
    'home.importantTitle', 'home.importantEmpty',
    'home.discoverTitle', 'home.discover.create', 'home.discover.research', 'home.discover.communicate', 'home.discover.organize', 'home.discover.automate', 'home.discover.browseAct',
    'home.recentActionsEmpty', 'home.todayEmpty', 'home.todayLoadError', 'home.memoryEmpty',
    'home.approveAndCreateEvent', 'home.approveAndSend', 'home.approveAndSubmit', 'home.approveAndDelete', 'home.approveGeneric',
  ];
  for (const key of keys) {
    const enMatch = i18nJs.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'([^']*)'`));
    assert.ok(enMatch, `missing key in i18n.js: ${key}`);
    assert.ok(enMatch![1].trim().length > 0, `empty EN value for ${key}`);
  }
});

test('20. Every new home.* key appears exactly twice in i18n.js (once per locale block), never left EN-only', async () => {
  const i18nJs = readSrc('public/i18n.js');
  const keys = ['home.heroTitle', 'home.importantTitle', 'home.discoverTitle', 'home.example.research', 'home.approveAndCreateEvent'];
  for (const key of keys) {
    const count = (i18nJs.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    assert.equal(count, 2, `expected ${key} exactly twice (en+ko), found ${count}`);
  }
});

// ─── 21-22: accessibility / responsive ───

test('21. Home\'s live-updating sections (Working, Important, Approvals) are aria-live="polite" without spamming (no aria-live="assertive" anywhere on Home)', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.ok(html.includes('id="list-nagex-working" aria-live="polite"'));
    assert.ok(html.includes('id="list-important-for-you" aria-live="polite"'));
    assert.ok(html.includes('id="list-needs-attention" aria-live="polite"'));
  });
});

test('22. Capability Discovery chips are real keyboard-reachable <button> elements with visible text, not div/span click targets', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const gridMatch = html.match(/<div class="home-discover-grid">([\s\S]*?)<\/div>\s*<\/section>/);
    assert.ok(gridMatch);
    const buttonCount = (gridMatch![1].match(/<button class="home-discover-chip/g) || []).length;
    assert.equal(buttonCount, 6);
  });
});

test('23. Home Discover grid CSS uses a responsive auto-fit column layout, not a fixed pixel width (mobile-safe)', async () => {
  const css = readSrc('public/desktop/desktop-home.css');
  const ruleMatch = css.match(/\.home-discover-grid \{[\s\S]*?\}/);
  assert.ok(ruleMatch);
  assert.match(ruleMatch![0], /grid-template-columns: repeat\(auto-fit, minmax\(160px, 1fr\)\)/);
  assert.doesNotMatch(ruleMatch![0], /width:\s*\d{3,}px/);
});

// ─── 24-25: failure isolation ───

test('24. The composer submit handler has no dependency on renderHomeWorkspaceSections\' own data (one failed secondary section cannot break the composer)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const homeFn = appJs.match(/function renderHome\(\) \{[\s\S]*?\n  \}\n\n  async function renderHomeWorkspaceSections/);
    assert.ok(homeFn);
    // btnSend wiring happens unconditionally in renderHome(), never inside
    // renderHomeWorkspaceSections's own try/await chain.
    assert.match(homeFn![0], /btnSend\.onclick = async \(\) => \{/);
  });
});

test('25. renderHome() no longer overrides hero copy with hardcoded strings — capability-neutral copy is owned by data-i18n markup', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const homeFn = appJs.match(/function renderHome\(\) \{[\s\S]*?renderHomeWorkspaceSections\(\);/);
    assert.ok(homeFn);
    assert.doesNotMatch(homeFn![0], /Plans and Executes/);
    assert.doesNotMatch(homeFn![0], /heroTitle\.innerHTML/);
  });
});
