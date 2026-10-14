#!/usr/bin/env node
// Opt-in REAL certification of advisory plans: 10 advice-only requests and 10 action requests through the real AiService.plan (allowAdvisory: true, as the Home route calls it),
// the real UnifiedModelRouter and real providers - no fake fetch. Reported SEPARATELY. Facts only (never a prompt answer, reasoning text, header or credential).
//
//   NAGEX_LIVE_ADVISORY_PLAN=1 node scripts/advisory-plan-live-cert.mjs        (after `npm run build`)
//
// Credentials come from the environment only; on a server NAGEX_CERT_ENV_FROM_PID=<pid of the running service> loads ONLY an allow-list of variable names from that process,
// in this process (see nemotron-first-live-cert.mjs). It makes about 20 paid calls and changes nothing.
import fs from 'node:fs';
import { createProviders } from '../dist/src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../dist/src/model-gateway/unified-model-router.js';
import { AiService } from '../dist/src/model-gateway/ai-service.js';
import { classifyPlanRequest, isConcreteSuggestion } from '../dist/src/model-gateway/plan-request-kind.js';

if (process.env.NAGEX_LIVE_ADVISORY_PLAN !== '1') { console.log('REAL_ADVISORY_PLAN=NOT_RUN (set NAGEX_LIVE_ADVISORY_PLAN=1 to make real, paid calls)'); process.exit(0); }
const ALLOWED = new Set(['NEBIUS_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'NAGEX_NEBIUS_MODEL', 'NAGEX_GEMINI_MODEL', 'NAGEX_OPENAI_MODEL', 'NAGEX_NEBIUS_BASE_URL', 'NAGEX_NEBIUS_TIMEOUT_MS', 'NAGEX_NEBIUS_MAX_TOKENS', 'NAGEX_PROVIDER_PRIORITY']);
const pid = process.env.NAGEX_CERT_ENV_FROM_PID;
if (pid) {
  if (!/^[0-9]{1,9}$/.test(pid)) { console.log('REAL_ADVISORY_PLAN=NOT_RUN (invalid pid)'); process.exit(0); }
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0 && ALLOWED.has(entry.slice(0, i)) && !(entry.slice(0, i) in process.env)) process.env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch { console.log('REAL_ADVISORY_PLAN=NOT_RUN (the process environment is not readable)'); process.exit(0); }
}
if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_API_KEY.trim()) { console.log('REAL_ADVISORY_PLAN=NOT_RUN (NEBIUS_API_KEY is not set)'); process.exit(0); }

const ADVISORY = [
  "Prepare a concise briefing for tomorrow's meeting, use what you remember about this project, draft a one-page summary, and suggest the next action.",
  'What should I focus on this week to keep the launch on track?',
  'Suggest the next action for the vendor negotiation and explain why.',
  'Help me think through the risks of shipping the approval flow next week.',
  "Summarize what matters for tomorrow's budget review and recommend priorities.",
  'Prepare talking points for the design sync and suggest what to ask.',
  '내일 회의 브리핑을 준비하고 다음 행동을 제안해줘.',
  '이번 주에 무엇에 집중해야 할지 조언해줘.',
  '프로젝트 현황을 요약하고 우선순위를 추천해줘.',
  "Give me ideas for how to open Monday's planning meeting.",
];
const ACTION = [
  'Schedule a 30 minute project review tomorrow at 10:00 titled Project review.',
  'Send an email to Alex saying the report is ready.',
  'Cancel my 3 PM meeting on Friday.',
  'Create a calendar event called Budget review next Tuesday at 2 PM for one hour.',
  'Reply to the vendor email and accept the quote.',
  '내일 오전 10시에 프로젝트 리뷰 회의 일정을 잡아줘.',
  '알렉스에게 보고서가 준비됐다고 메일을 보내줘.',
  '금요일 오후 3시 회의를 취소해줘.',
  'Book a 45 minute call with Sam on Thursday at 11:00.',
  'Remind me tomorrow at 9 to send the invoice.',
];

const logs = [];
const router = new UnifiedModelRouter(createProviders(process.env), { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }) });
const service = new AiService(router);
let seq = 0;

async function run(prompt, expectedClass) {
  const requestId = `cert_adv_${++seq}`;
  const row = { class: classifyPlanRequest(prompt).kind, expectedClass, outcome: 'ERROR', kind: '-', provider: '-', model: '-', latencyMs: 0, fallback: '-', reason: '-', steps: '-', suggestions: '-', note: '' };
  const started = Date.now();
  try {
    const result = await service.plan({ prompt, memories: [], mode: 'auto', requestId, allowAdvisory: true });
    const trace = router.recentCalls(1)[0];
    row.kind = result.data.kind ?? 'ACTION';
    row.provider = result.provider; row.model = result.model; row.latencyMs = result.latencyMs;
    row.fallback = trace?.fallbackUsed ? 'yes' : 'no'; row.reason = trace?.fallbackReason ?? '-';
    row.steps = String(result.data.steps.length);
    row.suggestions = String((result.data.suggestions ?? []).length);
    // invariants that must hold for every answer, whoever gave it
    if (row.kind === 'ADVISORY' && (result.data.steps.length !== 0 || !(result.data.suggestions ?? []).every(isConcreteSuggestion) || (result.data.suggestions ?? []).length === 0)) row.note = 'INVARIANT_BROKEN';
    if (row.kind === 'ACTION' && result.data.steps.length === 0) row.note = 'INVARIANT_BROKEN';
    row.outcome = 'OK';
  } catch (error) {
    const failures = Array.isArray(error?.details?.failures) ? error.details.failures.map((f) => `${f.provider}:${f.reason}`).join(',') : '';
    row.note = `${typeof error?.code === 'string' ? error.code : 'ERROR'} ${failures}`.trim();
    row.latencyMs = Date.now() - started;
  }
  row.codes = logs.filter((l) => l.event === 'model_request_failed' && l.fields.requestId === requestId).map((l) => `${l.fields.provider}:${l.fields.code}`);
  return row;
}

const advisoryRows = [];
const actionRows = [];
for (const p of ADVISORY) advisoryRows.push(await run(p, 'ADVISORY'));
for (const p of ACTION) actionRows.push(await run(p, 'ACTION'));

const pad = (v, n) => String(v).padEnd(n);
const print = (title, rows) => {
  console.log(`\n== ${title}`);
  console.log(`${pad('#', 3)}${pad('class', 10)}${pad('answered', 9)}${pad('provider', 9)}${pad('latencyMs', 10)}${pad('fallback', 9)}${pad('steps', 6)}${pad('sugg', 5)}reason / codes`);
  rows.forEach((r, i) => console.log(`${pad(i + 1, 3)}${pad(r.class, 10)}${pad(r.outcome === 'OK' ? r.kind : 'ERROR', 9)}${pad(r.provider, 9)}${pad(r.latencyMs, 10)}${pad(r.fallback, 9)}${pad(r.steps, 6)}${pad(r.suggestions, 5)}${[r.reason !== '-' ? r.reason : '', ...(r.codes ?? []), r.note].filter(Boolean).join(' ')}`));
};
print('ADVICE-ONLY requests (10)', advisoryRows);
print('ACTION requests (10)', actionRows);

const direct = (r) => r.outcome === 'OK' && r.provider === 'nebius' && r.fallback === 'no';
const adv = {
  classified: advisoryRows.filter((r) => r.class === 'ADVISORY').length,
  nemotronDirect: advisoryRows.filter(direct).length,
  advisoryAccepted: advisoryRows.filter((r) => direct(r) && r.kind === 'ADVISORY').length,
  actionPlanFromNemotron: advisoryRows.filter((r) => direct(r) && r.kind === 'ACTION').length,
  fellBack: advisoryRows.filter((r) => r.outcome === 'OK' && r.fallback === 'yes').length,
  errors: advisoryRows.filter((r) => r.outcome !== 'OK').length,
};
const act = {
  classified: actionRows.filter((r) => r.class === 'ACTION').length,
  nemotronDirect: actionRows.filter(direct).length,
  advisoryAnswers: actionRows.filter((r) => r.outcome === 'OK' && r.kind === 'ADVISORY').length,
  zeroStepActionPlans: actionRows.filter((r) => r.outcome === 'OK' && r.kind === 'ACTION' && r.steps === '0').length,
  fellBack: actionRows.filter((r) => r.outcome === 'OK' && r.fallback === 'yes').length,
  errors: actionRows.filter((r) => r.outcome !== 'OK').length,
};
const median = (rows) => { const s = rows.filter((r) => r.outcome === 'OK').map((r) => r.latencyMs).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 'n/a'; };
console.log(`\nADVICE-ONLY: classified advisory ${adv.classified}/10; answered by Nemotron without fallback ${adv.nemotronDirect}/10 (advice accepted ${adv.advisoryAccepted}, a real step plan ${adv.actionPlanFromNemotron}); fell back ${adv.fellBack}; errors ${adv.errors}; median latency ${median(advisoryRows)} ms`);
console.log(`ACTION: classified action ${act.classified}/10; answered by Nemotron without fallback ${act.nemotronDirect}/10; ADVISORY answers ${act.advisoryAnswers} (must be 0); zero-step ACTION plans ${act.zeroStepActionPlans} (must be 0); fell back ${act.fellBack}; errors ${act.errors}; median latency ${median(actionRows)} ms`);
const broken = [...advisoryRows, ...actionRows].filter((r) => r.note === 'INVARIANT_BROKEN').length;
const pass = adv.classified === 10 && adv.nemotronDirect === 10 && act.classified === 10 && act.advisoryAnswers === 0 && act.zeroStepActionPlans === 0 && broken === 0 && adv.errors === 0 && act.errors === 0;
console.log(`GUARDS: advisory-for-action ${act.advisoryAnswers} (must be 0), zero-step action plans ${act.zeroStepActionPlans} (must be 0), broken invariants ${broken} (must be 0)`);
console.log(`REAL_ADVISORY_PLAN=${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
