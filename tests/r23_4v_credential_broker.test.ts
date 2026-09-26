import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { NagexError } from '../src/common/errors.js';
import { CredentialBrokerService } from '../src/security/credentials/index.js';
import {
  handleGoogleOAuthStartRoutes,
  handleGoogleOAuthCallbackRoutes,
} from '../src/http/routes/google-oauth.routes.js';
import { googleTokenStore, InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';

const CANARY_SECRET = 'R23_4V_CANARY_SECRET_7f4d2c11';

function expectCode(code: string) {
  return (error: unknown) => error instanceof NagexError && error.code === code;
}

test('R23.4V Credential Broker — reference-only, owner-bound, inject-only contract', async (t) => {
  await t.test('registered reference exposes metadata only and never the secret', () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit, () => Date.parse('2026-09-26T14:00:00.000Z'));

    const ref = broker.registerReference({
      tenantId: 'ten_a',
      principalId: 'usr_a',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: ['gmail.modify', 'calendar.events'],
      status: 'ACTIVE',
      expiresAt: '2026-09-27T14:00:00.000Z',
    });

    const serialized = JSON.stringify(ref);
    assert.match(ref.credentialRef, /^cred_/);
    assert.doesNotMatch(serialized, /accessToken|refreshToken|password|apiKey/i);
    assert.doesNotMatch(serialized, new RegExp(CANARY_SECRET));
  });

  await t.test('correct owner/provider/scope can use a secret only inside the privileged callback', async () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit);
    const ref = broker.registerReference({
      tenantId: 'ten_a',
      principalId: 'usr_a',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: ['gmail.modify'],
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    let callbackObservedSecret = false;
    const result = await broker.withCredential(
      {
        credentialRef: ref.credentialRef,
        tenantId: 'ten_a',
        principalId: 'usr_a',
        provider: 'GOOGLE',
        requiredScopes: ['gmail.modify'],
        purpose: 'gmail.send',
        requestId: 'req_ok',
        capabilityId: 'gmail.send_email',
      },
      async () => CANARY_SECRET,
      async ({ lease, secret }) => {
        callbackObservedSecret = secret === CANARY_SECRET;
        assert.match(lease.leaseId, /^lease_/);
        assert.equal(lease.credentialRef, ref.credentialRef);
        assert.doesNotMatch(JSON.stringify(lease), new RegExp(CANARY_SECRET));
        return 'provider-ok';
      },
    );

    assert.equal(callbackObservedSecret, true);
    assert.equal(result, 'provider-ok');

    const auditSerialized = JSON.stringify(audit.getAuditLogs('ten_a'));
    assert.doesNotMatch(auditSerialized, new RegExp(CANARY_SECRET));
  });

  await t.test('cross-tenant and cross-user access are hidden as not found', async () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit);
    const ref = broker.registerReference({
      tenantId: 'ten_owner',
      principalId: 'usr_owner',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: ['gmail.modify'],
      status: 'ACTIVE',
      expiresAt: null,
    });

    for (const [tenantId, principalId] of [
      ['ten_other', 'usr_owner'],
      ['ten_owner', 'usr_other'],
    ] as const) {
      await assert.rejects(
        broker.withCredential(
          {
            credentialRef: ref.credentialRef,
            tenantId,
            principalId,
            provider: 'GOOGLE',
            requiredScopes: ['gmail.modify'],
            purpose: 'cross-owner-attempt',
            requestId: 'req_cross',
          },
          async () => CANARY_SECRET,
          async () => 'must-not-run',
        ),
        expectCode('CREDENTIAL_NOT_FOUND'),
      );
    }
  });

  await t.test('provider mismatch and missing scope fail closed before secret resolution', async () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit);
    const ref = broker.registerReference({
      tenantId: 'ten_a',
      principalId: 'usr_a',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: ['gmail.modify'],
      status: 'ACTIVE',
      expiresAt: null,
    });

    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return CANARY_SECRET;
    };

    await assert.rejects(
      broker.withCredential(
        {
          credentialRef: ref.credentialRef,
          tenantId: 'ten_a',
          principalId: 'usr_a',
          provider: 'MICROSOFT',
          requiredScopes: [],
          purpose: 'wrong-provider',
          requestId: 'req_provider',
        },
        resolver,
        async () => 'must-not-run',
      ),
      expectCode('CREDENTIAL_PROVIDER_MISMATCH'),
    );

    await assert.rejects(
      broker.withCredential(
        {
          credentialRef: ref.credentialRef,
          tenantId: 'ten_a',
          principalId: 'usr_a',
          provider: 'GOOGLE',
          requiredScopes: ['calendar.events'],
          purpose: 'missing-scope',
          requestId: 'req_scope',
        },
        resolver,
        async () => 'must-not-run',
      ),
      expectCode('CREDENTIAL_SCOPE_MISSING'),
    );

    assert.equal(resolverCalls, 0);
  });

  await t.test('revoked and expired credentials fail closed before injection', async () => {
    const audit = new AuditLogger();
    const now = Date.parse('2026-09-26T14:00:00.000Z');
    const broker = new CredentialBrokerService(audit, () => now);

    const expired = broker.registerReference({
      tenantId: 'ten_a',
      principalId: 'usr_a',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: [],
      status: 'ACTIVE',
      expiresAt: '2026-09-26T13:59:59.000Z',
    });
    await assert.rejects(
      broker.withCredential(
        { credentialRef: expired.credentialRef, tenantId: 'ten_a', principalId: 'usr_a', provider: 'GOOGLE', requiredScopes: [], purpose: 'expired', requestId: 'req_expired' },
        async () => CANARY_SECRET,
        async () => 'must-not-run',
      ),
      expectCode('CREDENTIAL_EXPIRED'),
    );

    const revoked = broker.registerReference({
      tenantId: 'ten_a',
      principalId: 'usr_a',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: [],
      status: 'ACTIVE',
      expiresAt: null,
    });
    broker.revokeReference(revoked.credentialRef, 'ten_a', 'usr_a', 'req_revoke');

    await assert.rejects(
      broker.withCredential(
        { credentialRef: revoked.credentialRef, tenantId: 'ten_a', principalId: 'usr_a', provider: 'GOOGLE', requiredScopes: [], purpose: 'revoked', requestId: 'req_revoked' },
        async () => CANARY_SECRET,
        async () => 'must-not-run',
      ),
      expectCode('CREDENTIAL_REVOKED'),
    );
  });



  await t.test('browser-ready capability and origin constraints fail closed before secret resolution', async () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit);
    const ref = broker.registerReference({
      tenantId: 'ten_browser',
      principalId: 'usr_browser',
      provider: 'WEB_LOGIN',
      credentialType: 'PASSWORD_REFERENCE',
      scopes: ['signin'],
      status: 'ACTIVE',
      expiresAt: null,
      allowedOrigins: ['https://example.com/'],
      allowedCapabilities: ['browser.login.inject'],
    });

    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return CANARY_SECRET;
    };

    await assert.rejects(
      broker.withCredential(
        {
          credentialRef: ref.credentialRef,
          tenantId: 'ten_browser',
          principalId: 'usr_browser',
          provider: 'WEB_LOGIN',
          requiredScopes: ['signin'],
          purpose: 'browser-login',
          requestId: 'req_wrong_origin',
          capabilityId: 'browser.login.inject',
          origin: 'https://evil.example',
        },
        resolver,
        async () => 'must-not-run',
      ),
      expectCode('CREDENTIAL_ORIGIN_NOT_ALLOWED'),
    );

    await assert.rejects(
      broker.withCredential(
        {
          credentialRef: ref.credentialRef,
          tenantId: 'ten_browser',
          principalId: 'usr_browser',
          provider: 'WEB_LOGIN',
          requiredScopes: ['signin'],
          purpose: 'browser-login',
          requestId: 'req_wrong_capability',
          capabilityId: 'browser.type',
          origin: 'https://example.com/login',
        },
        resolver,
        async () => 'must-not-run',
      ),
      expectCode('CREDENTIAL_CAPABILITY_NOT_ALLOWED'),
    );

    assert.equal(resolverCalls, 0);
  });

  await t.test('lease exposes scoped metadata only and normalizes the approved origin', async () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit);
    const ref = broker.registerReference({
      tenantId: 'ten_lease',
      principalId: 'usr_lease',
      provider: 'WEB_LOGIN',
      credentialType: 'PASSWORD_REFERENCE',
      scopes: ['signin'],
      status: 'ACTIVE',
      expiresAt: null,
      allowedOrigins: ['https://Example.com/'],
      allowedCapabilities: ['browser.login.inject'],
    });

    const lease = await broker.withCredential(
      {
        credentialRef: ref.credentialRef,
        tenantId: 'ten_lease',
        principalId: 'usr_lease',
        provider: 'WEB_LOGIN',
        requiredScopes: ['signin'],
        purpose: 'browser-login',
        requestId: 'req_lease',
        capabilityId: 'browser.login.inject',
        origin: 'https://example.com/account/signin',
      },
      async () => CANARY_SECRET,
      async ({ lease, secret }) => {
        assert.equal(secret, CANARY_SECRET);
        return lease;
      },
    );

    assert.equal(lease.origin, 'https://example.com');
    assert.equal(lease.capabilityId, 'browser.login.inject');
    assert.deepEqual(lease.scopes, ['signin']);
    assert.doesNotMatch(JSON.stringify(lease), new RegExp(CANARY_SECRET));
  });
  await t.test('provider failure cannot leak the secret through broker audit', async () => {
    const audit = new AuditLogger();
    const broker = new CredentialBrokerService(audit);
    const ref = broker.registerReference({
      tenantId: 'ten_a',
      principalId: 'usr_a',
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: [],
      status: 'ACTIVE',
      expiresAt: null,
    });

    await assert.rejects(
      broker.withCredential(
        { credentialRef: ref.credentialRef, tenantId: 'ten_a', principalId: 'usr_a', provider: 'GOOGLE', requiredScopes: [], purpose: 'provider-error', requestId: 'req_provider_error' },
        async () => CANARY_SECRET,
        async () => { throw new Error('provider failed without echoing credential'); },
      ),
      /provider failed/,
    );

    assert.doesNotMatch(JSON.stringify(audit.getAuditLogs('ten_a')), new RegExp(CANARY_SECRET));
  });
});

test('R23.4V Google OAuth state is bound to the initiating tenant and principal', async () => {
  const oldEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  };
  const originalFetch = globalThis.fetch;

  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost/oauth/callback';

  const tenantId = 'ten_r234v_oauth';
  const principalId = 'usr_r234v_owner';
  const audit = new AuditLogger();

  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'oauth-test-access',
    refresh_token: 'oauth-test-refresh',
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    token_type: 'Bearer',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const started = handleGoogleOAuthStartRoutes(
      'GET',
      '/api/v1/oauth/google/start-url',
      null,
      { 'x-nagex-tenant': tenantId, 'x-principal-id': principalId },
      {},
      {},
    );
    assert.equal(started?.status, 200);
    const authorizeUrl = (started?.data as { authorizeUrl: string }).authorizeUrl;
    const state = new URL(authorizeUrl).searchParams.get('state');
    assert.ok(state);

    const callback = await handleGoogleOAuthCallbackRoutes(
      'GET',
      '/api/v1/oauth/google/callback',
      null,
      {
        // An attacker/spurious callback header cannot rebind the OAuth
        // continuation to another identity.
        'x-nagex-tenant': 'ten_attacker',
        'x-principal-id': 'usr_attacker',
      },
      { state: state!, code: 'auth-code' },
      { auditLogger: audit },
    );
    assert.equal(callback?.status, 302);

    const ownerLogs = audit.getAuditLogs(tenantId);
    assert.equal(ownerLogs.length, 1);
    assert.equal(ownerLogs[0].actor.id, principalId);
    assert.equal(ownerLogs[0].tenant_id, tenantId);
    assert.equal(ownerLogs[0].action, 'oauth:google_connected');
    assert.equal(audit.getAuditLogs('ten_attacker').length, 0);

    // State is one-time. Replay must fail before another token exchange.
    const replay = await handleGoogleOAuthCallbackRoutes(
      'GET',
      '/api/v1/oauth/google/callback',
      null,
      {},
      { state: state!, code: 'auth-code-replay' },
      { auditLogger: audit },
    );
    assert.equal(replay?.status, 302);
    assert.match(String(replay?.redirectTo), /status=error/);
  } finally {
    googleTokenStore.clearForPrincipal(tenantId, principalId);
    globalThis.fetch = originalFetch;
    if (oldEnv.GOOGLE_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = oldEnv.GOOGLE_CLIENT_ID;
    if (oldEnv.GOOGLE_CLIENT_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = oldEnv.GOOGLE_CLIENT_SECRET;
    if (oldEnv.GOOGLE_REDIRECT_URI === undefined) delete process.env.GOOGLE_REDIRECT_URI; else process.env.GOOGLE_REDIRECT_URI = oldEnv.GOOGLE_REDIRECT_URI;
  }
});


test('R23.4V Google token backend — same tenant remains principal-isolated', async () => {
  const store = new InMemoryGoogleOAuthTokenStore();
  const config = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost/callback' };
  const noRefresh: typeof fetch = async () => { throw new Error('refresh must not be called'); };

  store.saveForPrincipal('ten_shared', 'usr_a', {
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    expiresAt: Date.now() + 60_000,
    scope: 'scope.a',
  });
  store.saveForPrincipal('ten_shared', 'usr_b', {
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
    expiresAt: Date.now() + 60_000,
    scope: 'scope.b',
  });

  assert.equal(store.getStatusForPrincipal('ten_shared', 'usr_a').connected, true);
  assert.deepEqual(store.getStatusForPrincipal('ten_shared', 'usr_a').scopes, ['scope.a']);
  assert.deepEqual(store.getStatusForPrincipal('ten_shared', 'usr_b').scopes, ['scope.b']);

  assert.equal(
    await store.getValidAccessTokenForPrincipal('ten_shared', 'usr_a', config, noRefresh, 'req_a'),
    'access-a',
  );
  assert.equal(
    await store.getValidAccessTokenForPrincipal('ten_shared', 'usr_b', config, noRefresh, 'req_b'),
    'access-b',
  );

  store.clearForPrincipal('ten_shared', 'usr_a');
  assert.equal(store.isConnectedForPrincipal('ten_shared', 'usr_a'), false);
  assert.equal(store.isConnectedForPrincipal('ten_shared', 'usr_b'), true);
});
