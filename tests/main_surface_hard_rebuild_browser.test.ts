import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const getComputedStyle: any;

let h: CanvasAskHarness;

before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const screenshotDir = path.join(process.cwd(), 'artifacts', 'visual-cert', 'main-hard-rebuild');

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nagex-main-surface', { timeout: 20000 });
}

async function installVoiceMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__nagexVoiceTranscript = '안녕하세요 네이젝스';
    (window as any).__nagexVoicePermission = 'granted';
    (window as any).__nagexVoiceMediaUnavailable = false;
    (window as any).__nagexVoiceTrackStopped = false;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if ((window as any).__nagexVoiceMediaUnavailable) {
            throw Object.assign(new Error('missing mic'), { name: 'NotFoundError' });
          }
          if ((window as any).__nagexVoicePermission === 'denied') {
            throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          }
          return { getTracks: () => [{ stop() { (window as any).__nagexVoiceTrackStopped = true; } }] };
        },
      },
    });
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => ({ state: (window as any).__nagexVoicePermission }) },
    });
    class FakeSpeechRecognition {
      lang = '';
      interimResults = false;
      continuous = false;
      resultIndex = 0;
      onstart: any = null;
      onresult: any = null;
      onend: any = null;
      onerror: any = null;
      start() {
        setTimeout(() => {
          this.onstart?.();
          const transcript = (window as any).__nagexVoiceTranscript || 'voice input';
          const result: any = [{ transcript }];
          result.isFinal = true;
          this.onresult?.({ resultIndex: 0, results: [result] });
          this.onend?.();
        }, 20);
      }
      stop() { this.onend?.(); }
    }
    (window as any).SpeechRecognition = FakeSpeechRecognition;
    (window as any).webkitSpeechRecognition = FakeSpeechRecognition;
  });
}

describe('NAgex Main surface hard rebuild', () => {
  it('keeps Main surface assets in the frontend build-version and no-cache set', () => {
    const server = fs.readFileSync('src/server_web.ts', 'utf8');
    for (const asset of ['main-surface.js', 'main-surface-rearchitecture.css', 'renderer-voice-adapter.js']) {
      assert.match(server, new RegExp(`MUTABLE_FRONTEND_FILES[\\s\\S]*${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(server, new RegExp(`createBuildVersion[\\s\\S]*${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  it('replaces legacy Home with canonical Main, keeps voice functional, and avoids assistant modal execution', async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const user = h.user('main_hard_rebuild');
    const seeded = h.seedDocument(user, {
      title: '한국 생성형 AI 시장 동향 보고서 v1.docx',
      content: '한국 생성형 AI 시장은 빠르게 성장하고 있습니다. 주요 기업, 투자 동향, 산업별 활용 사례, 향후 전망을 요약합니다.',
      revision: 1,
    });
    const ctx = await h.newContext('desktop', user, 'ko');
    const page = await ctx.newPage();
    await installVoiceMocks(page);
    await openMain(page);

    assert.equal(await page.locator('#view-home[data-main-surface="1"]').count(), 1);
    assert.equal(await page.locator('#home-section-create').count(), 0);
    assert.equal(await page.locator('#home-recent-results').count(), 0);
    assert.equal(await page.locator('#assistant-modal, #ambient-assistant-overlay, .ambient-assistant-overlay').count(), 0);
    assert.equal(await page.locator('#main-model-select').count(), 0);
    assert.equal(await page.locator('#nagex-main-surface').getByText(/GPT|Claude|Gemini|model/i).count(), 0);
    assert.equal(await page.locator('#main-bottom-tray, #main-tray-toggle, #main-count-today, #main-count-activity, #main-count-suggestions').count(), 0);
    assert.equal(await page.locator('[data-main-mode="ASK"][aria-pressed="true"]').count(), 1);
    assert.equal(await page.locator('#btn-floating-quickwake').evaluate((el) => getComputedStyle(el).display === 'none'), true);
    assert.equal(await page.locator('#main-mic').isEnabled(), true);
    assert.equal(await page.locator('#main-voice').isEnabled(), true);
    assert.equal(await page.locator('#nagex-main-surface').getByText(/Telegram/i).count(), 0);
    assert.equal(await page.locator('.nav-menu .nav-item[data-tab="tab-create"]').evaluate((el) => getComputedStyle(el).display === 'none'), true);
    assert.equal(await page.locator('.nav-menu .nav-item[data-tab="tab-canvas"]').evaluate((el) => getComputedStyle(el).display === 'none'), true);

    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = '한국 생성형 AI 시장 조사'; });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value.includes('한국 생성형 AI 시장 조사'));
    assert.equal(await page.evaluate(() => (window as any).__nagexVoiceTrackStopped), true);

    await page.fill('#main-surface-input', '기존 요청');
    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = '일본 시장과 비교해줘'; });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value.includes('기존 요청 일본 시장과 비교해줘'));

    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = 'Compare the Japanese market too'; });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value.includes('Compare the Japanese market too'));

    await page.evaluate(() => { (window as any).__nagexVoicePermission = 'denied'; });
    await page.click('#main-mic');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Voice input unavailable'));

    await page.evaluate(() => {
      (window as any).__nagexVoicePermission = 'granted';
      (window as any).__nagexVoiceMediaUnavailable = true;
    });
    await page.click('#main-mic');
    await page.waitForFunction(() => document.querySelector('#main-work-summary')?.textContent?.includes('Voice input failed'));
    await page.evaluate(() => { (window as any).__nagexVoiceMediaUnavailable = false; });

    await page.fill('#main-surface-input', '');
    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = '음성으로 계획을 세워줘'; });
    await page.click('#main-voice');
    await page.waitForSelector('#main-thread-card:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#main-request-text')?.textContent?.includes('음성으로 계획을 세워줘'));

    await page.fill('#main-surface-input', '한국의 생성형 AI 시장 동향을 조사해서 보고서로 만들어줘. 최근 1년간의 주요 기업, 투자 동향, 산업별 활용 사례, 향후 전망을 포함해줘.');
    const height = await page.locator('#main-surface-input').evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(height > 90, `composer must grow for long input, got ${height}`);
    await page.screenshot({ path: path.join(screenshotDir, 'desktop-long-input.png'), fullPage: true });

    await page.click('[data-main-mode="PLAN"]');
    await page.click('#main-send');
    await page.waitForSelector('#main-thread-card:not([hidden])', { timeout: 30000 });
    await page.screenshot({ path: path.join(screenshotDir, 'desktop-working.png'), fullPage: true });
    assert.equal(await page.locator('[role="dialog"]:visible').count(), 0);

    const opened = await page.evaluate((artifactId: string) => window.NAGEX_MAIN_SURFACE.openArtifactResult(artifactId), seeded.artifactId);
    assert.equal(opened, true);
    await page.waitForSelector('#main-result-panel:not([hidden])');
    await page.screenshot({ path: path.join(screenshotDir, 'desktop-result-panel.png'), fullPage: true });
    await page.click('#main-result-expand');
    await page.waitForFunction(() => document.body.classList.contains('main-result-fullscreen'));
    await page.screenshot({ path: path.join(screenshotDir, 'desktop-fullscreen-result.png'), fullPage: true });
    await page.click('#main-result-expand');

    await page.click('#main-result-revise');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Describe the revision'));
    await page.fill('#main-surface-input', '요약 문장을 더 간결하게 만들어줘.');
    await page.click('#main-send');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Document revision could not be created') || document.querySelector('#main-work-title')?.textContent?.includes('Document revised'), undefined, { timeout: 30000 });

    const routeDecision = await page.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/route-input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '테스트 중이야' }),
      });
      return res.json();
    });
    assert.equal(((routeDecision as any).data || routeDecision as any).primaryIntent, 'ASK');

    await page.click('#btn-notif-bell');
    await page.waitForSelector('#attention-popover:not([hidden])');
    await page.screenshot({ path: path.join(screenshotDir, 'desktop-attention-bell.png'), fullPage: true });
    const matrix = await page.evaluate(() => window.NAGEX_MAIN_SURFACE.getControlMatrix());
    assert.ok(matrix.length >= 10);
    await ctx.close();
  });

  it('keeps the result viewer usable on a representative mobile viewport', async () => {
    const user = h.user('main_mobile');
    const seeded = h.seedDocument(user, {
      title: 'Mobile result',
      content: 'Mobile result preview content from the real artifact and document stores.',
      revision: 1,
    });
    const ctx = await h.newContext('mobile', user, 'ko');
    const page = await ctx.newPage();
    await openMain(page);
    await page.evaluate((artifactId: string) => window.NAGEX_MAIN_SURFACE.openArtifactResult(artifactId), seeded.artifactId);
    await page.waitForSelector('#main-result-panel:not([hidden])');
    await page.click('#main-result-expand');
    await page.waitForFunction(() => document.body.classList.contains('main-result-fullscreen'));
    const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
    assert.ok(overflow <= 4, `mobile horizontal overflow ${overflow}`);
    await page.screenshot({ path: path.join(screenshotDir, 'mobile-fullscreen-result.png'), fullPage: true });
    await ctx.close();
  });
});
