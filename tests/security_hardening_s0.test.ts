import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleAsyncApiRequest, createServerInstance } from '../src/server_web.js';
import { handleAuthRoutes } from '../src/http/routes/auth.routes.js';
import { handleCaptureRoutes } from '../src/http/routes/capture.routes.js';
import { sessionCookieHeader, clearSessionCookieHeader } from '../src/http/session-cookie.js';
import { GLOBAL_DEFAULT_BODY_LIMIT_BYTES } from '../src/http/body-limit.js';
import { baseSecurityHeaders } from '../src/http/security-headers.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { IdentityTokenStore } from '../src/identity/identity.tokens.js';
import { IdentityAuditStore } from '../src/identity/identity.audit.js';
import { SessionStore } from '../src/sessions/session.store.js';

test('S0-01 anonymous and forged desktop quickwake control requests are denied', async () => {
  delete process.env.NAGEX_DESKTOP_BRIDGE_TOKEN;
  for (const [method, path, body] of [
    ['POST', '/api/v1/desktop/quickwake/toggle', {}],
    ['POST', '/api/v1/desktop/quickwake/tray/action', { action: 'ACTIVE_TASKS' }],
    ['POST', '/api/v1/desktop/quickwake/tray/action', { action: 'PAUSE_AUTOMATIONS' }],
    ['POST', '/api/v1/desktop/quickwake/tray/action', { action: 'QUIT' }],
  ] as const) {
    const res = await handleAsyncApiRequest(method, path, body, { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' });
    assert.equal(res.status, 403);
    assert.match(JSON.stringify(res.data), /DESKTOP_BRIDGE_AUTH_REQUIRED/);
  }
});

test('S0-01 desktop bridge token is required for native runtime authority', async () => {
  process.env.NAGEX_DESKTOP_BRIDGE_TOKEN = 'test-desktop-bridge-token';
  try {
    assert.equal((await handleAsyncApiRequest('POST', '/api/v1/desktop/quickwake/toggle', {}, {})).status, 403);
    const res = await handleAsyncApiRequest('POST', '/api/v1/desktop/quickwake/toggle', {}, { 'x-nagex-desktop-bridge-token': 'test-desktop-bridge-token' });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.NAGEX_DESKTOP_BRIDGE_TOKEN;
  }
});

test('S0-02 oversized JSON is rejected before route mutation', async () => {
  const server = createServerInstance();
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/api/v1/quickwake/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(GLOBAL_DEFAULT_BODY_LIMIT_BYTES + 1) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await close(server);
  }
});

test('S0-03 session cookies use Secure/HttpOnly/SameSite and logout parity', async () => {
  const created = sessionCookieHeader('sess_test');
  const cleared = clearSessionCookieHeader();
  for (const cookie of [created, cleared]) {
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
  }

  const identityStore = new IdentityStore();
  const tokenStore = new IdentityTokenStore();
  const auditStore = new IdentityAuditStore();
  const sessionStore = new SessionStore();
  const { identity } = identityStore.createAccount('hardening@example.com', 'disabled');
  const session = sessionStore.createAuthSession('ten_hardening', identity.userId, 'MAIN');
  const res = await handleAuthRoutes('POST', '/api/v1/auth/logout', null, { cookie: `nagex_session=${session.sessionId}` }, {}, {
    identityStore,
    identityTokenStore: tokenStore,
    identityAuditStore: auditStore,
    sessionStore,
  });
  assert.equal(res?.status, 200);
  assert.equal(res?.headers?.['Set-Cookie'], cleared);
});

test('S0-03 baseline security headers are emitted', () => {
  const headers = baseSecurityHeaders({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.match(headers['Strict-Transport-Security'], /max-age=/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors/);
});

test('S0-03b CORS is same-origin by default and does not reflect arbitrary origins', async () => {
  delete process.env.NAGEX_CORS_ALLOWED_ORIGINS;
  const server = createServerInstance();
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);

    const preflight = await fetch(`${origin}/api/v1/quickwake/config`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  } finally {
    await close(server);
  }
});

test('S0-03c CORS allows only explicit server-side origins and validates preflight headers', async () => {
  process.env.NAGEX_CORS_ALLOWED_ORIGINS = 'https://approved.example';
  const server = createServerInstance();
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/health`, { headers: { Origin: 'https://approved.example' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://approved.example');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);

    const rejected = await fetch(`${origin}/api/v1/quickwake/config`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://approved.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, X-Evil-Header',
      },
    });
    assert.equal(rejected.status, 204);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  } finally {
    delete process.env.NAGEX_CORS_ALLOWED_ORIGINS;
    await close(server);
  }
});

test('S0-04 .nagex_data is ignored as runtime-private data', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync('.gitignore', 'utf8'), /^\.nagex_data\/$/m);
});

test('P2 anonymous link capture is rate limited before capture execution', async () => {
  let calls = 0;
  const linkCaptureService = {
    captureLink: async (_url: string) => {
      calls += 1;
      return { status: 'CAPTURED', url: _url };
    },
  };
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await handleCaptureRoutes('POST', '/api/v1/capture/link', { url: `https://example.com/${i}` }, {}, {}, { linkCaptureService } as any))?.status, 200);
  }
  const limited = await handleCaptureRoutes('POST', '/api/v1/capture/link', { url: 'https://example.com/limited' }, {}, {}, { linkCaptureService } as any);
  assert.equal(limited?.status, 429);
  assert.equal(calls, 10);
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert.equal(typeof addr, 'object');
      resolve(`http://127.0.0.1:${(addr as AddressInfo).port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
