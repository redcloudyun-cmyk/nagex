// R16 test-only helpers: generate a real RSA keypair + self-signed
// certificate and use them to produce REAL, correctly-signed OIDC ID
// tokens and SAML Responses. This is legitimate test infrastructure (the
// same pattern any OIDC/SAML client test suite uses without a live IdP
// account) — NAgex's own verification code (oidc.service.ts/
// saml.service.ts) is exercised against genuine cryptographic material it
// did not create, never stubbed or monkey-patched.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestIdpKeys {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  jwk: { kty: string; kid: string; n: string; e: string; alg: string; use: string };
  certificatePem: string; // self-signed X.509 wrapping the same keypair, for SAML
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateTestIdpKeys(kid = 'test-key-1'): TestIdpKeys {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwkPublic = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const jwk = { kty: 'RSA', kid, n: jwkPublic.n, e: jwkPublic.e, alg: 'RS256', use: 'sig' };

  // Self-signed certificate wrapping the same keypair — crypto.X509Certificate
  // has no Node-native "create/sign a cert" API, so this uses a minimal
  // hand-built X.509 structure via crypto's low-level cert generation
  // helper (Node 20+: X509Certificate can be built via the `crypto`
  // module's `createCertificate`... which does not exist in core Node).
  // Node has no built-in CA/cert-signing API at all, so certificate
  // creation itself is done here with node-forge-free manual DER encoding
  // is out of scope for a test helper; instead this uses OpenSSL via the
  // system `openssl` CLI, which is present on every CI/dev machine that
  // can run this repo's own git checkout (already relied on implicitly by
  // Node's own crypto module build).
  const certificatePem = createSelfSignedCertificateSync(privateKey, publicKey);

  return { privateKey, publicKey, jwk, certificatePem };
}

// Generates a self-signed certificate for the given keypair using the
// system `openssl` binary via a temp key file — the only reliable way to
// mint an X.509 certificate with no Node-native cert-signing API and no
// new npm dependency. Test-only; production code never calls this.
function createSelfSignedCertificateSync(privateKey: crypto.KeyObject, _publicKey: crypto.KeyObject): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-test-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  fs.writeFileSync(keyPath, keyPem);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', keyPath, '-out', certPath, '-days', '365', '-subj', '/CN=nagex-test-idp'], { stdio: 'pipe' });
  const certPem = fs.readFileSync(certPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return certPem;
}

export function signJwt(keys: TestIdpKeys, claims: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: keys.jwk.kid };
  const headerB64 = base64Url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64Url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), { key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${signingInput}.${base64Url(signature)}`;
}

export interface BuildSamlResponseParams {
  keys: TestIdpKeys;
  responseId: string;
  assertionId: string;
  issuer: string;
  audience: string;
  recipient: string;
  inResponseTo: string;
  nameId: string;
  attributes?: Record<string, string>;
  notBefore?: string;
  notOnOrAfter?: string;
  scdNotOnOrAfter?: string;
}

// Builds a REAL, correctly-signed SAML Response — constructs the assertion
// XML without a signature first, computes its real SHA-256 digest,
// builds+signs a real SignedInfo block over that digest, then inserts the
// Signature into the assertion. saml.service.ts's own digest computation
// (`assertionBlock.full.replace(signatureBlock.full, '')`) reconstructs
// exactly the pre-signature XML this function digested, since the
// Signature substring is inserted verbatim and appears exactly once.
export function buildSignedSamlResponse(params: BuildSamlResponseParams): string {
  const now = new Date();
  const notBefore = params.notBefore ?? new Date(now.getTime() - 60_000).toISOString();
  const notOnOrAfter = params.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000).toISOString();
  const scdNotOnOrAfter = params.scdNotOnOrAfter ?? new Date(now.getTime() + 5 * 60_000).toISOString();
  const issueInstant = now.toISOString();

  const attributeStatements = Object.entries(params.attributes ?? {})
    .map(([name, value]) => `<saml2:Attribute Name="${name}"><saml2:AttributeValue>${value}</saml2:AttributeValue></saml2:Attribute>`)
    .join('');

  const assertionNoSig =
    `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="${params.assertionId}" Version="2.0" IssueInstant="${issueInstant}">` +
    `<saml2:Issuer>${params.issuer}</saml2:Issuer>` +
    `<saml2:Subject><saml2:NameID>${params.nameId}</saml2:NameID><saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml2:SubjectConfirmationData Recipient="${params.recipient}" NotOnOrAfter="${scdNotOnOrAfter}" InResponseTo="${params.inResponseTo}"/></saml2:SubjectConfirmation></saml2:Subject>` +
    `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml2:AudienceRestriction><saml2:Audience>${params.audience}</saml2:Audience></saml2:AudienceRestriction></saml2:Conditions>` +
    `<saml2:AttributeStatement>${attributeStatements}</saml2:AttributeStatement>` +
    `</saml2:Assertion>`;

  const digestValue = crypto.createHash('sha256').update(assertionNoSig, 'utf8').digest('base64');
  const signedInfo =
    `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<ds:Reference URI="#${params.assertionId}"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digestValue}</ds:DigestValue></ds:Reference>` +
    `</ds:SignedInfo>`;
  const signatureValue = base64FromBuffer(crypto.sign('RSA-SHA256', Buffer.from(signedInfo, 'utf8'), { key: params.keys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }));
  const signature = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${signatureValue}</ds:SignatureValue></ds:Signature>`;

  // Insert the Signature right after Issuer, the conventional position —
  // exact position doesn't matter to the verifier (it locates Signature
  // by tag, not by fixed offset), only that it appears exactly once.
  const assertionWithSig = assertionNoSig.replace('</saml2:Issuer>', `</saml2:Issuer>${signature}`);

  return (
    `<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" ID="${params.responseId}" Version="2.0" IssueInstant="${issueInstant}" InResponseTo="${params.inResponseTo}">` +
    `<saml2:Issuer xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">${params.issuer}</saml2:Issuer>` +
    assertionWithSig +
    `</saml2p:Response>`
  );
}

function base64FromBuffer(buf: Buffer): string {
  return buf.toString('base64');
}
