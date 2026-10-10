import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EphemeralAudioPrerollBuffer,
  VoiceActivationPipeline,
  type AudioFrame,
  type WakeDetectorResult,
} from '../src/voice/voice-activation-pipeline.js';

const CALL_COMMAND = '\uC870\uBBFC\uD615\uC5D0\uAC8C \uC804\uD654\uD574 \uC918';
const WAKE_PHRASE = '\uD5E4\uC774 \uB124\uC774\uC81D\uC2A4';

function detectedWake(): WakeDetectorResult {
  return {
    executed: true,
    detected: true,
    phrase: WAKE_PHRASE,
    confidence: 0.91,
    timestampMs: 10_000,
    detectorType: 'ON_DEVICE_WAKE_DETECTOR',
  };
}

test('A. wake detector evidence plus command STT without wake is a valid command', () => {
  const pipeline = new VoiceActivationPipeline();
  const listening = pipeline.startWakeListening('voice_sess_a');
  const commandSession = pipeline.onWakeDetection(listening, detectedWake());

  const result = pipeline.acceptCommand({ session: commandSession, sttText: CALL_COMMAND });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'WAKE_DETECTED');
  assert.equal(result.commandText, CALL_COMMAND);
});

test('B. wake-word mode without wake detector evidence is not accepted', () => {
  const pipeline = new VoiceActivationPipeline();
  const session = pipeline.startWakeListening('voice_sess_b');

  const result = pipeline.acceptCommand({ session, sttText: CALL_COMMAND });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'NO_VALID_ACTIVATION');
});

test('C. push-to-talk accepts command STT without any wake phrase', () => {
  const pipeline = new VoiceActivationPipeline();
  const session = pipeline.startPushToTalk('voice_sess_c');

  const result = pipeline.acceptCommand({ session, sttText: CALL_COMMAND });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'PUSH_TO_TALK_INPUT');
});

test('D. wake phrase in STT alone does not grant wake-word authority', () => {
  const pipeline = new VoiceActivationPipeline();
  const session = pipeline.startWakeListening('voice_sess_d');

  const result = pipeline.acceptCommand({
    session,
    sttText: `${WAKE_PHRASE} ${CALL_COMMAND}`,
    wakePhraseInTranscript: true,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'NO_VALID_ACTIVATION');
});

test('E. wake detection remains separate from speaker verification and liveness', () => {
  const pipeline = new VoiceActivationPipeline();
  const listening = pipeline.startWakeListening('voice_sess_e');
  const commandSession = pipeline.onWakeDetection(listening, detectedWake());

  assert.equal(commandSession.wakeDetectorResult?.detected, true);
  assert.equal(commandSession.speakerVerified, false);
  assert.equal(commandSession.livenessCertified, false);
  const result = pipeline.acceptCommand({ session: commandSession, sttText: CALL_COMMAND });
  assert.equal(result.speakerAuthorityGranted, false);
});

test('F/G. command preroll preserves boundary frames and is ephemeral', () => {
  const preroll = new EphemeralAudioPrerollBuffer(2);
  const beforeWake: AudioFrame = { id: 'pre_first_syllable', payload: '\uC870', capturedAtMs: 1_000 };
  const beforeWake2: AudioFrame = { id: 'pre_second_syllable', payload: '\uBBFC', capturedAtMs: 1_010 };
  const afterWake: AudioFrame = { id: 'post_command_tail', payload: '\uD615\uC5D0\uAC8C \uC804\uD654\uD574 \uC918', capturedAtMs: 1_020 };

  preroll.add(beforeWake);
  preroll.add(beforeWake2);
  const segment = preroll.commandSegment([afterWake]);

  assert.deepEqual(segment.map((frame) => frame.id), ['pre_first_syllable', 'pre_second_syllable', 'post_command_tail']);
  assert.equal(segment.map((frame) => frame.payload).join(''), CALL_COMMAND);
  assert.equal(preroll.persisted(), false);
  preroll.clear();
  assert.equal(preroll.size(), 0);
});

test('H. continuation-window follow-up does not require another wake phrase', () => {
  const pipeline = new VoiceActivationPipeline();
  const listening = pipeline.startWakeListening('voice_sess_h');
  const commandSession = pipeline.onWakeDetection(listening, detectedWake());
  const continuation = pipeline.enterContinuationWindow(commandSession, 20_000, 45_000);

  const result = pipeline.acceptCommand({
    session: continuation,
    sttText: '\uC624\uD6C4 \uC77C\uC815\uB9CC \uB9D0\uD574\uC918',
    nowMs: 30_000,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'CONTINUATION_WINDOW');
});
