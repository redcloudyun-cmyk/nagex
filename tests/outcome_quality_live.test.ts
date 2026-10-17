// LIVE_EXTERNAL - opt-in. Real documents and real decks through the PRODUCTION routes with a REAL model, to be judged afterwards by the evaluator and by real Word / PowerPoint:
//   DOC-1 (ko) an operations report from a fact sheet in the request, with a table;      DECK-1 (ko) a deck made FROM DOC-1 (the person's own document as the source)
//   DOC-2 (en) a decision memo comparing three options, with a table;                      DECK-2 (en) a decision deck with key figures, a chart and a table, plus the person's own picture
//   DOC-3 (ko) meeting minutes with a decisions table AND the person's own picture (a bar chart of the weekly counts, rendered locally from the same data - NOT an AI-generated image)
// The model is Google Gemini (free-tier key of this machine) behind the Model Gateway: the same path a person's request takes. Nothing is deployed; the server is an isolated in-process instance.
// What it records: the files, the request, the data the person gave (the expectation), timings - NOT a verdict. The verdict is scripts/outcome-quality-evaluate.mjs over these files plus what Word /
// PowerPoint measured (scripts/office-render.ps1). Runs only with NAGEX_OUTCOME_QUALITY_LIVE=1 (a handful of free-tier requests); output goes to NAGEX_LIVE_EVIDENCE_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { ImageStore } from '../src/creation/image.store.js';

const ENABLED = process.env.NAGEX_OUTCOME_QUALITY_LIVE === '1' && Boolean(process.env.GEMINI_API_KEY) && Boolean(process.env.NAGEX_LIVE_EVIDENCE_DIR);
const MODEL = process.env.NAGEX_LIVE_GEMINI_MODEL || 'gemini-flash-lite-latest';
const OUT = process.env.NAGEX_LIVE_EVIDENCE_DIR ?? '';

let h: CanvasAskHarness;
let ctx: BrowserContext;
let owner: { userId: string; tenantId: string };
const manifest: any[] = [];
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// what the person gave, per scenario: the request text IS the corpus, so the evaluator can tell a figure that was given from one that was made up
const FACTS_DOC1 = [
  '- 회의 준비 시간: 기존 45분, 도입 후 12분 (73% 단축)',
  '- 보고서 작성 시간: 기존 3시간, 도입 후 50분 (72% 단축)',
  '- 일정 조율 시간: 기존 30분, 도입 후 5분 (83% 단축)',
  '- 월 비용: 사용자 1명당 12,000원',
  '- 승인 거절률: 4.2%',
  '- 조사 대상: 사용자 48명, 기간 2026년 7월부터 9월',
].join('\n');
const PROMPT_DOC1 = `다음 자료로 2026년 3분기 운영 보고서를 작성해줘. 개요, 처리 시간 변화, 비용과 승인, 위험과 대응, 다음 분기 계획 순서로 쓰고, 처리 시간 변화는 표로 정리해줘. 자료에 없는 숫자는 절대 쓰지 마.\n자료:\n${FACTS_DOC1}`;

const FACTS_DOC2 = [
  '- Option A (hybrid, 3 office days): cost $18,000, 12 weeks, risk Low',
  '- Option B (fully remote): cost $9,500, 12 weeks, risk Medium',
  '- Option C (office only): cost $24,000, 12 weeks, risk Low',
  '- Team size: 30 people. Decision needed by 2026-11-15.',
].join('\n');
const PROMPT_DOC2 = `Write a decision memo recommending one of three options for a 12-week working-model pilot. Include a comparison table, the recommendation with its reasons, and next steps. Use only these facts and add no other numbers:\n${FACTS_DOC2}`;

const FACTS_DOC3 = [
  '- 주간 처리 건수: 1주 320건, 2주 410건, 3주 380건, 4주 460건',
  '- 결정: 승인 대기 알림을 오전 9시에 묶어서 보내기 (A팀, 10월 24일까지)',
  '- 결정: 실패 건 재시도 기준을 3회로 통일 (B팀, 10월 31일까지)',
  '- 확인 필요: 월말 정산 일정 (C팀)',
].join('\n');
const PROMPT_DOC3 = `다음 메모로 주간 운영 회의록을 만들어줘. 결정 사항과 할 일(담당 팀, 기한)은 표로 정리하고, 첨부한 그림(주간 처리 건수 막대그래프)을 본문의 알맞은 곳에 넣어줘. 메모에 없는 숫자나 이름은 쓰지 마.\n메모:\n${FACTS_DOC3}`;

const PROMPT_DECK1 = '이 운영 보고서로 7장짜리 발표자료를 만들어줘. 처리 시간 비교는 차트로, 핵심 수치는 카드로 보여줘. 보고서에 없는 숫자는 쓰지 마.';
const PROMPT_DECK2 = `Make a 6-slide decision deck for leadership from these facts: show the three options' costs as a chart, the comparison as a table, the key figures as cards, and put the attached picture where it helps. Use only these facts and add no other numbers:\n${FACTS_DOC2}`;

// a bar chart as a real picture, rendered locally from the data (a stand-in for a stored image: it is NOT AI-generated and is reported so)
async function renderBarChartPng(data: Array<{ label: string; value: number }>): Promise<Buffer> {
  const max = Math.max(...data.map((d) => d.value));
  const bars = data.map((d, i) => { const hgt = Math.round((d.value / max) * 280); const x = 70 + i * 150; return `<rect x="${x}" y="${330 - hgt}" width="90" height="${hgt}" fill="#0A56F7"/><text x="${x + 45}" y="${322 - hgt}" font-size="22" text-anchor="middle" fill="#1F2937">${d.value}</text><text x="${x + 45}" y="362" font-size="20" text-anchor="middle" fill="#64748B">${d.label}</text>`; }).join('');
  const html = `<body style="margin:0;background:#fff;font-family:'Malgun Gothic',sans-serif"><svg xmlns="http://www.w3.org/2000/svg" width="700" height="390"><line x1="50" y1="330" x2="680" y2="330" stroke="#CBD5E1"/>${bars}</svg></body>`;
  const page = await h.browser.newPage({ viewport: { width: 700, height: 390 } });
  try { await page.setContent(html); return await page.screenshot({ type: 'png' }); } finally { await page.close(); }
}

function storeImage(title: string, bytes: Buffer): string {
  const images = new ImageStore();
  const imageId = `img_${Date.now().toString(16).padStart(12, '0')}${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`.slice(0, 28);
  const now = new Date().toISOString();
  images.save({ imageId, tenantId: owner.tenantId, ownerId: owner.userId, title, prompt: title, aspectRatio: '16:9', mimeType: 'image/png', width: 700, height: 390, binaryStoragePath: images.saveBinary(imageId, bytes, 'image/png'), revisionIndex: 1, sourceRefs: [], providerExecutionMetadata: { providerId: 'local-chart-render', engineOrModel: 'chromium-svg', createdAt: now } as never, createdAt: now, updatedAt: now });
  return h.artifactStore.saveCompleted({ tenantId: owner.tenantId, ownerId: owner.userId, type: 'IMAGE', title, preview: title, sourceType: 'CAPTURE', sourceId: imageId, openTarget: `/api/v1/creations/images/${imageId}` }).artifactId;
}

async function create(kind: 'documents' | 'presentations', id: string, body: Record<string, unknown>, expectation: Record<string, unknown>, ext: 'docx' | 'pptx'): Promise<any> {
  if (manifest.length > 0) await pause(Number(process.env.NAGEX_LIVE_TURN_GAP_MS ?? 6000));
  const started = Date.now();
  const res = await ctx.request.post(`${h.origin}/api/v1/creations/${kind}`, { data: body, headers: { 'content-type': 'application/json' }, timeout: 180000 });
  const elapsedMs = Date.now() - started;
  const json = await res.json().catch(() => ({}));
  const record: any = { id, kind, httpStatus: res.status(), elapsedMs, request: { ...body, sourceArtifactIds: body.sourceArtifactIds ? '(own artifacts)' : undefined }, expectation };
  if (res.status() === 201 || res.status() === 200) {
    const result = json?.data ?? json;
    record.creationId = result.creationId; record.artifactId = result.artifactId; record.title = result.title; record.metadata = result.metadata;
    const download = await ctx.request.get(`${h.origin}/api/v1/creations/${kind}/${result.creationId}/download`);
    const bytes = await download.body();
    record.file = `${id}.${ext}`; record.bytes = bytes.length; record.downloadStatus = download.status();
    fs.writeFileSync(path.join(OUT, record.file), bytes);
    fs.writeFileSync(path.join(OUT, `${id}.content.md`), String(result.content ?? ''), 'utf8');
  } else record.error = json;
  fs.writeFileSync(path.join(OUT, `${id}.expect.json`), JSON.stringify({ id, file: record.file, kind: ext.toUpperCase(), ...expectation }, null, 2));
  manifest.push(record);
  return record;
}

before(async () => {
  if (!ENABLED) return;
  fs.mkdirSync(OUT, { recursive: true });
  h = await startCanvasAskHarness({ scrubProviders: true, env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '', NAGEX_GEMINI_MODEL: MODEL, NAGEX_PROVIDER_PRIORITY: 'gemini' } });
  const user = h.user('outcome-quality-live');
  h.setLocale(user, 'ko');
  owner = { userId: user.userId, tenantId: user.tenantId };
  ctx = await h.newContext('desktop', user, 'ko');
});
after(async () => {
  if (manifest.length > 0 && OUT) {
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), model: MODEL, retrieval: 'none (no web search in this run)', scenarios: manifest }, null, 2));
  }
  await ctx?.close(); await h?.close();
});

describe('LIVE: real documents and decks through the production routes', { skip: ENABLED ? false : 'LIVE_DEPENDENCY_UNAVAILABLE: set NAGEX_OUTCOME_QUALITY_LIVE=1, GEMINI_API_KEY and NAGEX_LIVE_EVIDENCE_DIR' }, () => {
  const state: { doc1?: string; chartImage?: string; chartPng?: Buffer } = {};

  it('DOC-1: an operations report from a fact sheet, in Korean, with a table', async () => {
    const record = await create('documents', 'DOC-1', { prompt: PROMPT_DOC1, locale: 'ko', documentKind: 'REPORT' }, { corpus: PROMPT_DOC1, locale: 'ko', requiredFacts: ['73%', '72%', '83%', '12,000원', '4.2%', '48명', '45분', '12분', '50분'].map((t) => ({ id: t, text: t })), pages: { min: 1, max: 6 } }, 'docx');
    state.doc1 = record.artifactId;
    if (record.httpStatus !== 201) throw new Error(`DOC-1 failed: ${JSON.stringify(record.error)}`);
  });

  it('DOC-2: a decision memo in English comparing three options, with a table', async () => {
    const record = await create('documents', 'DOC-2', { prompt: PROMPT_DOC2, locale: 'en', documentKind: 'MEMO' }, { corpus: PROMPT_DOC2, locale: 'en', requiredFacts: ['$18,000', '$9,500', '$24,000', '30 people'].map((t) => ({ id: t, text: t })), pages: { min: 1, max: 4 } }, 'docx');
    if (record.httpStatus !== 201) throw new Error(`DOC-2 failed: ${JSON.stringify(record.error)}`);
  });

  it('DOC-3: meeting minutes with a decisions table AND the person\'s own picture', async () => {
    state.chartPng = await renderBarChartPng([{ label: '1주', value: 320 }, { label: '2주', value: 410 }, { label: '3주', value: 380 }, { label: '4주', value: 460 }]);
    fs.writeFileSync(path.join(OUT, 'input-chart.png'), state.chartPng);
    state.chartImage = storeImage('주간 처리 건수 막대그래프', state.chartPng);
    const record = await create('documents', 'DOC-3', { prompt: PROMPT_DOC3, locale: 'ko', documentKind: 'REPORT', sourceArtifactIds: [state.chartImage] }, { corpus: PROMPT_DOC3, locale: 'ko', requiredFacts: ['320건', '410건', '380건', '460건', 'A팀', 'B팀', 'C팀', '10월 24일', '10월 31일'].map((t) => ({ id: t, text: t })), minPictures: 1, pages: { min: 1, max: 4 } }, 'docx');
    if (record.httpStatus !== 201) throw new Error(`DOC-3 failed: ${JSON.stringify(record.error)}`);
  });

  it('DECK-1: a Korean deck made from DOC-1 (the person\'s own document as the source), with a chart and key figures', async () => {
    const record = await create('presentations', 'DECK-1', { prompt: PROMPT_DECK1, locale: 'ko', sourceArtifactIds: [state.doc1!] }, { corpus: `${PROMPT_DOC1}\n${PROMPT_DECK1}`, locale: 'ko', requiredFacts: ['73%', '12,000원'].map((t) => ({ id: t, text: t })), minCharts: 1, pages: { min: 7, max: 8 } }, 'pptx');
    if (record.httpStatus !== 201) throw new Error(`DECK-1 failed: ${JSON.stringify(record.error)}`);
  });

  it('DECK-2: an English decision deck with a cost chart, a table, key figures and the person\'s own picture', async () => {
    const record = await create('presentations', 'DECK-2', { prompt: PROMPT_DECK2, locale: 'en', sourceArtifactIds: [state.chartImage!] }, { corpus: PROMPT_DECK2, locale: 'en', requiredFacts: ['$18,000', '$9,500', '$24,000'].map((t) => ({ id: t, text: t })), minCharts: 1, minPictures: 1, pages: { min: 6, max: 7 } }, 'pptx');
    if (record.httpStatus !== 201) throw new Error(`DECK-2 failed: ${JSON.stringify(record.error)}`);
  });
});
