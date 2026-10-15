// D-9 Track A - the approval-gated "save to my Vault" certified through the PRODUCTION HTTP surface from a REAL Chromium session (the signed-in cookie a person has), EN + KR.
// Scope, stated plainly: the Home screen has NO affordance for this yet (public/** is the integrator's, not this track's), so the browser here is a real client of the real endpoints -
// same-origin fetch with the real session - not a screen test. Nothing is mocked: the plan route, plan seal, task / approval routes, TaskContinuationCoordinator, CapabilityBroker,
// VaultSaveService, the Vault routes and the Activity feed are the production ones, on disposable stores. No model is involved (the draft is built from the person's own words).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { resolveNagexDataDir } from '../src/governance/file-record.store.js';

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const SUMMARY = {
  ko: '## 주간 회의 요약\n\n- 출시일은 다음 주 금요일로 확정했습니다.\n- 담당자: 민수\n\n다음 회의는 목요일 오후 3시입니다.',
  en: '## Weekly meeting summary\n\n- The launch date is confirmed for next Friday.\n- Owner: Dana\n\nThe next meeting is Thursday at 3 PM.',
} as const;
const TITLE = { ko: '주간 회의 요약', en: 'Weekly meeting summary' } as const;
const SAVE = { ko: '회의 요약을 내 보관함에 저장해줘', en: 'Save the meeting summary to my Vault' } as const;

interface Client { ctx: BrowserContext; page: Page; call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }> }

async function client(user: DisposableUser | null, locale: 'en' | 'ko'): Promise<Client> {
  const ctx = user ? await h.newContext('desktop', user, locale) : await h.browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${h.origin}/api/v1/health`, { waitUntil: 'domcontentloaded' });
  const call = (method: string, path: string, body?: unknown) => page.evaluate(async ({ method, path, body }: { method: string; path: string; body?: unknown }) => {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  }, { method, path, body });
  return { ctx, page, call };
}

async function waitForRun(c: Client, taskId: string): Promise<any> {
  for (let i = 0; i < 100; i += 1) {
    const runs: any[] = (await c.call('GET', `/api/v1/tasks/${taskId}/runs`)).json?.runs ?? [];
    const latest = runs[runs.length - 1];
    if (latest && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the run did not finish');
}
const vaultList = async (c: Client) => (await c.call('GET', '/api/v1/workspace/vault')).json.items as any[];
const vaultActivity = async (c: Client) => ((await c.call('GET', '/api/v1/activity?limit=100')).json.activities as any[]).filter((a) => String(a.type).startsWith('vault.'));

// plan route -> run route -> the proposal the person reviews
async function previewAndRequest(c: Client, locale: 'en' | 'ko', saveContext: string | undefined = SUMMARY[locale]) {
  const preview = await c.call('POST', '/api/v1/ambient/intent', { prompt: SAVE[locale], ...(saveContext === undefined ? {} : { saveContext }) });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.status, 'PLAN_PREVIEW', JSON.stringify(preview.json));
  const started = await c.call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: preview.json.plan, planSeal: preview.json.planSeal, prompt: SAVE[locale] });
  return { preview: preview.json, started };
}

describe('plan -> request approval -> Approve -> one verified Vault item, from a real signed-in browser session (EN/KR)', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: nothing is stored before Approve; the exact text is approved; Approve stores one item that a brand-new session opens again; Activity records the title only`, async () => {
      const user = h.user(`vsb_${locale}`);
      if (locale === 'ko') h.setLocale(user, 'ko');
      const c = await client(user, locale);

      // 1. the plan (no model: the reply says so) carries the EXACT draft, one approval-gated step, and the server's runnable verdict
      const { preview, started } = await previewAndRequest(c, locale);
      assert.equal(preview.provider, 'nagex');
      assert.equal(preview.draftSource, 'PREVIOUS_ANSWER');
      assert.equal(preview.plan.steps.length, 1);
      const step = preview.plan.steps[0];
      assert.equal(step.tool, 'vault.save_note');
      assert.equal(step.requiresApproval, true);
      assert.deepEqual(step.parameters, { title: TITLE[locale], content: SUMMARY[locale], source: 'PREVIOUS_ANSWER' });
      assert.equal(preview.runnable.ok, true);
      assert.equal(preview.plan.goal, locale === 'ko' ? '내 보관함에 저장' : 'Save to your Vault');
      assert.doesNotMatch(JSON.stringify(preview.plan.summary), /주간 회의 요약|Weekly meeting summary/, 'the task name that notifications use never carries the text');
      assert.deepEqual(await vaultList(c), [], 'showing the draft stored nothing');

      // 2. the approval is requested; the proposal is the whole text; STILL nothing stored, no Activity "saved"
      assert.equal(started.status, 200, JSON.stringify(started.json));
      assert.equal(started.json.state, 'APPROVAL_REQUIRED');
      const args = Object.fromEntries((started.json.proposal.arguments as any[]).map((a) => [a.name, a.value]));
      assert.equal(args.content, SUMMARY[locale], 'line breaks and every character, not a snippet');
      assert.equal(args.title, TITLE[locale]);
      assert.deepEqual(await vaultList(c), []);
      assert.deepEqual(await vaultActivity(c), []);
      const approvalId: string = started.json.proposal.approval.approvalId;
      assert.ok(((await c.call('GET', '/api/v1/approvals')).json.pending as any[]).some((a) => a.approvalId === approvalId), 'in the person\'s own pending list');

      // 3. the person's own Approve (the unchanged production route) -> saved and read back
      const approved = await c.call('POST', `/api/v1/approvals/${approvalId}/approve`, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.json));
      const run = await waitForRun(c, started.json.taskId);
      assert.equal(run.status, 'SUCCEEDED', JSON.stringify(run));
      const done = (run.result.steps ?? run.result.completedSteps)[0];
      assert.equal(done.result.outcome, 'SAVED_TO_VAULT');
      assert.deepEqual(done.result.verification, { status: 'VERIFIED', reason: 'REREAD_FROM_OWNER_VAULT' });
      assert.equal(done.result.destination, 'MY_VAULT');
      assert.equal(done.result.title, TITLE[locale]);
      const items = await vaultList(c);
      assert.equal(items.length, 1, 'exactly one item');
      assert.equal(items[0].vaultItemId, done.result.vaultItemId);

      // 4. a brand-new session of the same person opens it again (Vault list, preview, download) and sees the Activity record
      const fresh = await client(user, locale);
      const reopened = (await vaultList(fresh))[0];
      assert.equal(reopened.title, TITLE[locale]);
      const preview2 = await fresh.call('GET', `/api/v1/workspace/vault/${reopened.vaultItemId}/preview`);
      assert.equal(preview2.status, 200);
      assert.equal(preview2.json.contentText, SUMMARY[locale]);
      assert.equal((await fresh.call('GET', `/api/v1/workspace/vault/${reopened.vaultItemId}/download`)).json.contentText, SUMMARY[locale]);
      const activity = await vaultActivity(fresh);
      assert.equal(activity.length, 1);
      assert.equal(activity[0].status, 'COMPLETED');
      assert.equal(activity[0].type, 'vault.item_saved');
      assert.ok(!JSON.stringify(activity).includes(SUMMARY[locale].split('\n')[2]), 'Activity never carries the text');
      await fresh.ctx.close();

      // 5. replays do nothing: a second Approve, the same preview again, a second run
      assert.notEqual((await c.call('POST', `/api/v1/approvals/${approvalId}/approve`, {})).status, 200);
      const replay = await c.call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: preview.plan, planSeal: preview.planSeal, prompt: SAVE[locale] });
      assert.equal(replay.status, 409);
      assert.equal(replay.json.error.code, 'PLAN_ALREADY_STARTED');
      assert.equal((await vaultList(c)).length, 1);
      assert.equal((await vaultActivity(c)).length, 1);
      await c.ctx.close();
    });
  }

  it('a double click on "request approval" makes one task and one approval; two simultaneous Approves store one item', async () => {
    const user = h.user('vsb_double');
    const c = await client(user, 'en');
    const preview = (await c.call('POST', '/api/v1/ambient/intent', { prompt: SAVE.en, saveContext: SUMMARY.en })).json;
    const [a, b] = await Promise.all([1, 2].map(() => c.call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: preview.plan, planSeal: preview.planSeal, prompt: SAVE.en })));
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(((await c.call('GET', '/api/v1/tasks')).json.tasks as any[]).length, 1);
    const pending = (await c.call('GET', '/api/v1/approvals')).json.pending as any[];
    assert.equal(pending.length, 1);
    const approvalId = pending[0].approvalId;
    const approves = await Promise.all([1, 2, 3].map(() => c.call('POST', `/api/v1/approvals/${approvalId}/approve`, {})));
    assert.ok(approves.filter((r) => r.status === 200).length >= 1);
    const taskId = (a.status === 200 ? a : b).json.taskId;
    assert.equal((await waitForRun(c, taskId)).status, 'SUCCEEDED');
    assert.equal((await vaultList(c)).length, 1, 'concurrent approvals: one item');
    await c.ctx.close();
  });

  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: decline stores nothing; asking again gives a fresh approval that works`, async () => {
      const user = h.user(`vsb_decline_${locale}`);
      const c = await client(user, locale);
      const first = await previewAndRequest(c, locale);
      assert.equal((await c.call('POST', `/api/v1/approvals/${first.started.json.proposal.approval.approvalId}/reject`, {})).status, 200);
      const run = await waitForRun(c, first.started.json.taskId);
      assert.equal(run.status, 'FAILED');
      assert.equal(run.errorCode, 'APPROVAL_REJECTED');
      assert.deepEqual(await vaultList(c), []);
      assert.deepEqual(await vaultActivity(c), []);
      // the same words again are a new, deliberate request (a fresh preview) - not blocked by the declined one
      const second = await previewAndRequest(c, locale);
      assert.equal(second.started.status, 200, JSON.stringify(second.started.json));
      assert.notEqual(second.started.json.proposal.approval.approvalId, first.started.json.proposal.approval.approvalId);
      await c.call('POST', `/api/v1/approvals/${second.started.json.proposal.approval.approvalId}/approve`, {});
      assert.equal((await waitForRun(c, second.started.json.taskId)).status, 'SUCCEEDED');
      assert.equal((await vaultList(c)).length, 1);
      await c.ctx.close();
    });
  }
});

describe('what is shown is what is approved, and what is not clear is asked, never guessed', () => {
  it('text quoted in the request is the draft (no previous answer needed); a tampered plan is refused before any approval exists', async () => {
    const user = h.user('vsb_inline');
    const c = await client(user, 'ko');
    const preview = (await c.call('POST', '/api/v1/ambient/intent', { prompt: '"금요일 3시에 민수와 계약 검토" 내 보관함에 저장해줘' })).json;
    assert.equal(preview.status, 'PLAN_PREVIEW');
    assert.equal(preview.draftSource, 'USER_MESSAGE');
    assert.deepEqual(preview.plan.steps[0].parameters, { title: '금요일 3시에 민수와 계약 검토', content: '금요일 3시에 민수와 계약 검토', source: 'USER_MESSAGE' });
    const tampered = JSON.parse(JSON.stringify(preview.plan));
    tampered.steps[0].parameters.content = '다른 내용';
    const refused = await c.call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: tampered, planSeal: preview.planSeal, prompt: 'x' });
    assert.equal(refused.status, 403);
    assert.deepEqual((await c.call('GET', '/api/v1/approvals')).json.pending, []);
    assert.deepEqual(await vaultList(c), []);
    await c.ctx.close();
  });

  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: nothing to save -> a plain question (no plan, no approval); a text that is too long -> refused, never shortened`, async () => {
      const user = h.user(`vsb_ask_${locale}`);
      const c = await client(user, locale);
      const nothing = await c.call('POST', '/api/v1/ambient/intent', { prompt: SAVE[locale] });
      assert.equal(nothing.status, 200);
      assert.equal(nothing.json.status, 'NEEDS_DETAIL');
      assert.equal(nothing.json.executable, false);
      assert.equal(nothing.json.plan, undefined);
      assert.match(nothing.json.message, locale === 'ko' ? /무엇을 저장할지 알려 주세요/ : /Tell me what to save/);
      const long = await c.call('POST', '/api/v1/ambient/intent', { prompt: SAVE[locale], saveContext: 'a'.repeat(20001) });
      assert.equal(long.json.status, 'NEEDS_DETAIL');
      assert.equal(long.json.reason, 'TOO_LONG');
      assert.match(long.json.message, locale === 'ko' ? /아무것도 저장하지 않았어요/ : /Nothing was saved/);
      assert.deepEqual((await c.call('GET', '/api/v1/approvals')).json.pending, []);
      assert.deepEqual(await vaultList(c), []);
      await c.ctx.close();
    });
  }
});

describe('authorization boundary', () => {
  it('no session: every route answers 401 and nothing is created', async () => {
    const anon = await client(null, 'en');
    for (const [method, path, body] of [['POST', '/api/v1/ambient/intent', { prompt: SAVE.en, saveContext: SUMMARY.en }], ['POST', '/api/v1/tasks/from-reviewed-plan', { plan: {}, planSeal: { token: 'x' } }], ['GET', '/api/v1/workspace/vault', undefined], ['GET', '/api/v1/activity', undefined]] as const) {
      assert.equal((await anon.call(method, path, body)).status, 401, `${method} ${path}`);
    }
    await anon.ctx.close();
  });

  it('another person can not run, approve, read or see anything of the first person\'s save', async () => {
    const owner = h.user('vsb_owner');
    const other = h.user('vsb_stranger');
    const o = await client(owner, 'en');
    const s = await client(other, 'en');
    const { preview, started } = await previewAndRequest(o, 'en');
    const approvalId = started.json.proposal.approval.approvalId;
    // the stranger holds the owner's plan and token: refused; the owner's approval does not exist for them
    const stolen = await s.call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: preview.plan, planSeal: preview.planSeal, prompt: 'x' });
    assert.equal(stolen.status, 403);
    assert.notEqual((await s.call('POST', `/api/v1/approvals/${approvalId}/approve`, {})).status, 200);
    assert.deepEqual((await s.call('GET', '/api/v1/approvals')).json.pending, []);
    assert.equal((await o.call('GET', '/api/v1/approvals')).json.pending.length, 1, 'the owner\'s approval is untouched');
    await o.call('POST', `/api/v1/approvals/${approvalId}/approve`, {});
    assert.equal((await waitForRun(o, started.json.taskId)).status, 'SUCCEEDED');
    const id = (await vaultList(o))[0].vaultItemId;
    assert.deepEqual(await vaultList(s), []);
    assert.equal((await s.call('GET', `/api/v1/workspace/vault/${id}`)).status, 404);
    assert.equal((await s.call('GET', `/api/v1/workspace/vault/${id}/preview`)).status, 404);
    assert.equal((await s.call('DELETE', `/api/v1/workspace/vault/${id}`)).status, 404);
    assert.deepEqual(await vaultActivity(s), []);
    assert.equal((await vaultList(o)).length, 1, 'the stranger\'s attempts changed nothing');
    await o.ctx.close();
    await s.ctx.close();
  });
});

describe('a Vault that can not write is reported as NOT saved', () => {
  it('no item, no "saved" outcome, the approval is spent, Activity says it failed', async () => {
    const user = h.user('vsb_disk');
    const c = await client(user, 'en');
    const { started } = await previewAndRequest(c, 'en');
    // the Vault directory becomes a plain file: nothing can be written below it
    const dir = resolveNagexDataDir('vault', 'NAGEX_VAULT_DIR');
    const aside = `${dir}.aside-${Date.now()}`;
    fs.renameSync(dir, aside);
    fs.writeFileSync(dir, 'blocked');
    let run: any;
    try {
      await c.call('POST', `/api/v1/approvals/${started.json.proposal.approval.approvalId}/approve`, {});
      run = await waitForRun(c, started.json.taskId);
    } finally {
      fs.rmSync(dir, { force: true });
      fs.renameSync(aside, dir);
    }
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'VAULT_SAVE_FAILED');
    assert.doesNotMatch(JSON.stringify(run), /SAVED_TO_VAULT/);
    assert.deepEqual(await vaultList(c), []);
    const activity = await vaultActivity(c);
    assert.deepEqual(activity.map((a) => a.status), ['FAILED']);
    assert.notEqual((await c.call('POST', `/api/v1/approvals/${started.json.proposal.approval.approvalId}/approve`, {})).status, 200, 'the spent approval can not be retried');
    await c.ctx.close();
  });
});
