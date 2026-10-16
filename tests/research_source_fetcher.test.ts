// What NAgex will and will not read from the web for a research report. Local HTTP fixtures only (127.0.0.1, enabled through the fetcher's test switch); no external site is contacted.
// The rules under test: robots.txt is obeyed (and an unreadable one means "do not fetch"), private / local / non-http destinations are refused, only readable text is taken, size and time are bounded,
// a rate-limited site is left alone, and the outcome always says what happened.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { extractReadablePage } from '../src/research/html-text.js';
import { parseRobots } from '../src/research/robots.js';
import { SourceFetcher } from '../src/research/source-fetcher.js';

const UA = 'NAgex-Research/1.0 (read-only personal research assistant)';

describe('robots.txt rules (RFC 9309)', () => {
  const rules = (text: string) => parseRobots(text, UA);
  it('a specific group wins over "*"; the longest matching pattern decides; Allow wins a tie', () => {
    const r = rules(['User-agent: *', 'Disallow: /', '', 'User-agent: nagex-research', 'Disallow: /private', 'Allow: /private/open', 'Disallow: /tie', 'Allow: /tie'].join('\n'));
    assert.equal(r.allows('/articles/1'), true);
    assert.equal(r.allows('/private/x'), false);
    assert.equal(r.allows('/private/open/page'), true);
    assert.equal(r.allows('/tie'), true);
  });
  it('falls back to "*" when no group names this crawler; wildcards and an end anchor work; an empty Disallow allows everything', () => {
    const r = rules(['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /search?', 'Disallow: /tmp/'].join('\n'));
    assert.equal(r.allows('/a/b.pdf'), false);
    assert.equal(r.allows('/a/b.pdf?x=1'), true, '$ anchors the end');
    assert.equal(r.allows('/search?q=1'), false);
    assert.equal(r.allows('/tmp/file'), false);
    assert.equal(r.allows('/news'), true);
    assert.equal(rules('User-agent: *\nDisallow:').allows('/anything'), true);
    assert.equal(rules('').allows('/anything'), true, 'nothing written, nothing forbidden');
  });
  it('comments, a byte order mark and other agents\' groups are ignored; Crawl-delay is read and capped', () => {
    const r = rules('﻿User-agent: googlebot # a comment\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 120\nDisallow: /x');
    assert.equal(r.allows('/y'), true, 'googlebot\'s group does not apply to NAgex');
    assert.equal(r.allows('/x'), false);
    assert.equal(r.crawlDelaySeconds, 10, 'capped');
  });
});

describe('readable text from HTML', () => {
  const PAGE = `<!doctype html><html><head><title>  AI &amp; Work &mdash; Report </title>
    <meta property="article:published_time" content="2026-03-02T09:30:00+09:00"><script>var secret = "do not read";</script><style>.a{}</style></head>
    <body><nav>Home | About | Login</nav><main><article><h1>Heading</h1>
    <p>First paragraph with &quot;quotes&quot; and a&nbsp;space and a figure of 12.5% growth.<sup class="reference"><a href="#r1">[1]</a></sup></p>
    <p>Second paragraph.</p><form><input name="q"><button>Search</button></form><script>alert(1)</script>
    <p>${'Filler sentence for length. '.repeat(30)}</p></article></main><footer>Copyright</footer></body></html>`;
  it('keeps what a person reads and drops scripts, styles, navigation, forms, footers and footnote markers', () => {
    const page = extractReadablePage(PAGE, 20000);
    assert.equal(page.title, 'AI & Work - Report');
    assert.match(page.text, /First paragraph with "quotes" and a space and a figure of 12\.5% growth\./);
    assert.doesNotMatch(page.text, /do not read|alert|Home \| About|Copyright|Search|\[1\]/);
    assert.equal(page.textTruncated, false);
  });
  it('reads the publication date the page declares (meta, JSON-LD, <time>); a date-only value stays a date; nothing is invented', () => {
    assert.equal(extractReadablePage(PAGE, 5000).publishedAt, '2026-03-02T00:30:00.000Z');
    assert.equal(extractReadablePage('<meta name="date" content="2026-01-15"><p>x</p>', 100).publishedAt, '2026-01-15');
    assert.equal(extractReadablePage('<script type="application/ld+json">{"@type":"Article","datePublished":"2025-12-31T10:00:00Z"}</script><p>x</p>', 100).publishedAt, '2025-12-31T10:00:00.000Z');
    assert.equal(extractReadablePage('<article><time datetime="2026-02-02">Feb 2</time><p>' + 'x'.repeat(500) + '</p></article>', 1000).publishedAt, '2026-02-02');
    assert.equal(extractReadablePage('<meta name="date" content="not a date"><p>x</p>', 100).publishedAt, undefined);
    assert.equal(extractReadablePage('<p>no date here</p>', 100).publishedAt, undefined);
  });
  it('cuts long text at a line boundary and says it was cut', () => {
    const long = '<p>' + Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join('</p><p>') + '</p>';
    const page = extractReadablePage(long, 2000);
    assert.equal(page.textTruncated, true);
    assert.ok(page.text.length <= 2000);
    assert.match(page.text, /\.$/, 'ends at a complete line');
  });
});

describe('SourceFetcher against a local site', () => {
  const requests: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
  let robotsBody: { status: number; body: string } = { status: 404, body: '' };
  let server: http.Server;
  let base = '';
  const ARTICLE = `<html><head><title>Fixture Article</title><meta name="date" content="2026-02-10"></head><body><article><p>${'The market for personal assistants grew 34% in 2025 according to the fixture. '.repeat(6)}</p></article></body></html>`;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      requests.push({ path: url.pathname, headers: req.headers });
      const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(body); };
      switch (url.pathname) {
        case '/robots.txt': return send(robotsBody.status, 'text/plain', robotsBody.body);
        case '/ok': return send(200, 'text/html; charset=utf-8', ARTICLE);
        case '/private/page': return send(200, 'text/html', ARTICLE);
        case '/missing': return send(404, 'text/html', 'nope');
        case '/pdf': return send(200, 'application/pdf', Buffer.from('%PDF-1.4'));
        case '/json': return send(200, 'application/json', '{}');
        case '/empty': return send(200, 'text/html', '<html><body><script>app()</script></body></html>');
        case '/big': return send(200, 'text/html', 'x', { 'Content-Length': '99999999' });
        case '/stream-big': { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<p>' + 'y'.repeat(4000) + '</p>'); res.write('<p>' + 'y'.repeat(4000) + '</p>'); return res.end(); }
        case '/moved': return send(302, 'text/plain', '', { Location: '/ok' });
        case '/loop': return send(302, 'text/plain', '', { Location: '/loop' });
        case '/limited': return send(429, 'text/plain', 'slow down', { 'Retry-After': '30' });
        case '/hang': return; // never answers
        case '/euckr': return send(200, 'text/html; charset=euc-kr', Buffer.concat([Buffer.from('<html><head><title>'), Buffer.from([0xb0, 0xed, 0xb0, 0xb4]), Buffer.from('</title></head><body><p>'), Buffer.from([0xc0, 0xce, 0xb0, 0xf8, 0xc1, 0xf6, 0xb4, 0xc9]), Buffer.from(' '.repeat(2) + 'text '.repeat(40) + '</p></body></html>')]));
        default: return send(404, 'text/plain', 'not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const fetcher = (extra: ConstructorParameters<typeof SourceFetcher>[0] = {}) => new SourceFetcher({ allowLocalTestDestinations: true, perHostIntervalMs: 0, timeoutMs: 1500, sleep: async () => {}, ...extra });
  const reset = (robots: { status: number; body: string } = { status: 404, body: '' }) => { requests.length = 0; robotsBody = robots; };

  it('reads a page: title, text, the date the page declares, the final address and a hash of the text it read', async () => {
    reset();
    const outcome = await fetcher().fetch(`${base}/ok`);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const s = outcome.source;
    assert.equal(s.title, 'Fixture Article');
    assert.match(s.text, /grew 34% in 2025/);
    assert.equal(s.publishedAt, '2026-02-10');
    assert.equal(s.robots, 'NO_ROBOTS_FILE');
    assert.equal(s.httpStatus, 200);
    assert.equal(s.contentHash, crypto.createHash('sha256').update(s.text).digest('hex'));
    assert.equal(s.finalUrl, `${base}/ok`);
  });

  it('identifies itself and sends no cookie or credential', async () => {
    reset();
    await fetcher().fetch(`${base}/ok`);
    for (const r of requests) {
      assert.equal(r.headers['user-agent'], UA);
      assert.equal(r.headers.cookie, undefined);
      assert.equal(r.headers.authorization, undefined);
    }
  });

  it('robots.txt is obeyed: a disallowed page is never requested; an Allow rule opens a path again', async () => {
    reset({ status: 200, body: 'User-agent: *\nDisallow: /private\nAllow: /private/page\nDisallow: /ok-not' });
    const open = await fetcher().fetch(`${base}/private/page`);
    assert.equal(open.ok, true, 'Allow is the longer match');
    reset({ status: 200, body: 'User-agent: *\nDisallow: /private' });
    const blocked = await fetcher().fetch(`${base}/private/page`);
    assert.deepEqual(blocked.ok ? null : blocked.code, 'ROBOTS_DISALLOWED');
    assert.equal(requests.some((r) => r.path === '/private/page'), false, 'the page itself was not requested');
  });

  it('a robots.txt that cannot be read means "do not fetch" (5xx, 403); a missing one (404) means "allowed"', async () => {
    for (const status of [500, 403, 401]) {
      reset({ status, body: 'error' });
      const outcome = await fetcher().fetch(`${base}/ok`);
      assert.equal(outcome.ok ? null : outcome.code, 'ROBOTS_UNREADABLE', String(status));
      assert.equal(requests.some((r) => r.path === '/ok'), false);
    }
    reset({ status: 404, body: '' });
    assert.equal((await fetcher().fetch(`${base}/ok`)).ok, true);
  });

  it('robots.txt is read once per site, not once per page', async () => {
    reset();
    const f = fetcher();
    await f.fetch(`${base}/ok`);
    await f.fetch(`${base}/moved`);
    assert.equal(requests.filter((r) => r.path === '/robots.txt').length, 1);
  });

  it('only readable text is taken; a PDF, JSON, an empty shell, an oversized or an endless page are reported, not guessed at', async () => {
    reset();
    const f = fetcher({ maxBytes: 5000 });
    const code = async (path: string) => { const o = await f.fetch(`${base}${path}`); return o.ok ? 'OK' : o.code; };
    assert.equal(await code('/pdf'), 'UNSUPPORTED_CONTENT');
    assert.equal(await code('/json'), 'UNSUPPORTED_CONTENT');
    assert.equal(await code('/empty'), 'UNSUPPORTED_CONTENT');
    assert.equal(await code('/big'), 'TOO_LARGE');
    assert.equal(await code('/stream-big'), 'TOO_LARGE');
    assert.equal(await code('/missing'), 'HTTP_ERROR');
  });

  it('redirects are followed (and checked again); a redirect loop ends; a silent site times out', async () => {
    reset();
    const moved = await fetcher().fetch(`${base}/moved`);
    assert.equal(moved.ok && moved.source.finalUrl, `${base}/ok`);
    const loop = await fetcher().fetch(`${base}/loop`);
    assert.equal(loop.ok ? null : loop.code, 'TOO_MANY_REDIRECTS');
    const hang = await fetcher({ timeoutMs: 250 }).fetch(`${base}/hang`);
    assert.equal(hang.ok ? null : hang.code, 'TIMEOUT');
  });

  it('a rate-limited site is left alone: HTTP 429 is reported and the site is not contacted again in this run', async () => {
    reset();
    const f = fetcher();
    const first = await f.fetch(`${base}/limited`);
    assert.equal(first.ok ? null : first.code, 'RATE_LIMITED');
    const before = requests.length;
    const second = await f.fetch(`${base}/ok`);
    assert.equal(second.ok ? null : second.code, 'RATE_LIMITED');
    assert.equal(requests.length, before, 'no further request was made');
  });

  it('requests to one site are spaced; the wait is bounded (a Crawl-delay is honoured)', async () => {
    reset({ status: 200, body: 'User-agent: *\nCrawl-delay: 2' });
    let clock = 1_000_000;
    const waits: number[] = [];
    const f = new SourceFetcher({ allowLocalTestDestinations: true, perHostIntervalMs: 500, timeoutMs: 1500, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    await f.fetch(`${base}/ok`);
    await f.fetch(`${base}/ok?again=1`);
    assert.ok(waits.some((w) => w >= 2000), `a 2 s Crawl-delay is waited out (waited ${waits.join(', ')})`);
    const impatient = new SourceFetcher({ allowLocalTestDestinations: true, perHostIntervalMs: 60_000, maxThrottleWaitMs: 1000, now: () => clock, sleep: async () => {} });
    await impatient.fetch(`${base}/ok?a=1`);
    const third = await impatient.fetch(`${base}/ok?a=2`);
    assert.equal(third.ok ? null : third.code, 'RATE_LIMITED', 'a page that would have to wait too long is skipped, not waited for');
  });

  it('decodes the page in its declared charset (EUC-KR)', async () => {
    reset();
    const outcome = await fetcher().fetch(`${base}/euckr`);
    assert.equal(outcome.ok, true);
    if (outcome.ok) { assert.equal(outcome.source.title, '고객'); assert.match(outcome.source.text, /^인공지능/); }
  });

  it('private, local and non-http destinations are refused before any connection is made', async () => {
    reset();
    const strict = new SourceFetcher({ perHostIntervalMs: 0, sleep: async () => {}, resolver: async (host) => (host === 'sneaky.example' ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]) });
    for (const url of [`${base}/ok`, 'http://localhost/ok', 'http://10.1.2.3/ok', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/ok', 'http://sneaky.example/ok', 'file:///etc/passwd', 'ftp://example.com/x', 'http://user:pw@example.com/x']) {
      const outcome = await strict.fetch(url);
      assert.equal(outcome.ok ? null : outcome.code, 'POLICY_BLOCKED', url);
    }
    assert.equal(requests.length, 0, 'nothing reached the local site');
  });
});
