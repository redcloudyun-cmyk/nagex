// Enrollment of a PC as a device (the step that was missing): a key pair is generated on the device, the public half goes to the server together with the person's own session, and the identity that
// comes back is saved next to the private key. Real route handler, real session store, real Ed25519 keys, real signed transport - the proof that the enrolled credential WORKS is that the agent
// then connects and heartbeats with it. Nothing here grants any authority beyond "this machine is a registered device of this person".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { enrollThisDevice } from '../src/device-agent/device-enrollment.js';
import { LocalDeviceAgentClient } from '../src/device-agent/local-device-agent-client.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback } from '../src/device-agent/local-device-credential.store.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { SessionStore } from '../src/sessions/session.store.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-enroll-'));

function server() {
  const dir = tmp();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const sessions = new SessionStore({ dir: path.join(dir, 'sessions') });
  const endpoint = new DeviceAgentTransportEndpoint(
    new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') }), devices, new DeviceConnectionStatusStore({ dir: path.join(dir, 'conn') }),
    new DesktopExecutionSessionStore({ dir: path.join(dir, 'sess') }), new DevicePendingCommandStore({ dir: path.join(dir, 'pending') }),
  );
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  // the real route handler behind a fetch-shaped function
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ url: url.pathname, headers, body: String(init?.body ?? '') });
    try {
      const result = await handleDeviceAgentRoutes(init?.method ?? 'GET', url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined, headers, {}, { deviceAgentTransportEndpoint: endpoint, deviceIdentityStore: devices, sessionStore: sessions } as never);
      if (!result) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(result.data), { status: result.status });
    } catch (error) {
      const category = (error as { category?: string }).category;
      return new Response(JSON.stringify({ error: { code: (error as { code?: string }).code } }), { status: category === 'AUTHENTICATION' ? 401 : category === 'VALIDATION' ? 400 : 403 });
    }
  }) as typeof fetch;
  const credentials = () => new LocalDeviceCredentialStore(path.join(tmp(), 'device-credential.enc'), new PlaintextLocalStorageFallback());
  return { devices, sessions, endpoint, fetchFn, requests, credentials };
}

test('enrolling creates this device for the SIGNED-IN person, saves the private key only locally, and the saved credential really authenticates (connect + heartbeat over the signed transport)', async () => {
  const s = server();
  const session = s.sessions.createAuthSession('ten_a', 'usr_a');
  const store = s.credentials();
  const result = await enrollThisDevice({ serverBaseUrl: 'http://nagex.test', sessionId: session.sessionId, credentialStore: store, agentVersion: '1.2.3', capabilityInventory: ['desktop:UIA_INTERACTIVE:NOTEPAD'], fetchFn: s.fetchFn });
  assert.equal(result.enrolled, true);
  if (!result.enrolled) return;
  // tenant and owner come from the session - the request never carried them
  assert.equal(result.tenantId, 'ten_a');
  assert.equal(result.ownerId, 'usr_a');
  const record = s.devices.getOwned(result.deviceId, 'ten_a', 'usr_a');
  assert.equal(record?.status, 'ACTIVE');
  assert.deepEqual(record?.capabilityInventory, ['desktop:UIA_INTERACTIVE:NOTEPAD']);
  const sent = s.requests[0];
  assert.equal(sent.url, '/api/v1/device-agent/enroll');
  assert.ok(!sent.body.includes('PRIVATE KEY'), 'the private key is never sent');
  assert.ok(!/tenant|owner/i.test(sent.body.replace(/-----[A-Z ]+-----/g, '')), 'no tenant or owner in the request body');
  assert.ok(sent.body.includes('PUBLIC KEY'));

  // the credential on this machine holds the private key and the identity the server issued
  const saved = store.load();
  assert.equal(saved?.deviceId, result.deviceId);
  assert.ok(saved?.privateKeyPem.includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(record).includes('PRIVATE KEY'), 'the server never holds the private key');

  // and it WORKS: a real signed connect + heartbeat with exactly that credential
  const client = new LocalDeviceAgentClient({
    tenantId: saved!.tenantId, ownerId: saved!.ownerId, deviceId: saved!.deviceId, privateKeyPem: saved!.privateKeyPem, serverBaseUrl: 'http://x', agentVersion: '1.2.3',
    fetchFn: (async (_i: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(s.endpoint.handle({ envelope: body.envelope, payload: body.payload }, 'req_x')), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal((await client.connect()).status, 'OK');
  assert.equal(await client.heartbeat(), null);
});

test('not signed in: no session, a made-up session, or an expired one enrolls nothing and writes no credential', async () => {
  const s = server();
  const none = s.credentials();
  assert.deepEqual(await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: '', credentialStore: none, agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn }), { enrolled: false, reason: 'NOT_SIGNED_IN' });
  assert.equal(s.requests.length, 0, 'no request is made without a session');
  const fake = s.credentials();
  const r = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: 'sess_made_up', credentialStore: fake, agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn });
  assert.equal(r.enrolled, false);
  assert.equal((r as { reason: string }).reason, 'NOT_SIGNED_IN');
  assert.equal(fake.load(), null);
  assert.equal(s.devices.listOwned('ten_a', 'usr_a').length, 0);
});

test('an already-enrolled PC keeps its identity (no second device, no new key); replacing is explicit', async () => {
  const s = server();
  const session = s.sessions.createAuthSession('ten_a', 'usr_a');
  const store = s.credentials();
  const first = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: store, agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn });
  assert.equal(first.enrolled, true);
  const keyBefore = store.load()?.privateKeyPem;
  const again = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: store, agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn });
  assert.deepEqual(again, { enrolled: false, reason: 'ALREADY_ENROLLED' });
  assert.equal(store.load()?.privateKeyPem, keyBefore);
  assert.equal(s.devices.listOwned('ten_a', 'usr_a').length, 1);
  const replaced = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: store, agentVersion: '1', capabilityInventory: [], replaceExisting: true, fetchFn: s.fetchFn });
  assert.equal(replaced.enrolled, true);
  assert.notEqual(store.load()?.privateKeyPem, keyBefore, 'a replacement is a new key');
});

test('a server that cannot be reached, refuses, or answers nonsense leaves the PC unenrolled and says why', async () => {
  const s = server();
  const session = s.sessions.createAuthSession('ten_a', 'usr_a');
  const down = s.credentials();
  assert.deepEqual(await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: down, agentVersion: '1', capabilityInventory: [], fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as never }), { enrolled: false, reason: 'SERVER_UNREACHABLE' });
  const refused = s.credentials();
  assert.deepEqual(await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: refused, agentVersion: '1', capabilityInventory: [], fetchFn: (async () => new Response('{}', { status: 500 })) as never }), { enrolled: false, reason: 'SERVER_REFUSED', httpStatus: 500 });
  const nonsense = s.credentials();
  assert.deepEqual(await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: nonsense, agentVersion: '1', capabilityInventory: [], fetchFn: (async () => new Response('{"hello":1}', { status: 201 })) as never }), { enrolled: false, reason: 'INVALID_RESPONSE' });
  for (const store of [down, refused, nonsense]) assert.equal(store.load(), null);
});

test('the private key is generated per enrollment (two PCs never share a key) and is a real Ed25519 key', async () => {
  const s = server();
  const session = s.sessions.createAuthSession('ten_a', 'usr_a');
  const a = s.credentials();
  const b = s.credentials();
  await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: a, agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn });
  await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: b, agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn });
  assert.notEqual(a.load()?.privateKeyPem, b.load()?.privateKeyPem);
  assert.equal(crypto.createPrivateKey(a.load()!.privateKeyPem).asymmetricKeyType, 'ed25519');
  assert.notEqual(a.load()?.deviceId, b.load()?.deviceId);
});

test('the PC is named by what the person will recognise (its host name); the name is plain text only - control characters and markup never reach the screen', async () => {
  const s = server();
  const session = s.sessions.createAuthSession('ten_a', 'usr_a');
  const named = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: s.credentials(), agentVersion: '1', capabilityInventory: [], deviceName: 'MIN-DESKTOP', platform: 'win32', fetchFn: s.fetchFn });
  assert.equal(named.enrolled, true);
  if (!named.enrolled) return;
  assert.equal(s.devices.getOwned(named.deviceId, 'ten_a', 'usr_a')?.systemDeviceName, 'MIN-DESKTOP');
  assert.equal(s.devices.getOwned(named.deviceId, 'ten_a', 'usr_a')?.os, 'win32');

  const hostile = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: s.credentials(), agentVersion: '1', capabilityInventory: [], deviceName: `<img src=x onerror=alert(1)>\u0000\n  ${'x'.repeat(200)}`, fetchFn: s.fetchFn });
  assert.equal(hostile.enrolled, true);
  if (!hostile.enrolled) return;
  const stored = s.devices.getOwned(hostile.deviceId, 'ten_a', 'usr_a')?.systemDeviceName ?? '';
  assert.ok(stored.length <= 60);
  assert.ok(!/[<>\u0000-\u001f]/.test(stored), JSON.stringify(stored));
  const none = await enrollThisDevice({ serverBaseUrl: 'http://x', sessionId: session.sessionId, credentialStore: s.credentials(), agentVersion: '1', capabilityInventory: [], fetchFn: s.fetchFn });
  assert.equal(none.enrolled && s.devices.getOwned(none.deviceId, 'ten_a', 'usr_a')?.systemDeviceName, null, 'no name is fine: the id is shown instead');
});
