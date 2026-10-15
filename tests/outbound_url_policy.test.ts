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

// ---- D-9 IPv6 literal screening (deny by classification, never by the accident of a failed DNS lookup) ----
import { classifyIPv6, isPrivateIPv4, isPrivateIPv6, OutboundPolicyError, parseIPv6 } from '../src/security/outbound-url-policy.js';

// A resolver that records every question. For a LITERAL address the policy must never ask; and if it did, the verdict must not depend on the answer: ENOTFOUND (Linux) or a PUBLIC address
// (a platform whose resolver accepts brackets) must lead to the same refusal.
const recordingResolver = (calls: string[], answer: 'notfound' | 'public') => async (host: string) => {
  calls.push(host);
  if (answer === 'notfound') throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return [{ address: '93.184.216.34', family: 4 }];
};

// the loopback address is refused by the long-standing local-host rule (its class is OUTBOUND_LOCAL_HOSTNAME) whatever spelling it comes in
const LOOPBACK_LITERALS = new Set(['[::1]', '[0:0:0:0:0:0:0:1]']);
const PRIVATE_V6_LITERALS = [
  '[::1]', '[::]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::FFFF:7F00:1]', '[::ffff:10.0.0.1]', '[::ffff:a00:1]', '[::ffff:192.168.1.1]', '[::ffff:c0a8:101]',
  '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[::ffff:100.100.100.200]', '[fd00::1]', '[fc00::1]', '[fd00:ec2::254]', '[fe80::1]', '[febf::1]', '[fec0::1]', '[ff02::1]', '[ff00::]',
  '[64:ff9b::7f00:1]', '[64:ff9b::127.0.0.1]', '[64:ff9b::a9fe:a9fe]', '[64:ff9b:1::1]', '[2002:7f00:1::]', '[2002:a9fe:a9fe::1]', '[2002:c0a8:101::]', '[2001::1]', '[2001:db8::1]', '[100::1]',
  '[::127.0.0.1]', '[::7f00:1]', '[2001:10::1]', '[2001:2::1]', '[4000::1]', '[8000::1]',
];

test('every private, loopback, link-local, ULA, metadata, mapped, NAT64, 6to4 and reserved IPv6 literal is refused with the IPv6 reason - without asking DNS, whatever DNS would answer', async () => {
  for (const answer of ['notfound', 'public'] as const) {
    for (const literal of PRIVATE_V6_LITERALS) {
      const calls: string[] = [];
      await assert.rejects(
        () => validateOutboundUrl(`http://${literal}/`, { resolver: recordingResolver(calls, answer) }),
        (error: unknown) => error instanceof OutboundPolicyError && (LOOPBACK_LITERALS.has(literal) ? error.code === 'OUTBOUND_LOCAL_HOSTNAME' : error.code === 'OUTBOUND_PRIVATE_IPV6' && /private network IPv6/.test(error.message)),
        `${literal} (DNS would answer: ${answer})`,
      );
      assert.deepEqual(calls, [], `${literal}: DNS must not be consulted for a literal address`);
    }
  }
});

test('private IPv6 literals are refused as redirect destinations as well, and as the host of an https URL', async () => {
  const initial = await validateOutboundUrl('https://public.example', { resolver: publicResolver });
  for (const literal of ['[::1]', '[::ffff:7f00:1]', '[fd00::1]', '[64:ff9b::a9fe:a9fe]', '[fe80::1]']) {
    await assert.rejects(() => validateRedirectDestination(`http://${literal}/admin`, initial.parsedUrl), (e: unknown) => e instanceof OutboundPolicyError && e.code === (LOOPBACK_LITERALS.has(literal) ? 'OUTBOUND_LOCAL_HOSTNAME' : 'OUTBOUND_PRIVATE_IPV6'), literal);
    await assert.rejects(() => validateOutboundUrl(`https://${literal}:8443/x`), (e: unknown) => e instanceof OutboundPolicyError && e.code === (LOOPBACK_LITERALS.has(literal) ? 'OUTBOUND_LOCAL_HOSTNAME' : 'OUTBOUND_PRIVATE_IPV6'), literal);
  }
  // a relative redirect from a literal base is judged by its address too
  await assert.rejects(() => validateRedirectDestination('/internal', new URL('http://[::ffff:7f00:1]/')), (e: unknown) => e instanceof OutboundPolicyError && e.code === 'OUTBOUND_PRIVATE_IPV6');
});

test('a public IPv6 literal is allowed without any DNS lookup (it used to be refused on Linux only because the lookup failed)', async () => {
  for (const literal of ['[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[2a00:1450:4001:81b::200e]']) {
    const calls: string[] = [];
    const ok = await validateOutboundUrl(`https://${literal}/`, { resolver: recordingResolver(calls, 'notfound') });
    assert.equal(ok.addressFamily, 6);
    assert.ok(!ok.resolvedPublicIp.startsWith('['), 'the address is carried without brackets');
    assert.deepEqual(calls, []);
  }
  // IPv4-mapped / NAT64 / 6to4 forms of a PUBLIC IPv4 address are judged by the address they carry
  for (const literal of ['[::ffff:5db8:d822]', '[::ffff:93.184.216.34]', '[64:ff9b::5db8:d822]', '[2002:5db8:d822::1]']) {
    const calls: string[] = [];
    await validateOutboundUrl(`https://${literal}/`, { resolver: recordingResolver(calls, 'notfound') });
    assert.deepEqual(calls, [], literal);
  }
});

test('a NAME that resolves to a private address in ANY textual form is refused (dotted or hex IPv4-mapped, NAT64, 6to4, ULA, link-local)', async () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:A00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fd12:3456::1', 'fe80::1%eth0', '::1', '::']) {
    await assert.rejects(
      () => validateOutboundUrl('https://public.example', { resolver: async () => [{ address, family: 6 }] }),
      (e: unknown) => e instanceof OutboundPolicyError && e.code === 'OUTBOUND_RESOLVED_PRIVATE' && /not a public destination/.test(e.message),
      address,
    );
  }
  // one public and one private answer: the private one decides
  await assert.rejects(() => validateOutboundUrl('https://public.example', { resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:7f00:1', family: 6 }] }), /not a public destination/);
});

test('numeric / encoded / trailing-dot IPv4 and local names stay denied, with the right class (including the shared and reserved IPv4 ranges)', async () => {
  const classOf = async (u: string) => { try { await validateOutboundUrl(u, { resolver: publicResolver }); return 'ALLOWED'; } catch (e) { return e instanceof OutboundPolicyError ? e.code : `OTHER:${(e as Error).name}`; } };
  for (const u of ['http://127.0.0.1/', 'http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://192.168.0.1/', 'http://172.16.0.1/', 'http://0.0.0.0/']) {
    assert.ok(['OUTBOUND_PRIVATE_IPV4', 'OUTBOUND_LOCAL_HOSTNAME'].includes(await classOf(u)), u);
  }
  for (const u of ['http://100.64.0.1/', 'http://100.100.100.200/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/', 'http://192.0.0.8/']) assert.equal(await classOf(u), 'OUTBOUND_PRIVATE_IPV4', u);
  for (const u of ['http://localhost/', 'http://localhost./', 'http://LOCALHOST/', 'http://a.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://nas.lan/']) assert.equal(await classOf(u), 'OUTBOUND_LOCAL_HOSTNAME', u);
  assert.equal(await classOf('http://user:pass@example.com/'), 'OUTBOUND_EMBEDDED_CREDENTIALS');
  assert.equal(await classOf('ftp://example.com/'), 'OUTBOUND_UNSUPPORTED_PROTOCOL');
  assert.equal(await classOf('https://93.184.216.34/'), 'ALLOWED');
  assert.equal(await classOf('https://example.com/'), 'ALLOWED');
  const empty = await validateOutboundUrl('https://x.example', { resolver: async () => [] }).catch((e) => e);
  assert.equal((empty as OutboundPolicyError).code, 'OUTBOUND_NO_ADDRESSES');
});

test('the pinned lookup blocks a rebound or hex-mapped private answer with the rebinding class', async () => {
  const initial = await validateOutboundUrl('https://public.example', { resolver: publicResolver });
  for (const address of ['10.0.0.9', '::ffff:7f00:1', '::ffff:10.0.0.9', 'fd00::9']) {
    const lookup = createPinnedLookup(initial, async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
    await new Promise<void>((resolve) => lookup('public.example', (err: Error | null) => {
      assert.ok(err instanceof OutboundPolicyError && err.code === 'OUTBOUND_DNS_REBINDING', address);
      resolve();
    }));
  }
});

test('the address classifier itself: parsing of every textual form, and the other callers of isPrivateIPv6 (host names are not IPv6 and are not its business)', () => {
  assert.deepEqual([...parseIPv6('::1')!], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...parseIPv6('[2001:DB8:0:0:0:0:0:1]')!], [...parseIPv6('2001:db8::1')!]);
  assert.deepEqual([...parseIPv6('::ffff:1.2.3.4')!], [...parseIPv6('::ffff:102:304')!]);
  assert.deepEqual([...parseIPv6('fe80::1%eth0')!], [...parseIPv6('fe80::1')!]);
  for (const bad of [':::', '1::2::3', '12345::1', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'example.com', '127.0.0.1', '', '[::1', '::1]']) assert.equal(parseIPv6(bad), null, bad);
  assert.equal(classifyIPv6('2606:4700:4700::1111'), null);
  assert.equal(classifyIPv6('::ffff:8.8.8.8'), null);
  assert.match(classifyIPv6('::ffff:7f00:1')!, /IPv4-mapped 127\.0\.0\.1/);
  assert.match(classifyIPv6('2002:a9fe:a9fe::')!, /6to4 169\.254\.169\.254/);
  assert.match(classifyIPv6('64:ff9b::a00:1')!, /NAT64 10\.0\.0\.1/);
  // host names and IPv4 text are not IPv6: false (callers screen them by other means); IPv6 literals are classified
  for (const notV6 of ['example.com', 'localhost', '127.0.0.1', '']) assert.equal(isPrivateIPv6(notV6), false, notV6);
  assert.equal(isPrivateIPv6('[::1]'), true);
  assert.equal(isPrivateIPv6('2606:4700:4700::1111'), false);
  assert.equal(isPrivateIPv4('100.64.0.1'), true);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
});
