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
    (window as any).__nagexVoiceError = null;
    (window as any).__nagexVoiceEvents = null;
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
          if ((window as any).__nagexVoiceError) {
            this.onerror?.({ error: (window as any).__nagexVoiceError });
            this.onend?.();
            return;
          }
          const scriptedEvents = (window as any).__nagexVoiceEvents;
          const events = Array.isArray(scriptedEvents) && scriptedEvents.length
            ? scriptedEvents
            : [{ transcript: (window as any).__nagexVoiceTranscript || 'voice input', isFinal: true, resultIndex: 0 }];
          for (const entry of events) {
            const result: any = [{ transcript: entry.transcript || '', confidence: entry.confidence ?? 0.91 }];
            result.isFinal = Boolean(entry.isFinal);
            this.onresult?.({ resultIndex: entry.resultIndex ?? 0, results: [result] });
          }
          this.onend?.();
        }, 20);
      }
      stop() { this.onend?.(); }
    }
    (window as any).SpeechRecognition = FakeSpeechRecognition;
    (window as any).webkitSpeechRecognition = FakeSpeechRecognition;
  });
}

async function expectInlineVoiceNotice(page: Page, pattern: RegExp): Promise<void> {
  await page.waitForSelector('#main-composer-notice:not([hidden])');
  assert.match(await page.locator('#main-composer-notice').textContent() || '', pattern);
  const surfaceText = await page.locator('#nagex-main-surface').textContent();
  assert.doesNotMatch(surfaceText || '', /NO_TRANSCRIPT|RendererVoiceAdapter|Microphone opened|Speech recognition ended|Voice input unavailable|No speech captured/);
}

describe('NAgex Main surface hard rebuild', () => {
  it('keeps Main surface assets in the frontend build-version and no-cache set', () => {
    const server = fs.readFileSync('src/server_web.ts', 'utf8');
    for (const asset of ['main-surface.js', 'main-surface-rearchitecture.css', 'renderer-voice-adapter.js']) {
      assert.match(server, new RegExp(`MUTABLE_FRONTEND_FILES[\\s\\S]*${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(server, new RegExp(`createBuildVersion[\\s\\S]*${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    const voiceAdapter = fs.readFileSync('public/renderer-voice-adapter.js', 'utf8');
    assert.match(voiceAdapter, /window\.location && window\.location\.protocol === 'https:'[\s\S]*'whisper-local'/);
    assert.match(voiceAdapter, /window\.NAGEX_STT_BACKEND !== 'browser'/);
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
    const firstVoiceDiagnostic = await page.evaluate(() => (window as any).__NAGEX_LAST_VOICE_DIAGNOSTIC);
    assert.equal(firstVoiceDiagnostic.transcriptPresent, true);
    assert.equal(firstVoiceDiagnostic.alternativePresent, true);
    assert.equal(firstVoiceDiagnostic.alternativeCount, 1);
    assert.equal(firstVoiceDiagnostic.rawTranscriptType, 'string');
    assert.ok(firstVoiceDiagnostic.rawTranscriptLength >= firstVoiceDiagnostic.transcriptLength);
    assert.equal(firstVoiceDiagnostic.confidencePresent, true);
    assert.equal(firstVoiceDiagnostic.isFinal, true);
    assert.equal(firstVoiceDiagnostic.callbackDelivered, true);
    assert.ok(firstVoiceDiagnostic.transcriptLength > 0);

    await page.fill('#main-surface-input', '');
    await page.evaluate(() => {
      (window as any).__nagexVoiceEvents = [
        { transcript: 'interim text', isFinal: false },
        { transcript: 'final text', isFinal: true },
      ];
    });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value === 'final text');
    await page.evaluate(() => { (window as any).__nagexVoiceEvents = null; });

    await page.fill('#main-surface-input', '');
    await page.evaluate(() => {
      (window as any).__nagexVoiceEvents = [
        { transcript: '', isFinal: true },
      ];
    });
    await page.click('#main-mic');
    await expectInlineVoiceNotice(page, /didn't catch|Try again/i);
    await page.evaluate(() => { (window as any).__nagexVoiceEvents = null; });

    await page.fill('#main-surface-input', '');
    await page.evaluate(() => {
      (window as any).__nagexVoiceEvents = [
        { transcript: 'duplicate guard', isFinal: true },
        { transcript: 'duplicate guard', isFinal: true },
      ];
    });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value === 'duplicate guard');
    await page.evaluate(() => { (window as any).__nagexVoiceEvents = null; });

    await page.fill('#main-surface-input', 'existing');
    await page.evaluate(() => {
      (window as any).NAGEX_STT_MAX_RECORD_MS = 1;
      window.localStorage.setItem('nagex_stt_backend', 'whisper-local');
      (window as any).__originalFetch = window.fetch;
      window.fetch = async (url: any, options: any) => {
        if (String(url).includes('127.0.0.1:4760/transcribe')) {
          const body = options && options.body;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              transcript: '위스퍼 테스트',
              transcriptLength: 6,
              durationSeconds: 1,
              latencyMs: 120,
              peakRssMb: 70,
              receivedAudio: Boolean(body),
            }),
          } as any;
        }
        return (window as any).__originalFetch(url, options);
      };
      class FakeAudioContext {
        sampleRate = 16000;
        destination = {};
        createMediaStreamSource() { return { connect() {} }; }
        createScriptProcessor() {
          const processor: any = { connect() {}, disconnect() {}, onaudioprocess: null };
          setTimeout(() => {
            if (processor.onaudioprocess) {
              processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(16000) } });
            }
          }, 0);
          return processor;
        }
        close() { return Promise.resolve(); }
      }
      (window as any).AudioContext = FakeAudioContext;
      (window as any).webkitAudioContext = FakeAudioContext;
    });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value === 'existing 위스퍼 테스트');
    const whisperDiagnostic = await page.evaluate(() => (window as any).__NAGEX_LAST_VOICE_DIAGNOSTIC);
    assert.equal(whisperDiagnostic.detail.backend, 'whisper-local');
    assert.equal(whisperDiagnostic.transcriptPresent, true);
    await page.evaluate(() => {
      window.localStorage.removeItem('nagex_stt_backend');
      delete (window as any).NAGEX_STT_MAX_RECORD_MS;
      if ((window as any).__originalFetch) window.fetch = (window as any).__originalFetch;
    });

    await page.fill('#main-surface-input', '기존 요청');
    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = '일본 시장과 비교해줘'; });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value.includes('기존 요청 일본 시장과 비교해줘'));

    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = 'Compare the Japanese market too'; });
    await page.click('#main-mic');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value.includes('Compare the Japanese market too'));

    await page.evaluate(() => { (window as any).__nagexVoicePermission = 'denied'; });
    await page.click('#main-mic');
    await expectInlineVoiceNotice(page, /permission/i);
    assert.notEqual(await page.locator('#main-request-text').textContent().catch(() => ''), 'Voice input');

    await page.evaluate(() => {
      (window as any).__nagexVoicePermission = 'granted';
      (window as any).__nagexVoiceMediaUnavailable = true;
    });
    await page.click('#main-mic');
    await expectInlineVoiceNotice(page, /failed|unavailable|supported browser/i);
    await page.evaluate(() => { (window as any).__nagexVoiceMediaUnavailable = false; });

    await page.evaluate(() => { (window as any).__nagexVoiceError = 'no-speech'; });
    await page.click('#main-mic');
    await expectInlineVoiceNotice(page, /didn't catch|Try again/i);
    await page.evaluate(() => { (window as any).__nagexVoiceError = 'network'; });
    await page.click('#main-mic');
    await expectInlineVoiceNotice(page, /unavailable|Try again/i);
    await page.evaluate(() => { (window as any).__nagexVoiceError = null; });

    await page.fill('#main-surface-input', '');
    await page.evaluate(() => { (window as any).__nagexVoiceTranscript = '음성으로 계획을 세워줘'; });
    const beforeVoiceRequest = await page.locator('#main-request-text').textContent().catch(() => '');
    await page.click('#main-voice');
    await page.waitForFunction(() => (document.querySelector('#main-surface-input') as any)?.value.includes('음성으로 계획을 세워줘'));
    const afterVoiceRequest = await page.locator('#main-request-text').textContent().catch(() => '');
    assert.equal(afterVoiceRequest, beforeVoiceRequest);

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

  it('audits all Main modes and routes enabled modes without clearing composer context', async () => {
    const user = h.user('main_mode_selector');
    const ctx = await h.newContext('desktop', user, 'ko');
    const page = await ctx.newPage();
    const calls: string[] = [];

    await page.route('**/api/v1/workspace/route-input', async (route) => {
      calls.push('route-input');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { primaryIntent: 'ASK', confidence: 0.91, reason: 'test route', normalizedPayload: { rawInput: 'x' } } }),
      });
    });
    await page.route('**/api/v1/ai/chat', async (route) => {
      calls.push('ask');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message: 'real answer path', messageId: 'msg_mode_1' } }) });
    });
    await page.route('**/api/v1/research', async (route) => {
      calls.push('research');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: 'q', answer: 'research answer', sources: [{ url: 'https://example.test', title: 'Source' }] }) });
    });
    await page.route('**/api/v1/creations/documents', async (route) => {
      calls.push('document');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ creationId: 'doc_mode_1', documentId: 'doc_mode_1', artifactId: 'art_doc_mode_1', title: 'Document result', content: 'document body', format: 'MARKDOWN', openTarget: '/api/v1/creations/documents/doc_mode_1' }),
      });
    });
    await page.route('**/api/v1/ambient/intent', async (route) => {
      calls.push('plan');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plan: { summary: 'Plan ready', steps: [{ title: 'Check context', reasoning: 'Needed' }, { title: 'Execute safely', reasoning: 'Approval if needed' }] } }),
      });
    });
    await page.route('**/api/v1/creations/generate', async (route) => {
      calls.push('image');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ creationId: 'img_mode_1', artifactId: 'art_img_mode_1', type: 'IMAGE', title: 'Image result', prompt: 'image prompt', imageUrl: '/api/v1/creations/images/img_mode_1', outputAssetUrl: '/api/v1/creations/images/img_mode_1', mimeType: 'image/png' }),
      });
    });

    await openMain(page);
    assert.equal(await page.locator('[data-main-mode]').count(), 9);
    for (const enabledMode of ['ASK', 'RESEARCH', 'DOCUMENT', 'PLAN', 'IMAGE', 'MORE']) {
      await page.fill('#main-surface-input', `draft ${enabledMode}`);
      await page.click(`[data-main-mode="${enabledMode}"]`);
      assert.equal(await page.locator('#main-surface-input').inputValue(), `draft ${enabledMode}`);
      assert.equal(await page.locator(`[data-main-mode="${enabledMode}"]`).getAttribute('aria-pressed'), 'true');
    }
    for (const disabledMode of ['SLIDES', 'VIDEO', 'CODE']) {
      assert.equal(await page.locator(`[data-main-mode="${disabledMode}"]`).isDisabled(), true);
      assert.equal(await page.locator(`[data-main-mode="${disabledMode}"]`).getAttribute('aria-disabled'), 'true');
    }

    await page.fill('#main-surface-input', 'ask prompt');
    await page.click('[data-main-mode="ASK"]');
    await page.click('#main-send');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('NAgex answered inline'));

    await page.fill('#main-surface-input', 'research prompt');
    await page.click('[data-main-mode="RESEARCH"]');
    await page.click('#main-send');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Research result'));

    await page.fill('#main-surface-input', 'document prompt');
    await page.click('[data-main-mode="DOCUMENT"]');
    await page.click('#main-send');
    await page.waitForSelector('#main-result-panel:not([hidden])');
    assert.equal(await page.locator('#main-result-kind').textContent(), 'DOC');

    await page.fill('#main-surface-input', 'plan prompt');
    await page.click('[data-main-mode="PLAN"]');
    await page.click('#main-send');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Plan ready'));

    await page.fill('#main-surface-input', 'image prompt');
    await page.click('[data-main-mode="IMAGE"]');
    await page.click('#main-send');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Image created'));
    assert.equal(await page.locator('#main-result-kind').textContent(), 'IMAGE');
    assert.equal(await page.locator('#main-result-preview img').count(), 1);

    await page.fill('#main-surface-input', 'show capabilities');
    await page.click('[data-main-mode="MORE"]');
    await page.click('#main-send');
    await page.waitForFunction(() => document.querySelector('#main-work-title')?.textContent?.includes('Main mode capability audit'));
    assert.equal(await page.locator('#main-result-panel').isHidden(), true);

    await page.focus('[data-main-mode="ASK"]');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-main-mode')), 'RESEARCH');

    for (const expected of ['ask', 'research', 'document', 'plan', 'image']) {
      assert.ok(calls.includes(expected), `${expected} route must be called`);
    }
    await ctx.close();
  });
});
