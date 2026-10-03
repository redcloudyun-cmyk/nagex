// Security Gate S1 — source contract for the identity boundary. Behavior is proven end-to-end in
// security_s1_identity_boundary.test.ts; this file keeps the CODE from drifting back (a route that reads
// a client identity header, a default principal, a second cookie parser, a handler outside the error
// boundary). Implementation-coupled by design.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');
const routeFiles = fs.readdirSync(path.join(process.cwd(), 'src/http/routes')).filter((f) => f.endsWith('.routes.ts')).map((f) => `src/http/routes/${f}`);

describe('S1 — no route derives identity from the client', () => {
  it('no route module reads X-Principal-Id / X-NAgex-Tenant (or any x-tenant/x-user header)', () => {
    const offenders = routeFiles.filter((f) => /x-principal-id|x-nagex-tenant|x-tenant-id|x-user-id/i.test(code(f)));
    assert.deepEqual(offenders, []);
  });
  it('no route module falls back to a default principal or tenant', () => {
    const offenders: string[] = [];
    for (const f of routeFiles) {
      const src = code(f);
      // governance.routes.ts keeps one legacy SEED RECORD (data, not authority) naming the old default tenant.
      const scrubbed = f.endsWith('governance.routes.ts') ? src.replace(/tenant_id: 'ten_production_01',/, '') : src;
      if (/usr_admin_001|ten_production_01|DEFAULT_GOOGLE_TENANT_ID|DEFAULT_GOOGLE_PRINCIPAL_ID|'usr_default'|'default-tenant'|'default-user'|usr_anonymous/.test(scrubbed)) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
  });
  it('routes obtain the caller only through callerIdentity()/tryGetCallerIdentity()/resolveAuthenticatedIdentity()', () => {
    const legacyReaders = routeFiles.filter((f) => /getHeaderValue\(headers, 'x-(nagex-tenant|principal-id)'\)/.test(code(f)));
    assert.deepEqual(legacyReaders, []);
    const usingCaller = routeFiles.filter((f) => /callerIdentity\(|tryGetCallerIdentity\(|resolveAuthenticatedIdentity\(|getSessionIdFromHeaders\(/.test(code(f)));
    assert.ok(usingCaller.length >= 40, `expected the route modules to use the verified-caller API (found ${usingCaller.length})`);
  });
  it('the verified-identity registry is module-private and clients cannot reach the demo grant', () => {
    const src = code('src/http/request-identity.ts');
    assert.doesNotMatch(src, /export (const|let|var) VERIFIED_CALLER/);
    assert.match(src, /const VERIFIED_CALLER = new WeakMap/);
    assert.match(src, /CLIENT_IDENTITY_HEADERS = new Set\(\['x-nagex-tenant', 'x-principal-id', 'x-tenant-id', 'x-user-id'\]\)/);
    assert.doesNotMatch(src, /usr_admin_001|ten_production_01|DEFAULT_GOOGLE/);
    assert.doesNotMatch(src, /headers\[['"]x-(principal-id|nagex-tenant)['"]\]/, 'request-identity must never READ an identity header');
  });
  it('there is no built-in admin by name', () => {
    const src = code('src/identity/permission.registry.ts');
    assert.doesNotMatch(src, /usr_admin_001|'admin'/);
    assert.match(src, /NAGEX_BUILTIN_ADMIN_PRINCIPALS/);
  });
  it('services no longer default a missing principal to the default admin', () => {
    for (const f of ['src/modules/gmail/gmail.service.ts', 'src/modules/calendar/google-calendar.service.ts']) {
      assert.doesNotMatch(code(f), /DEFAULT_GOOGLE_PRINCIPAL_ID/, f);
    }
    for (const f of ['src/integrations/telegram/telegram-identity.store.ts', 'src/integrations/slack/slack-identity.store.ts']) {
      assert.doesNotMatch(code(f), /ten_production_01/, `${f}: an unlinked channel user must not land in the default tenant`);
    }
  });
  it('the shipped frontend no longer sends or hard-codes a default identity', () => {
    for (const f of ['public/app.js', 'public/desktop-quickwake.js', 'public/meeting-prep-view.js', 'public/personal-home-view.js']) {
      const src = read(f);
      assert.doesNotMatch(src, /['"]x-principal-id['"]|['"]x-nagex-tenant['"]/i, f);
      assert.doesNotMatch(src, /usr_admin_001/, f);
    }
  });
});

describe('S1 — one credential parser, and nothing outside the error boundary', () => {
  it('exactly one session-cookie parser exists and none of the route modules decodes the cookie itself', () => {
    const defs = [...routeFiles, 'src/http/request-identity.ts', 'src/http/session-credential.ts', 'src/server_web.ts'].filter((f) => /function getSessionIdFromHeaders\(/.test(code(f)));
    assert.deepEqual(defs, ['src/http/session-credential.ts']);
    const rawCookieRegex = [...routeFiles, 'src/http/request-identity.ts', 'src/server_web.ts'].filter((f) => /nagex_session=\(/.test(code(f)) || /match\(\/\(\?:\^\|;\\s\*\)nagex_session/.test(code(f)));
    assert.deepEqual(rawCookieRegex, []);
  });
  it('the parser guards decodeURIComponent', () => {
    const src = code('src/http/session-credential.ts');
    assert.match(src, /try \{\s*decoded = decodeURIComponent\(raw\);\s*\} catch \{\s*return null;\s*\}/);
  });
  it('server_web canonicalizes INSIDE the async entry try-block and guards both entry points with the access policy', () => {
    const src = code('src/server_web.ts');
    const asyncStart = src.indexOf('export async function handleAsyncApiRequest');
    const firstCanon = src.indexOf('canonicalizeRequestHeaders(', asyncStart);
    const tryBetween = src.slice(asyncStart, firstCanon);
    assert.match(tryBetween, /\btry \{\s*$/m, 'canonicalizeRequestHeaders must run inside the try block');
    assert.equal((src.match(/denyIfUnauthorized\(/g) || []).length >= 2, true, 'both HTTP entry points must apply the access policy');
    assert.doesNotMatch(src, /'ten_production_01'|'usr_admin_001'/);
  });
  it('the HTTP request handler is wrapped so an unexpected throw is a failed REQUEST, not a dead process', () => {
    const src = code('src/server_web.ts');
    assert.match(src, /return http\.createServer\(\(req, res\) => \{\s*try \{\s*handleHttpRequest\(req, res\);\s*\} catch \(error\) \{\s*failRequest\(res, error\);/);
    assert.match(src, /\}\)\(\)\.catch\(\(error\) => failRequest\(res, error\)\);/);
  });
});

describe('S1 — the access policy is default-deny and explicit', () => {
  it('route-access.ts ends in a deny, and every anonymous exemption is a named rule with a reason', () => {
    const src = read('src/http/route-access.ts');
    assert.match(src, /return AUTHENTICATION_REQUIRED_RESULT\(\);\s*\n\}/);
    assert.match(src, /DEFAULT DENY/);
    const ruleCount = (src.match(/^  rule\(/gm) || []).length;
    assert.ok(ruleCount >= 30, `expected an explicit rule table (found ${ruleCount})`);
  });
  it('the demo persona is a server constant and is granted only on GET + allow-list', () => {
    const src = code('src/http/route-access.ts');
    assert.match(src, /isDemoRequest\(headers\) && method\.toUpperCase\(\) === 'GET' && DEMO_READ_ROUTES\.some/);
    assert.equal(fs.readFileSync(path.join(process.cwd(), 'src/demo/demo-identity.ts'), 'utf8').includes("DEMO_TENANT_ID = 'ten_demo_hackathon'"), true);
  });
});
