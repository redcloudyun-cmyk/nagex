import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('open-source STT POC is isolated, local-only, and inserts without auto-submit', () => {
  const server = fs.readFileSync('scripts/stt-open-source-poc.mjs', 'utf8');
  const html = fs.readFileSync('scripts/stt-open-source-poc.html', 'utf8');

  assert.match(server, /listen\(PORT, '127\.0\.0\.1'/);
  assert.match(server, /WHISPER_CPP_NOT_CONFIGURED/);
  assert.match(server, /FASTER_WHISPER_NOT_CONFIGURED/);
  assert.match(server, /NAGEX_STT_POC_TOKEN/);
  assert.match(server, /access-control-allow-origin/);
  assert.match(server, /https:\/\/nagex-test\.agex\.site/);
  assert.match(server, /req\.method === 'OPTIONS'/);
  assert.match(server, /TRANSCRIPTION_BUSY/);
  assert.match(server, /TRANSCRIBE_TIMEOUT/);
  assert.match(server, /AUDIO_DURATION_UNSUPPORTED/);
  assert.match(server, /await rm\(dir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(server, /server_web|nagex\.service|systemctl|git push/);

  assert.match(html, /getUserMedia/);
  assert.match(html, /composer\.value/);
  assert.doesNotMatch(html, /sendRequest|submitPrompt|form\.submit/);
});
