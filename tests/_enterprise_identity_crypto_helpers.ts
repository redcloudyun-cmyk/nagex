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

const FALLBACK_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDsM5jksWM1hNeo\nXH836z2VGmJT5ON3zGUqzmOeJtk1KCG56mNgVLpzB1G65uW30bz75ObeXxzkz7Av\nSdOmF0WE+2zb0Fr64f5azdEn0OfiuQgizOvQp8j1Ab/+AbwkjEJNG2+GqQgPpOUU\nCXBxZvuDGo1I8tFWQO+NwxQIJItTIS/qTU3HDyVDCcTLh0l8Hm0RezVbSL530TFD\ntI4tlvFp9PlvPCypw3ochLRDnzACsUfOAULo09equHvAkPd3rnifPecwunvax3gh\nHl/w7HWyA+cV8ma8XPJAAXiua9WloKyAfD5BY90n5xZw2y99nGrlebPE5EjcMgJc\nE+nb2Za5AgMBAAECggEANyFJ5+LxXX3+mfjQ5rvc2U7ZsWwknYMS/91BShoWK36M\n9Khc/pB4Hj4QmPeomXF2UzLXogKAK3XAUSFBqawX2VSX0Wx9t74E0KvmTA1J+lSm\nrfy3c7GdyXXZmo9MGxmzpeyn6L3OOFyL7VPQr19SiASsAmFOc/vfDe8A32+sJ0AO\ncXYIQTCxpO6GxHXi98yxTr8GuewaLSRVOrgvuRqdZyMXDtoEwXdHsa6W8NpE0I4t\ncVhuUIRmu6JHx3DukCJhEkrWhjAvQRXBDiHKhnKRtXTIwppH0bv+LnJbUZnnK41m\n7kwNZuz3k7ih35w27ofCRD8eLZyI6NjdkeD4U2xNewKBgQD55LIP94GtDFXndvI3\nBmMMyvu60d8OtwZ8Zw3tYfmWOh9XhPJsRV04J08wCm7t92zpQFIjxqiRxRx3sANx\nrBdmatuhsJwNoTrdyt339D2nS2XvOqIvY2nPXeG3KwnxCUm7C2hUDwSOPyY2DwkJ\n1ndNPfgqtxm4VjcTjt8701zuFwKBgQDx+T9VOHIIrxBiqki3Scfo0N1KvXKODSYl\nHeWjukdvKClGZ43/oP2ynarbnnZHKwpLxF7e2her0VNKq2XVX4cVvcuNK9vUyTWs\nrEbFhQ2plwRr5YnMFk1nCoPwzzea9x8/HeJflRlrVPbF0XkAusGXUuqjRm4hzy2g\nimdpQCXzrwKBgQD3nPgfwCW7fgylFYS+p1KAe6XiIVGAODVyEX+IZ9uzUxZ5V2AL\njtPm73SU6tGudMxzd+usTY39Gy6xHjTbbyWks1+8IM8Q5mD5Iqq9pkNtQNXZreTF\nRiGze5hMMpZgQ87OS2huWo8uED7htBZFrEB8xlngoZwXvz5F3/0tP6vGswKBgH4j\npLRUPH3yZORKSKXjvGbNms5/e9w5Vo06zJ9RWDPGB94/1XJRBm+6aXsbXCU1dqSQ\ntbQOlRBoirb+KpPUvKLE0fvBxVNjoKtnE22cMscZhqCIhBDz/12bybQbEa2i7ZMF\njSCupRWisRHmZOHQeWLdQpvi9z6AthRekhH38tDZAoGBAO4q9x79fYaJaBOS05CS\nIZc1JLkXUST2P1n6Fa6Sz66VNF6E+4ntQayksPQ9shNiyaFdKE6vWueaaEwfE4Xr\nQG4zl/Xn1kyULqgoNELRMH4YFDdpQiFShzRNgYZs2RqkdETiwcM8ALxDWVt0QD/L\nEuVnd0phtl6Sl5DxDRdB7bJ5\n-----END PRIVATE KEY-----\n';

const FALLBACK_CERTIFICATE_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIDEzCCAfugAwIBAgIUEzvi78xXp/uaYkIaj22ttrTl+RQwDQYJKoZIhvcNAQEL\nBQAwGTEXMBUGA1UEAwwObmFnZXgtdGVzdC1pZHAwHhcNMjYwOTE3MTIwODE1WhcN\nMzYwOTE4MTIwODE1WjAZMRcwFQYDVQQDDA5uYWdleC10ZXN0LWlkcDCCASIwDQYJ\nKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOwzmOSxYzWE16hcfzfrPZUaYlPk43fM\nZSrOY54m2TUoIbnqY2BUunMHUbrm5bfRvPvk5t5fHOTPsC9J06YXRYT7bNvQWvrh\n/lrN0SfQ5+K5CCLM69CnyPUBv/4BvCSMQk0bb4apCA+k5RQJcHFm+4MajUjy0VZA\n743DFAgki1MhL+pNTccPJUMJxMuHSXwebRF7NVtIvnfRMUO0ji2W8Wn0+W88LKnD\nehyEtEOfMAKxR84BQujT16q4e8CQ93eueJ895zC6e9rHeCEeX/DsdbID5xXyZrxc\n8kABeK5r1aWgrIB8PkFj3SfnFnDbL32cauV5s8TkSNwyAlwT6dvZlrkCAwEAAaNT\nMFEwHQYDVR0OBBYEFKMbHXViEPgxQw7a8PdXBDG9IcqnMB8GA1UdIwQYMBaAFKMb\nHXViEPgxQw7a8PdXBDG9IcqnMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL\nBQADggEBAN8YjDUZ0NLdvjGduWEUq1pbyd5+XLiL6Z+tK7dZ5jlXOZ6mYfAhwaHV\n9yobanYwBQrw5qUAjCb6wZmhsp2oQlPFGMMDDUJdX+iDSAOTLRyjbVeSrfFjGmWr\nFhmrgT9AptWFW2r58stG4GwlT3y52msjTgv7xKLMuPCfP0DY/TSqc7PBESBmZd2P\nytLQSkOyQFUHUkTapW1kgLRVkYg7ZwdBrxFMttIuiamVcmo3NVbTTRDxvMfImVlY\nFWm5ew6u52BtBXjlG3UsIikRHUDFxGIpNQ//2Gl+Wb33SOkBbMpXiPUTXGldiEhd\noGbKDSu/Gt0wMcACPbPXr14jAW9GM5M=\n-----END CERTIFICATE-----\n';

function findOpensslBinary(): string | null {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // ignore
    }
  }
  return null;
}

export function generateTestIdpKeys(kid = 'test-key-1'): TestIdpKeys {
  const opensslBin = findOpensslBinary();
  let privateKey: crypto.KeyObject;
  let publicKey: crypto.KeyObject;
  let certificatePem: string;

  if (opensslBin) {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    certificatePem = createSelfSignedCertificateSync(opensslBin, privateKey);
  } else {
    privateKey = crypto.createPrivateKey(FALLBACK_PRIVATE_KEY_PEM);
    publicKey = crypto.createPublicKey(FALLBACK_PRIVATE_KEY_PEM);
    certificatePem = FALLBACK_CERTIFICATE_PEM;
  }

  const jwkPublic = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const jwk = { kty: 'RSA', kid, n: jwkPublic.n, e: jwkPublic.e, alg: 'RS256', use: 'sig' };

  return { privateKey, publicKey, jwk, certificatePem };
}

function createSelfSignedCertificateSync(opensslBin: string, privateKey: crypto.KeyObject): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-test-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  fs.writeFileSync(keyPath, keyPem);
  execFileSync(opensslBin, ['req', '-new', '-x509', '-key', keyPath, '-out', certPath, '-days', '365', '-subj', '/CN=nagex-test-idp'], { stdio: 'pipe' });
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
