import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { VoiceIdentityService } from '../src/voice/voice-identity.service.js';

// ADR-0013 — Universal Voice architecture. These tests pin the invariants that hold TODAY
// (privacy, authorization and Voice Action boundaries). They deliberately do not assert the
// open gaps listed in the ADR (local-first default, consent UI, desktop quick-wake submit).

const read = (file: string): string => fs.readFileSync(file, 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('ADR-0013 P1. server STT route keeps audio local: no outbound network, logging, or persistence', () => {
  const route = read('src/http/routes/stt.routes.ts');
  assert.doesNotMatch(route, /from 'node:(http|https|net|tls|dgram|dns)'/);
  assert.doesNotMatch(route, /\bfetch\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(route, /console\.|logger|auditLogger/);
  // the route may import only node builtins, HTTP types and caller identity: no stores, memory, vault, capture or model modules
  const imports = [...route.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    '../http-types.js',
    '../request-identity.js',
    'node:child_process',
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:path',
    'node:perf_hooks',
  ]);
  assert.match(route, /tryGetCallerIdentity\(headers\)[\s\S]*AUTHENTICATION_REQUIRED/);
  assert.match(route, /mkdir\(dir, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(route, /writeFile\(wavPath, audio, \{ mode: 0o600 \}\)/);
  assert.match(route, /finally \{[\s\S]*await rm\(dir, \{ recursive: true, force: true \}\)/);
  const response = between(route, 'return {\n      status: 200,', '} catch (cause)');
  assert.doesNotMatch(response, /audio\b|wavPath|base64/);
});

test('ADR-0013 P2. server-Whisper path never falls back to the browser vendor recognizer', () => {
  const adapter = read('public/renderer-voice-adapter.js');
  const whisperPath = between(adapter, 'async startLocalWhisper(', 'async cancel()');
  assert.doesNotMatch(whisperPath, /recognitionCtor\(|new Recognition|SpeechRecognition|webkitSpeechRecognition/);
  assert.match(whisperPath, /if \(!response\.ok \|\| !transcript\)[\s\S]*STATES\.CANCELLED/);
  assert.match(whisperPath, /catch \(error\)[\s\S]*STATES\.ERROR/);
});

test('ADR-0013 P3. renderer adapter does not persist audio or log raw transcript text', () => {
  const adapter = read('public/renderer-voice-adapter.js');
  assert.doesNotMatch(adapter, /indexedDB|localStorage\.setItem|sessionStorage\.setItem|FileSystem|showSaveFilePicker|URL\.createObjectURL/);
  // diagnostics carry lengths/flags only: no diagnose() payload may include a raw transcript string
  const diagnoseCalls = adapter.match(/this\.diagnose\('[A-Z_]+',\s*\{[^}]*\}/g) ?? [];
  assert.ok(diagnoseCalls.length > 5);
  for (const call of diagnoseCalls) {
    assert.doesNotMatch(call, /\b(transcript|finalTranscript|interimTranscript|rawTranscript|text)\s*[,}:]/, call);
  }
  // audio buffers are cleared on cleanup
  assert.match(adapter, /cleanup\(\) \{[\s\S]*this\.audioChunks = \[\]/);
});

test('ADR-0013 D1. Main dictation preserves existing text and never auto-submits', () => {
  const main = read('public/main-surface.js');
  const dictation = between(main, 'async function startVoiceRecognition(mode)', 'async function saveTextToVault');
  assert.match(dictation, /dataset\.voiceBase = input\.value\.trim\(\)/);
  assert.match(dictation, /\[base, finalTranscript, interimTranscript\]\.filter\(Boolean\)/);
  assert.doesNotMatch(dictation, /main-send|\.click\(\)|requestSubmit|submit|dispatchEvent|sendMain|runMain|api\(/);
});

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
  const noWake = verifications[0];
  assert.equal(service.decideAuthority('LOW', noWake), 'BLOCK');
});

test('ADR-0013 A3. non-TEXT (voice) modality is normalized but not executed in production', () => {
  const service = read('src/commands/multimodal-command.service.ts');
  const nonText = between(service, "if (modality !== 'TEXT') {", 'const parsed = this.parseKakaoTextIntent');
  assert.match(nonText, /productionExecutionEnabled: false/);
  assert.match(nonText, /handled: false/);
  assert.match(nonText, /UNSUPPORTED_MODALITY/);
  assert.doesNotMatch(nonText, /prepareApproval|execute|enqueue|send/i);
});

test('ADR-0013 P4. speaker enrollment audio is ephemeral and device-local by default', () => {
  const service = new VoiceIdentityService();
  assert.equal(service.policy.voiceProfileDeviceLocalDefault, true);
  assert.equal(service.policy.rawAudioSyncDefault, false);
});
