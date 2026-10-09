import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VoiceIdentityService } from '../src/voice/voice-identity.service.js';
import {
  DEFAULT_WAKE_PHRASE,
  DISABLED_WAKE_PHRASE,
  FORBIDDEN_OK_NAGEX_DEFAULT_WAKE_PHRASE,
  LEGACY_AGEX_DEFAULT_WAKE_PHRASE,
  LEGACY_AGEX_SHORT_WAKE_PHRASE,
  SHORT_WAKE_PHRASE,
} from '../src/voice/voice-identity.types.js';

test('A/B. canonical wake phrases are Hey NAgex in Korean pronunciation and legacy AGex values are not canonical', () => {
  const service = new VoiceIdentityService();
  assert.equal(service.policy.defaultWakePhrase, DEFAULT_WAKE_PHRASE);
  assert.equal(DEFAULT_WAKE_PHRASE, '\uD5E4\uC774 \uB124\uC774\uC81D\uC2A4');
  assert.equal(service.policy.shortWakePhrase, SHORT_WAKE_PHRASE);
  assert.equal(SHORT_WAKE_PHRASE, '\uB124\uC774\uC81D\uC2A4');
  assert.equal(service.policy.disabledWakePhrase, DISABLED_WAKE_PHRASE);
  assert.equal(service.policy.okNagexDefault, false);
  assert.notEqual(service.policy.defaultWakePhrase, FORBIDDEN_OK_NAGEX_DEFAULT_WAKE_PHRASE);
  assert.notEqual(DEFAULT_WAKE_PHRASE, LEGACY_AGEX_DEFAULT_WAKE_PHRASE);
  assert.notEqual(SHORT_WAKE_PHRASE, LEGACY_AGEX_SHORT_WAKE_PHRASE);
});

test('legacy AGex wake settings normalize only inside the Voice Wake Phrase contract', () => {
  const service = new VoiceIdentityService();
  assert.equal(service.normalizeWakePhraseSelection(LEGACY_AGEX_DEFAULT_WAKE_PHRASE), 'DEFAULT');
  assert.equal(service.wakePhraseForMode(service.normalizeWakePhraseSelection(LEGACY_AGEX_DEFAULT_WAKE_PHRASE)), DEFAULT_WAKE_PHRASE);
  assert.equal(service.normalizeWakePhraseSelection(LEGACY_AGEX_SHORT_WAKE_PHRASE), 'SHORT');
  assert.equal(service.wakePhraseForMode(service.normalizeWakePhraseSelection(LEGACY_AGEX_SHORT_WAKE_PHRASE)), SHORT_WAKE_PHRASE);
  assert.equal(service.normalizeWakePhraseSelection(DISABLED_WAKE_PHRASE), 'DISABLED');
});

test('C/D/E/F. wake detection never implies verified speaker trust', () => {
  const service = new VoiceIdentityService();
  const notEnrolled = service.verify({ wakePhraseDetected: true });
  assert.equal(notEnrolled.wakeWordMatch, true);
  assert.equal(notEnrolled.speakerMatch, 'NOT_ENROLLED');
  assert.equal(notEnrolled.inputTrustLevel, 'UNTRUSTED');

  const profile = service.createDeviceLocalProfile({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_a', sampleCount: 4 });
  const mismatch = service.verify({ wakePhraseDetected: true, profile, speakerMatchesProfile: false, livenessResult: 'LIVE_LIKELY' });
  assert.equal(mismatch.speakerMatch, 'MISMATCH');
  assert.equal(mismatch.inputTrustLevel, 'UNTRUSTED');

  const dev = service.verify({ wakePhraseDetected: true, developmentTrustMode: true });
  assert.equal(dev.inputTrustLevel, 'DEVELOPMENT_TRUST');
  assert.equal(dev.speakerMatch, 'NOT_ENROLLED');

  const prodDev = service.verify({ wakePhraseDetected: true, developmentTrustMode: true, production: true });
  assert.equal(prodDev.inputTrustLevel, 'UNTRUSTED');
});

test('G/H. low-risk voice may proceed under policy but high-risk still requires deterministic authority', () => {
  const service = new VoiceIdentityService();
  const profile = service.createDeviceLocalProfile({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_a', sampleCount: 4 });
  const trusted = service.verify({ wakePhraseDetected: true, profile, speakerMatchesProfile: true, livenessResult: 'LIVE_LIKELY' });
  assert.equal(trusted.speakerMatch, 'VERIFIED');
  assert.equal(service.decideAuthority('LOW', trusted), 'ALLOW');
  assert.equal(service.decideAuthority('HIGH', trusted), 'REQUIRE_APPROVAL');
});

test('I/J. continuation window accepts follow-up speech and device lock invalidates trust', () => {
  const service = new VoiceIdentityService();
  const session = service.startSession(1_000);
  assert.equal(session.wakePhraseRequired, true);
  const continuation = service.enterContinuationWindow(session, 'TRUSTED', 1_000, 30_000);
  assert.equal(continuation.wakePhraseRequired, false);
  assert.equal(service.acceptFollowUpWithoutWake(continuation, 2_000), true);
  assert.equal(service.acceptFollowUpWithoutWake(continuation, 40_000), false);
  const locked = service.invalidateForDeviceLock(continuation);
  assert.equal(locked.state, 'IDLE');
  assert.equal(locked.wakePhraseRequired, true);
  assert.equal(locked.trustLevel, 'UNTRUSTED');
});

test('K/L/M. enrollment is multi-sample, device-local, ephemeral, and device-model independent', () => {
  const service = new VoiceIdentityService();
  const draft = service.createEnrollmentDraft();
  assert.ok(draft.minimumAcceptedSamples > 1);
  assert.equal(draft.prompts[0]?.text, DEFAULT_WAKE_PHRASE);
  assert.equal(draft.rawAudioRetention, 'EPHEMERAL');
  assert.equal(service.policy.voiceProfileDeviceLocalDefault, true);
  assert.equal(service.policy.rawAudioSyncDefault, false);
  assert.throws(() => service.createDeviceLocalProfile({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'dev_a', sampleCount: 1 }), /VOICE_ENROLLMENT_REQUIRES_MULTIPLE_SAMPLES/);
  const fold = service.createDeviceLocalProfile({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'fold3', sampleCount: 4 });
  const slab = service.createDeviceLocalProfile({ tenantId: 'ten_a', ownerId: 'usr_a', deviceId: 'pixel', sampleCount: 4 });
  assert.equal(fold.storageScope, 'DEVICE_LOCAL');
  assert.equal(slab.storageScope, 'DEVICE_LOCAL');
  assert.equal(fold.rawAudioRetained, false);
  assert.equal(slab.rawAudioRetained, false);
});

test('Settings UI exposes canonical Voice Identity controls without internal model terminology', () => {
  const app = fs.readFileSync('public/app.js', 'latin1');
  assert.match(app, /data-voice-identity-settings/);
  assert.match(app, /Enroll my voice/);
  assert.match(app, /Re-enroll voice/);
  assert.match(app, /Remove voice profile/);
  assert.match(app, /&#54860;&#51060; &#45348;&#51060;&#51229;&#49828;/);
  assert.match(app, /&#45348;&#51060;&#51229;&#49828;/);
  assert.doesNotMatch(app, /&#54860;&#51060; &#50640;&#51060;&#51229;&#49828;/);
  assert.doesNotMatch(app, /&#50640;&#51060;&#51229;&#49828;/);
  assert.match(app, /&#51020;&#49457; &#54840;&#52636; &#49324;&#50857; &#50504; &#54632;/);
  const consumerSlice = app.slice(app.indexOf('data-voice-identity-settings'), app.indexOf('function openVoiceEnrollmentModal'));
  assert.doesNotMatch(consumerSlice, /embedding|threshold|cosine|anti-spoof|VAD/i);
});
