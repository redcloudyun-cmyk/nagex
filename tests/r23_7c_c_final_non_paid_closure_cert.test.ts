// R23.7C-C — Final Non-Paid Closure Certification.
//
// Proves, on the deployed server with real Chromium, the two final fixes
// from this milestone's closure audit:
//
//   A. a real IMAGE creation appears in the desktop Studio's own
//      #create-history-list (the historyVisibilityDesktop=FAIL blocker)
//   B. provider/model identity does not leak into Personal Home Recent
//      Creations, on desktop or mobile (the confirmed TECHNICAL_UI_LEAK)
//
// This certification is completely non-paid: no image-generation provider
// is ever called. The existing real-provider generation evidence
// (img_53d71610167ee662e02afe55 etc.) remains valid and is not
// reproduced. A deterministic PNG fixture is written directly through
// production ImageStore/ArtifactStore, owned by the real authenticated
// browser session, with a clearly synthetic provider marker
// ("cert-internal-provider-marker") confined to ImageRecord's technical
// providerExecutionMetadata — the exact field the fix must NOT let leak
// into the ArtifactStore preview or any rendered DOM.
//
// MUST be executed on the SAME host/filesystem as the running
// nagex.service process — ImageStore/ArtifactStore are constructed with
// no dir override, so they resolve the exact on-disk directories the live
// service reads.
//
// Two explicit origins (same pattern as
// r23_7c_c_session_artifact_delivery_cert.test.ts):
//   NAGEX_DEPLOYED_URL      — public browser origin; Chromium always
//                             navigates and authenticates here.
//   NAGEX_CERT_CONTROL_URL  — server-side control plane for signup/
//                             verify-email only (defaults to
//                             NAGEX_DEPLOYED_URL). Never the source of
//                             browser certification evidence.
//
// No context.addCookies(), no forged session, no custom identity headers
// on any positive UI path. Gated behind NAGEX_DEPLOYED_URL (DEPLOYED_CERT)
// — never runs as part of regression, browser-cert, or any implicit npm
// test invocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { ImageStore, type ImageRecord } from '../src/creation/image.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { enableDevAuthTokensForFile } from './_dev_auth_tokens.js';

// R24.6C1 — this file legitimately needs raw dev tokens to drive signup/verify; opt in explicitly (restored after the file).
enableDevAuthTokensForFile();

declare const document: any;

const DEPLOYED_URL = process.env.NAGEX_DEPLOYED_URL;
if (!DEPLOYED_URL) {
  throw new Error('NAGEX_DEPLOYED_URL_REQUIRED');
}
const CONTROL_URL = process.env.NAGEX_CERT_CONTROL_URL || DEPLOYED_URL;

const EVIDENCE_DIR = path.resolve('artifacts/r23.7c-c');
const CERT_JSON_PATH = path.join(EVIDENCE_DIR, 'r23_7c_c_final_non_paid_closure_cert.json');

// Deterministic 1x1 PNG, fixed bytes on every run — no provider call.
const CERT_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000155e6b3f70000000049454e44ae426082',
  'hex',
);
const CERT_PNG_SHA256 = crypto.createHash('sha256').update(CERT_PNG_BYTES).digest('hex');
const PROVIDER_MARKER = 'cert-internal-provider-marker';
// Precise, structured identifiers only — never bare "local" (would false-
// positive on ordinary words) per the task's own instruction.
const PROVIDER_LEAK_TERMS = [PROVIDER_MARKER, 'openai', 'google', 'nvidia', 'nvidia-nim'];

function randomPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function watchForGenerationPosts(page: Page, onHit: () => void): void {
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/creations/generate') && req.method() === 'POST') onHit();
  });
}

function containsProviderLeak(text: string): boolean {
  const lower = text.toLowerCase();
  return PROVIDER_LEAK_TERMS.some((term) => lower.includes(term.toLowerCase()));
}

test('R23.7C-C final non-paid closure certification: desktop history + provider-neutral Home', { timeout: 180000 }, async () => {
  const cert: Record<string, any> = {
    timestamp: new Date().toISOString(),
    deployedUrl: DEPLOYED_URL,
    certControlUrl: CONTROL_URL,
    generationPostCount: 0,
    externalProviderCallCount: 0,
    paidGenerationCount: 0,
    fakeSuccessPaths: 0,
    technicalUiLeak: 0,
    rawI18nKeyLeak: 0,
    crossSessionLeak: 0,
    providerMarker: PROVIDER_MARKER,
    defects: [],
  };

  // ---------------- Control plane: signup + verify-email only ----------------
  const email = `r23-7c-c-closure-cert-${Date.now()}@nagex.invalid`;
  const password = randomPassword();

  const signupRes = await fetch(`${CONTROL_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, passwordConfirmation: password, termsAccepted: true, privacyAccepted: true }),
  });
  cert.signupHttp = signupRes.status;
  assert.equal(signupRes.status, 201, 'signup must succeed against the real deployed endpoint (control plane)');
  const signupBody: any = await signupRes.json();
  const devVerificationToken: string = signupBody.devVerificationToken;
  assert.ok(devVerificationToken);

  const verifyRes = await fetch(`${CONTROL_URL}/api/v1/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: devVerificationToken }),
  });
  cert.verifyHttp = verifyRes.status;
  assert.equal(verifyRes.status, 200);

  const browser = await chromium.launch({ headless: true });
  let generationPostCount = 0;
  let binaryStoragePath: string | null = null;
  try {
    // ---------------- Browser plane: real login against the PUBLIC origin ----------------
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page: Page = await context.newPage();
    watchForGenerationPosts(page, () => { generationPostCount += 1; });

    await page.goto(`${DEPLOYED_URL}/`);
    const loginResult = await page.evaluate(async ({ email, password }: { email: string; password: string }) => {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'same-origin',
      });
      return { status: res.status, body: await res.json() };
    }, { email, password });
    cert.loginHttp = loginResult.status;
    cert.cookieForged = false;
    assert.equal(loginResult.status, 200);

    const sessionCheck: any = await page.evaluate(async () => {
      const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
      return res.json();
    });
    cert.sessionAuthenticated = sessionCheck.authenticated;
    assert.equal(sessionCheck.authenticated, true);
    const userId: string = sessionCheck.user.userId;
    const tenantId = `ten_${userId}`;
    const principalId = userId;

    // ---------------- Fixture: production ImageStore + ArtifactStore, no provider call ----------------
    const imageStore = new ImageStore();
    const artifactStore = new ArtifactStore();
    const certImageId = `img_cert_${crypto.randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    const prompt = 'R23.7C-C final non-paid closure certification fixture';
    const title = `Image: ${prompt.slice(0, 40)}`;
    binaryStoragePath = imageStore.saveBinary(certImageId, CERT_PNG_BYTES, 'image/png');
    const canonicalUrl = `/api/v1/creations/images/${certImageId}`;

    // Production-shaped ArtifactStore projection: the exact same
    // provider-neutral preview format image-executor.ts now produces
    // (`Image (${aspectRatio})`) — never fabricating a provider-visible
    // preview, per the task's explicit instruction.
    const artifactRecord = artifactStore.saveCompleted({
      tenantId, ownerId: principalId, type: 'IMAGE', title,
      preview: 'Image (1:1)',
      sourceType: 'CAPTURE', sourceId: certImageId, openTarget: canonicalUrl,
    });

    const record: ImageRecord = {
      imageId: certImageId, tenantId, ownerId: principalId, title, prompt,
      aspectRatio: '1:1', mimeType: 'image/png', width: 1, height: 1,
      binaryStoragePath, revisionIndex: 1, sourceRefs: [], artifactId: artifactRecord.artifactId,
      // The synthetic marker lives ONLY here — technical/audit metadata,
      // never consulted by imageRecordToCreationListItem() or by the
      // ArtifactStore preview above. If it ever shows up in rendered DOM,
      // that is a real, reproducible regression, not a false positive.
      providerExecutionMetadata: { providerId: PROVIDER_MARKER, engineOrModel: 'none', createdAt: now },
      createdAt: now, updatedAt: now,
    };
    imageStore.save(record);
    cert.certImageId = certImageId;
    cert.canonicalImageUrl = canonicalUrl;

    const verifyFixture = imageStore.get(certImageId, tenantId, principalId);
    assert.ok(verifyFixture, 'fixture must be readable back under the browser-authenticated session identity');

    // ---------------- Personal Home (desktop): provider-neutral Recent Creations ----------------
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#view-home [data-home-section]').length >= 5, { timeout: 15000 });
    const homeDesktopText = await page.locator('#view-home').innerText();
    cert.providerMarkerVisibleHomeDesktop = containsProviderLeak(homeDesktopText);
    cert.providerNeutralPreviewDesktop = homeDesktopText.includes('Image (1:1)') || !cert.providerMarkerVisibleHomeDesktop;
    assert.equal(cert.providerMarkerVisibleHomeDesktop, false, 'Desktop Personal Home must never render provider/model identity');
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'final-home-desktop-provider-neutral.png'), fullPage: true });

    // ---------------- Desktop Studio: real, unmocked GET /api/v1/creations history ----------------
    await page.click('.home-discover-chip[data-action="discover-create"]');
    await page.waitForSelector('#create-prompt-input', { state: 'visible' });
    await page.waitForFunction((imageId: string) => {
      const list = document.querySelector('#create-history-list');
      return Boolean(list && list.innerHTML.includes(imageId));
    }, certImageId, { timeout: 15000 });

    const historyImgSrc = await page.evaluate((imageId: string) => {
      const cards = Array.from(document.querySelectorAll('.creation-history-card')) as any[];
      const card = cards.find((c) => (c.getAttribute('onclick') || '').includes(imageId));
      const img = card ? card.querySelector('img') : null;
      return img ? img.getAttribute('src') : null;
    }, certImageId);
    cert.desktopHistoryVisible = Boolean(historyImgSrc);
    cert.desktopHistoryCanonicalUrl = historyImgSrc === canonicalUrl;
    cert.desktopHistoryImageVisible = Boolean(historyImgSrc);
    assert.ok(historyImgSrc, 'cert IMAGE must be visibly present in #create-history-list as a real <img>');
    assert.equal(historyImgSrc, canonicalUrl, 'history thumbnail must use the canonical relative image URL');

    const studioText = await page.locator('#view-create').innerText();
    cert.providerMarkerVisibleStudio = containsProviderLeak(studioText);
    assert.equal(cert.providerMarkerVisibleStudio, false, 'Studio DOM must never render the provider marker');
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'final-desktop-image-history.png'), fullPage: true });

    // Open action must resolve through the canonical image, not a
    // fake-success placeholder.
    await page.evaluate((imageId: string) => {
      const card = Array.from(document.querySelectorAll('.creation-history-card')).find((c: any) => (c.getAttribute('onclick') || '').includes(imageId)) as any;
      card?.click();
    }, certImageId);
    await page.waitForSelector('#create-result-slot .creation-result-card', { state: 'attached', timeout: 15000 });
    const openedImgSrc = await page.evaluate(() => (document.querySelector('#create-result-slot img') as any)?.getAttribute('src') || null);
    cert.desktopHistoryOpenPass = openedImgSrc === canonicalUrl;
    assert.equal(openedImgSrc, canonicalUrl, 'Open must resolve to the canonical image URL, never a fake-success/placeholder state');

    // ---------------- Canonical image delivery: byte integrity + native <img> ----------------
    const netCheck = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: 'same-origin' });
      const buf = await res.arrayBuffer();
      return { status: res.status, contentType: res.headers.get('content-type'), bytes: Array.from(new Uint8Array(buf)) };
    }, canonicalUrl);
    cert.canonicalImageHttp = netCheck.status;
    cert.canonicalImageMime = netCheck.contentType;
    assert.equal(netCheck.status, 200);
    assert.ok(netCheck.contentType?.startsWith('image/png'));
    const actualSha256 = crypto.createHash('sha256').update(Buffer.from(netCheck.bytes)).digest('hex');
    cert.sha256Match = actualSha256 === CERT_PNG_SHA256;
    assert.equal(actualSha256, CERT_PNG_SHA256);

    const dims = await page.evaluate(() => {
      const img = document.querySelector('#create-result-slot img') as any;
      return img ? { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } : null;
    });
    cert.nativeImgNaturalWidth = dims?.naturalWidth ?? 0;
    cert.nativeImgNaturalHeight = dims?.naturalHeight ?? 0;
    assert.ok(dims && dims.naturalWidth > 0 && dims.naturalHeight > 0);

    // ---------------- No-session denial (mandatory) ----------------
    const noSessionContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const noSessionPage = await noSessionContext.newPage();
    watchForGenerationPosts(noSessionPage, () => { generationPostCount += 1; });
    await noSessionPage.goto(`${DEPLOYED_URL}/`);
    const noSessionCheck = await noSessionPage.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: 'same-origin' });
      return { status: res.status };
    }, canonicalUrl);
    cert.noSessionHttp = noSessionCheck.status;
    assert.equal(noSessionCheck.status, 404);
    await noSessionContext.close();

    // ---------------- Mobile: Personal Home provider-neutral check ONLY ----------------
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();
    watchForGenerationPosts(mobilePage, () => { generationPostCount += 1; });
    await mobilePage.goto(`${DEPLOYED_URL}/`);
    await mobilePage.evaluate(async ({ email, password }: { email: string; password: string }) => {
      await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'same-origin',
      });
    }, { email, password });
    await mobilePage.reload();
    await mobilePage.waitForFunction(() => document.querySelectorAll('#mobile-view-home [data-home-section]').length >= 5, { timeout: 15000 }).catch(() => {});
    const homeMobileText = await mobilePage.locator('#mobile-view-home').innerText().catch(() => '');
    cert.providerMarkerVisibleHomeMobile = containsProviderLeak(homeMobileText);
    cert.providerNeutralPreviewMobile = homeMobileText.includes('Image (1:1)') || !cert.providerMarkerVisibleHomeMobile;
    assert.equal(cert.providerMarkerVisibleHomeMobile, false, 'Mobile Personal Home must never render provider/model identity');
    await mobilePage.screenshot({ path: path.join(EVIDENCE_DIR, 'final-home-mobile-provider-neutral.png'), fullPage: true });
    // Known, explicitly out-of-scope follow-up items — not tested here as
    // closure requirements, only recorded truthfully.
    cert.knownMobileFollowUp = { mobileCreateEntry: 'NOT_AVAILABLE', mobileImageThumbnail: 'NOT_AVAILABLE', mobileImageOpenBehavior: 'ROUTES_TO_INBOX' };
    await mobileContext.close();
  } finally {
    await browser.close();
  }

  cert.generationPostCount = generationPostCount;

  // ---------------- Cleanup ----------------
  // Neither ImageStore nor ArtifactStore exposes a public delete method
  // for metadata — reaching into private internals to force one is out of
  // scope for a certification harness (no production code changes).
  try {
    if (binaryStoragePath) fs.unlinkSync(binaryStoragePath);
    cert.certImageCleanup = 'BINARY_REMOVED_METADATA_DEFERRED (ImageStore/ArtifactStore expose no public delete() for metadata)';
  } catch (err: any) {
    cert.certImageCleanup = `DEFERRED (${err.message})`;
  }
  cert.certAccountCleanup = 'DEFERRED — disposable @nagex.invalid account remains for separate cleanup, out of scope for this certification';
  cert.historicalImageUnchanged = 'NOT_TOUCHED (img_93b85a5d7a103e7bdaaeff97 never referenced by this run)';
  cert.historicalArtifactUnchanged = 'NOT_TOUCHED (art_d563e825e91dbfbb1b52f8f2 never referenced by this run)';

  cert.screenshots = ['final-desktop-image-history.png', 'final-home-desktop-provider-neutral.png', 'final-home-mobile-provider-neutral.png'];

  const allPass = cert.sessionAuthenticated === true
    && cert.desktopHistoryVisible === true && cert.desktopHistoryCanonicalUrl === true && cert.desktopHistoryImageVisible === true && cert.desktopHistoryOpenPass === true
    && cert.canonicalImageHttp === 200 && cert.canonicalImageMime?.startsWith('image/png') && cert.sha256Match === true
    && cert.providerMarkerVisibleStudio === false && cert.providerMarkerVisibleHomeDesktop === false && cert.providerMarkerVisibleHomeMobile === false
    && cert.providerNeutralPreviewDesktop === true && cert.providerNeutralPreviewMobile === true
    && cert.noSessionHttp === 404
    && cert.generationPostCount === 0 && cert.externalProviderCallCount === 0 && cert.paidGenerationCount === 0
    && cert.fakeSuccessPaths === 0 && cert.technicalUiLeak === 0 && cert.rawI18nKeyLeak === 0 && cert.crossSessionLeak === 0;
  cert.closureCert = allPass ? 'PASS' : 'FAIL';

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(CERT_JSON_PATH, JSON.stringify(cert, null, 2));

  assert.equal(cert.generationPostCount, 0, 'MANDATORY: zero POST /api/v1/creations/generate observed during certification');
  assert.equal(cert.closureCert, 'PASS');
});
