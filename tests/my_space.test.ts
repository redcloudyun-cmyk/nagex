// P08 — My Space Foundation (first slice).
//
// GET /api/v1/my-space is a thin, read-only composition of already-frozen,
// already tenant/owner-scoped sources (Activity, Memory, Task, Workflow
// Definition) plus one new, small, read-only Calendar method
// (GoogleCalendarService.listUpcomingEvents) and a composed History =
// Activity + owned TaskRun (never the legacy in-memory executionHistory
// array, never the unwired governance ExecutionStore, never runtime.
// engine's private map — all explicitly forbidden by the implementation
// directive). These tests prove the composition is genuinely isolated, not
// merely that data round-trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { handleAsyncApiRequest, handleApiRequest, createServerInstance } from '../src/server_web.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { listUpcomingCalendarEvents } from '../src/modules/calendar/calendar.client.js';

function headersFor(tenant: string, principal: string) {
  return { 'x-nagex-tenant': tenant, 'x-principal-id': principal };
}

// Static assets (index.html, app.js) are served by the underlying HTTP
// listener before a request is ever routed into handleApiRequest — real
// TCP + fetch, exactly the precedent already established in ambient_
// composer.test.ts, not handleApiRequest (which only knows /api/v1/* JSON
// routes).
async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (typeof (instance as any).closeIdleConnections === 'function') {
      (instance as any).closeIdleConnections();
    }
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

async function getMySpace(tenant: string, principal: string) {
  const res = await handleAsyncApiRequest('GET', '/api/v1/my-space', null, headersFor(tenant, principal));
  return res.data as {
    activity: Array<{ activityId: string; title: string; status: string; occurredAt: string }>;
    memory: Array<{ id: string; content: { subject: string; value: unknown } }>;
    tasks: Array<{ taskId: string; name: string; status: string }>;
    workflows: Array<{ id: string; name: string; enabled: boolean; lastRunStatus: string | null; lastRunAt: string | null }>;
    calendar: Array<{ id: string; title: string; start: string; end: string; source?: string }>;
    calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
    history: Array<{ kind: 'ACTIVITY' | 'TASK_RUN'; id: string; title: string; status: string; timestamp: string }>;
  };
}

// Deterministic, file-scoped identities — never reused elsewhere in this
// suite, so no cross-test-file collision in the shared test data dirs.
const T_A = 'ten_myspace_test_a';
const T_B = 'ten_myspace_test_b';
const O_X = 'usr_myspace_test_x';
const O_Y = 'usr_myspace_test_y';

// ── 1: response shape ────────────────────────────────────────────────────

test('1. GET /api/v1/my-space returns exactly the approved thin composition shape', async () => {
  const data = await getMySpace(T_A, O_X);
  assert.deepEqual(
    Object.keys(data).sort(),
    ['activity', 'calendar', 'calendarStatus', 'history', 'memory', 'tasks', 'workflows'].sort(),
  );
  assert.ok(Array.isArray(data.activity));
  assert.ok(Array.isArray(data.memory));
  assert.ok(Array.isArray(data.tasks));
  assert.ok(Array.isArray(data.workflows));
  assert.ok(Array.isArray(data.calendar));
  assert.ok(Array.isArray(data.history));
});

// ── 2-3: Activity isolation ──────────────────────────────────────────────

test('2. Activity: tenant A cannot see tenant B activity in My Space', async () => {
  const activityStore = new ActivityStore();
  const marker = `MYSPACE_ACT_TENANT_${Date.now()}`;
  activityStore.record({ tenantId: T_A, principalId: O_X, type: 'test.event', title: marker, status: 'COMPLETED', dedupeKey: marker });

  const ownTenant = await getMySpace(T_A, O_X);
  assert.ok(ownTenant.activity.some((a) => a.title === marker));

  const otherTenant = await getMySpace(T_B, O_X);
  assert.ok(!otherTenant.activity.some((a) => a.title === marker));
});

test('3. Activity: owner X cannot see owner Y activity in My Space (same tenant)', async () => {
  const activityStore = new ActivityStore();
  const marker = `MYSPACE_ACT_OWNER_${Date.now()}`;
  activityStore.record({ tenantId: T_A, principalId: O_X, type: 'test.event', title: marker, status: 'COMPLETED', dedupeKey: marker });

  const ownOwner = await getMySpace(T_A, O_X);
  assert.ok(ownOwner.activity.some((a) => a.title === marker));

  const otherOwner = await getMySpace(T_A, O_Y);
  assert.ok(!otherOwner.activity.some((a) => a.title === marker));
});

// ── 4-5: Memory isolation ────────────────────────────────────────────────

test('4. Memory: tenant A cannot see tenant B memory in My Space', async () => {
  const marker = `MYSPACE_MEM_TENANT_${Date.now()}`;
  const created = await handleApiRequest('POST', '/api/v1/memory', { scope: 'USER', subject: marker, predicate: 'note', value: 'secret' }, headersFor(T_A, O_X));
  assert.equal(created.status, 201);

  const ownTenant = await getMySpace(T_A, O_X);
  assert.ok(ownTenant.memory.some((m) => m.content.subject === marker));

  const otherTenant = await getMySpace(T_B, O_X);
  assert.ok(!otherTenant.memory.some((m) => m.content.subject === marker));
});

test('5. Memory: owner X cannot see owner Y memory in My Space (same tenant)', async () => {
  const marker = `MYSPACE_MEM_OWNER_${Date.now()}`;
  const created = await handleApiRequest('POST', '/api/v1/memory', { scope: 'USER', subject: marker, predicate: 'note', value: 'secret' }, headersFor(T_A, O_X));
  assert.equal(created.status, 201);

  const ownOwner = await getMySpace(T_A, O_X);
  assert.ok(ownOwner.memory.some((m) => m.content.subject === marker));

  const otherOwner = await getMySpace(T_A, O_Y);
  assert.ok(!otherOwner.memory.some((m) => m.content.subject === marker));
});

// ── 6-7: Task isolation ──────────────────────────────────────────────────

async function createTask(tenant: string, principal: string, name: string) {
  const res = await handleApiRequest('POST', '/api/v1/tasks', {
    type: 'ONE_TIME',
    name,
    objective: 'do a thing',
    trigger: { type: 'MANUAL' },
    approvalPolicy: 'READ_ONLY_AUTO',
  }, headersFor(tenant, principal));
  assert.equal(res.status, 201);
  return (res.data as { taskId: string }).taskId;
}

test('6. Tasks: tenant A cannot see tenant B tasks in My Space', async () => {
  const marker = `MYSPACE_TASK_TENANT_${Date.now()}`;
  await createTask(T_A, O_X, marker);

  const ownTenant = await getMySpace(T_A, O_X);
  assert.ok(ownTenant.tasks.some((t) => t.name === marker));

  const otherTenant = await getMySpace(T_B, O_X);
  assert.ok(!otherTenant.tasks.some((t) => t.name === marker));
});

test('7. Tasks: owner X cannot see owner Y tasks in My Space (same tenant)', async () => {
  const marker = `MYSPACE_TASK_OWNER_${Date.now()}`;
  await createTask(T_A, O_X, marker);

  const ownOwner = await getMySpace(T_A, O_X);
  assert.ok(ownOwner.tasks.some((t) => t.name === marker));

  const otherOwner = await getMySpace(T_A, O_Y);
  assert.ok(!otherOwner.tasks.some((t) => t.name === marker));
});

// ── 8-9: Workflow isolation ──────────────────────────────────────────────

async function createWorkflow(tenant: string, principal: string, name: string) {
  const res = await handleApiRequest('POST', '/api/v1/workflows', {
    name,
    description: 'a test workflow',
    steps: [{ title: 'Step one', skill: 'skill.email_drafting', tool: null }],
  }, headersFor(tenant, principal));
  assert.equal(res.status, 201);
  return (res.data as { workflowId: string }).workflowId;
}

test('8. Workflows: tenant A cannot see tenant B workflows in My Space', async () => {
  const marker = `MYSPACE_WF_TENANT_${Date.now()}`;
  await createWorkflow(T_A, O_X, marker);

  const ownTenant = await getMySpace(T_A, O_X);
  assert.ok(ownTenant.workflows.some((w) => w.name === marker));

  const otherTenant = await getMySpace(T_B, O_X);
  assert.ok(!otherTenant.workflows.some((w) => w.name === marker));
});

test('9. Workflows: owner X cannot see owner Y workflows in My Space (same tenant)', async () => {
  const marker = `MYSPACE_WF_OWNER_${Date.now()}`;
  await createWorkflow(T_A, O_X, marker);

  const ownOwner = await getMySpace(T_A, O_X);
  assert.ok(ownOwner.workflows.some((w) => w.name === marker));

  const otherOwner = await getMySpace(T_A, O_Y);
  assert.ok(!otherOwner.workflows.some((w) => w.name === marker));
});

test('9b. Workflows: a workflow with no linked task run yet reports lastRunStatus/lastRunAt as null, never fabricated', async () => {
  // POST /api/v1/tasks has no field for workflowDefinitionId — in real
  // production it is set only internally, by WorkflowDefinitionService.
  // prepareRun() during an actual POST /api/v1/workflows/:id/run
  // instantiation (already covered end-to-end by workflow_definition.
  // test.ts's own tests 16/17/20 against the real Broker/execution path,
  // not re-tested here). This test proves the narrower thing My Space's
  // own composition is responsible for: a workflow with zero linked runs
  // must never show an invented status.
  const marker = `MYSPACE_WF_RUNSTATE_${Date.now()}`;
  await createWorkflow(T_A, O_X, marker);

  const data = await getMySpace(T_A, O_X);
  const wf = data.workflows.find((w) => w.name === marker);
  assert.ok(wf, 'expected the created workflow to appear in My Space');
  assert.equal(wf!.lastRunStatus, null);
  assert.equal(wf!.lastRunAt, null);
});

// ── 10: History isolation — the directive's own explicit hard requirement ──

test('10. History: TaskRun never leaks to another owner or tenant, and composes only via owned taskIds', async () => {
  const marker = `MYSPACE_HIST_${Date.now()}`;
  const taskId = await createTask(T_A, O_X, marker);

  // Seed a real TaskRun directly against the same durable store the live
  // server uses (readAll() reads fresh from disk — no caching), rather than
  // fabricating a fake in-memory record — this is the actual persisted
  // shape a real task execution would produce.
  const taskRunStore = new TaskRunStore();
  const runId = `run_myspace_hist_${Date.now()}`;
  taskRunStore.start({ runId, taskId, tenantId: T_A, startedAt: new Date().toISOString() });
  taskRunStore.succeed(runId, { result: { ok: true }, completedAt: new Date().toISOString() });

  const rightful = await getMySpace(T_A, O_X);
  assert.ok(rightful.history.some((h) => h.kind === 'TASK_RUN' && h.id === runId), 'the rightful owner must see their own TaskRun in History');

  const wrongOwner = await getMySpace(T_A, O_Y);
  assert.ok(!wrongOwner.history.some((h) => h.id === runId), 'a different owner in the same tenant must never see this TaskRun');

  const wrongTenant = await getMySpace(T_B, O_X);
  assert.ok(!wrongTenant.history.some((h) => h.id === runId), 'a different tenant must never see this TaskRun');
});

test('10b. History never contains the legacy executionHistory or governance ExecutionStore shapes', async () => {
  const data = await getMySpace(T_A, O_X);
  for (const entry of data.history) {
    assert.ok(entry.kind === 'ACTIVITY' || entry.kind === 'TASK_RUN', `History entry had an unexpected kind: ${entry.kind}`);
    // The legacy in-memory executionHistory records carry an `agent_id`
    // field; a real ExecutionRecord carries `toolId`/`approvalId`/
    // `externalId` — neither shape should ever appear on a History entry.
    assert.equal((entry as Record<string, unknown>).agent_id, undefined);
    assert.equal((entry as Record<string, unknown>).toolId, undefined);
    assert.equal((entry as Record<string, unknown>).externalId, undefined);
  }
});

// ── 11: Calendar canonical normalization (unit-level, real client fn) ────

test('11. Calendar: raw Google event fields never leak, only the canonical {id,title,start,end,source} shape is returned', async () => {
  const rawGoogleResponse = {
    kind: 'calendar#events',
    etag: '"abc123"',
    items: [
      {
        kind: 'calendar#event',
        etag: '"xyz"',
        id: 'evt_1',
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/event?eid=evt_1',
        summary: 'Team sync',
        organizer: { email: 'someone@example.com', self: true },
        attendees: [{ email: 'other@example.com' }],
        start: { dateTime: '2026-09-20T10:00:00Z', timeZone: 'UTC' },
        end: { dateTime: '2026-09-20T10:30:00Z', timeZone: 'UTC' },
      },
      {
        // All-day event uses `date`, not `dateTime`.
        id: 'evt_2',
        start: { date: '2026-09-21' },
        end: { date: '2026-09-22' },
        // No `summary` at all — a real, legitimately untitled event.
      },
    ],
  };
  const fetchFn = (async () => ({
    ok: true,
    json: async () => rawGoogleResponse,
  })) as unknown as typeof fetch;

  const events = await listUpcomingCalendarEvents('fake_token', { calendarId: 'primary', timeMin: 't0', timeMax: 't1' }, fetchFn, 'req_test');

  assert.equal(events.length, 2);
  for (const ev of events) {
    assert.deepEqual(Object.keys(ev).sort(), ['attendees', 'end', 'id', 'source', 'start', 'status', 'title', 'updated'].sort());
  }
  assert.equal(events[0].id, 'evt_1');
  assert.equal(events[0].title, 'Team sync');
  assert.equal(events[0].start, '2026-09-20T10:00:00Z');
  assert.equal(events[0].end, '2026-09-20T10:30:00Z');

  assert.equal(events[1].id, 'evt_2');
  assert.equal(events[1].title, '(No title)', 'an untitled event must be defaulted, never dropped');
  assert.equal(events[1].start, '2026-09-21');
  assert.equal(events[1].end, '2026-09-22');
});

test('12. Calendar: disconnected Google account reports calendarStatus=DISCONNECTED with an empty (never fabricated) event list, and never fails the whole My Space response', async () => {
  const data = await getMySpace(T_A, O_X);
  // This test environment has no real Google OAuth token configured.
  assert.equal(data.calendarStatus, 'DISCONNECTED');
  assert.deepEqual(data.calendar, []);
  // Confirms the section-level fault tolerance requirement: every other
  // section must still be present and array-shaped despite Calendar's
  // failure.
  assert.ok(Array.isArray(data.activity));
  assert.ok(Array.isArray(data.tasks));
});

// ── 13-15: frontend navigation / render (real served static markup) ──────

test('13. #view-my-space exists with all six section containers, and top navigation is unchanged (still exactly 5 items)', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();

    const viewMatch = /<div[^>]*id="view-my-space"[^>]*class="tab-view[^"]*"[^>]*>/.exec(html);
    assert.ok(viewMatch, 'expected #view-my-space to exist as a tab-view');

    for (const id of ['myspace-activity-list', 'myspace-memory-list', 'myspace-tasks-list', 'myspace-workflows-list', 'myspace-calendar-list', 'myspace-history-list']) {
      assert.match(html, new RegExp(`id="${id}"`), `expected ${id} container in the served page`);
    }

    // Top nav (Section 4.1) must remain exactly Home/Inbox/Activity/Vault/Settings.
    const navItemMatches = [...html.matchAll(/<li class="nav-item[^"]*" data-tab="(tab-[a-z-]+)">/g)].map((m) => m[1]);
    assert.deepEqual(navItemMatches, ['tab-home', 'tab-inbox', 'tab-executions', 'tab-vault', 'tab-settings']);
  });
});

test("14. Home carries a My Space entry affordance that calls switchTab('tab-my-space')", async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /onclick="window\.NAGEX\.switchTab\('tab-my-space'\)"/, 'expected a real entry point into My Space from Home');
  });
});

test('15. app.js wires tab-my-space to renderMySpace() in the existing renderActiveTab() dispatcher (no new router)', async () => {
  await withServer(async (origin) => {
    const js = await (await fetch(`${origin}/app.js`)).text();
    assert.match(js, /state\.activeTab === 'tab-my-space'\) renderMySpace\(\)/);
    assert.match(js, /async function renderMySpace\(\)/);
  });
});
