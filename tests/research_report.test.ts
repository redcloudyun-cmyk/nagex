// "Research this with sources and give me a report." What makes the report trustworthy is decided by NAgex, not by the model: a claim is admitted only if its quote is in a page that was actually retrieved,
// a figure only if the quote contains it, and every citation marker in the report is generated from a retrieved source. These tests drive the whole workflow (search -> retrieve -> verify -> compose ->
// document -> provenance) with a scripted model, a stand-in search provider and real pages served from 127.0.0.1; no external site, model or search provider is contacted. A live run with a configured
// provider is part of the sprint evidence, not of this file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { CLAIM_LIMITS, normalizeForMatch, relevantExcerpt, significantNumbers, validateConflicts, verifyClaims } from '../src/research/claim-verification.js';
import { composeResearchReport } from '../src/research/report-composer.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { buildDocx } from '../src/creation/docx/docx-writer.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { handleDocumentCreationRoutes } from '../src/http/routes/document-creation.routes.js';
import { handleResearchRoutes } from '../src/http/routes/research.routes.js';
import type { EvidencePack, EvidenceSource } from '../src/research/evidence-pack.types.js';
import { OpenKnowledgeSearchProvider } from '../src/research/providers/open-knowledge-search.provider.js';
import { ResearchReportService } from '../src/research/research-report.service.js';
import { ResearchRunStore } from '../src/research/research-run.store.js';
import type { ResearchClaimRecord, ResearchSourceRecord } from '../src/research/research-run.types.js';
import { SourceFetcher } from '../src/research/source-fetcher.js';
import { authAs } from './_s1_session_auth.js';

// ---------------------------------------------------------------------------------------------------------------- claims

describe('which claims are admitted', () => {
  const text = 'The market for enterprise AI assistants reached $48 billion in 2025, up 31% from 2024 [3]. Adoption among small businesses is expected to double by 2027.\n인공지능 비서 시장은 2025년에 32% 성장했다.';
  const sources = [{ sourceId: 'S1', text }, { sourceId: 'S2', text: 'Another page that says nothing about markets.' }];
  const claim = (over: Record<string, unknown>) => ({ sourceId: 'S1', statement: 'The enterprise AI assistant market reached $48 billion in 2025.', quote: 'reached $48 billion in 2025, up 31% from 2024', ...over });

  it('a statement whose quote is in the retrieved text is admitted; case, quotation style, reference markers and spacing do not matter', () => {
    const r = verifyClaims([claim({}), claim({ statement: 'Small-business adoption is expected to double by 2027.', quote: 'ADOPTION  among small businesses is expected to double by 2027' })], sources);
    assert.equal(r.verified.length, 2);
    assert.deepEqual(r.verified.map((c) => c.claimId), ['C1', 'C2']);
    assert.equal(verifyClaims([claim({ statement: 'Small businesses came next after a 31% rise from 2024.', quote: 'up 31% from 2024. Adoption among small' })], sources).verified.length, 1, 'a reference marker like [3] in the page does not break a quote');
  });
  it('a paraphrase, an invented quote, a quote from another source, an unknown source and a too-short quote are all refused', () => {
    const r = verifyClaims([
      claim({ quote: 'the assistant market hit roughly forty-eight billion dollars last year' }),
      claim({ sourceId: 'S2' }),
      claim({ sourceId: 'S9' }),
      claim({ quote: 'reached $48' }),
      { sourceId: 'S1', statement: '', quote: 'reached $48 billion in 2025, up 31% from 2024' },
      'not an object',
    ], sources);
    assert.equal(r.verified.length, 0);
    assert.deepEqual(r.rejected.map((x) => x.reason), ['QUOTE_NOT_IN_SOURCE', 'QUOTE_NOT_IN_SOURCE', 'UNKNOWN_SOURCE', 'QUOTE_TOO_SHORT', 'MALFORMED', 'MALFORMED']);
  });
  it('a figure that is not in the quote is refused - a rounded, converted or invented number', () => {
    const r = verifyClaims([claim({ statement: 'The market reached $50 billion in 2025.' }), claim({ statement: 'The market grew 40% in 2025, reaching $48 billion.' }), claim({ statement: 'The market reached $48 billion in 2025, up 31%.' })], sources);
    assert.deepEqual(r.rejected.map((x) => x.reason), ['NUMBER_NOT_IN_QUOTE', 'NUMBER_NOT_IN_QUOTE']);
    assert.equal(r.verified.length, 1);
    assert.deepEqual(significantNumbers('3 trends, 12 firms, 2,500 users, 4.5 points, 8%'), ['12', '2500', '4.5', '8']);
    assert.deepEqual(significantNumbers('Q3 brought 5 billion, 3x, $4 and 8억 3천만 달러'), ['5', '3', '4', '8', '3'], 'a lone digit counts when it carries a unit, scale or currency');
    const converted = verifyClaims([claim({ statement: 'The market was worth 8억 3천만 달러.', quote: 'The market reached $830 million in 2025' })], sources);
    assert.deepEqual(converted.rejected.map((x) => x.reason), ['QUOTE_NOT_IN_SOURCE'], 'sanity: this quote is not in the page, so it is refused anyway');
    const withQuote = { sourceId: 'S1', statement: 'The market was worth 8억 3천만 달러.', quote: 'reached $48 billion in 2025, up 31% from 2024' };
    assert.deepEqual(verifyClaims([withQuote], sources).rejected.map((x) => x.reason), ['NUMBER_NOT_IN_QUOTE'], 'a converted scale is not a figure the quote contains');
    assert.equal(verifyClaims([{ sourceId: 'S1', statement: 'The market reached $48 billion in 2025.', quote: 'reached $48 billion in 2025, up 31% from 2024' }], sources).verified.length, 1);
  });
  it('a quote with an ellipsis is checked piece by piece, in order; Korean text and full-width characters match', () => {
    const base = { sourceId: 'S1', statement: 'The market reached $48 billion and adoption among small businesses is expected to double.' };
    assert.equal(verifyClaims([{ ...base, quote: 'reached $48 billion in 2025 ... adoption among small businesses is expected to double' }], sources).verified.length, 1);
    assert.equal(verifyClaims([{ ...base, quote: 'adoption among small businesses is expected to double ... reached $48 billion in 2025' }], sources).verified.length, 0, 'out of order');
    assert.equal(verifyClaims([{ sourceId: 'S1', statement: '인공지능 비서 시장은 2025년에 32% 성장했다고 한다.', quote: '인공지능 비서 시장은 2025년에 32% 성장했다.' }], sources).verified.length, 1);
    assert.equal(normalizeForMatch('Ｗｉｄｅ “quoted” — text [12]'), 'wide "quoted" - text');
  });
  it('the same statement twice, too many from one source and too many overall are limited', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ sourceId: 'S1', statement: `Statement number ${i} about the market size.`, quote: 'reached $48 billion in 2025, up 31% from 2024' }));
    const r = verifyClaims([...many, many[0]], sources);
    assert.equal(r.verified.length, CLAIM_LIMITS.maxPerSource);
    assert.ok(r.rejected.some((x) => x.reason === 'DUPLICATE'));
    assert.ok(r.rejected.some((x) => x.reason === 'OVER_LIMIT'));
  });
  it('model-flagged conflicts are kept only when they point at two or more distinct claims that exist', () => {
    const claims: ResearchClaimRecord[] = [1, 2, 3].map((n) => ({ claimId: `C${n}`, sourceId: 'S1', statement: `s${n}`, quote: `q${n}` }));
    const kept = validateConflicts([{ topic: 'Market size', claimIds: ['C1', 'C2', 'C2', 'C9'], note: 'differs' }, { topic: 'One only', claimIds: ['C1'], note: '' }, { topic: '', claimIds: ['C1', 'C3'], note: '' }, 'junk'], claims);
    assert.deepEqual(kept, [{ topic: 'Market size', claimIds: ['C1', 'C2'], note: 'differs' }]);
  });
  it('a long page is cut to its opening and the paragraphs that share words with the question, in their original order', () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => (i === 41 ? 'The regulation of assistants in Korea changed in 2026.' : `Unrelated filler paragraph number ${i} about something else entirely.`));
    const excerpt = relevantExcerpt(paragraphs.join('\n'), 'AI assistant regulation Korea 2026', 400);
    assert.ok(excerpt.length <= 400);
    assert.match(excerpt, /regulation of assistants in Korea/);
    assert.match(excerpt, /paragraph number 0 /, 'the opening is kept');
    assert.equal(relevantExcerpt('short', 'x', 400), 'short');
  });
});

// ---------------------------------------------------------------------------------------------------------------- composing

describe('what the composed report contains', () => {
  const retrievedAt = '2026-10-16T01:02:03.000Z';
  const source = (n: number, over: Partial<ResearchSourceRecord> = {}): ResearchSourceRecord => ({
    sourceId: `S${n}`, title: `Source ${n} title`, publisher: `site${n}.example`, url: `https://site${n}.example/a_b_c`, finalUrl: `https://site${n}.example/a_b_c`, publishedAt: '2026-03-01', retrievedAt, basis: 'FULL_TEXT',
    contentHash: 'h'.repeat(64), textLength: 1000, textTruncated: false, httpStatus: 200, robots: 'ALLOWED', freshness: 'RECENT', provider: 'test', ...over,
  });
  const claims: ResearchClaimRecord[] = [
    { claimId: 'C1', sourceId: 'S1', statement: 'The market reached $48 billion in 2025, up 31%.', quote: 'reached $48 billion in 2025, up 31%' },
    { claimId: 'C2', sourceId: 'S2', statement: 'A rule takes effect on 1 July 2026 and costs $2 million per provider.', quote: 'effective 1 July 2026 ... $2 million per provider' },
    { claimId: 'C3', sourceId: 'S3', statement: 'Another survey measured the market at $41 billion.', quote: 'measured the market at $41 billion' },
  ];
  const stats = { provider: 'tavily', plannedQueries: ['ai market 2026'], candidateCount: 5, retrievedCount: 3, rejectedClaims: 2, generatedAt: '2026-10-16T01:05:00.000Z' };
  const compose = (raw: unknown, over: Record<string, unknown> = {}) => composeResearchReport({ raw, claims, sources: [source(1), source(2), source(3), source(4)], conflicts: [], skipped: [], locale: 'en', query: 'AI market in 2026', stats, ...over } as any);
  const draft = {
    title: 'AI market 2026',
    summary: { kind: 'FACT', text: 'The market reached $48 billion in 2025, up 31%.', claimIds: ['C1'] },
    sections: [
      { heading: 'Size', paragraphs: [{ kind: 'FACT', text: 'The market reached $48 billion in 2025, up 31%.', claimIds: ['C1'] }, { kind: 'ANALYSIS', text: 'This suggests strong momentum, although one survey disagrees.', claimIds: ['C1', 'C3'] }] },
      { heading: 'Rules', paragraphs: [{ kind: 'FACT', text: 'A rule takes effect on 1 July 2026 with costs of $2 million per provider.', claimIds: ['C2'] }] },
    ],
  };

  it('numbers the citations in order of first use and lists exactly the cited sources with address, publisher, date and retrieval time', () => {
    const report = compose(draft)!;
    assert.deepEqual(report.citedSourceIds, ['S1', 'S3', 'S2']);
    assert.match(report.markdown, /The market reached \$48 billion in 2025, up 31%\. \[1\]/);
    assert.match(report.markdown, /\*Analysis:\* This suggests strong momentum.*\[1\]\[2\]/);
    assert.match(report.markdown, /takes effect on 1 July 2026.*\[3\]/);
    assert.match(report.markdown, /- \[1\] Source 1 title - site1\.example, published 2026-03-01\. https:\/\/site1\.example\/a_b_c \(retrieved 2026-10-16 01:02 UTC; full page read\)/);
    assert.doesNotMatch(report.markdown, /site4\.example/, 'a source nobody cited is not listed');
    assert.match(report.markdown, /## Method and limitations/);
    assert.match(report.markdown, /3 candidate|5 candidate sources, 3 retrieved, 3 cited/);
    assert.match(report.markdown, /2 proposed statements were rejected/);
  });
  it('a FACT paragraph with no verified citation, an unknown claim id, or a figure no cited claim contains is dropped - and counted', () => {
    const bad = {
      title: 'T',
      sections: [{
        heading: 'Mixed', paragraphs: [
          { kind: 'FACT', text: 'A confident statement with nothing behind it at all.', claimIds: [] },
          { kind: 'FACT', text: 'A statement citing a claim that does not exist anywhere.', claimIds: ['C99'] },
          { kind: 'FACT', text: 'The market reached $52 billion in 2025, up 31% on the year.', claimIds: ['C1'] },
          { kind: 'FACT', text: 'The market reached $48 billion in 2025, up 31%.', claimIds: ['C1', 'C99'] },
          { kind: 'ANALYSIS', text: 'Analysts expect the market to hit 90% penetration soon.', claimIds: [] },
          'junk',
        ],
      }],
    };
    const report = compose(bad)!;
    assert.equal(report.keptParagraphs, 1);
    assert.equal(report.droppedParagraphs, 5);
    assert.deepEqual(report.dropReasons, { NO_VERIFIED_CITATION: 2, UNSUPPORTED_NUMBER: 2, MALFORMED: 1 });
    assert.doesNotMatch(report.markdown, /\$52|90%|confident statement/);
    assert.match(report.markdown, /\$48 billion/);
  });
  it('whatever the model wrote that looks like a citation or an address is removed; the markers come only from the claims\' sources', () => {
    const report = compose({
      title: 'See https://evil.example now',
      sections: [{ heading: 'Facts [S9]', paragraphs: [{ kind: 'FACT', text: 'The market reached $48 billion in 2025, up 31% [7] according to https://made-up.example/report [C4, C5].', claimIds: ['C1'] }] }],
    })!;
    assert.doesNotMatch(report.markdown, /made-up\.example|evil\.example|\[7\]|\[S9\]|\[C4/);
    assert.match(report.markdown, /up 31% according to\. \[1\]|up 31% according to \[1\]|according to\. \[1\]/);
    assert.equal(report.citedSourceIds.length, 1);
  });
  it('nothing supported means no report; an unsupported summary is replaced by the first supported finding', () => {
    assert.equal(compose({ title: 'x', sections: [{ heading: 'h', paragraphs: [{ kind: 'ANALYSIS', text: 'Only an opinion with no facts behind it whatsoever.' }] }] }), null);
    assert.equal(compose({ title: 'x', sections: [] }), null);
    assert.equal(compose('garbage'), null);
    const withBadSummary = compose({ ...draft, summary: { kind: 'FACT', text: 'The market reached $99 billion.', claimIds: ['C1'] } })!;
    assert.doesNotMatch(withBadSummary.markdown, /\$99/);
    assert.equal(withBadSummary.summary, 'The market reached $48 billion in 2025, up 31%.');
  });
  it('conflicting claims get their own section naming both sources; weak sources are disclosed in the method section; Korean reports use Korean labels', () => {
    const report = compose(draft, {
      conflicts: [{ topic: 'Market size in 2025', claimIds: ['C1', 'C3'], note: 'Two surveys disagree by $7 billion.' }],
      sources: [source(1), source(2), source(3, { basis: 'SEARCH_SNIPPET', freshness: 'STALE', textTruncated: true, publishedAt: undefined })],
      skipped: [{ url: 'https://x.example', reason: 'ROBOTS_DISALLOWED', message: 'no' }],
    })!;
    assert.match(report.markdown, /## Conflicting or uncertain information\n\n- \*\*Market size in 2025\*\*: Two surveys disagree by \$7 billion\. \[1\]\[2\]/);
    assert.match(report.markdown, /only the search provider's excerpt was available/);
    assert.match(report.markdown, /publication date not stated/);
    assert.match(report.markdown, /1 source\(s\) could not be fetched in full/);
    assert.match(report.markdown, /1 candidate source\(s\) were not used/);
    assert.match(report.markdown, /may be out of date/);
    assert.match(report.markdown, /only the beginning of each was read/);
    const ko = compose(draft, { locale: 'ko' })!;
    assert.match(ko.markdown, /## 출처/);
    assert.match(ko.markdown, /## 조사 방법과 한계/);
    assert.match(ko.markdown, /\*분석:\*/);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the workflow

describe('the research workflow end to end (stand-in search provider, real pages, scripted model)', () => {
  const T = 'ten_rr';
  const U = 'usr_rr';
  const requests: string[] = [];
  let server: http.Server;
  let base = '';
  let disallowed = '/blocked';

  const page = (title: string, date: string, body: string) => `<html><head><title>${title}</title><meta name="date" content="${date}"></head><body><article><h1>${title}</h1>${body}</article></body></html>`;
  const FILLER = '<p>Filler context sentence that pads the page so that it is a realistic length for extraction purposes.</p>'.repeat(3);
  const PAGES: Record<string, string> = {
    '/ai-market': page('Enterprise AI market report', '2026-03-01', `<p>The market for enterprise AI assistants reached $48 billion in 2025, up 31% from 2024.</p><p>Analysts at Fixture Research expect adoption among small businesses to double by 2027.</p>${FILLER}`),
    '/ai-rules': page('AI transparency rule', '2026-04-10', `<p>The fixture regional council adopted an AI transparency rule effective 1 July 2026.</p><p>Compliance is estimated to cost $2 million per large provider.</p>${FILLER}`),
    '/ai-market-alt': page('Another market survey', '2026-02-12', `<p>A separate survey measured the 2025 market at $41 billion, an increase of 27% over the prior year.</p>${FILLER}`),
    '/blocked/page': page('Blocked page', '2026-01-01', `<p>This page must never be fetched because robots.txt forbids it, and it says 99% of everything.</p>${FILLER}`),
    '/ko-trend': page('국내 AI 비서 동향', '2026-05-05', `<p>2025년 국내 AI 비서 시장은 전년 대비 32% 성장했다.</p>${FILLER}`),
  };

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      requests.push(url.pathname);
      if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`User-agent: *\nDisallow: ${disallowed}`); return; }
      const body = PAGES[url.pathname];
      if (!body) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const evSource = (p: string, over: Partial<EvidenceSource> = {}): EvidenceSource => ({
    sourceId: `src_${p}`, title: `Result ${p}`, url: `${base}${p}`, sourceName: 'fixture.example', snippet: 'A search provider excerpt that is long enough to be usable as a fallback when the page itself cannot be fetched.', publishedAt: '2026-03-01',
    retrievedAt: '2026-10-16T00:00:00.000Z', freshnessStatus: 'RECENT', ...over,
  });

  interface Rig {
    service: ResearchReportService;
    runStore: ResearchRunStore;
    documentStore: DocumentStore;
    artifactStore: ArtifactStore;
    executor: DocumentExecutor;
    calls: { plan: number; extract: number; write: number; search: string[] };
    auditEvents: any[];
  }
  interface RigOptions {
    available?: boolean;
    pack?: (q: string) => Partial<EvidencePack>;
    extract?: (input: any) => any[] | Promise<any[]>;
    write?: (input: any) => Record<string, unknown>;
    plan?: () => string[] | Error;
    providerName?: string;
  }

  function rig(options: RigOptions = {}): Rig {
    const dir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex_rr_${p}_`));
    const runStore = new ResearchRunStore({ dir: dir('runs') });
    const documentStore = new DocumentStore({ dir: dir('docs') });
    const artifactStore = new ArtifactStore({ dir: dir('art') });
    const executor = new DocumentExecutor({ aiService: {} as any, documentStore, artifactStore });
    const calls = { plan: 0, extract: 0, write: 0, search: [] as string[] };
    const auditEvents: any[] = [];
    const meta = { provider: 'fake', model: 'fake-1', latencyMs: 1, requestId: 'r' };
    const defaultExtract = (input: any) => {
      const claims: any[] = [];
      for (const s of input.sources) {
        if (s.text.includes('reached $48 billion')) claims.push({ sourceId: s.sourceId, statement: 'The enterprise AI assistant market reached $48 billion in 2025, up 31%.', quote: 'reached $48 billion in 2025, up 31% from 2024' });
        if (s.text.includes('adoption among small businesses')) claims.push({ sourceId: s.sourceId, statement: 'Small-business adoption is expected to double by 2027.', quote: 'adoption among small businesses to double by 2027' });
        if (s.text.includes('transparency rule')) claims.push({ sourceId: s.sourceId, statement: 'A regional AI transparency rule is effective 1 July 2026.', quote: 'AI transparency rule effective 1 July 2026' });
        if (s.text.includes('$41 billion')) claims.push({ sourceId: s.sourceId, statement: 'A separate survey measured the 2025 market at $41 billion, up 27%.', quote: 'measured the 2025 market at $41 billion, an increase of 27%' });
        if (s.text.includes('32% 성장')) claims.push({ sourceId: s.sourceId, statement: '2025년 국내 AI 비서 시장은 전년 대비 32% 성장했다.', quote: '2025년 국내 AI 비서 시장은 전년 대비 32% 성장했다.' });
      }
      return claims;
    };
    const defaultWrite = (input: any) => {
      const id = (re: RegExp) => input.claims.find((c: any) => re.test(c.statement))?.claimId;
      const market = id(/\$48 billion/); const alt = id(/\$41 billion/); const rule = id(/transparency rule/); const ko = id(/32% 성장/);
      const sections: any[] = [];
      if (market) sections.push({ heading: 'Market size', paragraphs: [{ kind: 'FACT', text: 'The enterprise AI assistant market reached $48 billion in 2025, up 31%.', claimIds: [market] }] });
      if (rule) sections.push({ heading: 'Regulation', paragraphs: [{ kind: 'FACT', text: 'A regional AI transparency rule takes effect on 1 July 2026.', claimIds: [rule] }] });
      if (ko) sections.push({ heading: '국내 동향', paragraphs: [{ kind: 'FACT', text: '2025년 국내 AI 비서 시장은 전년 대비 32% 성장했다.', claimIds: [ko] }] });
      return { title: 'AI industry trends', summary: market ? { kind: 'FACT', text: 'The enterprise AI assistant market reached $48 billion in 2025, up 31%.', claimIds: [market] } : undefined, sections, conflicts: market && alt ? [{ topic: 'Market size 2025', claimIds: [market, alt], note: 'Two sources give different totals.' }] : [] };
    };
    const service = new ResearchReportService({
      aiService: {
        researchPlanQueries: async () => { calls.plan++; const planned = options.plan ? options.plan() : ['ai industry trends 2026', 'ai regulation 2026']; if (planned instanceof Error) throw planned; return { data: { queries: planned }, ...meta }; },
        researchExtractClaims: async (input: any) => { calls.extract++; return { data: { claims: await (options.extract ?? defaultExtract)(input) }, ...meta }; },
        researchWriteReport: async (input: any) => { calls.write++; return { data: { report: (options.write ?? defaultWrite)(input) }, ...meta }; },
      } as any,
      evidencePackService: {
        isWebSearchAvailable: () => options.available !== false,
        buildEvidencePack: async (q: string) => {
          calls.search.push(q);
          const sources = q.includes('regulation') ? [evSource('/ai-rules'), evSource('/ai-market')] : [evSource('/ai-market'), evSource('/ai-market-alt'), evSource('/blocked/page'), evSource('/ko-trend')];
          return { evidencePackId: 'evpack_x', query: q, generatedAt: 'x', freshnessRequirement: 'REQUIRED', category: 'TECHNOLOGY', status: 'SUCCESS', sources, ...(options.pack ? options.pack(q) : {}) } as EvidencePack;
        },
      } as any,
      fetcher: new SourceFetcher({ allowLocalTestDestinations: true, perHostIntervalMs: 0, sleep: async () => {}, timeoutMs: 2000 }),
      runStore,
      documentExecutor: executor,
      providerName: () => options.providerName ?? 'tavily',
      auditLogger: { logEvent: (event: any) => { auditEvents.push(event); return event; } } as any,
      now: () => new Date('2026-10-16T01:00:00.000Z'),
    });
    return { service, runStore, documentStore, artifactStore, executor, calls, auditEvents };
  }
  const ask = (r: Rig, query = '2026년 AI 산업 동향을 최신 자료로 조사하고, 출처가 포함된 보고서를 만들어줘', who = { tenantId: T, ownerId: U }) => r.service.run({ query, ...who, requestId: `req_${Math.random().toString(16).slice(2)}`, locale: 'en' });

  it('a report is written from what was retrieved: every citation resolves to a retrieved source, every claim to a quote in that source, and the document can be reopened and downloaded as .docx', async () => {
    requests.length = 0;
    const r = rig();
    const outcome = await ask(r);
    assert.equal(outcome.status, 'SUCCESS');
    if (outcome.status !== 'SUCCESS') return;
    assert.deepEqual(outcome.steps.map((s) => `${s.step}:${s.status}`), ['PLAN:DONE', 'SEARCH:DONE', 'RETRIEVE:DONE', 'EXTRACT:DONE', 'COMPOSE:DONE', 'PUBLISH:DONE']);

    const run = r.runStore.get(outcome.runId, T, U)!;
    const doc = r.documentStore.get(outcome.documentId, T, U)!;
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.documentId, doc.documentId);
    assert.equal(doc.researchRunId, run.runId);
    assert.equal(run.provider, 'tavily');
    assert.ok(r.artifactStore.list(T, U).some((a: any) => a.artifactId === outcome.artifactId), 'it appears among the person\'s recent creations');

    // every marker in the text names a listed source; every listed source was retrieved from the address shown, at a recorded time, with the hash of the text that was read
    const markers = [...new Set([...doc.content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
    const listed = [...doc.content.matchAll(/^- \[(\d+)\] .*? (http\S+) \(retrieved (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC; ([^)]+)\)$/gm)];
    assert.deepEqual(markers.sort(), listed.map((m) => Number(m[1])).sort());
    for (const m of listed) {
      const source = run.sources.find((s) => s.finalUrl === m[2]);
      assert.ok(source, `${m[2]} is a retrieved source`);
      assert.equal(source!.retrievedAt.slice(0, 16).replace('T', ' '), m[3]);
      assert.equal(source!.basis, 'FULL_TEXT');
      assert.match(source!.contentHash, /^[0-9a-f]{64}$/);
    }
    const urls = new Set(listed.map((m) => m[2]));
    assert.ok(urls.has(`${base}/ai-market`) && urls.has(`${base}/ai-rules`));
    assert.equal(doc.content.includes('/blocked/page'), false, 'a page robots.txt forbids is not a source');
    assert.equal(requests.includes('/blocked/page'), false, 'and was never requested');
    for (const claim of run.claims) assert.ok(claim.quote.length >= 20 && claim.sourceId.startsWith('S'));
    assert.match(doc.content, /Market size/);
    assert.match(doc.content, /## Conflicting or uncertain information/);

    // reopen: the stored document and the provenance are retrievable, and a real .docx comes out
    const bytes = buildDocx({ title: doc.title, markdown: doc.content, locale: 'en' });
    const parts = readZip(bytes);
    const xml = parts.find((p) => p.name === 'word/document.xml')!.data.toString('utf8');
    const rels = parts.find((p) => p.name === 'word/_rels/document.xml.rels')!.data.toString('utf8');
    assert.equal((xml.match(/<w:hyperlink /g) ?? []).length, listed.length, 'every source address is a clickable link');
    for (const url of urls) assert.ok(rels.includes(`Target="${url}"`), `${url} is a hyperlink target`);
    const download = await handleDocumentCreationRoutes('GET', `/api/v1/creations/documents/${outcome.documentId}/download`, null as any, authAs(T, U), {}, { creationRuntime: new CreationRuntime([r.executor]), documentExecutor: r.executor, documentStore: r.documentStore }) as any;
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(r.auditEvents.some((e) => e.action === 'research.report.created' && e.result === 'SUCCESS'), true);
  });

  it('a claim the model made up is refused before it can reach the report', async () => {
    const r = rig({
      extract: (input) => [
        ...input.sources.flatMap((s: any) => (s.text.includes('reached $48 billion') ? [{ sourceId: s.sourceId, statement: 'The enterprise AI assistant market reached $48 billion in 2025, up 31%.', quote: 'reached $48 billion in 2025, up 31% from 2024' }] : [])),
        ...input.sources.flatMap((s: any) => (s.text.includes('transparency rule') ? [{ sourceId: s.sourceId, statement: 'A regional AI transparency rule is effective 1 July 2026.', quote: 'AI transparency rule effective 1 July 2026' }] : [])),
        { sourceId: 'S1', statement: 'Ninety percent of enterprises have fully replaced their staff with assistants.', quote: 'ninety percent of enterprises replaced their staff with AI assistants' },
        { sourceId: 'S7', statement: 'A source that was never retrieved says something remarkable about the industry.', quote: 'remarkable claim from a source that does not exist in this run' },
      ],
    });
    const outcome = await ask(r);
    assert.equal(outcome.status, 'SUCCESS');
    if (outcome.status !== 'SUCCESS') return;
    assert.equal(outcome.stats.claimsRejected, 2);
    const run = r.runStore.get(outcome.runId, T, U)!;
    assert.deepEqual(run.rejectionReasons, { QUOTE_NOT_IN_SOURCE: 1, UNKNOWN_SOURCE: 1 });
    assert.equal(run.claims.some((c) => /Ninety percent/.test(c.statement)), false);
    assert.doesNotMatch(r.documentStore.get(outcome.documentId, T, U)!.content, /Ninety percent|remarkable/);
  });

  it('a draft paragraph that cites a claim that does not exist, or states a figure no claim contains, is dropped', async () => {
    const r = rig({
      write: (input) => {
        const market = input.claims.find((c: any) => /\$48 billion/.test(c.statement)).claimId;
        return { title: 'T', sections: [{ heading: 'Findings', paragraphs: [
          { kind: 'FACT', text: 'The enterprise AI assistant market reached $48 billion in 2025, up 31%.', claimIds: [market] },
          { kind: 'FACT', text: 'The market will triple to $150 billion by 2030 according to experts.', claimIds: [market] },
          { kind: 'FACT', text: 'Governments everywhere banned assistants outright this year.', claimIds: ['C77'] },
        ] }] };
      },
    });
    const outcome = await ask(r);
    assert.equal(outcome.status, 'SUCCESS');
    if (outcome.status !== 'SUCCESS') return;
    assert.equal(outcome.stats.paragraphsDropped, 2);
    const content = r.documentStore.get(outcome.documentId, T, U)!.content;
    assert.doesNotMatch(content, /\$150|banned assistants/);
    assert.equal(r.runStore.get(outcome.runId, T, U)!.droppedParagraphs, 2);
  });

  it('without a search provider the answer is "unavailable": no model is asked, nothing is stored, no document exists', async () => {
    const r = rig({ available: false });
    const outcome = await ask(r);
    assert.equal(outcome.status, 'UNAVAILABLE');
    assert.deepEqual([r.calls.plan, r.calls.extract, r.calls.write, r.calls.search.length], [0, 0, 0, 0]);
    assert.equal(r.runStore.list(T, U).length, 0);
    assert.equal(r.documentStore.list(T, U).length, 0);
    assert.match((outcome as any).message, /not configured/);
  });

  it('a provider that rejects its credentials or is rate limited is reported as such - and its credential never appears anywhere', async () => {
    const secret = 'tvly-SECRET-KEY-1234567890';
    const previous = process.env.NAGEX_TAVILY_API_KEY;
    process.env.NAGEX_TAVILY_API_KEY = secret;
    try {
      for (const status of ['AUTH_FAILED', 'RATE_LIMITED', 'PROVIDER_ERROR'] as const) {
        const r = rig({ pack: () => ({ status, sources: [], error: `HTTP failure for Bearer ${secret}` }) });
        const outcome = await ask(r);
        assert.equal(outcome.status, 'FAILED');
        assert.equal((outcome as any).code, `SEARCH_${status}`);
        assert.equal(r.documentStore.list(T, U).length, 0);
        const everything = JSON.stringify([outcome, r.runStore.list(T, U), r.auditEvents]);
        assert.equal(everything.includes(secret), false, `${status}: no credential in any result, record or audit event`);
      }
      const none = await ask(rig({ pack: () => ({ status: 'NO_RESULTS', sources: [] }) }));
      assert.deepEqual([none.status, (none as any).code], ['NO_RESULTS', 'SEARCH_NO_RESULTS']);
    } finally {
      if (previous === undefined) delete process.env.NAGEX_TAVILY_API_KEY; else process.env.NAGEX_TAVILY_API_KEY = previous;
    }
  });

  it('when no page can be read and the search provider gave no usable excerpt, there is no report', async () => {
    disallowed = '/';
    try {
      const r = rig({ pack: () => ({ sources: [evSource('/ai-market', { snippet: 'too short' }), evSource('/ai-rules', { snippet: '' })] }) });
      const outcome = await ask(r);
      assert.deepEqual([outcome.status, (outcome as any).code], ['NO_EVIDENCE', 'NO_SOURCE_RETRIEVED']);
      assert.equal(r.calls.extract, 0, 'the model was not asked to extract from nothing');
      assert.equal(r.documentStore.list(T, U).length, 0);
      assert.equal(r.runStore.list(T, U)[0].status, 'NO_EVIDENCE');
    } finally { disallowed = '/blocked'; }
  });

  it('a page that cannot be fetched may still be represented by the provider\'s own excerpt - and the report says so', async () => {
    disallowed = '/';
    try {
      const snippet = 'The market for enterprise AI assistants reached $48 billion in 2025, up 31% from 2024, according to the provider excerpt text.';
      const r = rig({ pack: () => ({ sources: [evSource('/ai-market', { snippet }), evSource('/ai-rules', { snippet: 'The fixture regional council adopted an AI transparency rule effective 1 July 2026, said the excerpt of the rules page.' })] }) });
      const outcome = await ask(r);
      assert.equal(outcome.status, 'SUCCESS');
      if (outcome.status !== 'SUCCESS') return;
      const run = r.runStore.get(outcome.runId, T, U)!;
      assert.ok(run.sources.every((s) => s.basis === 'SEARCH_SNIPPET' && /ROBOTS_DISALLOWED|ROBOTS_UNREADABLE/.test(s.fetchNote ?? '')));
      const content = r.documentStore.get(outcome.documentId, T, U)!.content;
      assert.match(content, /only the search provider's excerpt was available/);
      assert.match(content, /could not be fetched in full/);
    } finally { disallowed = '/blocked'; }
  });

  it('fewer than two verifiable statements is not a report; a failing model step stores nothing', async () => {
    const few = rig({ extract: (input) => input.sources.filter((s: any) => s.text.includes('reached $48 billion')).map((s: any) => ({ sourceId: s.sourceId, statement: 'The enterprise AI assistant market reached $48 billion in 2025.', quote: 'reached $48 billion in 2025, up 31% from 2024' })).slice(0, 1) });
    const fewOutcome = await ask(few);
    assert.deepEqual([fewOutcome.status, (fewOutcome as any).code], ['NO_EVIDENCE', 'NO_VERIFIABLE_CLAIMS']);
    assert.equal(few.documentStore.list(T, U).length, 0);

    const broken = rig({ extract: () => { throw Object.assign(new Error('provider exploded with details'), { code: 'PROVIDER_UNAVAILABLE' }); } });
    const brokenOutcome = await ask(broken);
    assert.deepEqual([brokenOutcome.status, (brokenOutcome as any).code], ['FAILED', 'PROVIDER_UNAVAILABLE']);
    assert.equal(broken.documentStore.list(T, U).length, 0);
    assert.doesNotMatch(JSON.stringify(brokenOutcome), /exploded with details/, 'internal error text is not shown');
    assert.equal(broken.runStore.list(T, U)[0].status, 'FAILED');

    const nothingSupported = rig({ write: () => ({ title: 't', sections: [{ heading: 'h', paragraphs: [{ kind: 'FACT', text: 'A statement with no claim behind it whatsoever.', claimIds: [] }] }] }) });
    assert.deepEqual([(await ask(nothingSupported)).status, ((await ask(nothingSupported)) as any).code], ['NO_EVIDENCE', 'NO_SUPPORTED_REPORT']);
  });

  it('planning is optional: if the model cannot plan, the question itself is searched and the step says it was skipped', async () => {
    const r = rig({ plan: () => new Error('plan failed') });
    const outcome = await ask(r, 'AI industry trends 2026');
    assert.equal(outcome.status, 'SUCCESS');
    assert.deepEqual(r.calls.search, ['AI industry trends 2026']);
    assert.equal(outcome.steps[0].status, 'SKIPPED');
  });

  it('the same question asked twice at once is one run and one report', async () => {
    const r = rig();
    const [a, b] = await Promise.all([ask(r), ask(r)]);
    assert.equal(a.status, 'SUCCESS');
    assert.equal((a as any).runId, (b as any).runId);
    assert.equal(r.calls.write, 1);
    assert.equal(r.documentStore.list(T, U).length, 1);
    const again = await ask(r);
    assert.notEqual((again as any).runId, (a as any).runId, 'asking again later is a new, deliberate run');
  });

  it('a Korean question gets a Korean report with Korean labels and its Korean source quoted verbatim', async () => {
    const r = rig();
    const outcome = await r.service.run({ query: '국내 AI 비서 시장 동향', tenantId: T, ownerId: U, requestId: 'req_ko', locale: 'ko' });
    assert.equal(outcome.status, 'SUCCESS');
    if (outcome.status !== 'SUCCESS') return;
    const content = r.documentStore.get(outcome.documentId, T, U)!.content;
    assert.match(content, /## 출처/);
    assert.match(content, /32% 성장했다/);
    const run = r.runStore.get(outcome.runId, T, U)!;
    assert.ok(run.claims.some((c) => c.quote === '2025년 국내 AI 비서 시장은 전년 대비 32% 성장했다.'));
  });

  it('runs and reports belong to their owner: another user or tenant gets nothing', async () => {
    const r = rig();
    const outcome = await ask(r);
    assert.equal(outcome.status, 'SUCCESS');
    if (outcome.status !== 'SUCCESS') return;
    assert.equal(r.runStore.get(outcome.runId, T, 'usr_other'), null);
    assert.equal(r.runStore.get(outcome.runId, 'ten_other', U), null);
    assert.equal(r.runStore.get('../../etc/passwd', T, U), null);
    assert.equal(r.runStore.get('run_000000000000000000000000', T, U), null);
    assert.equal(r.documentStore.get(outcome.documentId, T, 'usr_other'), null);
    assert.equal(r.runStore.list(T, 'usr_other').length, 0);
  });

  // ---- routes

  describe('routes', () => {
    const deps = (r: Rig | null) => ({ aiService: {} as any, evidencePackService: {} as any, modelErrorResult: () => ({ status: 500, data: {} }), ...(r ? { researchReportService: r.service, researchRunStore: r.runStore } : {}) });
    const call = (method: string, pathname: string, body: any, who: [string, string] | null, d: any) => handleResearchRoutes(method as any, pathname, body, authAs(who?.[0] ?? T, who?.[1] ?? U), {}, d) as Promise<any>;

    it('POST /reports validates, reports the unavailable state truthfully, and creates the report (201) for the signed-in owner', async () => {
      const r = rig();
      assert.equal((await call('POST', '/api/v1/research/reports', { query: '   ' }, null, deps(r))).status, 400);
      assert.equal((await call('POST', '/api/v1/research/reports', { query: 'x'.repeat(601) }, null, deps(r))).status, 400);
      assert.equal((await call('POST', '/api/v1/research/reports', { query: 'ai trends' }, null, deps(null))).status, 503);
      const off = await call('POST', '/api/v1/research/reports', { query: 'ai trends' }, null, deps(rig({ available: false })));
      assert.deepEqual([off.status, off.data.status, off.data.code], [200, 'UNAVAILABLE', 'SEARCH_UNAVAILABLE']);
      const ok = await call('POST', '/api/v1/research/reports', { query: '2026년 AI 산업 동향을 최신 자료로 조사하고, 출처가 포함된 보고서를 만들어줘' }, null, deps(r));
      assert.equal(ok.status, 201);
      assert.equal(ok.data.status, 'SUCCESS');
      assert.match(ok.data.documentId, /^doc_[0-9a-f]{24}$/);
      assert.match(ok.data.downloadTarget, /\/download$/);
      assert.ok(ok.data.sources.length >= 2 && ok.data.sources.every((s: any) => /^http/.test(s.url) && s.retrievedAt));
      assert.equal(r.documentStore.get(ok.data.documentId, T, U)!.locale, 'ko', 'a Korean question gets a Korean report');
    });

    it('GET /runs/:id returns the provenance to its owner only; foreign, unknown and malformed ids are all 404', async () => {
      const r = rig();
      const ok = await call('POST', '/api/v1/research/reports', { query: 'AI industry trends 2026' }, null, deps(r));
      const own = await call('GET', `/api/v1/research/runs/${ok.data.runId}`, null, null, deps(r));
      assert.equal(own.status, 200);
      assert.equal(own.data.run.sources.length >= 2, true);
      assert.equal('tenantId' in own.data.run || 'ownerId' in own.data.run, false, 'internal identity is not echoed');
      for (const [who, id] of [[[T, 'usr_other'], ok.data.runId], [['ten_other', U], ok.data.runId], [null, 'run_000000000000000000000000'], [null, 'nope'], [null, '..%2F..%2Fetc']] as const) {
        const res = await call('GET', `/api/v1/research/runs/${id}`, null, who as any, deps(r));
        assert.equal(res.status, 404, String(id));
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------- the open knowledge provider

describe('open knowledge search provider (Wikipedia + OpenAlex)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fakeFetch = (handler: (url: string) => Response | Promise<Response>) => (async (input: any) => handler(String(input))) as typeof fetch;
  const wiki = { query: { search: [{ title: 'Artificial intelligence', pageid: 1164, snippet: 'AI is the <span class="searchmatch">capability</span> of &quot;computational&quot; systems', timestamp: '2026-09-01T00:00:00Z' }] } };
  const openalex = { results: [
    { id: 'https://openalex.org/W123', title: 'Agentic AI in industry', doi: 'https://doi.org/10.1000/abc', publication_date: '2026-02-14', abstract_inverted_index: { Agents: [0], are: [1], spreading: [2], fast: [3] }, primary_location: { source: { display_name: 'Journal of Fixtures' } } },
    { id: 'https://openalex.org/W999', title: 'No abstract', doi: 'https://doi.org/10.1000/none', publication_date: '2026-01-01', abstract_inverted_index: null },
  ] };

  it('is off unless chosen on purpose, and says so', async () => {
    const provider = new OpenKnowledgeSearchProvider({ enabled: false, fetchFn: fakeFetch(() => { throw new Error('must not be called'); }) });
    assert.equal(provider.isConfigured(), false);
    assert.equal((await provider.search({ query: 'ai' })).status, 'UNAVAILABLE');
  });
  it('maps Wikipedia and OpenAlex results to sources with their own addresses, dates and attribution, and skips works without an abstract', async () => {
    const seen: string[] = [];
    const provider = new OpenKnowledgeSearchProvider({ enabled: true, now: () => new Date('2026-10-16T00:00:00Z'), fetchFn: fakeFetch((url) => { seen.push(url); return url.includes('wikipedia.org') ? json(wiki) : json(openalex); }) });
    const result = await provider.search({ query: 'AI industry trends 2026', maxResults: 6 });
    assert.equal(result.status, 'SUCCESS');
    const w = result.results.find((r) => r.url.includes('wikipedia.org'))!;
    assert.equal(w.url, 'https://en.wikipedia.org/wiki/Artificial_intelligence');
    assert.equal(w.snippet, 'AI is the capability of "computational" systems');
    assert.equal(w.observedAt, '2026-09-01T00:00:00Z');
    assert.equal(w.publishedAt, undefined, 'an edit time is not a publication date');
    const o = result.results.find((r) => r.url.includes('doi.org'))!;
    assert.deepEqual([o.title, o.snippet, o.publishedAt, o.sourceName], ['Agentic AI in industry', 'Agents are spreading fast', '2026-02-14', 'Journal of Fixtures']);
    assert.equal(result.results.length, 2);
    assert.ok(seen.some((u) => u.includes('from_publication_date:2024-01-01')), 'scholarly works are limited to the last two years');
  });
  it('a Korean question is also searched in Korean Wikipedia; one source failing does not fail the search; both failing is an error, not an empty success', async () => {
    const urls: string[] = [];
    const koWiki = { query: { search: [{ title: '인공지능', pageid: 5, snippet: '인공지능은', timestamp: '2026-01-01T00:00:00Z' }] } };
    const partial = new OpenKnowledgeSearchProvider({ enabled: true, fetchFn: fakeFetch((url) => { urls.push(url); return url.includes('ko.wikipedia') ? json(koWiki) : json({}, 500); }) });
    const result = await partial.search({ query: '인공지능 동향' });
    assert.equal(result.status, 'SUCCESS');
    assert.ok(urls.some((u) => u.startsWith('https://ko.wikipedia.org')));
    assert.equal(result.results[0].url, 'https://ko.wikipedia.org/wiki/%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5');
    const down = new OpenKnowledgeSearchProvider({ enabled: true, fetchFn: fakeFetch(() => json({}, 503)) });
    assert.equal((await down.search({ query: 'ai' })).status, 'PROVIDER_ERROR');
    const empty = new OpenKnowledgeSearchProvider({ enabled: true, fetchFn: fakeFetch((url) => (url.includes('wikipedia') ? json({ query: { search: [] } }) : json({ results: [] }))) });
    assert.equal((await empty.search({ query: 'zzzz' })).status, 'NO_RESULTS');
  });
});

describe('DOCX hyperlinks', () => {
  it('an address with underscores stays exactly as written and becomes a real, clickable link; trailing punctuation is not part of it', () => {
    const url = 'https://example.org/path_with_underscores/a_b_c?x=1&y=2';
    const bytes = buildDocx({ title: 'Links', markdown: `See ${url}, and also *this* emphasis.\n\n- [1] Source - site.example. ${url} (retrieved)`, locale: 'en' });
    const parts = readZip(bytes);
    const xml = parts.find((p) => p.name === 'word/document.xml')!.data.toString('utf8');
    const rels = parts.find((p) => p.name === 'word/_rels/document.xml.rels')!.data.toString('utf8');
    assert.ok(xml.includes('path_with_underscores/a_b_c?x=1&amp;y=2'));
    assert.equal((xml.match(/<w:hyperlink /g) ?? []).length, 2);
    assert.equal((rels.match(/\/hyperlink"/g) ?? []).length, 1, 'one relationship for one address');
    assert.ok(rels.includes('Target="https://example.org/path_with_underscores/a_b_c?x=1&amp;y=2" TargetMode="External"'));
    assert.match(xml, /<w:t xml:space="preserve">, and also <\/w:t>/, 'the comma after the address is plain text');
    assert.match(xml, /<w:i\/><\/w:rPr><w:t xml:space="preserve">this<\/w:t>/, 'emphasis elsewhere still works');
    for (const [name, text] of [['document', xml], ['rels', rels]] as const) assert.doesNotMatch(text.replace(/<[^>]*>/g, ''), /[<>]/, name);
    assert.equal(crypto.createHash('sha256').update(xml).digest('hex').length, 64);
  });
});
