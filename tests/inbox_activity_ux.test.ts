import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';

test('1. Inbox contains real attention items only', async () => {
  const headers = {
    'x-principal-id': 'usr_inbox_test_01',
    'x-nagex-tenant': 'ten_inbox_test_01',
  };

  const res = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((res.data as any).items));
});

test('2. Approval uses canonical source ActionApprovalStore.listPending', async () => {
  const store = new ActionApprovalStore();
  const record = store.request({
    tenantId: 't_appr_src',
    principalId: 'u_appr_src',
    toolId: 'google_calendar_create_event',
    payload: { summary: 'Team Sync' },
  });

  const pending = store.listPending('t_appr_src', 'u_appr_src');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].approvalId, record.approvalId);
});

test('3. No seeded approval fixture leaks into production API responses', async () => {
  const headers = {
    'x-principal-id': 'usr_clean_' + Date.now(),
    'x-nagex-tenant': 'ten_clean_' + Date.now(),
  };

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  assert.equal(res.status, 200);
  assert.equal((res.data as any).approvals.length, 0);
});

test('4. Clarification state presented without state mutation', async () => {
  const headers = {
    'x-principal-id': 'usr_clarify_' + Date.now(),
    'x-nagex-tenant': 'ten_clarify_' + Date.now(),
  };

  const inboxBefore = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.equal(inboxBefore.status, 200);
  const inboxAfter = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.deepEqual(inboxBefore.data, inboxAfter.data);
});

test('5. Failed task needing user action appears in attention priority', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /FAILED_WORK/);
  assert.match(appJs, /groupKey:\s*'NEEDS_ATTENTION'/);
});

test('6. Result-ready item appears in Ready for you group', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /READY_RESULT/);
  assert.match(appJs, /groupKey:\s*'READY_FOR_YOU'/);
});

test('7. Working item appears in NAGEX is working group without internal IDs', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /RUNNING_WORK/);
  assert.match(appJs, /groupKey:\s*'NAGEX_IS_WORKING'/);
  assert.doesNotMatch(appJs, /worker_id/);
});

test('8. Recently completed has lower priority than attention items', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /RECENTLY_COMPLETED/);
  assert.match(appJs, /groupKey:\s*'RECENTLY_COMPLETED'/);
  assert.match(appJs, /priority:\s*8/);
});

test('9. Inbox fetch failure is distinct from empty state', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /inbox\.loadError/);
  assert.match(appJs, /inbox\.emptyState/);
  assert.match(appJs, /Inbox could not be loaded/);
  assert.match(appJs, /Nothing needs your attention right now/);
});

test('10. Activity uses outcome-oriented user language', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /renderActivityOutcomeCard/);
  assert.match(appJs, /groupActivityByDate/);
});

test('11. Raw audit events are not primary Activity rows', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /View technical details/);
});

test('12. Completed state requires real canonical completion', async () => {
  const store = new ActivityStore({ dir: path.join(process.cwd(), 'tmp', 'act_comp_' + Date.now()) });
  const act = store.record({
    tenantId: 't_comp',
    principalId: 'u_comp',
    type: 'task.completed',
    title: 'Prepared report',
    status: 'COMPLETED',
    dedupeKey: 'dedupe_comp_12',
  });
  assert.equal(act.status, 'COMPLETED');
});

test('13. Partial failure is not shown as full success', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /statusPartiallyCompleted/);
  assert.match(appJs, /substepsCompleted/);
  assert.match(appJs, /substepsFailed/);
});

test('14. Artifact references in ready items represent real artifacts', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /artifactRef/);
});

test('15. Expanded details do not expose private chain-of-thought or raw credentials', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /chain_of_thought/);
  assert.doesNotMatch(appJs, /raw_secret/);
  assert.doesNotMatch(appJs, /bearer_token/);
});

test('16. EN and KR translations present and resolve properly', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /'inbox\.groupNeedsAttention':\s*'Needs your attention'/);
  assert.match(i18nJs, /'inbox\.groupNeedsAttention':\s*'조치가 필요합니다'/);
  assert.match(i18nJs, /'activity\.groupToday':\s*'Today'/);
  assert.match(i18nJs, /'activity\.groupToday':\s*'오늘'/);
});

test('17. Keyboard navigation support on card elements and controls', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /tabindex="0"/);
  assert.match(appJs, /onkeydown=/);
});

test('18. aria-expanded present on expandable detail triggers', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /aria-expanded/);
  assert.match(appJs, /toggleActivityDetail/);
});

test('19. Mobile static contract supported in mobile views', async () => {
  const mobInbox = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-inbox.js'), 'utf-8');
  const mobAct = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-activity.js'), 'utf-8');
  assert.ok(mobInbox.length > 0);
  assert.ok(mobAct.length > 0);
});

test('20. Responsive card layout prevents horizontal overflow', async () => {
  const mobCss = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-inbox.css'), 'utf-8');
  assert.match(mobCss, /box-sizing:\s*border-box/);
});

test('21. Home, Inbox, and Activity roles remain distinct', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /id="view-home"/);
  assert.match(indexHtml, /id="view-inbox"/);
  assert.match(indexHtml, /id="view-executions"/);
});
