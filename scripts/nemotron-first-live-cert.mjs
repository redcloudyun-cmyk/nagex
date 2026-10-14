#!/usr/bin/env node
// Opt-in REAL certification of the Nemotron-first policy: real Nebius Token Factory calls through the real AiService / UnifiedModelRouter / providers (no fake fetch).
//
//   NAGEX_LIVE_NEMOTRON_FIRST=1 node scripts/nemotron-first-live-cert.mjs        (after `npm run build`)
//
// Credentials come from the environment only (NEBIUS_API_KEY and, for the fallback demonstration, GEMINI_API_KEY / OPENAI_API_KEY). On a server, NAGEX_CERT_ENV_FROM_PID=<pid of
// the running service> loads ONLY an allow-list of variable NAMES (the provider keys and model ids) from that process, in this process, so no secret is ever typed, printed or
// copied. It prints PASS/FAIL facts only: task, provider, model, latency, token counts, whether the preferred provider answered, and why not. Never a prompt, an answer, reasoning
// text, header or credential. It makes about nine paid calls and changes nothing on the server (it is NOT the running service and starts no listener).
import fs from 'node:fs';
import { createProviders } from '../dist/src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../dist/src/model-gateway/unified-model-router.js';
import { AiService } from '../dist/src/model-gateway/ai-service.js';
import { AuditLogger } from '../dist/src/governance/audit.logger.js';

if (process.env.NAGEX_LIVE_NEMOTRON_FIRST !== '1') {
  console.log('REAL_NEMOTRON_FIRST=NOT_RUN (set NAGEX_LIVE_NEMOTRON_FIRST=1 to make real, paid calls)');
  process.exit(0);
}

const ALLOWED = new Set(['NEBIUS_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'NAGEX_NEBIUS_MODEL', 'NAGEX_GEMINI_MODEL', 'NAGEX_OPENAI_MODEL', 'NAGEX_NEBIUS_BASE_URL', 'NAGEX_NEBIUS_TIMEOUT_MS', 'NAGEX_NEBIUS_MAX_TOKENS', 'NAGEX_PROVIDER_PRIORITY']);
const pid = process.env.NAGEX_CERT_ENV_FROM_PID;
if (pid) {
  if (!/^[0-9]{1,9}$/.test(pid)) { console.log('REAL_NEMOTRON_FIRST=NOT_RUN (invalid pid)'); process.exit(0); }
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0 && ALLOWED.has(entry.slice(0, i)) && !(entry.slice(0, i) in process.env)) process.env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch { console.log('REAL_NEMOTRON_FIRST=NOT_RUN (the process environment is not readable)'); process.exit(0); }
}
if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_API_KEY.trim()) { console.log('REAL_NEMOTRON_FIRST=NOT_RUN (NEBIUS_API_KEY is not set)'); process.exit(0); }

const logs = [];
const logger = { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }) };
const audit = new AuditLogger();
function stack(env) {
  const router = new UnifiedModelRouter(createProviders(env), logger);
  router.setFallbackAuditSink((r) => audit.logEvent({ actor: { type: 'system', id: 'model-router' }, tenant_id: 'system', action: 'model.fallback', resource: { type: 'ModelRequest', id: r.requestId }, result: 'SUCCESS', ...(r.fallbackReason ? { reason_code: r.fallbackReason } : {}), request_id: r.requestId, details: { taskKind: r.taskKind, preferredProvider: r.preferredProvider, actualProvider: r.actualProvider, model: r.model } }));
  return { router, service: new AiService(router) };
}

const real = stack(process.env);
const rows = [];
const nowIso = new Date().toISOString();
const pack = {
  evidencePackId: 'ep_cert_synthetic', query: 'What is a hash-bound one-time approval?', generatedAt: nowIso, freshnessRequirement: 'NONE', category: 'GENERAL', status: 'SUCCESS',
  sources: [
    { sourceId: 'S1', title: 'Synthetic certification note A', url: 'https://example.com/a', snippet: 'An approval is bound to the exact action payload by a hash and can be used once.', retrievedAt: nowIso, freshnessStatus: 'CURRENT' },
    { sourceId: 'S2', title: 'Synthetic certification note B', url: 'https://example.com/b', snippet: 'Changing the target or arguments after approval invalidates the approval.', retrievedAt: nowIso, freshnessStatus: 'CURRENT' },
  ],
};

async function step(name, taskKind, run, check) {
  const started = Date.now();
  let outcome = 'PASS'; let note = '';
  try {
    const response = await run();
    const trace = real.router.recentCalls(1)[0];
    if (!trace || trace.taskKind !== taskKind) { outcome = 'FAIL'; note = 'no routing trace for the task'; }
    else {
      const valid = check(response.data);
      if (!valid) { outcome = 'FAIL'; note = 'the answer was empty or malformed'; }
      if (trace.actualProvider !== 'nebius') { outcome = 'FAIL'; note = `answered by ${trace.actualProvider}: ${trace.fallbackReason ?? 'not preferred'}`; }
      rows.push({ name, taskKind, provider: trace.actualProvider, model: trace.model, latencyMs: trace.latencyMs, fallbackUsed: trace.fallbackUsed, fallbackReason: trace.fallbackReason, outcome, note });
      return;
    }
  } catch (error) {
    outcome = 'FAIL';
    const failures = Array.isArray(error?.details?.failures) ? error.details.failures.map((f) => `${f.provider}:${f.reason}`).join(',') : '';
    note = `${typeof error?.code === 'string' ? error.code : 'ERROR'} ${failures}`.trim();
  }
  rows.push({ name, taskKind, provider: '-', model: '-', latencyMs: Date.now() - started, fallbackUsed: null, fallbackReason: null, outcome, note });
}

// The real paths. Each call goes through the production AiService method, so the TaskKind, JSON mode, validators and routing are the shipped ones.
// NAGEX_CERT_REPEAT=n (1-10) repeats the five paths to measure how often Nemotron answers validly and how long it takes.
const REPEAT = Math.min(10, Math.max(1, Number.parseInt(process.env.NAGEX_CERT_REPEAT ?? '1', 10) || 1));
for (let round = 0; round < REPEAT; round++) {
await step('conversation', 'CHAT', () => real.service.chat({ message: 'In two sentences, what does a personal AI need before it may send an email on my behalf?', mode: 'auto', requestId: 'cert_chat' }), (d) => typeof d.message === 'string' && d.message.trim().length > 20);
await step('planning', 'PLAN', () => real.service.plan({ prompt: 'Prepare for tomorrow\'s project review and suggest the next action.', memories: [], mode: 'auto', requestId: 'cert_plan' }), (d) => d && Array.isArray(d.steps) && d.steps.length > 0);
await step('research', 'RESEARCH_SYNTHESIS', () => real.service.research({ query: pack.query, evidencePack: pack, mode: 'auto', requestId: 'cert_research' }), (d) => typeof d.answer === 'string' && d.answer.trim().length > 20);
await step('meeting-prep', 'MEETING_PREP', () => real.service.meetingPrep({ eventDigest: 'Project review, 10:00, with the design lead', emailsDigest: '', vaultDigest: '', memoryDigest: 'The project ships a hash-bound approval flow.', mode: 'auto', requestId: 'cert_meeting' }), (d) => d && Array.isArray(d.keyPoints) && d.keyPoints.length > 0 && Array.isArray(d.suggestedAgenda) && d.suggestedAgenda.length > 0);
await step('document-draft', 'DOCUMENT_SYNTHESIS', () => real.service.documentSynthesis({ prompt: 'A one-page summary of why every external action needs a one-time approval.', documentKind: 'REPORT', locale: 'en', mode: 'auto', requestId: 'cert_doc' }), (d) => typeof d.title === 'string' && typeof d.content === 'string' && d.content.trim().length > 50);
}

// Control: a task that must NOT go to Nemotron keeps its own route (real call, answered by another provider).
let control = 'NOT_RUN';
try {
  await real.service.brief({ scheduleDigest: 'Project review 10:00', emailsDigest: '', tasksDigest: '', mode: 'auto', requestId: 'cert_brief' });
  const trace = real.router.recentCalls(1)[0];
  control = trace && trace.taskKind === 'DAILY_BRIEF' && trace.actualProvider !== 'nebius' ? `PASS (DAILY_BRIEF answered by ${trace.actualProvider})` : 'FAIL (DAILY_BRIEF was routed to Nemotron)';
} catch (error) { control = `FAIL (${typeof error?.code === 'string' ? error.code : 'ERROR'})`; }

// Real fallback: point Nemotron at a model id that does not exist (the provider answers 404) so the preferred route genuinely fails, then show the fallback, its reason and its audit record.
let fallback = 'NOT_RUN';
const hasOther = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
if (hasOther) {
  const broken = stack({ ...process.env, NAGEX_NEBIUS_MODEL: 'nvidia/nagex-certification-model-that-does-not-exist' });
  try {
    await broken.service.chat({ message: 'Say hello in five words.', mode: 'auto', requestId: 'cert_fallback' });
    const trace = broken.router.recentCalls(1)[0];
    const audited = audit.getAuditLogs('system').some((e) => e.action === 'model.fallback' && e.request_id === 'cert_fallback' && e.reason_code === trace?.fallbackReason);
    const logged = logs.some((l) => l.event === 'model_fallback' && l.fields.requestId === 'cert_fallback');
    fallback = trace && trace.fallbackUsed && trace.preferredProvider === 'nebius' && trace.actualProvider !== 'nebius' && audited && logged
      ? `PASS (preferred nebius failed: ${trace.fallbackReason}; answered by ${trace.actualProvider}; audit record written: ${audited}; log line written: ${logged})`
      : `FAIL (fallbackUsed=${trace?.fallbackUsed} reason=${trace?.fallbackReason} audited=${audited} logged=${logged})`;
  } catch (error) { fallback = `FAIL (${typeof error?.code === 'string' ? error.code : 'ERROR'})`; }
}

const pad = (v, n) => String(v).padEnd(n);
console.log(`${pad('step', 15)}${pad('task', 20)}${pad('provider', 10)}${pad('model', 32)}${pad('latencyMs', 11)}${pad('fallback', 10)}result`);
for (const r of rows) console.log(`${pad(r.name, 15)}${pad(r.taskKind, 20)}${pad(r.provider, 10)}${pad(r.model, 32)}${pad(r.latencyMs, 11)}${pad(r.fallbackUsed === null ? '-' : r.fallbackUsed ? 'yes' : 'no', 10)}${r.outcome}${r.note ? ' - ' + r.note : ''}`);
const usage = logs.filter((l) => l.event === 'model_request_succeeded' && l.fields.provider === 'nebius').map((l) => `${l.fields.taskKind}: in=${l.fields.inputTokens} out=${l.fields.outputTokens} reasoning=${l.fields.reasoningTokens}`);
console.log(`nebius token counts (provider-reported): ${usage.join(' | ') || 'n/a'}`);
console.log(`control (a non-Nemotron task keeps its route): ${control}`);
console.log(`real fallback with audit: ${fallback}`);
const byTask = {};
for (const r of rows) { const e = (byTask[r.taskKind] ??= { n: 0, ok: 0, ms: [] }); e.n++; if (r.outcome === 'PASS') e.ok++; e.ms.push(r.latencyMs); }
for (const [task, e] of Object.entries(byTask)) { const s = [...e.ms].sort((a, b) => a - b); console.log(`summary ${task}: ${e.ok}/${e.n} answered by Nemotron without fallback; latency min=${s[0]} median=${s[Math.floor(s.length / 2)]} max=${s[s.length - 1]} ms`); }
const allPass = rows.length === 5 * REPEAT && rows.every((r) => r.outcome === 'PASS');
console.log(`REAL_NEMOTRON_FIRST=${allPass ? 'PASS' : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
