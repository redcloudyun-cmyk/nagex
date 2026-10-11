import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('open-source STT POC is isolated, local-only, and inserts without auto-submit', () => {
  const server = fs.readFileSync('scripts/stt-open-source-poc.mjs', 'utf8');
  const html = fs.readFileSync('scripts/stt-open-source-poc.html', 'utf8');

  assert.match(server, /listen\(PORT, '127\.0\.0\.1'/);
  assert.match(server, /WHISPER_CPP_NOT_CONFIGURED/);
  assert.match(server, /FASTER_WHISPER_NOT_CONFIGURED/);
  assert.match(server, /await rm\(dir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(server, /server_web|nagex\.service|systemctl|git push/);

  assert.match(html, /getUserMedia/);
  assert.match(html, /composer\.value/);
  assert.doesNotMatch(html, /sendRequest|submitPrompt|form\.submit/);
});
