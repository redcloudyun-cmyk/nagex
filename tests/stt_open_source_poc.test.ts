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
  assert.match(server, /access-control-allow-private-network/);
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

test('same-origin STT route is bounded and reuses whisper.cpp without audio retention', () => {
  const route = fs.readFileSync('src/http/routes/stt.routes.ts', 'utf8');
  const server = fs.readFileSync('src/server_web.ts', 'utf8');
  const bodyLimit = fs.readFileSync('src/http/body-limit.ts', 'utf8');
  const access = fs.readFileSync('src/http/route-access.ts', 'utf8');

  assert.match(server, /handleSttRoutes/);
  assert.match(route, /NAGEX_WHISPER_CPP_BIN/);
  assert.match(route, /NAGEX_WHISPER_CPP_MODEL/);
  assert.match(route, /MAX_AUDIO_BYTES/);
  assert.match(route, /MAX_AUDIO_SECONDS/);
  assert.match(route, /MAX_CONCURRENT_TRANSCRIPTIONS/);
  assert.match(route, /TRANSCRIBE_TIMEOUT/);
  assert.match(route, /spawn\(bin, \['-m', model, '-f', wavPath, '-l', 'ko'/);
  assert.match(route, /await rm\(dir, \{ recursive: true, force: true \}\)/);
  assert.match(route, /Buffer\.isBuffer\(binaryBody\.data\)/);
  assert.match(route, /mimeType[\s\S]*includes\('wav'\)/);
  assert.match(bodyLimit, /\/api\/v1\/stt\/transcribe/);
  assert.match(access, /\/api\\\/v1\\\/stt\\\/transcribe/);
  assert.doesNotMatch(route, /localStorage|NAGEX_LOCAL_STT_TOKEN|127\.0\.0\.1:4760/);
});
