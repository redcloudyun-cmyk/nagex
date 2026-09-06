import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PersistentGoogleOAuthTokenStore,
  resolveDefaultGoogleTokenStorePath,
} from '../src/integrations/google/token.store.js';
import { ToolRegistry, type RegisteredTool } from '../src/tools/tool-registry.js';

function tmpStorePath(): string {
  return path.join(os.tmpdir(), `nagex-oauth-test-${crypto.randomBytes(6).toString('hex')}.json`);
}

function freshKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const config = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
const noopFetch: typeof fetch = async () => jsonResponse({});

test('OAuth connection survives a new token-store instance pointed at the same file', () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env });
    storeA.save('t1', { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env });
    assert.equal(storeB.isConnected('t1'), true);
    assert.equal(storeB.getStatus('t1').connected, true);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('access token is restored after a simulated restart, without needing a refresh', async () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env });
    storeA.save('t1', { accessToken: 'still-valid-access-token', refreshToken: 'rt_1', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env }); // "restart"
    const fetchThatMustNotBeCalled: typeof fetch = async () => { throw new Error('must not refresh a non-expired token'); };
    const accessToken = await storeB.getValidAccessToken('t1', config, fetchThatMustNotBeCalled, 'req_1');
    assert.equal(accessToken, 'still-valid-access-token');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('refresh token is restored after a simulated restart and can be used to refresh', async () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env });
    storeA.save('t1', { accessToken: 'expired-access-token', refreshToken: 'persisted-refresh-token', expiresAt: Date.now() - 1000, scope: 'calendar.events' });

    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env }); // "restart"
    let capturedRefreshToken = '';
    const fetchFn: typeof fetch = async (_url, init) => {
      capturedRefreshToken = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      return jsonResponse({ access_token: 'brand-new-access-token', expires_in: 3600, scope: 'calendar.events' });
    };
    const accessToken = await storeB.getValidAccessToken('t1', config, fetchFn, 'req_2');
    assert.equal(capturedRefreshToken, 'persisted-refresh-token');
    assert.equal(accessToken, 'brand-new-access-token');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('expired token refreshes automatically and the refreshed state is persisted for the next restart', async () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env });
    storeA.save('t1', { accessToken: 'expired', refreshToken: 'rt_1', expiresAt: Date.now() - 1000, scope: 'calendar.events' });

    const fetchFn: typeof fetch = async () => jsonResponse({ access_token: 'refreshed-and-persisted', expires_in: 3600, scope: 'calendar.events' });
    const refreshed = await storeA.getValidAccessToken('t1', config, fetchFn, 'req_3');
    assert.equal(refreshed, 'refreshed-and-persisted');

    // Simulate a second restart: a fresh instance must see the *refreshed*
    // token on disk, not the original expired one, and must not need to
    // refresh again.
    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env });
    const accessToken = await storeB.getValidAccessToken('t1', config, noopFetch, 'req_4');
    assert.equal(accessToken, 'refreshed-and-persisted');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('a corrupted token file fails closed to disconnected instead of crashing', () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'this is not valid json at all {{{', { mode: 0o600 });
  try {
    const store = new PersistentGoogleOAuthTokenStore({ filePath, env });
    assert.equal(store.isConnected('t1'), false);
    assert.deepEqual(store.getStatus('t1'), { connected: false, scopes: [], expiresAt: null });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('decrypting with the wrong encryption key fails closed to disconnected instead of throwing out of the constructor', () => {
  const filePath = tmpStorePath();
  const originalKey = freshKey();
  const wrongKey = freshKey();
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env: { NAGEX_TOKEN_ENCRYPTION_KEY: originalKey } });
    storeA.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

    // No throw, no crash — just fails closed.
    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env: { NAGEX_TOKEN_ENCRYPTION_KEY: wrongKey } });
    assert.equal(storeB.isConnected('t1'), false);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('disconnect (revoke) deletes the persisted credentials, not just the in-memory copy', async () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env });
    storeA.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
    assert.equal(fs.existsSync(filePath), true);

    await storeA.revoke('t1', noopFetch, 'req_revoke_1');
    assert.equal(storeA.isConnected('t1'), false);
    // The file itself is removed, not merely rewritten empty.
    assert.equal(fs.existsSync(filePath), false);

    // A fresh instance reading the same (now-absent) file must also see it
    // disconnected — the clear was actually written to disk, not only
    // applied in memory.
    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env });
    assert.equal(storeB.isConnected('t1'), false);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('status never exposes token values, even when backed by the persistent store', async () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const store = new PersistentGoogleOAuthTokenStore({ filePath, env });
    store.save('t1', { accessToken: 'top-secret-access', refreshToken: 'top-secret-refresh', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
    const status = store.getStatus('t1');
    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /top-secret-access|top-secret-refresh/);
    assert.deepEqual(Object.keys(status).sort(), ['connected', 'expiresAt', 'scopes']);

    // The file on disk is ciphertext, not a token value in the clear either.
    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(onDisk, /top-secret-access|top-secret-refresh/);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('tool registry reports LIVE after a simulated restart (fresh store instance, same file)', () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const storeA = new PersistentGoogleOAuthTokenStore({ filePath, env });
    storeA.save('ten_production_01', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

    // Fresh store instance simulates the registry after a process restart.
    const storeB = new PersistentGoogleOAuthTokenStore({ filePath, env });
    const tools: RegisteredTool[] = [
      {
        id: 'google_calendar.create_event',
        name: 'Google Calendar',
        capability: 'calendar.event.create',
        connectionStatus: 'disconnected',
        sideEffectLevel: 'REVERSIBLE_WRITE',
        requiresApproval: true,
        executionMode: 'unavailable',
        aliases: ['google calendar'],
        getLiveStatus: () => (storeB.isConnected('ten_production_01')
          ? { connectionStatus: 'connected', executionMode: 'live' }
          : { connectionStatus: 'disconnected', executionMode: 'unavailable' }),
      },
    ];
    const registry = new ToolRegistry(tools);
    const resolution = registry.resolve('Google Calendar');
    assert.equal(resolution.connectionStatus, 'connected');
    assert.equal(resolution.executionMode, 'live');
    assert.equal(resolution.availability, 'AVAILABLE');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('resolveDefaultGoogleTokenStorePath prefers NAGEX_GOOGLE_TOKEN_STORE_PATH, then /var/lib/nagex, then a per-user data dir', () => {
  const explicit = resolveDefaultGoogleTokenStorePath({ NAGEX_GOOGLE_TOKEN_STORE_PATH: '/custom/path.json' } as NodeJS.ProcessEnv);
  assert.equal(explicit, '/custom/path.json');

  const fallback = resolveDefaultGoogleTokenStorePath({} as NodeJS.ProcessEnv);
  assert.ok(fallback === '/var/lib/nagex/google-oauth.json' || fallback.endsWith(path.join('.local', 'share', 'nagex', 'google-oauth.json')));
});

test('the persisted file is written with mode 0600', () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const store = new PersistentGoogleOAuthTokenStore({ filePath, env });
    store.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

    // POSIX permission bits aren't meaningfully enforced by Node's fs.chmod
    // on Windows (NTFS ACLs are a different model), so only assert the exact
    // bits on platforms where chmod(0600) is real; elsewhere just confirm
    // the call path succeeded (file exists, no thrown error).
    const mode = fs.statSync(filePath).mode & 0o777;
    if (process.platform === 'win32') {
      assert.equal(fs.existsSync(filePath), true);
    } else {
      assert.equal(mode, 0o600);
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('refresh_token is preserved when Google omits one on a later save (e.g. a reconnect without forced consent)', () => {
  const filePath = tmpStorePath();
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const store = new PersistentGoogleOAuthTokenStore({ filePath, env });
    store.save('t1', { accessToken: 'first-access-token', refreshToken: 'the-only-refresh-token', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

    // A later grant that comes back with refreshToken: null must not erase
    // the previously-persisted refresh token.
    store.save('t1', { accessToken: 'second-access-token', refreshToken: null, expiresAt: Date.now() + 7200_000, scope: 'calendar.events' });

    const storeAfterRestart = new PersistentGoogleOAuthTokenStore({ filePath, env });
    let capturedRefreshToken = '';
    const fetchFn: typeof fetch = async (_url, init) => {
      capturedRefreshToken = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      return jsonResponse({ access_token: 'third-access-token', expires_in: 3600, scope: 'calendar.events' });
    };
    return storeAfterRestart.getValidAccessToken('t1', config, fetchFn, 'req_preserve_1', () => Date.now() + 999_999_999).then(() => {
      assert.equal(capturedRefreshToken, 'the-only-refresh-token');
    });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('atomic replacement: the envelope matches the required shape and no temp files are left behind', () => {
  const filePath = tmpStorePath();
  const dir = path.dirname(filePath);
  const env = { NAGEX_TOKEN_ENCRYPTION_KEY: freshKey() };
  try {
    const store = new PersistentGoogleOAuthTokenStore({ filePath, env });
    store.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
    store.save('t1', { accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 7200_000, scope: 'calendar.events' });
    store.save('t1', { accessToken: 'at3', refreshToken: null, expiresAt: Date.now() + 10_800_000, scope: 'calendar.events' });

    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(Object.keys(envelope).sort(), ['algorithm', 'ciphertext', 'iv', 'tag', 'version']);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.algorithm, 'aes-256-gcm');
    assert.equal(typeof envelope.iv, 'string');
    assert.equal(typeof envelope.tag, 'string');
    assert.equal(typeof envelope.ciphertext, 'string');

    // No leftover .tmp-* files from any of the three writes above.
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
