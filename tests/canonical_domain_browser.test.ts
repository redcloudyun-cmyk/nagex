// The canonical address in a REAL browser against the production server: with only NAGEX_PUBLIC_URL (https://nagex.agex.site) and the sign-in credentials configured, "Continue with Google" and
// "Continue with Microsoft" send the browser to the provider with a redirect_uri on the canonical host (derived, not hard-coded); completing the sign-in with a scripted provider leaves a
// session cookie that is HttpOnly + Secure + SameSite=Lax and host-only, and the person lands signed in on Main. The identity providers are scripted (the browser's navigation to them is answered
// locally and the server's token calls are answered by a stub); NAgex's routes, sessions, front end and cookie handling are the real ones. Nothing leaves the machine.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;
declare const window: any;

const CANONICAL = 'https://nagex.agex.site';
const realFetch = globalThis.fetch;
let h: CanvasAskHarness;

before(async () => {
  // the sign-in addresses must come from NAGEX_PUBLIC_URL alone: remove any explicit redirect settings of the developer's shell
  for (const key of ['NAGEX_GOOGLE_LOGIN_REDIRECT_URI', 'NAGEX_MICROSOFT_LOGIN_REDIRECT_URI', 'GOOGLE_REDIRECT_URI', 'GITHUB_REDIRECT_URI']) delete process.env[key];
  // the providers' token / userinfo endpoints (called by the SERVER) are answered by a stub; everything else is untouched
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'idt', access_token: 'at' }), { status: 200 });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return new Response(JSON.stringify({ sub: 'g-sub-canonical', email: 'canonical.google@example.test', email_verified: true, name: 'Canonical Google' }), { status: 200 });
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') return new Response(JSON.stringify({ id_token: 'idt', access_token: 'at' }), { status: 200 });
    if (url === 'https://graph.microsoft.com/oidc/userinfo') return new Response(JSON.stringify({ sub: 'm-sub-canonical', email: 'canonical.microsoft@example.test', name: 'Canonical Microsoft' }), { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
  h = await startCanvasAskHarness({
    scrubProviders: true,
    env: {
      NAGEX_PUBLIC_URL: CANONICAL,
      NAGEX_GOOGLE_LOGIN_CLIENT_ID: 'google-client', NAGEX_GOOGLE_LOGIN_CLIENT_SECRET: 'google-secret',
      NAGEX_MICROSOFT_LOGIN_CLIENT_ID: 'microsoft-client', NAGEX_MICROSOFT_LOGIN_CLIENT_SECRET: 'microsoft-secret',
    },
  });
});
after(async () => { await h?.close(); globalThis.fetch = realFetch; });

describe('sign-in addresses come from NAGEX_PUBLIC_URL', () => {
  for (const [provider, host, button, label, expectedPath] of [
    ['google', 'accounts.google.com', '#btn-auth-google', 'Continue with Google', '/api/v1/auth/oauth/google/callback'],
    ['microsoft', 'login.microsoftonline.com', '#btn-auth-microsoft', 'Continue with Microsoft', '/api/v1/auth/oauth/microsoft/callback'],
  ] as const) {
    it(`${provider}: the button leads to the provider with the canonical redirect_uri; finishing the sign-in sets a host-only Secure HttpOnly Lax session cookie and opens Main`, async () => {
      const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
      const page = await ctx.newPage();
      let authorize: URL | null = null;
      // NOTHING leaves the machine. The sign-in start route is fetched WITHOUT following its redirect (the Location is the provider's authorize URL, recorded here) and the browser is given a local
      // page instead; any other request to a host that is not the local server is blocked and listed.
      const external: string[] = [];
      await ctx.route('**/api/v1/auth/oauth/*/start', async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers()['location'];
        if (location) authorize = new URL(location);
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>provider</title>' });
      });
      await ctx.route((url) => url.hostname !== '127.0.0.1', (route) => { external.push(route.request().url()); return route.abort(); });
      await page.goto(h.origin, { waitUntil: 'domcontentloaded' });
      // the sign-in dialog of the front end (the same call the header's "Sign in" button makes)
      await page.waitForFunction(() => Boolean((window as any).NAGEX && (window as any).NAGEX.showAuthModal), undefined, { timeout: 20000 });
      await page.evaluate(() => (window as any).NAGEX.showAuthModal('signin'));
      await page.waitForSelector(button, { timeout: 20000 });
      assert.match(await page.locator(button).innerText(), new RegExp(label));
      await page.click(button);
      await page.waitForFunction(() => document.title === 'provider', undefined, { timeout: 15000 });
      assert.ok(authorize, `the browser reached the provider (now at ${page.url()})`);
      // (the page's own web-font stylesheet is the only outside address the front end asks for; it is blocked too)
      assert.deepEqual(external.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), [], 'no identity provider or anything else outside the local server was contacted');
      assert.equal(new URL((authorize as unknown as URL).href).hostname, host, 'the redirect leads to the provider');
      const params = (authorize as unknown as URL).searchParams;
      assert.equal(params.get('redirect_uri'), `${CANONICAL}${expectedPath}`, 'derived from NAGEX_PUBLIC_URL, not from the host the browser used');
      assert.equal(params.get('response_type'), 'code');
      assert.equal(params.get('scope'), 'openid email profile', 'identity only');
      assert.equal(params.get('prompt'), 'select_account');
      const state = params.get('state');
      assert.ok(state && state.length >= 16);

      // the provider sends the person back (to the server that is actually running here - the canonical host is the registered address, the dev server answers on loopback)
      await page.goto(`${h.origin}${expectedPath}?state=${encodeURIComponent(state!)}&code=test-code`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#main-surface-input', { timeout: 20000 });
      const cookie = (await ctx.cookies()).find((c) => c.name === 'nagex_session');
      assert.ok(cookie, 'a session cookie was set');
      assert.equal(cookie!.httpOnly, true);
      assert.equal(cookie!.secure, true);
      assert.equal(cookie!.sameSite, 'Lax');
      assert.equal(cookie!.path, '/');
      assert.equal(cookie!.domain, '127.0.0.1', 'host-only: no Domain attribute, so the cookie belongs to this host alone');
      assert.equal(await page.evaluate(() => document.cookie.includes('nagex_session')), false, 'script cannot read it');

      // the same state cannot be replayed
      const replay = await ctx.request.get(`${h.origin}${expectedPath}?state=${encodeURIComponent(state!)}&code=test-code`, { maxRedirects: 0 });
      assert.match(replay.headers().location ?? '', /status=error/);
      await ctx.close();
    });
  }
});
