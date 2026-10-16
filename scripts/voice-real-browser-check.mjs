#!/usr/bin/env node
// Real-browser voice check (NOT part of CI): the Main microphone button in a real branded browser (Chrome or Edge) with the browser's own speech service and the PC's real microphone.
//
//   npm run build && node scripts/voice-real-browser-check.mjs [--locale ko|en] [--channel chrome|msedge] [--seconds 25] [--say "text"]
//
// What it does: starts the production server in-process on isolated data directories (tests/_setup.js), opens Main as a disposable signed-in user, clicks the microphone, answers NAgex's own
// consent prompt ("Allow Google speech" - the same click a person makes; the browser sends the audio to its vendor), then listens for what the real microphone hears and prints what reached the box.
//   --say "text"  (Windows) speaks that text through the PC's speakers with an installed Windows voice, so a microphone that hears the speakers gives a hands-free, repeatable run.
//                 Without it, speak into the microphone yourself.
// It checks that nothing was submitted by the end of recognition and that the microphone was released. It never approves or sends anything.
// The browser's speech engine is the vendor's cloud service: anything the microphone hears during the run is sent there (that is what the consent prompt says).
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const LOCALE = opt('locale', 'ko');
const CHANNEL = opt('channel', 'chrome');
const SECONDS = Number(opt('seconds', '25'));
const SAY = opt('say', '');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(ROOT, 'dist/tests/_setup.js'))) { console.error('Run "npm run build" first.'); process.exit(2); }
require(path.join(ROOT, 'dist/tests/_setup.js')); // isolated data directories: nothing of the real service is touched
const { startCanvasAskHarness } = require(path.join(ROOT, 'dist/tests/_canvas_ask_harness.js'));
const { chromium } = require('playwright');

function synthesize(text, locale) {
  if (process.platform !== 'win32') { console.error('--say needs Windows (System.Speech).'); process.exit(2); }
  const file = path.join(os.tmpdir(), `nagex-voice-check-${Date.now()}.wav`);
  const culture = locale === 'ko' ? 'ko-KR' : 'en-US';
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq '${culture}' } | Select-Object -First 1`,
    "if (-not $v) { Write-Error 'no installed voice for the language'; exit 3 }",
    '$s.SelectVoice($v.VoiceInfo.Name)',
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}')`,
    `$s.Speak('${text.replace(/'/g, "''")}')`,
    '$s.Dispose()',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr || 'speech synthesis failed'); process.exit(3); }
  return file;
}

function play(file) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], { stdio: 'ignore' });
}

const wav = SAY ? synthesize(SAY, LOCALE) : '';
const h = await startCanvasAskHarness({ scrubProviders: true });
const user = h.user('voice_real_check');
if (LOCALE === 'ko') h.setLocale(user, 'ko');
const base = await h.newContext('desktop', user, LOCALE);
const cookies = await base.cookies();
await base.close();

// the real microphone: only the permission prompt is auto-accepted (the page still asks through getUserMedia)
const browser = await chromium.launch({ channel: CHANNEL, headless: false, args: ['--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: LOCALE === 'ko' ? 'ko-KR' : 'en-US' });
await ctx.addCookies(cookies);
await ctx.addInitScript((l) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, LOCALE);
const page = await ctx.newPage();
const posts = [];
page.on('request', (r) => { if (r.method() !== 'GET') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#main-mic');

const read = async () => ({
  voiceState: await page.locator('#nagex-main-surface').getAttribute('data-voice-state'),
  status: await page.locator('#main-voice-status').innerText(),
  notice: (await page.locator('#main-composer-notice').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220),
  box: await page.inputValue('#main-surface-input'),
});

await page.click('#main-mic');
await page.waitForTimeout(1500);
const allow = page.locator('#main-composer-notice button', { hasText: /Allow .* speech|음성 인식 허용/ }).first();
if (await allow.count()) await allow.click();
await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'LISTENING', undefined, { timeout: 15000 }).catch(() => {});
const afterStart = await read();
console.log('listening:', JSON.stringify(afterStart));
if (wav) { await page.waitForTimeout(800); play(wav); }
else console.log(`speak now (${SECONDS}s)...`);

const started = Date.now();
let last = '';
while (Date.now() - started < SECONDS * 1000) {
  await page.waitForTimeout(500);
  const s = await read();
  if (s.box !== last) { last = s.box; console.log('box:', JSON.stringify(s.box)); }
  if (s.voiceState === 'IDLE' || s.voiceState === 'ERROR') break;
}
if ((await read()).voiceState === 'LISTENING') { await page.click('#main-mic'); await page.waitForTimeout(2500); }
const final = await read();
const submitted = posts.filter((p) => /ai\/chat|ambient\/intent|route-input|creations|research|tasks|approvals/.test(p));
console.log('result:', JSON.stringify({ ...final, requestedByEndOfRecognition: submitted }));
await browser.close();
await h.close();
if (wav) try { fs.unlinkSync(wav); } catch { /* temp file */ }
process.exit(final.box && submitted.length === 0 ? 0 : 1);
