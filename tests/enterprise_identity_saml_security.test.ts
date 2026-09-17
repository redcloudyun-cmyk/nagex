// R16 §53-54, §70 — SAML security test matrix, using real RSA-signed XML
// (tests/_enterprise_identity_crypto_helpers.ts) verified against the
// real, unmodified verifySamlResponse().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySamlResponse, type SamlVerifyOptions } from '../src/enterprise-identity/saml.service.js';
import { generateTestIdpKeys, buildSignedSamlResponse } from './_enterprise_identity_crypto_helpers.js';

const keys = generateTestIdpKeys();
const ISSUER = 'https://test-idp.example.com/saml';
const SP_ENTITY_ID = 'https://sp.example.com/saml/metadata';
const ACS_URL = 'https://sp.example.com/saml/callback';

function baseOptions(overrides: Partial<SamlVerifyOptions> = {}): SamlVerifyOptions {
  return {
    organizationId: 'org_1',
    providerId: 'idp_1',
    config: { entityId: ISSUER, ssoUrl: 'https://test-idp.example.com/sso', x509Certificate: keys.certificatePem, nameIdFormat: 'x', attributeMappings: {} },
    spEntityId: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    expectedInResponseTo: '_req1',
    isReplay: () => false,
    ...overrides,
  };
}

let seq = 0;
function buildXml(overrides: Partial<Parameters<typeof buildSignedSamlResponse>[0]> = {}) {
  seq += 1;
  return buildSignedSamlResponse({
    keys,
    responseId: `_resp${seq}`,
    assertionId: `_assert${seq}`,
    issuer: ISSUER,
    audience: SP_ENTITY_ID,
    recipient: ACS_URL,
    inResponseTo: '_req1',
    nameId: 'alice@example.com',
    attributes: { email: 'alice@example.com' },
    ...overrides,
  });
}

test('1. Valid assertion: a correctly signed, correctly conditioned SAML Response verifies successfully', () => {
  const xml = buildXml();
  const assertion = verifySamlResponse(xml, baseOptions());
  assert.equal(assertion.nameId, 'alice@example.com');
  assert.equal(assertion.attributes.email, 'alice@example.com');
});

test('2. Unsigned response is rejected (SAML_MULTIPLE_SIGNATURES with count 0, or SAML_UNSIGNED)', () => {
  const xml = buildXml().replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '');
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_MULTIPLE_SIGNATURES');
});

test('3. Wrong issuer is rejected (SAML_ISSUER_MISMATCH)', () => {
  const xml = buildXml({ issuer: 'https://attacker-idp.example.com/saml' });
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_ISSUER_MISMATCH');
});

test('4. Wrong audience is rejected (SAML_AUDIENCE_MISMATCH)', () => {
  const xml = buildXml({ audience: 'https://some-other-sp.example.com/metadata' });
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_AUDIENCE_MISMATCH');
});

test('5. Wrong recipient is rejected (SAML_RECIPIENT_MISMATCH)', () => {
  const xml = buildXml({ recipient: 'https://attacker.example.com/callback' });
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_RECIPIENT_MISMATCH');
});

test('6. Expired assertion (NotOnOrAfter in the past) is rejected (SAML_ASSERTION_EXPIRED)', () => {
  const xml = buildXml({ notOnOrAfter: new Date(Date.now() - 60_000).toISOString(), scdNotOnOrAfter: new Date(Date.now() + 300_000).toISOString() });
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_ASSERTION_EXPIRED');
});

test('7. Not-yet-valid assertion (NotBefore in the future) is rejected (SAML_ASSERTION_NOT_YET_VALID)', () => {
  const xml = buildXml({ notBefore: new Date(Date.now() + 300_000).toISOString() });
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_ASSERTION_NOT_YET_VALID');
});

test('8. InResponseTo mismatch (CSRF/replay-adjacent) is rejected (SAML_IN_RESPONSE_TO_MISMATCH)', () => {
  const xml = buildXml({ inResponseTo: '_some_other_request' });
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_IN_RESPONSE_TO_MISMATCH');
});

test('9. Replay attempt: isReplay() returning true denies even an otherwise fully valid assertion (SAML_REPLAY_DETECTED)', () => {
  const xml = buildXml();
  assert.throws(() => verifySamlResponse(xml, baseOptions({ isReplay: () => true })), (err: any) => err.code === 'SAML_REPLAY_DETECTED');
});

test('10. Foreign-tenant IdP: an assertion genuinely signed by Org A\'s real IdP key must still be rejected against Org B\'s configured certificate/issuer', () => {
  const orgBKeys = generateTestIdpKeys('org-b-key');
  const xml = buildXml();
  assert.throws(
    () => verifySamlResponse(xml, baseOptions({ config: { entityId: ISSUER, ssoUrl: 'x', x509Certificate: orgBKeys.certificatePem, nameIdFormat: 'x', attributeMappings: {} } })),
    (err: any) => err.code === 'SAML_SIGNATURE_INVALID',
  );
});

test('11. Tampered assertion content (digest no longer matches) is rejected (SAML_DIGEST_MISMATCH)', () => {
  const xml = buildXml();
  const tampered = xml.replace('alice@example.com</saml2:NameID>', 'attacker@example.com</saml2:NameID>');
  assert.throws(() => verifySamlResponse(tampered, baseOptions()), (err: any) => err.code === 'SAML_DIGEST_MISMATCH');
});

test('12. Tampered SignatureValue (bit-flipped) is rejected (SAML_SIGNATURE_INVALID)', () => {
  const xml = buildXml();
  const tampered = xml.replace(/(<ds:SignatureValue>)([A-Za-z0-9+/=]{20})/, (_m, p1, p2) => `${p1}${p2.slice(0, -4)}AAAA`);
  assert.throws(() => verifySamlResponse(tampered, baseOptions()), (err: any) => err.code === 'SAML_SIGNATURE_INVALID' || err.code === 'SAML_DIGEST_MISMATCH');
});

test('13. XML Signature Wrapping: a second, attacker-injected Assertion alongside the legitimately-signed one is rejected outright (SAML_MULTIPLE_ASSERTIONS), never processed as if only the signed one existed', () => {
  const legit = buildXml();
  const forgedAssertion = legit.match(/<saml2:Assertion[\s\S]*?<\/saml2:Assertion>/)![0].replace(/ID="[^"]*"/, 'ID="_forged"').replace('alice@example.com', 'attacker@example.com').replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '');
  const wrapped = legit.replace('</saml2p:Response>', `${forgedAssertion}</saml2p:Response>`);
  assert.throws(() => verifySamlResponse(wrapped, baseOptions()), (err: any) => err.code === 'SAML_MULTIPLE_ASSERTIONS');
});

test('14. XML Signature Wrapping variant: a duplicated legitimate assertion (same content copied twice) is also rejected outright (SAML_MULTIPLE_ASSERTIONS)', () => {
  const legit = buildXml();
  const assertionXml = legit.match(/<saml2:Assertion[\s\S]*?<\/saml2:Assertion>/)![0];
  const wrapped = legit.replace('</saml2p:Response>', `${assertionXml}</saml2p:Response>`);
  assert.throws(() => verifySamlResponse(wrapped, baseOptions()), (err: any) => err.code === 'SAML_MULTIPLE_ASSERTIONS');
});

test('15. Reference URI not pointing at the Assertion\'s own ID is rejected (SAML_SIGNATURE_MALFORMED) — defends against a signature that covers different content than what is being interpreted', () => {
  const xml = buildXml();
  const tampered = xml.replace(/Reference URI="#_assert\d+"/, 'Reference URI="#_different_id"');
  assert.throws(() => verifySamlResponse(tampered, baseOptions()), (err: any) => err.code === 'SAML_SIGNATURE_MALFORMED');
});

test('16. Missing Conditions element is rejected (SAML_ASSERTION_MALFORMED)', () => {
  const xml = buildXml().replace(/<saml2:Conditions[\s\S]*?<\/saml2:Conditions>/, '');
  assert.throws(() => verifySamlResponse(xml, baseOptions()), (err: any) => err.code === 'SAML_ASSERTION_MALFORMED' || err.code === 'SAML_DIGEST_MISMATCH');
});
