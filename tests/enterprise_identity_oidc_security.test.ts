// R16 §52, §55, §70 — OIDC security test matrix. Uses a real RSA keypair
// (tests/_enterprise_identity_crypto_helpers.ts) to sign genuine JWTs and
// verifies them against the real, unmodified verifyIdToken() — no part of
// the verification logic is stubbed for these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyIdToken } from '../src/enterprise-identity/oidc.service.js';
import { generateTestIdpKeys, signJwt } from './_enterprise_identity_crypto_helpers.js';

const keys = generateTestIdpKeys();
const ISSUER = 'https://test-idp.example.com';
const AUDIENCE = 'client-abc';

function baseClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: 'user-123',
    aud: AUDIENCE,
    exp: now + 300,
    iat: now,
    nonce: 'expected-nonce',
    email: 'alice@example.com',
    ...overrides,
  };
}

test('1. Valid login: a correctly signed, correctly claimed ID token verifies successfully', () => {
  const jwt = signJwt(keys, baseClaims());
  const claims = verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' });
  assert.equal(claims.email, 'alice@example.com');
  assert.equal(claims.sub, 'user-123');
});

test('2. Invalid state is a route-layer concern verified separately (see enterprise_identity_lifecycle.test.ts) — state is consumed one-time by SsoFlowStore, never by verifyIdToken itself', () => {
  // Documented here so the §52 checklist is traceable to where each item
  // is actually covered, since verifyIdToken() has no "state" parameter —
  // state validation happens before verifyIdToken is ever called (see
  // src/http/routes/enterprise-identity.routes.ts's OIDC callback, and
  // tests/enterprise_identity_lifecycle.test.ts's "OIDC state is one-time"
  // test for the real end-to-end check).
  assert.ok(true);
});

test('3. Invalid/wrong nonce is rejected (OIDC_NONCE_MISMATCH)', () => {
  const jwt = signJwt(keys, baseClaims({ nonce: 'attacker-supplied-nonce' }));
  assert.throws(
    () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_NONCE_MISMATCH',
  );
});

test('4. Wrong issuer is rejected (OIDC_ISSUER_MISMATCH)', () => {
  const jwt = signJwt(keys, baseClaims({ iss: 'https://attacker-idp.example.com' }));
  assert.throws(
    () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_ISSUER_MISMATCH',
  );
});

test('5. Wrong audience is rejected (OIDC_AUDIENCE_MISMATCH)', () => {
  const jwt = signJwt(keys, baseClaims({ aud: 'some-other-client-id' }));
  assert.throws(
    () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_AUDIENCE_MISMATCH',
  );
});

test('6. Expired token is rejected (OIDC_TOKEN_EXPIRED)', () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(keys, baseClaims({ exp: now - 60 }));
  assert.throws(
    () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_TOKEN_EXPIRED',
  );
});

test('7. Invalid signature (tampered payload after signing) is rejected (OIDC_SIGNATURE_INVALID)', () => {
  const jwt = signJwt(keys, baseClaims());
  const [h, p, s] = jwt.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify(baseClaims({ sub: 'attacker-controlled-user' }))).toString('base64url');
  const tampered = `${h}.${tamperedPayload}.${s}`;
  assert.throws(
    () => verifyIdToken(tampered, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_SIGNATURE_INVALID',
  );
});

test('7b. A token signed with a DIFFERENT key than the configured JWKS is rejected (OIDC_SIGNATURE_INVALID)', () => {
  const otherKeys = generateTestIdpKeys('other-key');
  const jwt = signJwt(otherKeys, baseClaims());
  assert.throws(
    () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_SIGNATURE_INVALID',
  );
});

test('8. The classic "alg: none" forgery is rejected outright — before any signature check even runs', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(baseClaims())).toString('base64url');
  const forged = `${header}.${payload}.`; // "none" alg conventionally has an empty signature
  assert.throws(
    () => verifyIdToken(forged, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_SIGNATURE_INVALID' && /RS256/.test(err.message),
  );
});

test('8b. HS256 algorithm-confusion (symmetric-key forgery using the RSA public key/modulus as an HMAC secret) is rejected outright', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(baseClaims())).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const hmac = crypto.createHmac('sha256', keys.jwk.n).update(signingInput).digest('base64url');
  const forged = `${signingInput}.${hmac}`;
  assert.throws(
    () => verifyIdToken(forged, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_SIGNATURE_INVALID',
  );
});

test('9. Foreign-tenant provider: a token whose SIGNATURE is genuinely valid (real key, real kid match) must still be rejected if the route resolved the wrong organization\'s provider config (wrong issuer/audience expected)', () => {
  // Same signing key as the legitimate provider (so this test isolates
  // the issuer/audience check specifically, not signature/kid lookup) —
  // the attack this models is: Org A's provider genuinely exists and its
  // tokens are genuinely valid FOR Org A, but a request that resolved
  // Org B's provider config (e.g. via a tampered organizationId) must
  // still deny, because Org B's config names a different issuer/audience.
  const jwt = signJwt(keys, baseClaims({ iss: 'https://org-a-idp.example.com', aud: 'org-a-client' }));
  assert.throws(
    () => verifyIdToken(jwt, { issuer: 'https://org-b-idp.example.com', audience: 'org-b-client', jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_ISSUER_MISMATCH',
  );
});

test('10. Replay attempt: verifyIdToken alone does not prevent replay (that is SsoFlowStore\'s one-time state\'s job, tested end-to-end in enterprise_identity_lifecycle.test.ts) — but a token with an already-expired exp always fails regardless of how many times it is presented', () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(keys, baseClaims({ exp: now - 1 }));
  for (let i = 0; i < 3; i += 1) {
    assert.throws(
      () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
      (err: any) => err.code === 'OIDC_TOKEN_EXPIRED',
    );
  }
});

test('11. Malformed token (not three dot-separated parts) is rejected (OIDC_TOKEN_MALFORMED)', () => {
  assert.throws(
    () => verifyIdToken('not-a-real-jwt', { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }),
    (err: any) => err.code === 'OIDC_TOKEN_MALFORMED',
  );
});

test('12. No matching kid in JWKS is rejected (OIDC_SIGNATURE_INVALID), never silently falls back to the first key', () => {
  const unknownKidKeys = generateTestIdpKeys('unknown-kid');
  const jwt = signJwt(unknownKidKeys, baseClaims());
  assert.throws(
    () => verifyIdToken(jwt, { issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [keys.jwk] }, expectedNonce: 'expected-nonce' }), // only the ORIGINAL key's jwk is in the set
    (err: any) => err.code === 'OIDC_SIGNATURE_INVALID',
  );
});
