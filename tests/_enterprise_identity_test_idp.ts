// R16 real-browser certification — a minimal but REAL OIDC + SAML test
// IdP HTTP server. Issues genuinely signed tokens/assertions (via
// tests/_enterprise_identity_crypto_helpers.ts's real RSA keypair) and
// serves a real login form a real Chromium browser fills in — NAgex's own
// OIDC/SAML client code is exercised end to end against real network
// responses, nothing about the verification path is stubbed. This is
// test-only infrastructure, the same pattern any OIDC/SAML client test
// suite uses without a live external IdP account.
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { generateTestIdpKeys, signJwt, buildSignedSamlResponse, type TestIdpKeys } from './_enterprise_identity_crypto_helpers.js';

export interface TestIdp {
  origin: string;
  keys: TestIdpKeys;
  oidcIssuer: string;
  oidcAuthorizationEndpoint: string;
  oidcTokenEndpoint: string;
  oidcJwksUri: string;
  samlSsoUrl: string;
  samlEntityId: string;
  close: () => Promise<void>;
}

interface PendingOidcAuth {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export async function startTestIdp(defaultUserEmail = 'sso.user@corp.example.com'): Promise<TestIdp> {
  const keys = generateTestIdpKeys();
  const pendingAuth = new Map<string, PendingOidcAuth>(); // code -> pending auth
  const samlRequests = new Map<string, string>(); // relayState -> AuthnRequest id (extracted from SAMLRequest)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    try {
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const params = url.searchParams;
        const html = `<!doctype html><html><body>
          <h1>Test IdP Login</h1>
          <form method="POST" action="/authorize">
            <input type="hidden" name="client_id" value="${escapeHtml(params.get('client_id') || '')}">
            <input type="hidden" name="redirect_uri" value="${escapeHtml(params.get('redirect_uri') || '')}">
            <input type="hidden" name="state" value="${escapeHtml(params.get('state') || '')}">
            <input type="hidden" name="nonce" value="${escapeHtml(params.get('nonce') || '')}">
            <input type="hidden" name="code_challenge" value="${escapeHtml(params.get('code_challenge') || '')}">
            <label for="idp-email">Email</label>
            <input type="email" id="idp-email" name="email" value="${escapeHtml(defaultUserEmail)}">
            <button type="submit" id="idp-login-submit">Sign in</button>
          </form>
        </body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (url.pathname === '/authorize' && req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const code = crypto.randomBytes(16).toString('hex');
        pendingAuth.set(code, {
          clientId: params.get('client_id') || '',
          redirectUri: params.get('redirect_uri') || '',
          state: params.get('state') || '',
          nonce: params.get('nonce') || '',
          codeChallenge: params.get('code_challenge') || '',
        });
        (pendingAuth.get(code) as any).email = params.get('email') || defaultUserEmail;
        const redirectUrl = new URL(params.get('redirect_uri') || '');
        redirectUrl.searchParams.set('code', code);
        redirectUrl.searchParams.set('state', params.get('state') || '');
        res.writeHead(302, { Location: redirectUrl.toString() });
        res.end();
        return;
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const code = params.get('code') || '';
        const pending = pendingAuth.get(code);
        if (!pending) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        pendingAuth.delete(code); // one-time use
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(keys, {
          iss: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          sub: `sub-${crypto.createHash('sha256').update((pending as any).email).digest('hex').slice(0, 12)}`,
          aud: pending.clientId,
          exp: now + 300,
          iat: now,
          nonce: pending.nonce,
          email: (pending as any).email,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id_token: idToken, access_token: 'test-access-token', token_type: 'Bearer' }));
        return;
      }

      if (url.pathname === '/jwks' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [keys.jwk] }));
        return;
      }

      // ── SAML ──
      if (url.pathname === '/saml/sso' && req.method === 'GET') {
        const samlRequest = url.searchParams.get('SAMLRequest') || '';
        const relayState = url.searchParams.get('RelayState') || '';
        const xml = zlib.inflateRawSync(Buffer.from(samlRequest, 'base64')).toString('utf8');
        const idMatch = /ID="([^"]+)"/.exec(xml);
        const acsMatch = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml);
        if (idMatch) samlRequests.set(relayState, idMatch[1]);
        const html = `<!doctype html><html><body>
          <h1>Test IdP SAML Login</h1>
          <form method="POST" action="/saml/sso">
            <input type="hidden" name="RelayState" value="${escapeHtml(relayState)}">
            <input type="hidden" name="acs" value="${escapeHtml(acsMatch ? acsMatch[1] : '')}">
            <label for="idp-saml-email">Email</label>
            <input type="email" id="idp-saml-email" name="email" value="${escapeHtml(defaultUserEmail)}">
            <button type="submit" id="idp-saml-login-submit">Sign in</button>
          </form>
        </body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (url.pathname === '/saml/sso' && req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const relayState = params.get('RelayState') || '';
        const acsUrl = params.get('acs') || '';
        const email = params.get('email') || defaultUserEmail;
        const inResponseTo = samlRequests.get(relayState) || '';
        const idpOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const audienceMatch = /(https?:\/\/[^/]+)\/api\/v1\/auth\/saml\/metadata/.exec(acsUrl);
        const audience = audienceMatch ? `${audienceMatch[1]}/api/v1/auth/saml/metadata` : acsUrl;
        const responseXml = buildSignedSamlResponse({
          keys,
          responseId: `_resp_${crypto.randomBytes(8).toString('hex')}`,
          assertionId: `_assert_${crypto.randomBytes(8).toString('hex')}`,
          issuer: `${idpOrigin}/saml`,
          audience,
          recipient: acsUrl,
          inResponseTo,
          nameId: email,
          attributes: { email },
        });
        const encoded = Buffer.from(responseXml, 'utf8').toString('base64');
        const html = `<!doctype html><html><body onload="document.forms[0].submit()">
          <form method="POST" action="${escapeHtml(acsUrl)}">
            <input type="hidden" name="SAMLResponse" value="${escapeHtml(encoded)}">
            <input type="hidden" name="RelayState" value="${escapeHtml(relayState)}">
          </form>
        </body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    keys,
    oidcIssuer: origin,
    oidcAuthorizationEndpoint: `${origin}/authorize`,
    oidcTokenEndpoint: `${origin}/token`,
    oidcJwksUri: `${origin}/jwks`,
    samlSsoUrl: `${origin}/saml/sso`,
    samlEntityId: `${origin}/saml`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
