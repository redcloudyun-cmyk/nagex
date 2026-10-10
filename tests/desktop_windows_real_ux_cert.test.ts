import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopVoiceAudioOutput } from '../src/desktop/desktop-voice-audio-output.js';
import { DesktopCompactPopupRuntime, DesktopNotificationCenter } from '../src/life-execution/index.js';

test('desktop audio output lifecycle supports internal playback callbacks and release', async () => {
  const output = new DesktopVoiceAudioOutput();
  let started = false;
  let completed = false;
  await output.playBytes(new Uint8Array([1, 2, 3]), 'audio/mpeg', {
    onStarted: () => { started = true; },
  });
  assert.equal(started, true);
  assert.equal(output.isActive(), true);
  await output.complete({ onCompleted: () => { completed = true; } });
  assert.equal(completed, true);
  assert.equal(output.isActive(), false);
  await output.release();
  assert.equal(output.isReleased(), true);
});

test('desktop audio output never requires an external media player contract', async () => {
  const output = new DesktopVoiceAudioOutput();
  await output.playFile('C:/tmp/nagex-fixed-asset.mp3');
  assert.equal(output.isActive(), true);
  await output.stop();
  assert.equal(output.isActive(), false);
});

test('popup timeout preserves pending approval notification record', () => {
  const center = new DesktopNotificationCenter();
  const runtime = new DesktopCompactPopupRuntime(center);
  const popup = runtime.show({
    popupId: 'ux-cert-approval',
    goalId: 'goal-ux-cert',
    executionId: 'exec-ux-cert',
    type: 'APPROVAL_REQUIRED',
    summary: 'Approval required.',
    approvalId: 'approval-ux-cert',
    sensitiveDetailsRedacted: false,
  });
  const record = runtime.autoDismiss(popup);
  assert.equal(record.status, 'PERSISTED');
  assert.equal(record.approvalStatus, 'PENDING');
});

test('sensitive notification redaction degrades visible summary', () => {
  const center = new DesktopNotificationCenter();
  const runtime = new DesktopCompactPopupRuntime(center);
  runtime.show({
    popupId: 'ux-cert-sensitive',
    goalId: 'goal-sensitive',
    executionId: 'exec-sensitive',
    type: 'NEEDS_USER',
    summary: 'Private reservation detail',
    sensitiveDetailsRedacted: true,
  });
  assert.match(center.get('notification-ux-cert-sensitive')?.summary ?? '', /confirmation required/i);
});
