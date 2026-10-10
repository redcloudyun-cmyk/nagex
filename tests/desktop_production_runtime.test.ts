import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const desktopApp = readFileSync('src/desktop/desktop-app.ts', 'utf8');
const preload = readFileSync('src/desktop/preload.ts', 'utf8');
const quickWake = readFileSync('public/desktop-quickwake.js', 'utf8');

test('desktop production runtime is wired into the real Electron app entrypoint', () => {
  assert.match(desktopApp, /from 'electron'/);
  assert.match(desktopApp, /Tray/);
  assert.match(desktopApp, /BrowserWindow/);
  assert.match(desktopApp, /Notification/);
  assert.match(desktopApp, /globalShortcut/);
  assert.doesNotMatch(desktopApp, /DesktopReservationIntent|DesktopReservationStateMachine/);
});

test('tray lifecycle exposes required production actions without requiring the main window to stay open', () => {
  for (const label of ['Open NAgex', 'Talk to NAgex', 'Notifications', 'Mute voice', 'Settings', 'Quit']) {
    assert.match(desktopApp, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(desktopApp, /mainWindow\.on\('close'/);
  assert.match(desktopApp, /event\.preventDefault\(\)/);
  assert.match(desktopApp, /mainWindow\?\.hide\(\)/);
  assert.match(desktopApp, /tray\.on\('click'/);
});

test('global push-to-talk hook is registered and does not claim wake-word success', () => {
  assert.match(desktopApp, /productionPushToTalkShortcut = 'Ctrl\+Shift\+Space'/);
  assert.match(desktopApp, /registerPushToTalkShortcut/);
  assert.match(desktopApp, /desktop:push_to_talk_triggered/);
  assert.doesNotMatch(desktopApp, /WAKE_WORD.*SUCCESS|wake.*verified/i);
});

test('compact popup is a real non-focus-stealing Electron window with 10 and 30 second policies', () => {
  assert.match(desktopApp, /compactPopupWindow = new BrowserWindow/);
  assert.match(desktopApp, /focusable: false/);
  assert.match(desktopApp, /skipTaskbar: true/);
  assert.match(desktopApp, /showInactive\(\)/);
  assert.match(desktopApp, /payload\.type === 'INFO' \? 10 : 30/);
  assert.match(desktopApp, /setTimeout/);
  assert.match(desktopApp, /compactPopupWindow\?\.hide\(\)/);
});

test('real Windows UX cert trigger uses the actual compact popup path', () => {
  assert.match(desktopApp, /NAGEX_DESKTOP_CERT_POPUP/);
  assert.match(desktopApp, /runDesktopUxCertTrigger/);
  assert.match(desktopApp, /showCompactPopup\(\{/);
  assert.match(desktopApp, /foreground-cert-popup/);
});

test('popup placement uses display work area instead of static coordinates', () => {
  assert.match(desktopApp, /screen\.getDisplayNearestPoint/);
  assert.match(desktopApp, /screen\.getCursorScreenPoint/);
  assert.match(desktopApp, /workArea/);
  assert.doesNotMatch(desktopApp, /x:\s*\d{3,}/);
});

test('notification history persists approval and result records after popup timeout', () => {
  assert.match(desktopApp, /desktopNotificationHistory/);
  assert.match(desktopApp, /rememberDesktopNotification/);
  assert.match(desktopApp, /status: record\.status \?\?/);
  assert.match(desktopApp, /APPROVAL_REQUIRED.*PENDING/s);
  assert.match(desktopApp, /desktop:get_notification_history/);
});

test('renderer bridge exposes compact popup, notification history, and microphone session hooks', () => {
  for (const api of ['showCompactPopup', 'getNotificationHistory', 'startVoiceCapture', 'stopVoiceCapture']) {
    assert.match(preload, new RegExp(api));
  }
  assert.match(preload, /desktop:show_compact_popup/);
  assert.match(preload, /desktop:start_voice_capture/);
  assert.match(preload, /desktop:voice_capture_requested/);
});

test('microphone and STT path is truthful about renderer/provider requirement', () => {
  assert.match(desktopApp, /microphoneSession: 'REQUESTED'/);
  assert.match(desktopApp, /realMicCapture: 'RENDERER_GET_USER_MEDIA_REQUIRED'/);
  assert.match(desktopApp, /realStt: 'WEB_SPEECH_OR_PROVIDER_REQUIRED'/);
});

test('quick wake renderer implements real microphone capture and Web Speech STT handoff', () => {
  assert.match(quickWake, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  assert.match(quickWake, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(quickWake, /recognition\.onresult/);
  assert.match(quickWake, /submitPrompt\(transcript\)/);
  assert.match(quickWake, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
});

test('quick wake voice runtime supports click-to-talk and native push-to-talk continuity', () => {
  assert.match(quickWake, /startDesktopVoiceCapture\('CLICK_TO_TALK'\)/);
  assert.match(quickWake, /onPushToTalkTriggered/);
  assert.match(quickWake, /onVoiceCaptureRequested/);
  assert.match(quickWake, /state\.voice\.goalId/);
});

test('popup visual contract avoids crude debug styling markers', () => {
  assert.match(desktopApp, /border-radius:18px/);
  assert.match(desktopApp, /box-shadow:0 24px 70px/);
  assert.match(desktopApp, /font-family:Segoe UI/);
  assert.doesNotMatch(desktopApp, /TODO|debug|alert\(/i);
});
