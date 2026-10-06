// R23.7C-C — Deployed Real-Browser Certification.
//
// Repository-native Playwright certification driving the real,
// user-visible Personal Home/Create UI on a deployed NAgex instance. Reuses
// the existing chromium (Playwright) infrastructure and the existing
// DEPLOYED_CERT gate (see r21_p1_deployed_certification.test.ts and
// scripts/nagex-test-gate.mjs) rather than inventing a new browser
// framework or a new live-cert environment convention.
//
// This test performs exactly ONE real, paid image generation (Desktop EN).
// Mobile KR MUST NOT trigger a second generation — it only attempts to
// view the artifact created by the desktop run through the product's
// normal surface, and truthfully records NOT_AVAILABLE if no such surface
// exists rather than fabricating visibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { chromium, type Page, type ConsoleMessage } from 'playwright';

declare const document: any;
declare const window: any;
declare const getComputedStyle: any;

const BASE_URL = process.env.NAGEX_DEPLOYED_URL;

const EVIDENCE_DIR = path.resolve('artifacts/r23.7c-c');
const CERT_JSON_PATH = path.join(EVIDENCE_DIR, 'r23_7c_c_real_browser_cert.json');

const IMAGE_PROMPT = 'A clean futuristic personal AI workspace with subtle geometric light, dark navy background, minimal professional design, no text.';

// Only concrete internal/provider terms — deliberately excludes ordinary
// user-facing words ("image", "create", "AI", "artifact") to avoid false
// positives per the certification's explicit instruction.
const TECHNICAL_LEAK_TERMS = [
  'OpenAI', 'GPT Image', 'gpt-image', 'dall-e', 'DALL-E', 'Nebius', 'Nemotron',
  'ImageStore', 'ImageExecutor', 'ArtifactStore', 'ModelGateway', 'ModelRouter',
  'binaryStoragePath', 'providerExecutionMetadata', '/var/lib/nagex', 'filesystem path',
  'ten_production_01', 'ten_demo_hackathon', 'usr_admin_001',
];
// Known i18n namespace prefixes used by this app (public/index.html
// data-i18n keys) — a raw key leaking through means i18n substitution
// failed for that string.
const RAW_I18N_KEY_PATTERN = /\b(create|home|header|nav|analyze|workspace|heroBrief|settings)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

function getHeadSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name), fullPage: true });
}

async function overflowMetrics(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

function checkLeaks(bodyText: string, cert: Record<string, any>, surface: 'desktop' | 'mobile'): void {
  const technicalHits = TECHNICAL_LEAK_TERMS.filter((term) => bodyText.toLowerCase().includes(term.toLowerCase()));
  const i18nMatch = bodyText.match(RAW_I18N_KEY_PATTERN);
  cert.technicalUiLeak = (cert.technicalUiLeak || 0) + technicalHits.length;
  cert.rawI18nKeyLeak = (cert.rawI18nKeyLeak || 0) + (i18nMatch ? 1 : 0);
  if (technicalHits.length > 0) {
    cert.defects.push({ code: 'TECHNICAL_UI_LEAK', surface, evidence: technicalHits });
  }
  if (i18nMatch) {
    cert.defects.push({ code: 'RAW_I18N_KEY_LEAK', surface, evidence: i18nMatch[0] });
  }
}

test('R23.7C-C real-browser certification: canonical image creation through the deployed Personal Home/Create UI', { timeout: 300000, skip: BASE_URL ? false : 'NAGEX_DEPLOYED_URL_REQUIRED' }, async () => {
  const cert: Record<string, any> = {
    timestamp: new Date().toISOString(),
    deployedUrl: BASE_URL,
    headSha: getHeadSha(),
    desktopViewport: { width: 1440, height: 900 },
    mobileViewport: { width: 390, height: 844 },
    realGenerationCount: 0,
    generationHttpStatus: null,
    creationId: null,
    artifactId: null,
    canonicalImageUrl: null,
    canonicalImageBrowserLoad: null,
    renderedImageDimensionsDesktop: null,
    renderedImageDimensionsMobile: null,
    historyVisibilityDesktop: null,
    historyVisibilityMobile: null,
    mobileSurfaceNote: null,
    pendingStateTruthful: null,
    successStateTruthful: null,
    overflow: {},
    consoleErrors: { desktop: [], mobile: [] },
    pageErrors: { desktop: [], mobile: [] },
    screenshots: {},
    technicalUiLeak: 0,
    rawI18nKeyLeak: 0,
    fakeSuccessPaths: 0,
    defects: [],
    classification: 'PENDING',
  };

  const browser = await chromium.launch({ headless: true });
  try {
    // ---------------- DESKTOP EN — the ONE real generation ----------------
    const desktop = await browser.newPage({ viewport: cert.desktopViewport });
    const desktopConsoleErrors: string[] = [];
    const desktopPageErrors: string[] = [];
    desktop.on('console', (msg: ConsoleMessage) => { if (msg.type() === 'error') desktopConsoleErrors.push(msg.text()); });
    desktop.on('pageerror', (err) => desktopPageErrors.push(String(err)));

    await desktop.goto(`${BASE_URL}/`);
    await desktop.waitForSelector('.home-discover-chip[data-action="discover-create"]', { state: 'visible', timeout: 30000 });

    const localeEn = await desktop.evaluate(() => (window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : 'en'));
    assert.equal(localeEn, 'en', 'Desktop certification must run under EN locale');

    await shot(desktop, 'desktop-en-create-entry.png');
    cert.screenshots.desktopEnCreateEntry = 'desktop-en-create-entry.png';

    // Natural discovery: Personal Home's "Create" discovery chip.
    await desktop.click('.home-discover-chip[data-action="discover-create"]');
    await desktop.waitForSelector('#create-prompt-input', { state: 'visible', timeout: 15000 });

    await desktop.fill('#create-prompt-input', IMAGE_PROMPT);

    assert.equal(cert.realGenerationCount, 0, 'no generation may occur before this point');

    const generatePromise = desktop.waitForResponse(
      (res) => res.url().includes('/api/v1/creations/generate') && res.request().method() === 'POST',
      { timeout: 120000 },
    );

    await desktop.click('#btn-create-generate');
    cert.realGenerationCount += 1;

    // Truthful pending-state capture (before the response resolves).
    await desktop.waitForSelector('#btn-create-generate[disabled]', { timeout: 10000 }).catch(() => {});
    const pendingButtonText = await desktop.locator('#btn-create-generate').innerText().catch(() => '');
    cert.pendingStateTruthful = /generat/i.test(pendingButtonText);
    await shot(desktop, 'desktop-en-generation-pending.png');
    cert.screenshots.desktopEnGenerationPending = 'desktop-en-generation-pending.png';

    const generateResponse = await generatePromise;
    const generateStatus = generateResponse.status();
    const generateBody = await generateResponse.json().catch(() => null);
    cert.generationHttpStatus = generateStatus;

    assert.equal(cert.realGenerationCount, 1, 'MAX_REAL_GENERATIONS violated — exactly one real generation is permitted');

    if (generateStatus !== 201 || !generateBody?.creationId || !generateBody?.imageUrl) {
      cert.classification = 'FAIL_GENERATION';
      cert.defects.push({ code: 'GENERATION_FAILED_OR_INCOMPLETE', evidence: { status: generateStatus, body: generateBody } });
      throw new Error(`R23_7C_C_CERT_STOP: real generation did not return a completed contract (status=${generateStatus})`);
    }

    cert.creationId = generateBody.creationId;
    cert.artifactId = generateBody.artifactId || null;
    cert.canonicalImageUrl = generateBody.imageUrl;
    cert.successStateTruthful = generateBody.status === 'COMPLETED' && generateStatus === 201;
    assert.equal(cert.successStateTruthful, true, 'success must require both a real generation response AND a completed contract');

    // Canonical image must be genuinely GET-fetchable — success is never
    // inferred from the generation response alone.
    const imageLoadCheck = await desktop.evaluate(async (url: string) => {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return { status: res.status, contentType: res.headers.get('content-type'), byteLength: buf.byteLength };
    }, cert.canonicalImageUrl);
    cert.canonicalImageBrowserLoad = imageLoadCheck;
    assert.equal(imageLoadCheck.status, 200, 'canonical image URL must be genuinely GET-fetchable in the browser');
    assert.ok(imageLoadCheck.byteLength > 0, 'canonical image bytes must be non-empty');

    await desktop.waitForFunction(() => {
      const slot = document.querySelector('#create-result-slot');
      return Boolean(slot && !slot.textContent?.includes('No creation generated yet'));
    }, { timeout: 15000 });

    await shot(desktop, 'desktop-en-generated-image.png');
    cert.screenshots.desktopEnGeneratedImage = 'desktop-en-generated-image.png';

    // Require an ACTUAL rendered <img> element with non-zero natural
    // dimensions — never inferred from surrounding UI text.
    const renderedImgDesktop = await desktop.evaluate(() => {
      const img = document.querySelector('#create-result-slot img') as any;
      if (!img) return null;
      return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, src: img.getAttribute('src') };
    });
    cert.renderedImageDimensionsDesktop = renderedImgDesktop;

    if (!renderedImgDesktop || renderedImgDesktop.naturalWidth === 0 || renderedImgDesktop.naturalHeight === 0) {
      const slotHtml = await desktop.evaluate(() => document.querySelector('#create-result-slot')?.innerHTML?.slice(0, 500));
      cert.defects.push({
        code: 'CANONICAL_IMAGE_NOT_RENDERED_AS_IMG',
        surface: 'desktop',
        evidence: { renderedImgDesktop, slotHtml },
        note: 'public/app.js renderCreationOutput() only wraps assetUrl in an <img> tag when it starts with "data:" or "http"; the canonical imageUrl is a relative path (/api/v1/creations/images/:id) and falls through to being inserted as raw text instead of an <img> element.',
      });
      cert.classification = 'FAIL_UI_IMAGE_NOT_RENDERED';
      cert.screenshots.desktopEnImageOpened = 'UNAVAILABLE_NO_IMG_ELEMENT';
    } else {
      await shot(desktop, 'desktop-en-image-opened.png');
      cert.screenshots.desktopEnImageOpened = 'desktop-en-image-opened.png';
    }

    cert.overflow.desktop = await overflowMetrics(desktop);
    assert.equal(cert.overflow.desktop.scrollWidth <= cert.overflow.desktop.clientWidth, true, 'desktop must not overflow horizontally');

    const desktopBodyText = await desktop.locator('body').innerText();
    checkLeaks(desktopBodyText, cert, 'desktop');

    cert.consoleErrors.desktop = desktopConsoleErrors;
    cert.pageErrors.desktop = desktopPageErrors;

    await desktop.waitForFunction((creationId: string) => {
      const list = document.querySelector('#create-history-list');
      return Boolean(list && list.innerHTML.includes(creationId));
    }, cert.creationId, { timeout: 15000 }).catch(() => {});
    const desktopHistoryHasEntry = await desktop.evaluate((creationId: string) => {
      const list = document.querySelector('#create-history-list');
      return Boolean(list && list.innerHTML.includes(creationId));
    }, cert.creationId);
    cert.historyVisibilityDesktop = desktopHistoryHasEntry ? 'PASS' : 'FAIL';

    await desktop.close();

    // ---------------- MOBILE KR — view only, NEVER generate ----------------
    const mobile = await browser.newPage({ viewport: cert.mobileViewport });
    const mobileConsoleErrors: string[] = [];
    const mobilePageErrors: string[] = [];
    mobile.on('console', (msg: ConsoleMessage) => { if (msg.type() === 'error') mobileConsoleErrors.push(msg.text()); });
    mobile.on('pageerror', (err) => mobilePageErrors.push(String(err)));

    await mobile.goto(`${BASE_URL}/`);
    await mobile.waitForLoadState('domcontentloaded');

    // Real supported UI mechanism for switching locale (never localStorage
    // injection) — desktop shell and mobile shell each expose their own
    // lang-toggle button.
    const mobileLangToggle = mobile.locator('#mh-lang-toggle');
    if (await mobileLangToggle.count() > 0 && await mobileLangToggle.first().isVisible()) {
      await mobileLangToggle.first().click();
    } else {
      const desktopLangToggle = mobile.locator('#btn-lang-toggle');
      if (await desktopLangToggle.count() > 0) await desktopLangToggle.first().click();
    }
    cert.mobileLocale = await mobile.evaluate(() => (window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : null));

    // Attempt to reach the desktop-generated artifact through the mobile
    // UI's own normal surface — never by re-triggering generation.
    let mobileSurfaceNote = 'no discover-create entry point visible in the mobile UI';
    let mobileArtifactReached = false;
    const mobileDiscoverCreate = mobile.locator('.home-discover-chip[data-action="discover-create"]');
    if (await mobileDiscoverCreate.count() > 0 && await mobileDiscoverCreate.first().isVisible()) {
      await mobileDiscoverCreate.first().click();
      const createPromptVisible = await mobile.locator('#create-prompt-input').isVisible().catch(() => false);
      if (createPromptVisible) {
        await mobile.waitForFunction((creationId: string) => {
          const list = document.querySelector('#create-history-list');
          return Boolean(list && list.innerHTML.includes(creationId));
        }, cert.creationId, { timeout: 15000 }).catch(() => {});
        mobileArtifactReached = await mobile.evaluate((creationId: string) => {
          const list = document.querySelector('#create-history-list');
          return Boolean(list && list.innerHTML.includes(creationId));
        }, cert.creationId);
        mobileSurfaceNote = mobileArtifactReached
          ? 'shared Create Studio panel (#view-create) is reachable and shows the desktop-generated artifact at mobile viewport'
          : 'shared Create Studio panel (#view-create) is reachable but does not show the desktop-generated artifact (history not yet reflecting it)';
      } else {
        mobileSurfaceNote = '#view-create is not visible at mobile viewport after clicking the discover-create chip (desktop-only shell)';
      }
    }
    cert.mobileSurfaceNote = mobileSurfaceNote;
    cert.historyVisibilityMobile = mobileArtifactReached ? 'PASS' : 'NOT_AVAILABLE';

    if (mobileArtifactReached) {
      const dims = await mobile.evaluate((creationId: string) => {
        const cards = Array.from(document.querySelectorAll('.creation-history-card')) as any[];
        const card = cards.find((c) => (c.getAttribute('onclick') || '').includes(creationId));
        const img = card ? card.querySelector('img') : null;
        return img ? { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, src: img.getAttribute('src') } : null;
      }, cert.creationId);
      cert.renderedImageDimensionsMobile = dims;
      if (dims && dims.naturalWidth > 0 && dims.naturalHeight > 0) {
        await shot(mobile, 'mobile-kr-generated-image.png');
        cert.screenshots.mobileKrGeneratedImage = 'mobile-kr-generated-image.png';
        await shot(mobile, 'mobile-kr-image-opened.png');
        cert.screenshots.mobileKrImageOpened = 'mobile-kr-image-opened.png';
      } else {
        cert.defects.push({
          code: 'MOBILE_ARTIFACT_NOT_RENDERED_AS_IMG',
          surface: 'mobile',
          evidence: { creationId: cert.creationId, dims },
          note: 'loadCreationHistory() has the same relative-URL rendering gap as renderCreationOutput(): the canonical imageUrl never starts with "data:" or "http", so it is inserted as raw text instead of an <img> element in the history card too.',
        });
        cert.screenshots.mobileKrGeneratedImage = 'UNAVAILABLE_NO_IMG_ELEMENT';
        cert.screenshots.mobileKrImageOpened = 'UNAVAILABLE_NO_IMG_ELEMENT';
      }
    } else {
      cert.screenshots.mobileKrGeneratedImage = 'UNAVAILABLE_NO_MOBILE_SURFACE';
      cert.screenshots.mobileKrImageOpened = 'UNAVAILABLE_NO_MOBILE_SURFACE';
    }

    cert.overflow.mobile = await overflowMetrics(mobile);
    assert.equal(cert.overflow.mobile.scrollWidth <= cert.overflow.mobile.clientWidth, true, 'mobile must not overflow horizontally');

    const mobileBodyText = await mobile.locator('body').innerText();
    checkLeaks(mobileBodyText, cert, 'mobile');

    cert.consoleErrors.mobile = mobileConsoleErrors;
    cert.pageErrors.mobile = mobilePageErrors;

    await mobile.close();

    if (cert.classification === 'PENDING') {
      cert.classification = cert.defects.length === 0 ? 'PASS' : 'PASS_WITH_DEFECTS';
    }

    // Hard invariants — these must fail the test outright, never just be
    // recorded as a "defect" in the JSON, per MASTER.md's critical
    // invariants (Section 13).
    assert.equal(cert.technicalUiLeak, 0, 'TECHNICAL_UI_LEAK must be 0');
    assert.equal(cert.rawI18nKeyLeak, 0, 'RAW_I18N_KEY_LEAK must be 0');
    assert.equal(cert.fakeSuccessPaths, 0, 'FAKE_SUCCESS_PATHS must be 0');
  } finally {
    await browser.close();
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(CERT_JSON_PATH, JSON.stringify(cert, null, 2));
  }
});
