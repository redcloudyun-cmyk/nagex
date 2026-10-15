#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { decideRouting } = await import('../../../dist/src/workspace/input-router.js');
const { NebiusProvider, OpenAIProvider } = await import('../../../dist/src/model-gateway/providers.js');
const { UnifiedModelRouter } = await import('../../../dist/src/model-gateway/unified-model-router.js');
const { AiService } = await import('../../../dist/src/model-gateway/ai-service.js');
const { DocumentStore } = await import('../../../dist/src/creation/document.store.js');
const { ArtifactStore } = await import('../../../dist/src/artifacts/artifact.store.js');
const { DocumentExecutor } = await import('../../../dist/src/creation/executors/document-executor.js');
const { CreationRuntime } = await import('../../../dist/src/creation/creation-runtime.js');
const { ActionApprovalStore } = await import('../../../dist/src/governance/action-approval.store.js');

const checks = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const check = (name, passed, detail) => {
  checks.push({ name, passed, detail });
  console.log(`CHECK ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const expect = (name, condition, detail) => check(name, Boolean(condition), detail);
const textResponse = (body) => new Response(JSON.stringify({ choices: [{ message: { content: body }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } }), { status: 200 });
const jsonResponse = (body) => textResponse(JSON.stringify(body));
const korean = '\uB0B4\uC77C \uD68C\uC758\uB97C \uC5B4\uB5BB\uAC8C \uC900\uBE44\uD558\uBA74 \uC88B\uC744\uAE4C\uC694?';
const owner = { tenantId: 'codex-qa-tenant', ownerId: 'codex-qa-owner' };

const routingCases = [
  { id: 'ko-advice', text: korean, kind: 'ADVICE', language: 'ko' },
  { id: 'en-action', text: 'Schedule a project review tomorrow at 10 AM', kind: 'ACTION_PLAN', language: 'en' },
  { id: 'en-document', text: 'Write a one-page report about approval safety', kind: 'CREATE_ARTIFACT', language: 'en' },
  { id: 'en-negated', text: 'Do not send it, just draft the email', kind: 'CONVERSATION', language: 'en', negated: true },
  { id: 'en-video', text: 'Make a 30 second promo video', kind: 'UNSUPPORTED', language: 'en', target: 'VIDEO' },
  { id: 'en-vague', text: 'help', kind: 'CLARIFY', language: 'en' },
];

for (const item of routingCases) {
  const decision = decideRouting(item.text);
  const expectedTarget = item.target ? decision.targetArtifactType === item.target : true;
  const expectedNegation = item.negated ? decision.executionNegated === true : true;
  check(`one-input/${item.id}`, decision.kind === item.kind && decision.language === item.language && expectedTarget && expectedNegation, `kind=${decision.kind} language=${decision.language} target=${decision.targetArtifactType ?? '-'} risk=${decision.permissionRisk} approval=${decision.needs.some((need) => need.approvalRequired === true)}`);
}

const mainSurface = fs.readFileSync(path.join(repoRoot, 'public', 'main-surface.js'), 'utf8');
const workspaceRoutes = fs.readFileSync(path.join(repoRoot, 'src', 'http', 'routes', 'workspace.routes.ts'), 'utf8');
const documentRoutes = fs.readFileSync(path.join(repoRoot, 'src', 'http', 'routes', 'document-creation.routes.ts'), 'utf8');
const approvalRoutes = fs.readFileSync(path.join(repoRoot, 'src', 'http', 'routes', 'approvals.routes.ts'), 'utf8');
expect('browser-path/one-input-route', mainSurface.includes("api('/api/v1/workspace/route-input'") && workspaceRoutes.includes("'/api/v1/workspace/route-input'"), 'Main composer and server route agree');
expect('browser-path/document-create-open', mainSurface.includes("api('/api/v1/creations/documents'") && mainSurface.includes("/api/v1/creations/documents/' + encodeURIComponent(documentId)") && documentRoutes.includes("'/api/v1/creations/documents'"), 'create and reopen use the canonical document route');
expect('browser-path/approval-boundary', mainSurface.includes("/api/v1/tasks/from-reviewed-plan") && mainSurface.includes("/api/v1/approvals/' + encodeURIComponent") && approvalRoutes.includes("pathname.endsWith('/approve')") && approvalRoutes.includes("pathname.endsWith('/reject')"), 'request approval and verdict stay on approval routes');

const logs = [];
const fakeNebius = new NebiusProvider({
  apiKey: 'local-certification-only',
  model: 'nvidia/Nemotron-3_5-Lightning',
  fetchFn: async () => textResponse('A governed personal AI keeps approval explicit before external change.'),
});
const fakeOpenAI = new OpenAIProvider({
  apiKey: 'local-certification-only',
  model: 'local-fallback',
  fetchFn: async () => textResponse('local fallback'),
});
const router = new UnifiedModelRouter([fakeNebius, fakeOpenAI], {
  info: (event, fields) => logs.push({ event, fields }),
  warn: (event, fields) => logs.push({ event, fields }),
});
const aiService = new AiService(router);
const chat = await aiService.chat({ message: 'What should an approval boundary protect?', mode: 'auto', requestId: 'codex-qa-chat' });
const trace = router.recentCalls(1)[0];
expect('nemotron-first/local-route', chat.provider === 'nebius' && chat.model.includes('Nemotron') && trace?.fallbackUsed === false, `provider=${chat.provider} model=${chat.model} fallback=${trace?.fallbackUsed ?? '-'}; local stub endpoint, not live provider`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-codex-demo-'));
try {
  const documentStore = new DocumentStore({ dir: path.join(root, 'documents') });
  const artifactStore = new ArtifactStore({ dir: path.join(root, 'artifacts') });
  const documentProvider = new NebiusProvider({
    apiKey: 'local-certification-only',
    model: 'nvidia/Nemotron-3_5-Lightning',
    fetchFn: async () => jsonResponse({ title: 'Approval Safety Report', summary: 'Local round-trip evidence', content: '# Approval Safety\n\nExternal actions remain pending until the person approves the exact reviewed payload.' }),
  });
  const documentRouter = new UnifiedModelRouter([documentProvider], { info: () => {}, warn: () => {} });
  const documentRuntime = new CreationRuntime([new DocumentExecutor({ aiService: new AiService(documentRouter), documentStore, artifactStore })]);
  const created = await documentRuntime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Write a one-page report about approval safety',
    options: { documentKind: 'REPORT', locale: 'en', format: 'MARKDOWN' },
    ...owner,
    requestId: 'codex-qa-document',
  });
  const saved = created.status === 'SUCCESS' ? documentStore.get(created.creationId, owner.tenantId, owner.ownerId) : null;
  const recent = artifactStore.list(owner.tenantId, owner.ownerId).find((item) => item.sourceId === created.creationId);
  const reopened = created.status === 'SUCCESS' ? new DocumentStore({ dir: path.join(root, 'documents') }).get(created.creationId, owner.tenantId, owner.ownerId) : null;
  const stranger = created.status === 'SUCCESS' ? new DocumentStore({ dir: path.join(root, 'documents') }).get(created.creationId, owner.tenantId, 'codex-qa-stranger') : null;
  const sameContent = Boolean(saved && reopened && crypto.createHash('sha256').update(saved.content).digest('hex') === crypto.createHash('sha256').update(reopened.content).digest('hex'));
  expect('document/create-save-recent-reopen', created.status === 'SUCCESS' && Boolean(saved?.content) && Boolean(recent) && sameContent, `status=${created.status} saved=${Boolean(saved)} recent=${Boolean(recent)} reopened=${sameContent}; isolated local store`);
  expect('document/owner-isolation', stranger === null, `strangerVisible=${Boolean(stranger)}`);
  expect('document/provider-trace', created.metadata?.provider === 'nebius' && created.metadata?.model?.includes('Nemotron'), `provider=${created.metadata?.provider ?? '-'} model=${created.metadata?.model ?? '-'}; local stub endpoint, not live provider`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

let approvalClock = Date.now();
const approvals = new ActionApprovalStore(() => approvalClock, 60_000);
const approvalOwner = { tenantId: owner.tenantId, principalId: owner.ownerId };
const payload = { destination: 'codex-local-only', title: 'QA harmless action', body: 'No external side effect' };
const approval = approvals.request({ toolId: 'codex.qa.harmless', ...approvalOwner, payload });
let sideEffects = 0;
const execute = (candidate) => {
  approvals.consume(approval.approvalId, approvalOwner.tenantId, approvalOwner.principalId, 'codex.qa.harmless', candidate, 'codex-qa-execute', 'codex-execution-1');
  sideEffects += 1;
};
expect('approval/no-write-before-approval', sideEffects === 0 && approval.status === 'PENDING', `status=${approval.status} sideEffects=${sideEffects}`);
let strangerCode = '-';
try { approvals.approve(approval.approvalId, approvalOwner.tenantId, 'codex-qa-stranger', 'codex-qa-stranger-approve'); } catch (error) { strangerCode = error?.code ?? 'ERROR'; }
expect('approval/owner-isolation', strangerCode === 'APPROVAL_NOT_FOUND' && approval.status === 'PENDING', `stranger=${strangerCode} status=${approval.status}`);
approvals.approve(approval.approvalId, approvalOwner.tenantId, approvalOwner.principalId, 'codex-qa-approve');
let mismatchCode = '-';
try { execute({ ...payload, body: 'changed after review' }); } catch (error) { mismatchCode = error?.code ?? 'ERROR'; }
expect('approval/payload-boundary', mismatchCode === 'APPROVAL_PAYLOAD_MISMATCH' && sideEffects === 0, `mismatch=${mismatchCode} sideEffects=${sideEffects}`);
execute(payload);
let replayCode = '-';
try { execute(payload); } catch (error) { replayCode = error?.code ?? 'ERROR'; }
expect('approval/one-time-consume', sideEffects === 1 && replayCode === 'APPROVAL_ALREADY_CONSUMED', `sideEffects=${sideEffects} replay=${replayCode}`);
const expiring = new ActionApprovalStore(() => approvalClock, 10);
const expiringApproval = expiring.request({ toolId: 'codex.qa.expiry', ...approvalOwner, payload: { value: 'expiry' } });
approvalClock += 11;
let expiryCode = '-';
try { expiring.approve(expiringApproval.approvalId, approvalOwner.tenantId, approvalOwner.principalId, 'codex-qa-expiry'); } catch (error) { expiryCode = error?.code ?? 'ERROR'; }
expect('approval/expiry-fails-closed', expiryCode === 'APPROVAL_EXPIRED', `expiry=${expiryCode}`);

const passed = checks.every((item) => item.passed);
console.log(`SUMMARY checks=${checks.length} passed=${checks.filter((item) => item.passed).length} failed=${checks.filter((item) => !item.passed).length}`);
console.log(`LOCAL_DEMO_READINESS=${passed ? 'PASS' : 'FAIL'}`);
process.exit(passed ? 0 : 1);
