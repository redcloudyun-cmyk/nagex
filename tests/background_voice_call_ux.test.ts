import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundVoiceCallUxPolicy } from '../src/voice/background-call-ux.js';

test('ordinary short call commands use background capture and compact confirmation, not full screen voice UI', () => {
  const decision = new BackgroundVoiceCallUxPolicy().decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'UNIQUE_VERIFIED',
    phoneResolution: 'UNIQUE_VERIFIED',
  });

  assert.equal(decision.captureMode, 'BACKGROUND');
  assert.equal(decision.fullScreenVoiceUiAllowed, false);
  assert.equal(decision.popupState, 'COMPACT_CONFIRMATION_COUNTDOWN');
  assert.equal(decision.countdownSeconds, 5);
  assert.equal(decision.cancelWindowVisible, true);
  assert.equal(decision.callNowVisible, true);
  assert.equal(decision.voiceCancelSupported, true);
  assert.equal(decision.executeCall, false);
});

test('unique verified target executes only after countdown and final target plus phone revalidation', () => {
  const policy = new BackgroundVoiceCallUxPolicy();
  const beforeRevalidation = policy.decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'UNIQUE_VERIFIED',
    phoneResolution: 'PREFERRED_VERIFIED',
  });
  assert.equal(beforeRevalidation.countdownStarts, true);
  assert.equal(beforeRevalidation.executeCall, false);

  const afterRevalidation = policy.decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'UNIQUE_VERIFIED',
    phoneResolution: 'PREFERRED_VERIFIED',
    targetRevalidated: true,
    phoneTargetRevalidated: true,
  });
  assert.equal(afterRevalidation.executeCall, true);
  assert.equal(afterRevalidation.reason, 'COUNTDOWN_EXPIRED_AND_FINAL_REVALIDATION_PASSED');
});

test('tap cancel or voice cancel during the five second buffer prevents the call', () => {
  const policy = new BackgroundVoiceCallUxPolicy();
  for (const input of [{ cancelledDuringCountdown: true }, { voiceCancelDetected: true }]) {
    const decision = policy.decide({
      origin: 'EXPLICIT_USER_COMMAND',
      explicitCallIntentVerified: true,
      contactResolution: 'UNIQUE_VERIFIED',
      phoneResolution: 'UNIQUE_VERIFIED',
      targetRevalidated: true,
      phoneTargetRevalidated: true,
      ...input,
    });
    assert.equal(decision.popupState, 'COMPACT_CONFIRMATION_COUNTDOWN');
    assert.equal(decision.executeCall, false);
    assert.equal(decision.reason, 'CALL_CANCELLED_DURING_BUFFER');
  }
});

test('ambiguous contacts show candidate selection and never start countdown before explicit target selection', () => {
  const decision = new BackgroundVoiceCallUxPolicy().decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'AMBIGUOUS',
    phoneResolution: 'UNRESOLVED',
  });

  assert.equal(decision.popupState, 'CANDIDATE_SELECTION');
  assert.equal(decision.countdownStarts, false);
  assert.equal(decision.executeCall, false);
});

test('multiple phone numbers require selection unless a verified preferred number exists', () => {
  const policy = new BackgroundVoiceCallUxPolicy();
  const multiple = policy.decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'UNIQUE_VERIFIED',
    phoneResolution: 'MULTIPLE_NEEDS_SELECTION',
  });
  assert.equal(multiple.popupState, 'PHONE_NUMBER_SELECTION');
  assert.equal(multiple.countdownStarts, false);

  const preferred = policy.decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'UNIQUE_VERIFIED',
    phoneResolution: 'PREFERRED_VERIFIED',
  });
  assert.equal(preferred.popupState, 'COMPACT_CONFIRMATION_COUNTDOWN');
  assert.equal(preferred.countdownStarts, true);
});

test('proactive call suggestions require explicit positive confirmation; silence is never approval', () => {
  const decision = new BackgroundVoiceCallUxPolicy().decide({
    origin: 'PROACTIVE_SUGGESTION',
    explicitCallIntentVerified: true,
    contactResolution: 'UNIQUE_VERIFIED',
    phoneResolution: 'UNIQUE_VERIFIED',
    targetRevalidated: true,
    phoneTargetRevalidated: true,
  });

  assert.equal(decision.popupState, 'EXPLICIT_CONFIRMATION_REQUIRED');
  assert.equal(decision.silenceIsApproval, false);
  assert.equal(decision.countdownStarts, false);
  assert.equal(decision.executeCall, false);
});

test('popup is only an execution buffer and never substitutes for target verification', () => {
  const decision = new BackgroundVoiceCallUxPolicy().decide({
    origin: 'EXPLICIT_USER_COMMAND',
    explicitCallIntentVerified: true,
    contactResolution: 'UNRESOLVED',
    phoneResolution: 'UNIQUE_VERIFIED',
  });

  assert.equal(decision.popupState, 'BLOCKED');
  assert.equal(decision.countdownStarts, false);
  assert.equal(decision.executeCall, false);
  assert.equal(decision.reason, 'CONTACT_NOT_VERIFIED');
});
