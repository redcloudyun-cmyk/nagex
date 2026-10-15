// D-9 - the first complete OWNER-LOCAL, human-approved action: "save this to my Vault". Natural language -> exact draft preview -> sealed plan -> request approval ->
// the unchanged ActionApprovalStore -> explicit Approve -> TaskContinuationCoordinator -> ExecutingTaskRunner -> CapabilityBroker -> VaultSaveService -> one verified item in the
// Vault the person opens again + an Activity record. Everything is local and deterministic (temp directories, no network, no model: the draft is built from the person's own words).
//
// What must hold: nothing is written before Approve; Approve writes exactly one owner-visible item; decline / expiry / tamper / replay / restart / a second click write nothing more;
// a failed write is never reported as saved; another owner can neither see, approve nor replay anything; audit and Activity never carry the text.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { ExecutingTaskRunner } from '../src/tasks/runners/executing-task.runner.js';
import { TaskContinuationStore } from '../src/tasks/task-continuation.store.js';
import { TaskContinuationCoordinator } from '../src/tasks/task-continuation.coordinator.js';
import { DurableTaskRunStateStore } from '../src/tasks/durable-task-run-state.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { PlanSeal } from '../src/planning/plan-seal.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { handleTasksRunRoutes } from '../src/http/routes/tasks.routes.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { VaultStore } from '../src/workspace/vault.store.js';
import { VaultSaveService, vaultItemIdFor } from '../src/workspace/vault-save.service.js';
import { checkVaultDraft, inlineVaultText, isVaultSaveRequest, VAULT_SAVE_LIMITS } from '../src/workspace/vault-save-intent.js';
import { buildVaultSavePlan } from '../src/planning/vault-save-plan.js';
import { decideRouting, InputRouter } from '../src/workspace/input-router.js';
import { authAs } from './_s1_session_auth.js';

const TENANT = 'ten_vault_save';
const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex-vault-${prefix}-`));

const MEETING = '# 주간 회의 요약\n\n- 출시일은 다음 주 금요일로 확정했습니다.\n- 담당자: 민수\n\n다음 회의는 목요일 오후 3시입니다.';

describe('the words of the request decide whether it is a Vault save, and which text is meant', () => {
  const YES = [
    '회의 요약을 내 보관함에 저장해줘', '이 내용을 보관함에 저장해줘', '방금 답변을 내 보관함에 저장해 줘', '"내일 10시 치과" 보관함에 저장해줘', '보관함에 넣어줘',
    'Save this summary to my Vault', 'Save the meeting summary to my vault please', 'Put that in my vault', 'Store this in the Vault', 'Please save it to my vault',
  ];
  const NO = [
    '보관함에 어떻게 저장해?', 'How do I save something to my Vault?', 'Where is my Vault?', '보관함에서 삭제해줘', '내 보관함에 있는 문서 보여줘', '보관함 정리해줘',
    'Show me what is in my vault', '회의 요약을 알려줘', 'Save the date', '이 내용을 저장해줘',
  ];
  test('requests to save into the Vault are recognised; questions, deletions, listings and other words are not', () => {
    for (const text of YES) assert.equal(isVaultSaveRequest(text), true, text);
    for (const text of NO) assert.equal(isVaultSaveRequest(text), false, text);
  });

  test('One Input routes it as a plan that waits for approval (never a chat answer, never a silent save); a negated request, a question and a quick note are unchanged', () => {
    for (const text of YES) {
      const d = decideRouting(text);
      assert.equal(d.kind, 'ACTION_PLAN', text);
      assert.ok(d.reasonCodes.includes('VAULT_SAVE') && d.reasonCodes.includes('APPROVAL_REQUIRED'), text);
      assert.equal(d.needs.at(-1)?.approvalRequired, true, text);
      assert.equal(d.destructive, false, text);
    }
    for (const text of ['보관함에 저장하지 마', 'Do not save it to my vault']) assert.ok(!decideRouting(text).reasonCodes.includes('VAULT_SAVE'), text);
    for (const text of ['보관함에 어떻게 저장해?', 'How do I save something to my Vault?']) assert.notEqual(decideRouting(text).kind, 'ACTION_PLAN', text);
    // the generic quick note is a different, unchanged path
    for (const text of ['메모: 우유 사기', 'Save note: buy milk', 'remember to call Dana']) assert.equal(InputRouter.classify({ text }).decision.kind, 'CAPTURE', text);
  });

  test('only text the person wrote in the request counts as supplied: quoted text, or the text after "vault:"', () => {
    assert.equal(inlineVaultText('"내일 10시 치과" 보관함에 저장해줘'), '내일 10시 치과');
    assert.equal(inlineVaultText('내 보관함에 저장해줘: 우유, 계란'), '우유, 계란');
    assert.equal(inlineVaultText('Save to my vault: call Dana at 3'), 'call Dana at 3');
    assert.equal(inlineVaultText('회의 요약을 내 보관함에 저장해줘'), null);
  });
});

describe('the draft: built from the person\'s words only, exact, bounded', () => {
  test('the previous answer is saved as shown; a quoted text wins over it; nothing is summarised or invented', () => {
    const fromAnswer = buildVaultSavePlan({ prompt: '회의 요약을 내 보관함에 저장해줘', contextText: MEETING });
    assert.equal(fromAnswer.kind, 'PLAN');
    if (fromAnswer.kind !== 'PLAN') return;
    assert.equal(fromAnswer.source, 'PREVIOUS_ANSWER');
    const step = fromAnswer.plan.steps[0];
    assert.equal(step.tool, 'vault.save_note');
    assert.equal(step.requiresApproval, true);
    assert.deepEqual(step.parameters, { title: '주간 회의 요약', content: MEETING, source: 'PREVIOUS_ANSWER' });
    assert.equal(fromAnswer.plan.steps.length, 1);

    const quoted = buildVaultSavePlan({ prompt: 'Save "Call Dana about the contract" to my Vault', contextText: MEETING });
    assert.equal(quoted.kind, 'PLAN');
    if (quoted.kind === 'PLAN') {
      assert.equal(quoted.source, 'USER_MESSAGE');
      assert.deepEqual(quoted.plan.steps[0].parameters, { title: 'Call Dana about the contract', content: 'Call Dana about the contract', source: 'USER_MESSAGE' });
    }
  });

  test('with nothing to save it asks what to save; it never makes content up, and it never shortens a text that is too long', () => {
    const none = buildVaultSavePlan({ prompt: '회의 요약을 내 보관함에 저장해줘', contextText: '   ' });
    assert.equal(none.kind, 'NEEDS_CONTENT');
    const noneEn = buildVaultSavePlan({ prompt: 'Save the summary to my vault', contextText: null });
    assert.equal(noneEn.kind, 'NEEDS_CONTENT');
    if (noneEn.kind === 'NEEDS_CONTENT') assert.equal(noneEn.language, 'en');
    const long = buildVaultSavePlan({ prompt: '내 보관함에 저장해줘', contextText: 'a'.repeat(VAULT_SAVE_LIMITS.contentChars + 1) });
    assert.equal(long.kind, 'INVALID');
    if (long.kind === 'INVALID') { assert.equal(long.problem, 'TOO_LONG'); assert.match(long.message.ko, /아무것도 저장하지 않았어요/); }
    const control = buildVaultSavePlan({ prompt: '내 보관함에 저장해줘', contextText: 'bad\u0000text' });
    assert.equal(control.kind, 'INVALID');
  });

  test('the draft check is strict: exactly title / content / source, printable, bounded', () => {
    const ok = { title: 'T', content: 'body', source: 'USER_MESSAGE' };
    assert.equal(checkVaultDraft(ok).ok, true);
    for (const bad of [null, [], 'x', { ...ok, extra: 1 }, { title: 'T', content: 'b' }, { ...ok, source: 'MODEL' }, { ...ok, title: '' }, { ...ok, content: '   ' }, { ...ok, title: 'x'.repeat(121) }, { ...ok, content: 'a\u0007b' }, { ...ok, content: 42 }]) {
      assert.equal(checkVaultDraft(bad).ok, false, JSON.stringify(bad));
    }
  });
});

// ---- a world that can be "restarted": every store lives in a directory, every service is rebuilt from them ----
interface Dirs { tasks: string; runs: string; continuations: string; durable: string; approvals: string; exec: string; idem: string; notifications: string; vault: string; activity: string }
const newDirs = (): Dirs => ({ tasks: tempDir('tasks'), runs: tempDir('runs'), continuations: tempDir('cont'), durable: tempDir('durable'), approvals: tempDir('appr'), exec: tempDir('exec'), idem: tempDir('idem'), notifications: tempDir('notif'), vault: tempDir('vault'), activity: tempDir('act') });

const resolver = new PlanResolver(skillRegistry, toolRegistry);

interface WorldOptions { now?: () => number; ttlMs?: number; vault?: Pick<VaultStore, 'saveItemOnce' | 'getItem'>; withService?: boolean }

function world(dirs: Dirs, options: WorldOptions = {}) {
  const auditLogger = new AuditLogger();
  const clock = options.now ?? Date.now;
  const hooks: Array<(r: { approvalId: string }) => void> = [];
  const actionApprovals = new PersistentActionApprovalStore({ dir: dirs.approvals, now: clock, env: { ...process.env, ...(options.ttlMs ? { NAGEX_APPROVAL_TTL_SECONDS: String(options.ttlMs / 1000) } : {}) } as NodeJS.ProcessEnv, onExpired: (record) => { for (const hook of hooks) hook(record); } });
  const vaultStore = new VaultStore(dirs.vault);
  const activityStore = new ActivityStore({ dir: dirs.activity });
  const executionStore = new ExecutionStore({ dir: dirs.exec });
  const service = new VaultSaveService({ approvals: actionApprovals, vault: options.vault ?? vaultStore, activity: activityStore, audit: auditLogger, executions: executionStore });
  process.env.NAGEX_TEST_VAULT_IDEMPOTENCY_DIR = dirs.idem;
  const broker = new CapabilityBroker({} as any, {} as any, {} as any, auditLogger, new CapabilityRegistry(), 'test_vault_idem', 'NAGEX_TEST_VAULT_IDEMPOTENCY_DIR', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, options.withService === false ? undefined : service);
  const taskStore = new TaskStore({ dir: dirs.tasks });
  const taskRunStore = new TaskRunStore({ dir: dirs.runs });
  const continuations = new TaskContinuationStore({ dir: dirs.continuations });
  const durable = new DurableTaskRunStateStore({ dir: dirs.durable });
  const aiService: any = { plan: async () => { throw new Error('the model must never be asked on the run path'); } };
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], continuations, durable);
  const coordinator = new TaskContinuationCoordinator(continuations, durable, runner, taskStore, taskRunStore, auditLogger);
  hooks.push((record) => coordinator.onExpired(record.approvalId));
  const planSeal = new PlanSeal(clock, 30 * 60_000);
  const deps: any = {
    taskStore, taskRunStore, taskScheduler: new TaskScheduler(taskStore, taskRunStore, runner, auditLogger), service: aiService, aiService, planResolver: resolver, capabilityBroker: broker, getRelevantMemories: () => [],
    taskContinuations: continuations, durableTaskRunState: durable, auditLogger, notificationEngine: new NotificationEngine({ store: new NotificationStore({ dir: dirs.notifications }), auditLogger }),
    modelErrorResult: (e: any) => ({ status: 400, data: { error: { code: e?.code ?? 'ERROR', message: e?.message ?? String(e) } } }), actionApprovals, planSeal,
  };
  const run = (user: string, plan: unknown, token: unknown, tenant = TENANT) => handleTasksRunRoutes('POST', '/api/v1/tasks/from-reviewed-plan', { plan, planSeal: { token } }, authAs(tenant, user), {}, deps) as Promise<any>;
  const vaultItems = (user: string, tenant = TENANT) => new VaultStore(dirs.vault).listItems(tenant, user);
  return { auditLogger, actionApprovals, vaultStore, activityStore, executionStore, taskStore, taskRunStore, continuations, durable, coordinator, planSeal, run, broker, service, vaultItems, seal: (user: string, plan: unknown, tenant = TENANT) => planSeal.seal({ tenantId: tenant, principalId: user }, plan) };
}

const planOf = (prompt = '회의 요약을 내 보관함에 저장해줘', contextText: string | null = MEETING) => {
  const built = buildVaultSavePlan({ prompt, contextText });
  if (built.kind !== 'PLAN') throw new Error('the draft was not built: ' + built.kind);
  return built.plan;
};

describe('plan -> request approval -> Approve -> one verified Vault item', () => {
  test('nothing is written before Approve; the person approves the EXACT text; Approve writes exactly one item that is read back; Activity and audit carry no text', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_1';
    const plan = planOf();
    const issued = w.seal(user, plan);

    const started = await w.run(user, plan, issued.token);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.state, 'APPROVAL_REQUIRED');
    assert.equal(started.data.run.status, 'WAITING_APPROVAL');
    // the approval request wrote nothing: no item, no Activity, no execution
    assert.equal(w.vaultItems(user).length, 0, 'no write before Approve');
    assert.equal(w.activityStore.list(TENANT, user).filter((a) => a.type.startsWith('vault.')).length, 0);
    assert.equal(w.executionStore.list().filter((e) => e.principalId === user).length, 0);
    // what the person approves is the whole text, line breaks included, plus the title and where it came from
    const args = Object.fromEntries((started.data.proposal.arguments as Array<{ name: string; value: string }>).map((a) => [a.name, a.value]));
    assert.equal(args.content, MEETING);
    assert.equal(args.title, '주간 회의 요약');
    assert.equal(args.source, 'PREVIOUS_ANSWER');
    assert.equal(started.data.proposal.capabilityId, 'vault.save_note');

    const approvalId: string = started.data.proposal.approval.approvalId;
    w.actionApprovals.approve(approvalId, TENANT, user);
    assert.equal(w.vaultItems(user).length, 0, 'approving alone does not write; the continuation does');
    await w.coordinator.onApproved(approvalId);

    const run = w.taskRunStore.get(started.data.runId)!;
    assert.equal(run.status, 'SUCCEEDED');
    const step = (run.result as any).steps?.[0] ?? (run.result as any).completedSteps?.[0];
    assert.equal(step.status, 'EXECUTED');
    assert.equal(step.result.outcome, 'SAVED_TO_VAULT');
    assert.deepEqual(step.result.verification, { status: 'VERIFIED', reason: 'REREAD_FROM_OWNER_VAULT' });

    const items = w.vaultItems(user);
    assert.equal(items.length, 1, 'exactly one item');
    const item = items[0];
    assert.equal(item.vaultItemId, step.result.vaultItemId);
    assert.equal(item.vaultItemId, vaultItemIdFor(TENANT, user, approvalId));
    assert.equal(item.title, '주간 회의 요약');
    assert.equal(item.type, 'DOCUMENT');
    assert.equal(item.metadata.contentText, MEETING);
    assert.equal(item.metadata.sizeBytes, Buffer.byteLength(MEETING, 'utf8'));
    assert.equal(item.sourceRef, approvalId);
    // Activity: one COMPLETED record, the title only
    const activity = w.activityStore.list(TENANT, user).filter((a) => a.type.startsWith('vault.'));
    assert.equal(activity.length, 1);
    assert.equal(activity[0].status, 'COMPLETED');
    assert.equal(activity[0].type, 'vault.item_saved');
    assert.equal(activity[0].source?.approvalId, approvalId);
    assert.ok(!JSON.stringify(activity).includes('출시일'), 'Activity never carries the text');
    // audit: the trail exists and carries no text and no title
    const trail = JSON.stringify(w.auditLogger.getAuditLogs(TENANT, 500));
    assert.match(trail, /tool\.execution\.succeeded/);
    assert.match(trail, /approval\.requested/);
    const leaks = w.auditLogger.getAuditLogs(TENANT, 500).filter((e) => JSON.stringify(e).includes('출시일') || JSON.stringify(e).includes('주간 회의 요약')).map((e) => e.action + ':' + JSON.stringify(e.details).slice(0, 200));
    assert.deepEqual(leaks, [], 'audit never carries the draft');
    // the execution record links the approval to the item
    const execution = w.executionStore.list().find((e) => e.approvalId === approvalId)!;
    assert.equal(execution.status, 'SUCCEEDED');
    assert.equal(execution.externalId, item.vaultItemId);
  });

  test('a second Approve, a second continuation trigger and a replay of the same plan add nothing', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_2';
    const plan = planOf();
    const issued = w.seal(user, plan);
    const started = (await w.run(user, plan, issued.token)).data;
    const approvalId = started.proposal.approval.approvalId;
    w.actionApprovals.approve(approvalId, TENANT, user);
    await Promise.all([w.coordinator.onApproved(approvalId), w.coordinator.onApproved(approvalId), w.coordinator.onApproved(approvalId)]);
    assert.equal(w.vaultItems(user).length, 1, 'concurrent triggers: one item');
    assert.throws(() => w.actionApprovals.approve(approvalId, TENANT, user), 'a spent approval cannot be granted again');
    const again = await w.run(user, plan, issued.token);
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'PLAN_ALREADY_STARTED');
    // the broker itself refuses to spend the approval twice
    await assert.rejects(() => w.service.executeApproved({ tenantId: TENANT, principalId: user, requestId: 'req_replay', payload: plan.steps[0].parameters, approvalId }), (e: any) => e.code === 'APPROVAL_ALREADY_CONSUMED');
    assert.equal(w.vaultItems(user).length, 1);
    assert.equal(w.activityStore.list(TENANT, user).filter((a) => a.type.startsWith('vault.')).length, 1, 'one Activity record per approval');
  });

  test('two different requests make two different items - the exactly-once guard is per approval, not a blanket dedupe of identical text', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_3';
    for (let i = 0; i < 2; i += 1) {
      const plan = planOf();
      const started = (await w.run(user, plan, w.seal(user, plan).token)).data;
      w.actionApprovals.approve(started.proposal.approval.approvalId, TENANT, user);
      await w.coordinator.onApproved(started.proposal.approval.approvalId);
    }
    assert.equal(w.vaultItems(user).length, 2);
  });
});

describe('decline, expiry and restart write nothing more than they should', () => {
  test('decline: zero writes, the run ends FAILED / APPROVAL_REJECTED, no Activity "saved"', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_4';
    const plan = planOf();
    const started = (await w.run(user, plan, w.seal(user, plan).token)).data;
    w.actionApprovals.reject(started.proposal.approval.approvalId, TENANT, user);
    w.coordinator.onRejected(started.proposal.approval.approvalId);
    await w.coordinator.onApproved(started.proposal.approval.approvalId);
    assert.equal(w.taskRunStore.get(started.runId)!.errorCode, 'APPROVAL_REJECTED');
    assert.equal(w.vaultItems(user).length, 0);
    assert.equal(w.activityStore.list(TENANT, user).filter((a) => a.type.startsWith('vault.')).length, 0);
  });

  test('expiry: the run ends by itself, a late Approve is refused, zero writes', async () => {
    let now = Date.now();
    const w = world(newDirs(), { now: () => now, ttlMs: 60_000 });
    const user = 'usr_vault_5';
    const plan = planOf();
    const started = (await w.run(user, plan, w.seal(user, plan).token)).data;
    now += 120_000;
    assert.equal(w.actionApprovals.listPending(TENANT, user, 'req_list').length, 0);
    assert.equal(w.taskRunStore.get(started.runId)!.errorCode, 'APPROVAL_EXPIRED');
    assert.throws(() => w.actionApprovals.approve(started.proposal.approval.approvalId, TENANT, user), (e: any) => /EXPIRED/.test(e.code));
    await w.coordinator.onApproved(started.proposal.approval.approvalId);
    assert.equal(w.vaultItems(user).length, 0);
  });

  test('restart while waiting: the approval and the frozen draft survive; approving afterwards saves once; a third process can not save it again', async () => {
    const dirs = newDirs();
    const before = world(dirs);
    const user = 'usr_vault_6';
    const plan = planOf();
    const started = (await before.run(user, plan, before.seal(user, plan).token)).data;
    const approvalId = started.proposal.approval.approvalId;
    assert.equal(before.vaultItems(user).length, 0);

    const after = world(dirs); // every service rebuilt from the files
    assert.equal(after.actionApprovals.get(approvalId, TENANT, user)?.status, 'PENDING');
    assert.equal(after.vaultItems(user).length, 0);
    after.actionApprovals.approve(approvalId, TENANT, user);
    await after.coordinator.onApproved(approvalId);
    assert.equal(after.vaultItems(user).length, 1);
    assert.equal(after.vaultItems(user)[0].metadata.contentText, MEETING);

    const third = world(dirs);
    await third.coordinator.onApproved(approvalId);
    assert.equal(third.vaultItems(user).length, 1, 'a replay after another restart creates no second item');
    assert.equal(third.vaultStore.getItem(vaultItemIdFor(TENANT, user, approvalId), TENANT, user)?.title, '주간 회의 요약', 'the saved item survives the restart');
  });
});

describe('what is approved is exactly what is saved', () => {
  test('a plan changed after it was shown is refused (seal), before any approval exists', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_7';
    const plan = planOf();
    const issued = w.seal(user, plan);
    const tampered = JSON.parse(JSON.stringify(plan));
    tampered.steps[0].parameters.content = 'Something else entirely';
    const res = await w.run(user, tampered, issued.token);
    assert.equal(res.status, 403);
    assert.equal(w.actionApprovals.listPending(TENANT, user, 'req_list').length, 0);
    assert.equal(w.vaultItems(user).length, 0);
  });

  test('an approval for one draft can not save a different one, and an extra field is refused: nothing is written', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_8';
    const plan = planOf();
    const started = (await w.run(user, plan, w.seal(user, plan).token)).data;
    const approvalId = started.proposal.approval.approvalId;
    w.actionApprovals.approve(approvalId, TENANT, user);
    const params = plan.steps[0].parameters as Record<string, unknown>;
    await assert.rejects(() => w.service.executeApproved({ tenantId: TENANT, principalId: user, requestId: 'req_t1', payload: { ...params, content: 'changed' }, approvalId }), (e: any) => e.code === 'APPROVAL_PAYLOAD_MISMATCH');
    await assert.rejects(() => w.service.executeApproved({ tenantId: TENANT, principalId: user, requestId: 'req_t2', payload: { ...params, folder: '../../etc' }, approvalId }), (e: any) => e.code === 'VAULT_SAVE_INVALID_DRAFT');
    await assert.rejects(() => w.service.executeApproved({ tenantId: TENANT, principalId: user, requestId: 'req_t3', payload: { ...params, title: 'Other title' }, approvalId }), (e: any) => e.code === 'APPROVAL_PAYLOAD_MISMATCH');
    assert.equal(w.vaultItems(user).length, 0, 'nothing written by any mismatch');
    assert.equal(w.actionApprovals.get(approvalId, TENANT, user)?.status, 'APPROVED', 'a refused attempt does not spend the approval');
    // the real draft still saves
    await w.coordinator.onApproved(approvalId);
    assert.equal(w.vaultItems(user).length, 1);
  });

  test('the broker never executes without an approval, and a request for another tool id is not this action', async () => {
    const w = world(newDirs());
    const user = 'usr_vault_9';
    const params = planOf().steps[0].parameters;
    const first = await w.broker.execute({ capabilityId: 'vault.save_note', tenantId: TENANT, principalId: user, requestId: 'req_b1', payload: params, source: 'TASK' });
    assert.equal(first.status, 'APPROVAL_REQUIRED');
    assert.equal(w.vaultItems(user).length, 0);
    const forged = await w.broker.execute({ capabilityId: 'vault.save_note', tenantId: TENANT, principalId: user, requestId: 'req_b2', payload: params, source: 'TASK', approvalId: 'apr_does_not_exist' }).catch((e: any) => ({ status: 'THROWN', code: e.code }));
    assert.notEqual((forged as any).status, 'EXECUTED');
    assert.equal(w.vaultItems(user).length, 0);
  });

  test('without the service the capability is unavailable (BLOCKED), never a silent success', async () => {
    const w = world(newDirs(), { withService: false });
    const res = await w.broker.execute({ capabilityId: 'vault.save_note', tenantId: TENANT, principalId: 'usr_vault_10', requestId: 'req_u1', payload: planOf().steps[0].parameters, source: 'TASK' });
    assert.deepEqual(res, { status: 'BLOCKED', capabilityId: 'vault.save_note', reasonCode: 'CAPABILITY_PROVIDER_UNAVAILABLE' });
  });
});

describe('owner and tenant isolation', () => {
  test('another person can not see, approve, claim or replay anything of the first person; their own Vault stays empty', async () => {
    const w = world(newDirs());
    const owner = 'usr_vault_owner';
    const other = 'usr_vault_other';
    const plan = planOf();
    const issued = w.seal(owner, plan);
    // a seal is bound to its owner
    assert.equal((await w.run(other, plan, issued.token)).status, 403);
    const started = (await w.run(owner, plan, issued.token)).data;
    const approvalId = started.proposal.approval.approvalId;
    assert.equal(w.actionApprovals.listPending(TENANT, other, 'req_o').length, 0);
    assert.throws(() => w.actionApprovals.approve(approvalId, TENANT, other), (e: any) => /NOT_FOUND|APPROVAL/.test(e.code));
    assert.throws(() => w.actionApprovals.approve(approvalId, 'ten_other', owner));
    await assert.rejects(() => w.service.executeApproved({ tenantId: TENANT, principalId: other, requestId: 'req_x', payload: plan.steps[0].parameters, approvalId }));
    w.actionApprovals.approve(approvalId, TENANT, owner);
    await w.coordinator.onApproved(approvalId);
    assert.equal(w.vaultItems(owner).length, 1);
    assert.equal(w.vaultItems(other).length, 0);
    assert.equal(w.vaultItems(owner, 'ten_other').length, 0);
    const id = w.vaultItems(owner)[0].vaultItemId;
    assert.equal(w.vaultStore.getItem(id, TENANT, other), undefined, 'indistinguishable from "does not exist"');
    assert.equal(w.vaultStore.getItem(id, 'ten_other', owner), undefined);
    assert.equal(w.activityStore.list(TENANT, other).filter((a) => a.type.startsWith('vault.')).length, 0);
  });
});

describe('a failed write is never reported as saved', () => {
  const draft = () => planOf().steps[0].parameters;

  test('the Vault throws: the run FAILS with a plain reason, no item, the approval is spent (ask again), Activity says it failed', async () => {
    const dirs = newDirs();
    const real = new VaultStore(dirs.vault);
    const w = world(dirs, { vault: { getItem: (...a) => real.getItem(...a), saveItemOnce: () => { throw new Error('ENOSPC: no space left on device'); } } });
    const user = 'usr_vault_11';
    const plan = planOf();
    const started = (await w.run(user, plan, w.seal(user, plan).token)).data;
    const approvalId = started.proposal.approval.approvalId;
    w.actionApprovals.approve(approvalId, TENANT, user);
    await w.coordinator.onApproved(approvalId);
    const run = w.taskRunStore.get(started.runId)!;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'VAULT_SAVE_FAILED');
    assert.doesNotMatch(JSON.stringify(run), /ENOSPC|SAVED_TO_VAULT/, 'no raw system error text, and no "saved" outcome anywhere on a failed run');
    assert.equal(w.vaultItems(user).length, 0);
    assert.equal(w.actionApprovals.get(approvalId, TENANT, user)?.status, 'CONSUMED');
    assert.equal(w.executionStore.list().find((e) => e.approvalId === approvalId)?.status, 'FAILED');
    const activity = w.activityStore.list(TENANT, user).filter((a) => a.type.startsWith('vault.'));
    assert.equal(activity.length, 1);
    assert.equal(activity[0].status, 'FAILED');
    // the spent approval can not be retried into a second attempt
    await assert.rejects(() => w.service.executeApproved({ tenantId: TENANT, principalId: user, requestId: 'req_retry', payload: draft(), approvalId }), (e: any) => e.code === 'APPROVAL_ALREADY_CONSUMED');
  });

  test('a store that "succeeds" but can not read the item back is a failure too (never "saved")', async () => {
    const dirs = newDirs();
    const w = world(dirs, { vault: { saveItemOnce: (p) => ({ ...p, workspaceId: 'w', mimeType: 'text/plain', metadata: {}, createdAt: '', updatedAt: '', userId: p.userId } as any), getItem: () => undefined } });
    const user = 'usr_vault_12';
    const plan = planOf();
    const started = (await w.run(user, plan, w.seal(user, plan).token)).data;
    w.actionApprovals.approve(started.proposal.approval.approvalId, TENANT, user);
    await w.coordinator.onApproved(started.proposal.approval.approvalId);
    assert.equal(w.taskRunStore.get(started.runId)!.status, 'FAILED');
    assert.equal(w.taskRunStore.get(started.runId)!.errorCode, 'VAULT_ITEM_NOT_VERIFIED');
  });

  test('the real VaultStore on a directory that can not be written throws instead of pretending (the old saveItem swallowed write errors)', () => {
    const dir = tempDir('blocked');
    const file = path.join(dir, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    const store = new VaultStore(path.join(file, 'vault')); // a path below a regular file can never be created
    assert.throws(() => store.saveItemOnce({ vaultItemId: 'vlt_x', tenantId: TENANT, userId: 'u', type: 'DOCUMENT', title: 't', storageRef: 'r' }));
    assert.equal(store.listItems(TENANT, 'u').length, 0);
  });

  test('saving the same id twice returns the same item (idempotent), and an id owned by someone else is refused', () => {
    const store = new VaultStore(tempDir('idem-vault'));
    const params = { vaultItemId: 'vlt_fixed', tenantId: TENANT, userId: 'u1', type: 'DOCUMENT' as const, title: 't', storageRef: 'r', metadata: { contentText: 'a' } };
    const first = store.saveItemOnce(params);
    const second = store.saveItemOnce({ ...params, metadata: { contentText: 'b' } });
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.metadata.contentText, 'a');
    assert.equal(store.listItems(TENANT, 'u1').length, 1);
    assert.throws(() => store.saveItemOnce({ ...params, userId: 'u2' }), /VAULT_ITEM_ID_CONFLICT/);
  });
});

describe('truthful catalog: only what can run is live', () => {
  test('workspace.prepare_draft (no executor anywhere) is no longer advertised as live; vault.save_note is live and approval-gated; the plan resolver agrees', () => {
    const tools = new Map(toolRegistry.list().map((t) => [t.id, t]));
    assert.equal(tools.get('workspace.prepare_draft')?.executionMode, 'unavailable');
    assert.equal(tools.get('workspace.prepare_draft')?.connectionStatus, 'unavailable');
    assert.equal(tools.get('vault.save_note')?.executionMode, 'live');
    assert.equal(tools.get('vault.save_note')?.requiresApproval, true);
    const registry = new CapabilityRegistry();
    assert.deepEqual({ ...registry.get('vault.save_note') }, { id: 'vault.save_note', provider: 'VAULT', risk: 'LOW', approval: 'REQUIRED', enabled: true });
    const resolvedPlan = resolver.resolve(planOf());
    assert.equal(resolvedPlan.steps[0].executionReadiness, 'APPROVAL_REQUIRED');
    const draftPlan = { ...planOf(), steps: [{ ...planOf().steps[0], tool: 'workspace.prepare_draft' }] };
    assert.equal(resolver.resolve(draftPlan).steps[0].executionReadiness, 'BLOCKED', 'a planned-only tool can not be approved into running');
  });

  test('no other capability\'s approval policy changed: calendar / mail writes still need approval, reads still do not', () => {
    const registry = new CapabilityRegistry();
    for (const id of ['google_calendar.create_event', 'google_calendar.cancel_event', 'gmail.send_email', 'gmail.reply']) assert.equal(registry.get(id)?.approval, 'REQUIRED', id);
    for (const id of ['gmail.search', 'google_calendar.free_slots', 'github.read_file']) assert.equal(registry.get(id)?.approval, 'NONE', id);
  });
});
