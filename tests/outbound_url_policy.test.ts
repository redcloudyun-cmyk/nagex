import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOutboundUrl, validateRedirectDestination, createPinnedLookup } from '../src/security/outbound-url-policy.js';
import { validateUrlForSsrf } from '../src/capture/link-capture.service.js';
import { EvidencePackService } from '../src/research/evidence-pack.service.js';
import fs from 'node:fs';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolver = async () => [{ address: '10.1.2.3', family: 4 }];
const linkLocalResolver = async () => [{ address: '169.254.169.254', family: 4 }];
const privateV6Resolver = async () => [{ address: 'fd00::1', family: 6 }];

test('canonical outbound policy denies private DNS, link-local DNS, IPv6 private DNS, userinfo and encoded IP tricks', async () => {
  await assert.rejects(() => validateOutboundUrl('https://public.example', { resolver: privateResolver }), /not a public destination/);
  await assert.rejects(() => validateOutboundUrl('https://public.example', { resolver: linkLocalResolver }), /not a public destination/);
  await assert.rejects(() => validateOutboundUrl('https://public.example', { resolver: privateV6Resolver }), /not a public destination/);
  await assert.rejects(() => validateOutboundUrl('https://user:pass@example.com', { resolver: publicResolver }), /embedded credentials/);
  await assert.rejects(() => validateOutboundUrl('http://2130706433/'), /not a public destination|local|private/i);
  await assert.rejects(() => validateOutboundUrl('http://0x7f000001/'), /not a public destination|local|private/i);
  await assert.rejects(() => validateOutboundUrl('http://[::ffff:127.0.0.1]/'), /not a public destination|private network IPv6/);
  await assert.rejects(() => validateOutboundUrl('gopher://example.com'), /Unsupported protocol/);
});

test('canonical outbound policy validates redirect destinations and pinned lookup blocks DNS rebinding', async () => {
  const initial = await validateOutboundUrl('https://public.example', { resolver: publicResolver });
  await assert.rejects(() => validateRedirectDestination('http://169.254.169.254/latest/meta-data/', initial.parsedUrl), /private network IPv4|local/i);
  await assert.rejects(() => validateRedirectDestination('http://127.0.0.1/admin', initial.parsedUrl), /private network IPv4|local/i);
  await assert.rejects(() => validateRedirectDestination('http://10.0.0.5/admin', initial.parsedUrl), /private network IPv4|local/i);

  const lookup = createPinnedLookup(initial, async () => [{ address: '10.0.0.9', family: 4 }]);
  await new Promise<void>((resolve) => lookup('public.example', (err: Error | null) => {
    assert.ok(err);
    assert.match(err.message, /DNS rebinding blocked/);
    resolve();
  }));
});

test('Link Capture uses canonical policy for DNS validation', async () => {
  const blocked = await validateUrlForSsrf('https://public.example', privateResolver, false);
  assert.equal(blocked.valid, false);
  const allowed = await validateUrlForSsrf('https://public.example', publicResolver, false);
  assert.equal(allowed.valid, true);
  assert.equal(allowed.resolvedIp, '93.184.216.34');
});

test('research public URL filtering performs DNS validation, not string-only validation', async () => {
  const svc = new EvidencePackService();
  assert.equal(await svc.isValidPublicUrl('https://example.com'), true);
  assert.equal(await svc.isValidPublicUrl('http://127.0.0.1/admin'), false);
});

test('browser runtime and capture processor depend on canonical outbound policy', () => {
  const runtime = fs.readFileSync('src/modules/browser/browser.runtime.ts', 'utf8');
  assert.match(runtime, /validateOutboundUrl/);
  assert.match(runtime, /context\.route\('\*\*\/\*'/);
  assert.match(runtime, /route\.abort\('blockedbyclient'\)/);

  const captureProcessor = fs.readFileSync('src/workspace/capture-processor.ts', 'utf8');
  assert.match(captureProcessor, /validateOutboundUrl/);
  assert.doesNotMatch(captureProcessor, /isUrlSafe/);
});
