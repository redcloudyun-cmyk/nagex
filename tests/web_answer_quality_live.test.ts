// LIVE_EXTERNAL - opt-in. The Fold incident against a REAL model and REAL retrieval, on an isolated development instance of the production server (nothing deployed is touched):
//   - model: Google Gemini (free-tier key of this machine) behind the Model Gateway;
//   - retrieval: the keyless open-knowledge provider (Wikipedia ko/en + OpenAlex), pages read under robots.txt and the outbound policy. This is an ENCYCLOPEDIC route, not a general web search engine:
//     a general provider (Tavily / an HTTP endpoint) needs a credential that does not exist on this machine, so the manufacturer's own newsroom pages are NOT reachable through it.
// Runs only with NAGEX_WEB_ANSWER_LIVE=1 (it spends a handful of free-tier model requests). The prompts are the person's real words. The assertions are STRUCTURAL (a search happened, sources are real
// addresses, citations point at retrieved sources, the language is kept, the old canned sentence is gone). Whether the answers are FACTUALLY right is judged by reading the recorded transcript against the
// recorded sources (human review) - never by a model's self-assessment - and is reported as such. Evidence is written to NAGEX_LIVE_EVIDENCE_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

const ENABLED = process.env.NAGEX_WEB_ANSWER_LIVE === '1' && Boolean(process.env.GEMINI_API_KEY);
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const MODEL = process.env.NAGEX_LIVE_GEMINI_MODEL || 'gemini-flash-lite-latest';

let h: CanvasAskHarness;
let ctx: BrowserContext;
const transcript: any[] = [];

before(async () => {
  if (!ENABLED) return;
  h = await startCanvasAskHarness({
    scrubProviders: true,
    env: { GEMINI_API_KEY: GEMINI_KEY, NAGEX_GEMINI_MODEL: MODEL, NAGEX_PROVIDER_PRIORITY: 'gemini', NAGEX_WEB_SEARCH_PROVIDER: 'open_knowledge', NAGEX_ALLOW_LOCAL_TEST_URLS: '' },
  });
  const user = h.user('web-answer-quality-live');
  h.setLocale(user, 'ko');
  ctx = await h.newContext('desktop', user, 'ko');
});
after(async () => {
  if (transcript.length > 0 && process.env.NAGEX_LIVE_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAGEX_LIVE_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.NAGEX_LIVE_EVIDENCE_DIR, 'live-transcript.json'), JSON.stringify({ at: new Date().toISOString(), model: MODEL, retrieval: 'open_knowledge (Wikipedia ko/en + OpenAlex)', turns: transcript }, null, 2));
  }
  await ctx?.close(); await h?.close();
});

// a person asks at a human pace; the public APIs rate-limit bursts (observed: HTTP 429 with Retry-After), so the turns are spaced
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function turn(label: string, message: string): Promise<any> {
  if (transcript.length > 0) await pause(Number(process.env.NAGEX_LIVE_TURN_GAP_MS ?? 15000));
  const started = Date.now();
  const res = await ctx.request.post(`${h.origin}/api/v1/ai/chat`, { data: { message, requestMetadata: { timezone: 'Asia/Seoul', allowWebResearch: true } }, headers: { 'content-type': 'application/json' }, timeout: 120000 });
  const raw = await res.json();
  const data = raw?.data ?? {};
  const record = {
    label, prompt: message, httpStatus: res.status(), elapsedMs: Date.now() - started,
    provider: raw?.provider, model: raw?.model, modelLatencyMs: raw?.latencyMs,
    answer: String(data.message ?? ''), grounding: data.grounding, verification: data.verification ?? null,
    sources: (data.sources ?? []).map((s: any) => ({ id: s.sourceId, title: s.title, url: s.url, publishedAt: s.publishedAt ?? null, freshness: s.freshnessStatus, pageRead: Boolean(s.excerpt), excerpt: typeof s.excerpt === 'string' ? s.excerpt.slice(0, 700) : null })),
    errorBody: res.status() === 200 ? undefined : raw,
  };
  transcript.push(record);
  return record;
}

describe('LIVE: the Fold incident against a real model and real (encyclopedic) retrieval', { skip: ENABLED ? false : 'LIVE_DEPENDENCY_UNAVAILABLE: set NAGEX_WEB_ANSWER_LIVE=1 with GEMINI_API_KEY' }, () => {
  it('A - "갤럭시 폴드6와 폴드7의 주요 스펙 차이가 뭐지?": searched, sources read, answer in Korean, citations point at what was retrieved', async () => {
    const t = await turn('A', '갤럭시 폴드6와 폴드7의 주요 스펙 차이가 뭐지?');
    assert.equal(t.httpStatus, 200, JSON.stringify(t.errorBody)?.slice(0, 300));
    assert.ok(t.answer.length > 40);
    assert.ok(/[가-힣]/.test(t.answer), 'Korean is kept');
    assert.equal(/live web search is unavailable/i.test(t.answer), false);
    assert.equal(t.grounding.provider, 'open_knowledge', 'the real retrieval route was used');
    assert.ok(t.sources.length >= 1, `sources retrieved: ${JSON.stringify(t.grounding)}`);
    assert.ok(t.sources.every((s: any) => /^https:\/\//.test(s.url)), 'real https addresses');
    noInventedCitations(t);
  });

  it('B - "비교표로 만들어봐.": the subject is kept, a table is made, citations stay valid', async () => {
    const t = await turn('B', '비교표로 만들어봐.');
    assert.equal(t.httpStatus, 200);
    assert.equal(t.grounding.turnKind, 'FOLLOW_UP');
    assert.ok(/\|.+\|/.test(t.answer) || /확인|포함되어 있지 않|없/.test(t.answer), 'a table, or an honest statement of what the sources lack');
    assert.ok(/[가-힣]/.test(t.answer));
    noInventedCitations(t);
  });

  it('C - the challenge: checked against retrieved sources, answered in Korean, the earlier mistake dealt with explicitly (judged by reading the transcript)', async () => {
    const t = await turn('C', '지금 갤럭시 폴드8이 판매되고 있는데 폴드7을 미출시라고 하는 것은 잘못된 것 아닌가?');
    assert.equal(t.httpStatus, 200);
    assert.equal(t.grounding.turnKind, 'CORRECTION');
    assert.ok(/[가-힣]/.test(t.answer));
    assert.equal(/live web search is unavailable/i.test(t.answer), false);
    noInventedCitations(t);
    // the factual verdict is NOT asserted here: it is read from the transcript against the sources
    assert.ok(t.verification && typeof t.verification.status === 'string', 'the answer carries a verification report');
  });

  it('D - an unrelated current-fact question (English): the same chain, in English', async () => {
    const t = await turn('D', 'Is the Nintendo Switch 2 released yet, and what is its screen size?');
    assert.equal(t.httpStatus, 200);
    assert.ok((t.answer.match(/[A-Za-z]/g) ?? []).length > 60 && !/[가-힣]/.test(t.answer), 'English is kept');
    noInventedCitations(t);
  });
});

// A real model sometimes cites a source it was never given. NAgex removes such a citation and reports it (grounding.removedCitations, recorded in the transcript); what must hold is that the answer the
// person READS cites only what was retrieved.
function noInventedCitations(t: any): void {
  const retrieved = new Set((t.sources ?? []).map((s: any) => s.id));
  const cited = Array.from(String(t.answer).matchAll(/src_\d+/g)).map((m) => m[0]);
  assert.deepEqual(cited.filter((id) => !retrieved.has(id)), [], `an invented source id reached the person (removed by NAgex: ${JSON.stringify(t.grounding?.removedCitations)})`);
}
