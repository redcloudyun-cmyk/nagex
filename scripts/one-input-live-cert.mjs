#!/usr/bin/env node
// Opt-in REAL certification of One Input: Korean and English requests are routed by the real InputRouter, then the model-backed paths (advice / action plan / answer)
// run through the real AiService, the real UnifiedModelRouter and real providers - no fake fetch. Facts only: never a prompt, an answer, a header or a credential.
//
//   NAGEX_LIVE_ONE_INPUT=1 node scripts/one-input-live-cert.mjs        (after `npm run build`)
//
// Credentials come from the environment only; on a server NAGEX_CERT_ENV_FROM_PID=<pid of the running service> loads ONLY an allow-list of variable names from that
// process, into this process (see nemotron-first-live-cert.mjs). It makes about 20 paid calls and changes nothing (no task, approval or record is created).
import fs from 'node:fs';
import { createProviders } from '../dist/src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../dist/src/model-gateway/unified-model-router.js';
import { AiService } from '../dist/src/model-gateway/ai-service.js';
import { InputRouter } from '../dist/src/workspace/input-router.js';

if (process.env.NAGEX_LIVE_ONE_INPUT !== '1') { console.log('REAL_ONE_INPUT=NOT_RUN (set NAGEX_LIVE_ONE_INPUT=1 to make real, paid calls)'); process.exit(0); }
const ALLOWED = new Set(['NEBIUS_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'NAGEX_NEBIUS_MODEL', 'NAGEX_GEMINI_MODEL', 'NAGEX_OPENAI_MODEL', 'NAGEX_NEBIUS_BASE_URL', 'NAGEX_NEBIUS_TIMEOUT_MS', 'NAGEX_NEBIUS_MAX_TOKENS', 'NAGEX_PROVIDER_PRIORITY']);
const pid = process.env.NAGEX_CERT_ENV_FROM_PID;
if (pid) {
  if (!/^[0-9]{1,9}$/.test(pid)) { console.log('REAL_ONE_INPUT=NOT_RUN (invalid pid)'); process.exit(0); }
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0 && ALLOWED.has(entry.slice(0, i)) && !(entry.slice(0, i) in process.env)) process.env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch { console.log('REAL_ONE_INPUT=NOT_RUN (the process environment is not readable)'); process.exit(0); }
}
if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_API_KEY.trim()) { console.log('REAL_ONE_INPUT=NOT_RUN (NEBIUS_API_KEY is not set)'); process.exit(0); }

const REQUESTS = [
  // advice (Plan route, advisory contract)
  { id: 'A-ko', text: '내일 회의를 어떻게 준비하면 좋을까?', expect: 'ADVICE' },
  { id: 'A-ko2', text: '이번 주에 무엇에 집중해야 할지 조언해줘.', expect: 'ADVICE' },
  { id: 'A-ko3', text: '프로젝트 현황을 요약하고 우선순위를 추천해줘.', expect: 'ADVICE' },
  { id: 'A-en', text: "How should I prepare for tomorrow's meeting?", expect: 'ADVICE' },
  { id: 'A-en2', text: 'What should I focus on this week to keep the launch on track?', expect: 'ADVICE' },
  // action (Plan route, steps required, approval-gated downstream)
  { id: 'B-ko', text: '내일 오전 10시에 프로젝트 리뷰 회의를 잡아줘', expect: 'ACTION_PLAN' },
  { id: 'B-ko2', text: '알렉스에게 보고서가 준비됐다고 메일을 보내줘', expect: 'ACTION_PLAN' },
  { id: 'B-ko3', text: '금요일 오후 3시 회의를 취소해줘', expect: 'ACTION_PLAN' },
  { id: 'B-en', text: 'Schedule a project review meeting tomorrow at 10 AM', expect: 'ACTION_PLAN' },
  { id: 'B-en2', text: 'Send an email to Alex saying the report is ready', expect: 'ACTION_PLAN' },
  // plain conversation (Ask route)
  { id: 'Q-ko', text: '네이젝스가 뭐야? 두 문장으로 설명해줘.', expect: 'CONVERSATION' },
  { id: 'Q-ko2', text: '보내지 말고 이메일 초안만 작성해줘. 주제는 다음 주 회의 일정 안내야.', expect: 'CONVERSATION' },
  { id: 'Q-en', text: 'What is a personal AI assistant? Answer in two sentences.', expect: 'CONVERSATION' },
];

const logs = [];
const router = new UnifiedModelRouter(createProviders(process.env), { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }) });
const service = new AiService(router);
let seq = 0;
const hangulShare = (text) => { const h = (String(text).match(/[ㄱ-ㆎ가-힣]/g) || []).length; const l = (String(text).match(/[A-Za-z]/g) || []).length + h; return l ? Math.round((100 * h) / l) : 0; };
const visibleText = (value) => Array.isArray(value) ? value.map(visibleText).join(' ') : value && typeof value === 'object' ? Object.entries(value).filter(([k]) => ['goal', 'summary', 'reasoningSummary', 'suggestions', 'title', 'reasoning', 'steps'].includes(k)).map(([, v]) => visibleText(v)).join(' ') : typeof value === 'string' ? value : '';

const rows = [];
for (const req of REQUESTS) {
  const requestId = `cert_oi_${++seq}`;
  const decision = InputRouter.classify({ text: req.text }).decision;
  const row = { id: req.id, expect: req.expect, routed: decision.kind, routeOk: decision.kind === req.expect, outcome: 'ERROR', provider: '-', model: '-', latencyMs: 0, fallback: '-', reason: '-', attempts: '-', kind: '-', steps: '-', hangul: -1, note: '' };
  const started = Date.now();
  try {
    let result; let text = '';
    if (decision.kind === 'ADVICE' || decision.kind === 'ACTION_PLAN') {
      result = await service.plan({ prompt: req.text, memories: [], mode: 'auto', requestId, allowAdvisory: decision.kind === 'ADVICE' });
      row.kind = result.data.kind ?? 'ACTION'; row.steps = String(result.data.steps.length);
      text = visibleText(result.data);
      // invariants that must hold whoever answered: advice has no steps; an action plan has at least one
      if (decision.kind === 'ADVICE' && row.kind === 'ADVISORY' && result.data.steps.length !== 0) row.note = 'INVARIANT_BROKEN';
      if (decision.kind === 'ACTION_PLAN' && (row.kind === 'ADVISORY' || result.data.steps.length === 0)) row.note = 'INVARIANT_BROKEN';
    } else {
      result = await service.chat({ message: req.text, mode: 'auto', requestId });
      row.kind = 'ANSWER'; text = result.data.message;
    }
    const trace = router.recentCalls(1)[0];
    row.provider = result.provider; row.model = result.model; row.latencyMs = result.latencyMs;
    row.fallback = trace?.fallbackUsed ? 'yes' : 'no'; row.reason = trace?.fallbackReason ?? '-';
    row.hangul = hangulShare(text);
    row.outcome = 'OK';
  } catch (error) {
    const failures = Array.isArray(error?.details?.failures) ? error.details.failures.map((f) => `${f.provider}:${f.reason}`).join(',') : '';
    row.note = `${typeof error?.code === 'string' ? error.code : 'ERROR'} ${failures}`.trim();
    row.latencyMs = Date.now() - started;
  }
  row.attempts = (logs.find((l) => l.event === 'model_request_succeeded' && l.fields.requestId === requestId)?.fields.attempts) ?? '-';
  rows.push(row);
}

const pad = (v, n) => String(v).padEnd(n);
console.log(`\n${pad('id', 8)}${pad('routed', 14)}${pad('answered', 10)}${pad('provider', 9)}${pad('model', 30)}${pad('ms', 7)}${pad('fallback', 9)}${pad('tries', 6)}${pad('steps', 6)}${pad('hangul%', 8)}note`);
for (const r of rows) console.log(`${pad(r.id, 8)}${pad(r.routed, 14)}${pad(r.outcome === 'OK' ? r.kind : 'ERROR', 10)}${pad(r.provider, 9)}${pad(r.model, 30)}${pad(r.latencyMs, 7)}${pad(r.fallback, 9)}${pad(r.attempts, 6)}${pad(r.steps, 6)}${pad(r.hangul, 8)}${[r.reason !== '-' ? r.reason : '', r.note].filter(Boolean).join(' ')}`);

const direct = (r) => r.outcome === 'OK' && r.provider === 'nebius' && r.model.toLowerCase().includes('nemotron') && r.fallback === 'no';
const ko = rows.filter((r) => r.id.includes('-ko') && r.outcome === 'OK');
const en = rows.filter((r) => r.id.includes('-en') && r.outcome === 'OK');
const summary = {
  routed: rows.filter((r) => r.routeOk).length,
  nemotronDirect: rows.filter(direct).length,
  fellBack: rows.filter((r) => r.outcome === 'OK' && r.fallback === 'yes').length,
  errors: rows.filter((r) => r.outcome !== 'OK').length,
  broken: rows.filter((r) => r.note === 'INVARIANT_BROKEN').length,
  koreanRequestsAnsweredInKorean: ko.filter((r) => r.hangul >= 50).length,
  koreanRequests: ko.length,
  englishRequestsAnsweredInEnglish: en.filter((r) => r.hangul <= 5).length,
  englishRequests: en.length,
};
console.log(`\nROUTING: ${summary.routed}/${rows.length} requests routed as expected`);
console.log(`MODEL_ROUTE: answered by Nemotron without fallback ${summary.nemotronDirect}/${rows.length}; fell back ${summary.fellBack}; errors ${summary.errors}; broken invariants ${summary.broken} (must be 0)`);
console.log(`LANGUAGE: Korean requests answered mostly in Korean ${summary.koreanRequestsAnsweredInKorean}/${summary.koreanRequests}; English requests answered in English ${summary.englishRequestsAnsweredInEnglish}/${summary.englishRequests}`);
const pass = summary.routed === rows.length && summary.nemotronDirect === rows.length && summary.broken === 0 && summary.errors === 0
  && summary.koreanRequestsAnsweredInKorean === summary.koreanRequests && summary.englishRequestsAnsweredInEnglish === summary.englishRequests;
console.log(`REAL_ONE_INPUT=${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
