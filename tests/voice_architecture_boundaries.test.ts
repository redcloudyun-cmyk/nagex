import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { VoiceIdentityService } from '../src/voice/voice-identity.service.js';

// ADR-0013 — Universal Voice architecture. Pins the privacy, authorization and Voice Action invariants that hold today.
// It does not assert the open gaps listed in the ADR (Android recognizer locality, native Windows engine, iOS, Conversation loop).

const read = (file: string): string => fs.readFileSync(file, 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

// ── Runtime harness: executes the real renderer adapter in a sandbox with a scripted browser ──────────────────────
interface Harness {
  voice: any;
  counters: { micRequests: number; recognitionStarts: number; aborts: number; stops: number };
  storage: Map<string, string>;
  scripted: { events: Array<{ transcript: string; isFinal: boolean }> };
}

function loadAdapter(options: { ua: string; available?: (() => Promise<string>) | null; processLocally?: boolean }): Harness {
  const storage = new Map<string, string>();
  const counters = { micRequests: 0, recognitionStarts: 0, aborts: 0, stops: 0 };
  const scripted = { events: [{ transcript: '안녕하세요', isFinal: true }] };
  const withProcessLocally = options.processLocally !== false;

  class FakeRecognition {
    lang = '';
    onstart: any = null;
    onresult: any = null;
    onend: any = null;
    onerror: any = null;
    interimResults = false;
    continuous = false;
    maxAlternatives = 1;
    processLocally = false;
    constructor() {
      if (!withProcessLocally) delete (this as any).processLocally;
    }
    start() {
      counters.recognitionStarts += 1;
      setTimeout(() => this.onstart?.(), 0);
    }
    stop() {
      counters.stops += 1;
      for (const entry of scripted.events) {
        const result: any = [{ transcript: entry.transcript, confidence: 0.9 }];
        result.isFinal = entry.isFinal;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
      this.onend?.();
    }
    abort() {
      counters.aborts += 1;
      this.onend?.();
    }
  }
  if (options.available !== null) (FakeRecognition as any).available = options.available ?? (async () => 'unsupported');

  const window: any = {
    isSecureContext: true,
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    },
    navigator: {
      userAgent: options.ua,
      mediaDevices: { getUserMedia: async () => { counters.micRequests += 1; return { getTracks: () => [{ stop() {} }] }; } },
      permissions: { query: async () => ({ state: 'granted' }) },
    },
    SpeechRecognition: FakeRecognition,
    dispatchEvent() {},
    console: { info() {} },
    setTimeout,
    clearTimeout,
  };
  window.window = window;
  const sandbox: any = { window, navigator: window.navigator, CustomEvent: class {}, console: window.console, setTimeout, clearTimeout };
  vm.runInNewContext(read('public/renderer-voice-adapter.js'), sandbox);
  return { voice: window.NAGEX_RENDERER_VOICE, counters, storage, scripted };
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const EDGE_UA = `${CHROME_UA} Edg/155.0.0.0`;
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ELECTRON_UA = `${CHROME_UA} Electron/44.2.0`;

// ── Whisper prohibition ──────────────────────────────────────────────────────────────────────────────────────────

test('ADR-0013 W1. no active product source references Whisper or a hosted STT engine', () => {
  const roots = ['src', 'public', 'scripts', 'deploy'];
  const offenders: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of listFiles(root)) {
      if (!/\.(ts|tsx|js|mjs|cjs|html|json|sh|ps1|yml|yaml)$/.test(file)) continue;
      if (/whisper|faster-whisper|ggml-base|whisper-cli|NAGEX_WHISPER|server-whisper|whisper-local/i.test(read(file))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(read('package.json'), /whisper/i);
});

test('ADR-0013 W2. the retired server STT route never reads audio, starts a process or touches the filesystem', () => {
  const route = read('src/http/routes/stt.routes.ts');
  const imports = [...route.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['../http-types.js', '../request-identity.js']);
  assert.doesNotMatch(route, /child_process|spawn|exec\(|node:fs|node:os|tmpdir|writeFile|\bfetch\(|console\.|auditLogger/);
  assert.match(route, /tryGetCallerIdentity\(headers\)[\s\S]*AUTHENTICATION_REQUIRED/);
  assert.match(route, /410, 'SERVER_STT_DISABLED'/);
  assert.doesNotMatch(route, /\bbody\b\./); // the request body is never inspected
  assert.doesNotMatch(read('src/http/body-limit.ts'), /stt/);
});

// ── Processing-location policy (real adapter code, scripted browser) ────────────────────────────────────────────

test('ADR-0013 L1. browser SpeechRecognition is never assumed local: third-party unless the browser verifies on-device', async () => {
  const unknownLocation = loadAdapter({ ua: CHROME_UA });
  const processor = await unknownLocation.voice.resolveProcessor('ko-KR');
  assert.equal(processor.kind, 'THIRD_PARTY');
  assert.equal(processor.provider, 'google');
  assert.equal(processor.consentKey, 'third-party:google:v1');

  for (const availability of ['unavailable', 'downloadable', 'unknown-value']) {
    const harness = loadAdapter({ ua: CHROME_UA, available: async () => availability });
    const resolved = await harness.voice.resolveProcessor('ko-KR');
    assert.equal(resolved.kind, 'THIRD_PARTY', availability);
    assert.equal(resolved.localInstallable, availability === 'downloadable');
  }
  const throwing = loadAdapter({ ua: CHROME_UA, available: async () => { throw new Error('boom'); } });
  assert.equal((await throwing.voice.resolveProcessor('ko-KR')).kind, 'THIRD_PARTY');

  const verified = loadAdapter({ ua: CHROME_UA, available: async () => 'available' });
  const local = await verified.voice.resolveProcessor('ko-KR');
  assert.equal(local.kind, 'LOCAL');
  assert.equal(local.consentKey, undefined);
});

test('ADR-0013 L2. providers are identified specifically; unknown providers and the desktop runtime get no voice', async () => {
  assert.equal((await loadAdapter({ ua: EDGE_UA }).voice.resolveProcessor('ko-KR')).provider, 'microsoft');
  for (const [ua, reason] of [[FIREFOX_UA, 'PROVIDER_UNKNOWN'], [SAFARI_UA, 'PROVIDER_UNKNOWN'], [ELECTRON_UA, 'DESKTOP_RUNTIME_NO_STT']] as const) {
    const resolved = await loadAdapter({ ua }).voice.resolveProcessor('ko-KR');
    assert.equal(resolved.kind, 'NONE', ua);
    assert.equal(resolved.reason, reason, ua);
  }
});

test('ADR-0013 C1. no consent: nothing is recorded and the microphone is never opened', async () => {
  const harness = loadAdapter({ ua: CHROME_UA });
  const adapter = new harness.voice.RendererVoiceAdapter({});
  const result = await adapter.start({ lang: 'ko-KR' });
  assert.equal(result.state, 'CONSENT_REQUIRED');
  assert.equal(result.processor.provider, 'google');
  assert.equal(harness.counters.micRequests, 0);
  assert.equal(harness.counters.recognitionStarts, 0);
  assert.equal(adapter.isActive(), false);
});

test('ADR-0013 C2. consent is provider-specific, versioned and withdrawable; withdrawal blocks the next recording', async () => {
  const harness = loadAdapter({ ua: CHROME_UA });
  const { consent } = harness.voice;
  consent.grant('third-party:google:v1');
  assert.equal(consent.has('third-party:google:v1'), true);
  assert.equal(consent.has('third-party:microsoft:v1'), false);
  assert.equal(consent.has('third-party:google:v2'), false);

  const adapter = new harness.voice.RendererVoiceAdapter({});
  const running = adapter.start({ lang: 'ko-KR' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.counters.recognitionStarts, 1);
  await adapter.cancel();
  await running;

  consent.withdrawAll();
  assert.equal(consent.list().length, 0);
  const second = await new harness.voice.RendererVoiceAdapter({}).start({ lang: 'ko-KR' });
  assert.equal(second.state, 'CONSENT_REQUIRED');
  assert.equal(harness.counters.recognitionStarts, 1);
});

test('ADR-0013 C3. verified on-device recognition needs no consent; an unconfirmed processLocally is never claimed as local', async () => {
  const local = loadAdapter({ ua: CHROME_UA, available: async () => 'available' });
  const adapter = new local.voice.RendererVoiceAdapter({});
  const running = adapter.start({ lang: 'ko-KR' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(local.counters.recognitionStarts, 1);
  assert.equal(local.counters.micRequests, 1);
  await adapter.stop();
  const result = await running;
  assert.equal(result.processor.kind, 'LOCAL');
  assert.equal(local.voice.consent.list().length, 0);

  const unconfirmed = loadAdapter({ ua: CHROME_UA, available: async () => 'available', processLocally: false });
  const rejected = await new unconfirmed.voice.RendererVoiceAdapter({}).start({ lang: 'ko-KR' });
  assert.equal(rejected.state, 'UNAVAILABLE');
  assert.equal(rejected.reason, 'LOCAL_PROCESSING_NOT_VERIFIED');
  assert.equal(unconfirmed.counters.recognitionStarts, 0);
});

test('ADR-0013 R1. stop transcribes what was captured; cancel discards and delivers nothing', async () => {
  const stopHarness = loadAdapter({ ua: CHROME_UA, available: async () => 'available' });
  const delivered: string[] = [];
  const stopAdapter = new stopHarness.voice.RendererVoiceAdapter({ onTranscript: ({ transcript }: any) => delivered.push(transcript) });
  const stopped = stopAdapter.start({ lang: 'ko-KR' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stopHarness.scripted.events = [{ transcript: '정지 후 변환', isFinal: true }];
  await stopAdapter.stop();
  await stopAdapter.stop(); // a second stop must not submit twice
  const stopResult = await stopped;
  assert.equal(stopResult.state, 'COMPLETED');
  assert.equal(stopResult.transcript, '정지 후 변환');
  assert.deepEqual(delivered, ['정지 후 변환']);
  assert.equal(stopHarness.counters.stops, 1);

  const cancelHarness = loadAdapter({ ua: CHROME_UA, available: async () => 'available' });
  const cancelled: string[] = [];
  const cancelAdapter = new cancelHarness.voice.RendererVoiceAdapter({ onTranscript: ({ transcript }: any) => cancelled.push(transcript) });
  const running = cancelAdapter.start({ lang: 'ko-KR' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cancelAdapter.cancel();
  const cancelResult = await running;
  assert.equal(cancelResult.state, 'CANCELLED');
  assert.equal(cancelResult.transcript, '');
  assert.deepEqual(cancelled, []);
  assert.equal(cancelHarness.counters.aborts, 1);
  assert.equal(cancelAdapter.isActive(), false);
});

// ── Source-level privacy invariants ──────────────────────────────────────────────────────────────────────────────

test('ADR-0013 P1. the renderer adapter has no network, audio capture/encoding, or fallback to another engine', () => {
  const adapter = read('public/renderer-voice-adapter.js');
  assert.doesNotMatch(adapter, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|AudioContext|createScriptProcessor|MediaRecorder|encodeWav|Blob\(/);
  assert.equal((adapter.match(/new Recognition\(\)/g) ?? []).length, 1);
  // consent is enforced before the microphone is opened AND re-checked immediately before recognition starts
  const prepare = between(adapter, 'async prepare(lang, runId)', '// Stop recording and transcribe');
  assert.ok(prepare.indexOf('CONSENT_REQUIRED') < prepare.indexOf('getUserMedia'));
  const run = between(adapter, 'const Recognition = recognitionCtor();', 'recognition.start();');
  assert.match(run, /processor\.kind === 'THIRD_PARTY' && !consent\.has\(processor\.consentKey\)/);
});

test('ADR-0013 P2. the adapter persists nothing but consent records and logs no transcript text', () => {
  const adapter = read('public/renderer-voice-adapter.js');
  assert.doesNotMatch(adapter, /indexedDB|sessionStorage|FileSystem|showSaveFilePicker|URL\.createObjectURL/);
  const writes = adapter.match(/localStorage\.setItem\(([^,]+),/g) ?? [];
  assert.deepEqual(writes, ['localStorage.setItem(CONSENT_STORAGE_KEY,']);
  const diagnoseCalls = adapter.match(/this\.diagnose\('[A-Z_]+',\s*\{[^}]*\}/g) ?? [];
  assert.ok(diagnoseCalls.length > 5);
  for (const call of diagnoseCalls) {
    assert.doesNotMatch(call, /\b(transcript|finalTranscript|interimTranscript|rawTranscript|text)\s*[,}:]/, call);
  }
});

test('ADR-0013 D1. Main dictation preserves existing text, offers stop and cancel, and never auto-submits', () => {
  const main = read('public/main-surface.js');
  const dictation = between(main, 'async function startVoiceRecognition(mode)', 'async function saveTextToVault');
  assert.match(dictation, /dataset\.voiceBase = voiceBase/);
  assert.match(dictation, /\[base, finalTranscript, interimTranscript\]\.filter\(Boolean\)/);
  assert.match(dictation, /state\.voiceAdapter\.stop\(\)/); // second press = stop and transcribe
  assert.match(dictation, /input\.value = voiceBase/); // cancel restores the composer
  assert.doesNotMatch(dictation, /main-send|\.click\(\)|requestSubmit|submit|dispatchEvent|sendMain|runMain|api\(/);
  assert.match(main, /id="main-voice-cancel"/);
  assert.match(main, /event\.key === 'Escape'[\s\S]*voiceAdapter\.cancel\(\)/);
});

test('ADR-0013 D2. the control matrix describes the real processing location rules', () => {
  const main = read('public/main-surface.js');
  assert.doesNotMatch(main, /Browser SpeechRecognition/);
  assert.match(main, /on-device when the browser verifies it, otherwise the browser vendor only after consent/);
});

// ── Authority ────────────────────────────────────────────────────────────────────────────────────────────────────

test('ADR-0013 A1. voice capture/session layers hold no execution, approval or API authority (Android + TS)', () => {
  const dir = 'mobile-android/app/src/main/java/com/nagex/mobile';
  const kotlinCode = (file: string): string => read(`${dir}/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of ['VoiceCaptureManager.kt', 'VoiceSession.kt']) {
    assert.doesNotMatch(kotlinCode(file), /NagexApiClient|ActionApproval|approve|SmsManager|sendTextMessage|startActivity|\/api\//, file);
  }
  const activity = kotlinCode('VoiceCommandActivity.kt');
  const apiCalls = activity.match(/apiClient\.\w+/g) ?? [];
  assert.deepEqual([...new Set(apiCalls)], ['apiClient.resolveContacts']);
  assert.doesNotMatch(activity, /SmsManager|sendTextMessage|\/send|\/execute|approve\(/);

  const adapterCode = read('public/renderer-voice-adapter.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(adapterCode, /approve|execute|submit|\/api\//i);

  const pipeline = read('src/voice/voice-activation-pipeline.ts');
  assert.match(pipeline, /speakerAuthorityGranted: false;/);
  assert.doesNotMatch(pipeline, /from '\.\.\/(governance|execution|http|tasks|integrations)\//);
  const identity = read('src/voice/voice-identity.service.ts');
  assert.doesNotMatch(identity, /from '\.\.\/(governance|execution|http|tasks|integrations)\//);
});

test('ADR-0013 A2. wake word and speaker match are risk inputs, not authority', () => {
  const service = new VoiceIdentityService();
  const profile = service.createDeviceLocalProfile({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_a', sampleCount: 4 });
  const verifications = [
    service.verify({ wakePhraseDetected: false }),
    service.verify({ wakePhraseDetected: true }),
    service.verify({ wakePhraseDetected: true, profile, speakerMatchesProfile: false, livenessResult: 'LIVE_LIKELY' }),
    service.verify({ wakePhraseDetected: true, profile, speakerMatchesProfile: true, livenessResult: 'LIVE_LIKELY' }),
    service.verify({ wakePhraseDetected: true, profile, speakerMatchesProfile: true, livenessResult: 'REPLAY_SUSPECTED' }),
    service.verify({ wakePhraseDetected: true, developmentTrustMode: true }),
  ];
  for (const verification of verifications) {
    // no voice trust level, however strong, turns a consequential command into an automatic one
    assert.notEqual(service.decideAuthority('HIGH', verification), 'ALLOW');
    assert.notEqual(service.decideAuthority('MEDIUM', verification), 'ALLOW');
  }
  assert.equal(service.decideAuthority('LOW', verifications[0]), 'BLOCK');
});

test('ADR-0013 A3. non-TEXT (voice) modality is normalized but not executed in production', () => {
  const service = read('src/commands/multimodal-command.service.ts');
  const nonText = between(service, "if (modality !== 'TEXT') {", 'const parsed = this.parseKakaoTextIntent');
  assert.match(nonText, /productionExecutionEnabled: false/);
  assert.match(nonText, /handled: false/);
  assert.match(nonText, /UNSUPPORTED_MODALITY/);
  assert.doesNotMatch(nonText, /prepareApproval|execute|enqueue|send/i);
});

test('ADR-0013 A4. Quick Wake keeps no authority of its own: consent comes from the adapter and execution goes through the normal prompt path', () => {
  const quickWake = read('public/desktop-quickwake.js');
  const capture = between(quickWake, 'async function startDesktopVoiceCapture', 'function setupVoiceRuntime');
  assert.doesNotMatch(capture, /\bfetch\(|apiFetch\(|approve|execute/i);
  assert.match(capture, /CONSENT_REQUIRED/);
  assert.match(capture, /DESKTOP_RUNTIME_NO_STT/);
  assert.match(capture, /submitPrompt\(transcript\)/); // the existing prompt path (and its approvals) is the only way forward
  assert.match(quickWake, /function finishDesktopVoiceCapture\(\)[\s\S]*adapter\.stop\(\)/);
});

test('ADR-0013 P4. speaker enrollment audio is ephemeral and device-local by default', () => {
  const service = new VoiceIdentityService();
  assert.equal(service.policy.voiceProfileDeviceLocalDefault, true);
  assert.equal(service.policy.rawAudioSyncDefault, false);
});
