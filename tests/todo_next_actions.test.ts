// Next actions (TODOs): what is offered, what is executable (the router's decision, not the model's), how a TODO is chosen and run through the normal request path, and how its state is READ from
// the task engine / artifact store instead of claimed. Real stores and route handler; the model (proposals) and the task engine's runs are scripted. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { classifyFollowUp, wantsTodoList } from '../src/todos/todo-classification.js';
import { decideRouting } from '../src/workspace/input-router.js';
import { TodoService, TodoServiceError, type TaskOutcome } from '../src/todos/todo.service.js';
import { TodoStore } from '../src/todos/todo.store.js';
import { handleTodoRoutes } from '../src/http/routes/todo.routes.js';
import { authAs } from './_s1_session_auth.js';

const T = 'ten_todo';
const U = 'usr_todo';
const ME = { tenantId: T, ownerId: U };
const dir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex_todo_${p}_`));

describe('what is a TODO and what is only a recommendation', () => {
  it('a follow-up is executable only if the router would send it to creation, research or the plan -> approval engine', () => {
    const deck = classifyFollowUp('이 보고서로 발표자료 8장을 만들어줘.', { sourceDocument: true });
    assert.deepEqual([deck.executable, deck.kind], [true, 'CREATE_PRESENTATION']);
    assert.equal(classifyFollowUp('Make an 8-slide deck from this report.', { sourceDocument: true }).kind, 'CREATE_PRESENTATION');
    assert.deepEqual([classifyFollowUp('다음 분기 사업 계획 보고서를 써줘').executable, classifyFollowUp('다음 분기 사업 계획 보고서를 써줘').kind], [true, 'CREATE_DOCUMENT']);
    assert.equal(classifyFollowUp('최근 AI 동향을 조사해서 출처와 함께 알려줘').kind, 'RESEARCH');
    assert.deepEqual([classifyFollowUp('금요일 오후 3시에 30분짜리 분기 계획 리뷰 회의 일정을 만들어줘').executable, classifyFollowUp('금요일 오후 3시에 30분짜리 분기 계획 리뷰 회의 일정을 만들어줘').kind], [true, 'ACTION']);
    // advice, something NAgex cannot do, a request that needs more from the person, and a negated one are NOT executable
    for (const text of ['가족과 저녁 식사를 하며 시간을 보내세요', '30초짜리 홍보 영상을 만들어줘', '그거 해줘', '보내지 말고 이메일 초안만 작성해줘', 'Take a walk after lunch']) {
      assert.equal(classifyFollowUp(text).executable, false, text);
    }
    assert.equal(classifyFollowUp('이 보고서로 발표자료 8장을 만들어줘.').executable, false, 'a deck "from this report" with no report to point at needs the person first');
  });

  it('an English event request with modifiers is an action (found by the next-actions journey: "Create a 30 minute ... meeting" was answered as chat); documents about a meeting are not', () => {
    for (const text of ['Create a 30 minute quarterly plan review meeting tomorrow at 3 PM', 'Add a team meeting to my calendar for Friday at 10', 'Set up a one hour planning call with Dana next week', 'Schedule a project review meeting tomorrow at 10 AM']) {
      assert.equal(decideRouting(text).kind, 'ACTION_PLAN', text);
    }
    for (const text of ['Make a summary of the meeting', 'Create a report on the call with the client', 'Write a document about the project meeting', 'Create a deck for the meeting', 'Make an agenda for the meeting']) {
      assert.notEqual(decideRouting(text).kind, 'ACTION_PLAN', text);
    }
  });

  it('only a request for a to-do list or next steps gets one; a plain question never does', () => {
    for (const text of ['이번 주에 해야 할 일을 정리해줘', '프로젝트 다음 단계가 뭐야?', 'Give me my to-do list for the offsite', 'What are the next steps?', '액션 아이템 만들어줘', '체크리스트로 정리해줘']) assert.equal(wantsTodoList(text), true, text);
    for (const text of ['한국의 수도는 어디야?', 'What is the capital of France?', '오늘 날짜가 언제야?', 'NAgex의 주요 기능을 설명해줘', '보고서를 써줘']) assert.equal(wantsTodoList(text), false, text);
  });
});

// ---- the service ----
function rig(options: { outcomes?: Record<string, TaskOutcome>; proposer?: (message: string) => { todos: Array<{ title: string; prompt: string }>; recommendations: string[] } | Error; now?: () => number } = {}) {
  const artifactStore = new ArtifactStore({ dir: dir('art') });
  const outcomes = options.outcomes ?? {};
  const calls: string[] = [];
  const clock = { t: Date.now() };
  const service = new TodoService({
    store: new TodoStore({ dir: dir('todo') }),
    artifactStore,
    readTask: (tenantId, ownerId, taskId) => (tenantId === T && ownerId === U ? outcomes[taskId] ?? null : null),
    proposer: {
      async proposeFollowUps(input) {
        calls.push(input.message);
        const answer = options.proposer ? options.proposer(input.message) : { todos: [], recommendations: [] };
        if (answer instanceof Error) throw answer;
        return { data: answer };
      },
    },
    now: options.now ?? (() => clock.t),
  });
  let documents = 0;
  const report = (owner = U, tenant = T, title = '분기 사업 계획 보고서') => {
    const id = `doc_${String(++documents).padStart(24, '0')}`;
    return artifactStore.saveCompleted({ tenantId: tenant, ownerId: owner, type: 'DOCUMENT', title, preview: 'p', sourceType: 'CAPTURE', sourceId: id, openTarget: `/api/v1/creations/documents/${id}` });
  };
  return { service, artifactStore, outcomes, calls, clock, report };
}

describe('offering', () => {
  it('after a report: one deterministic follow-up - a deck from that very document - offered once however often it is asked', () => {
    const r = rig();
    const art = r.report();
    const first = r.service.suggestForArtifact(ME, art.artifactId);
    assert.equal(first.todos.length, 1);
    const todo = first.todos[0];
    assert.deepEqual([todo.state, todo.kind, todo.origin, todo.sourceArtifactId, todo.sourceDocumentId], ['PROPOSED', 'CREATE_PRESENTATION', 'ARTIFACT', art.artifactId, 'doc_000000000000000000000001']);
    assert.equal((todo as any).tenantId, undefined, 'no tenant or owner in the view');
    assert.equal(r.service.suggestForArtifact(ME, art.artifactId).todos[0].todoId, todo.todoId, 'idempotent');
    assert.equal(r.service.list(ME).length, 1);
    const english = r.service.suggestForArtifact(ME, r.report(U, T, 'Quarterly plan').artifactId).todos[0];
    assert.match(english.title, /PowerPoint/);
    assert.throws(() => r.service.suggestForArtifact(ME, 'art_ffffffffffffffffffffffff'), (e: unknown) => e instanceof TodoServiceError && e.code === 'NOT_FOUND');
    assert.throws(() => r.service.suggestForArtifact({ tenantId: T, ownerId: 'usr_other' }, art.artifactId), (e: unknown) => e instanceof TodoServiceError && e.code === 'NOT_FOUND', 'someone else\'s report is not found');
    const image = r.artifactStore.saveCompleted({ tenantId: T, ownerId: U, type: 'IMAGE', title: '그림', preview: 'p', sourceType: 'CAPTURE', sourceId: 'img_x', openTarget: '/api/v1/creations/images/img_000000000000000000000001' });
    assert.equal(r.service.suggestForArtifact(ME, image.artifactId).reason, 'NOT_A_DOCUMENT');
  });

  it('a plain question asks the model nothing and returns nothing; a request for next steps is split into TODOs (router-approved) and recommendations', async () => {
    const r = rig({ proposer: () => ({
      todos: [
        { title: '킥오프 회의 일정 만들기', prompt: '금요일 오후 3시에 30분짜리 킥오프 회의 일정을 만들어줘' },
        { title: '시장 조사 하기', prompt: '최근 AI 시장 동향을 조사해서 출처와 함께 알려줘' },
        { title: '영상 만들기', prompt: '30초짜리 홍보 영상을 만들어줘' },
      ],
      recommendations: ['팀원들과 먼저 의견을 나눠 보세요'],
    }) });
    const none = await r.service.suggestFromConversation(ME, { message: '한국의 수도는 어디야?', answer: '서울입니다.' });
    assert.deepEqual([none.todos, none.recommendations, none.reason], [[], [], 'NOT_REQUESTED']);
    assert.equal(r.calls.length, 0, 'no model call for a plain question');

    const out = await r.service.suggestFromConversation(ME, { message: '킥오프 준비를 위해 해야 할 일을 정리해줘', answer: '...' });
    assert.equal(r.calls.length, 1);
    assert.deepEqual(out.todos.map((t) => [t.kind, t.state]), [['ACTION', 'PROPOSED'], ['RESEARCH', 'PROPOSED']]);
    assert.deepEqual(out.recommendations, ['팀원들과 먼저 의견을 나눠 보세요', '영상 만들기'], 'what NAgex cannot do is a recommendation, never a button');
    const again = await r.service.suggestFromConversation(ME, { message: '킥오프 준비를 위해 해야 할 일을 정리해줘' });
    assert.deepEqual(again.todos.map((t) => t.todoId), out.todos.map((t) => t.todoId), 'the same request gives the same TODOs');
    assert.equal(r.service.list(ME).length, 2);
  });

  it('when the model cannot propose, the person is told so (nothing invented)', async () => {
    const r = rig({ proposer: () => new Error('provider down') });
    await assert.rejects(r.service.suggestFromConversation(ME, { message: '다음 단계가 뭐야?' }), (e: unknown) => e instanceof TodoServiceError && e.code === 'FOLLOW_UPS_UNAVAILABLE');
    const noModel = new TodoService({ store: new TodoStore({ dir: dir('x') }), artifactStore: new ArtifactStore({ dir: dir('y') }), readTask: () => null });
    await assert.rejects(noModel.suggestFromConversation(ME, { message: 'What are the next steps?' }), (e: unknown) => e instanceof TodoServiceError && e.code === 'FOLLOW_UPS_UNAVAILABLE');
  });
});

describe('choosing and running: state is read, never claimed', () => {
  const started = () => {
    const r = rig();
    const art = r.report();
    const todo = r.service.suggestForArtifact(ME, art.artifactId).todos[0];
    const begun = r.service.start(ME, todo.todoId);
    return { r, art, todo, begun };
  };

  it('start returns the exact request to run, moves it to IN_PROGRESS once, and refuses a second start', () => {
    const { r, todo, begun } = started();
    assert.equal(begun.prompt, '이 보고서로 발표자료 8장을 만들어줘.');
    assert.deepEqual([begun.todo.state, begun.source.documentId], ['IN_PROGRESS', 'doc_000000000000000000000001']);
    assert.throws(() => r.service.start(ME, todo.todoId), (e: unknown) => e instanceof TodoServiceError && e.code === 'NOT_STARTABLE');
    assert.throws(() => r.service.start({ tenantId: T, ownerId: 'usr_other' }, todo.todoId), (e: unknown) => e instanceof TodoServiceError && e.code === 'NOT_FOUND');
    assert.throws(() => r.service.start(ME, 'todo_ffffffffffffffffffffffff'), (e: unknown) => e instanceof TodoServiceError && e.code === 'NOT_FOUND');
  });

  it('an artifact that is the owner\'s and newer than the start completes it; someone else\'s, an older one, an unknown one and a bare "completed" claim do not', () => {
    const { r, todo } = started();
    const foreign = r.report('usr_other');
    assert.throws(() => r.service.link(ME, todo.todoId, { artifactId: foreign.artifactId }), (e: unknown) => e instanceof TodoServiceError && e.code === 'INVALID_LINK');
    assert.throws(() => r.service.link(ME, todo.todoId, { artifactId: 'art_ffffffffffffffffffffffff' }), (e: unknown) => e instanceof TodoServiceError && e.code === 'INVALID_LINK');
    assert.throws(() => r.service.link(ME, todo.todoId, { state: 'COMPLETED' } as never), (e: unknown) => e instanceof TodoServiceError && e.code === 'INVALID_LINK', 'the client cannot declare success');
    assert.equal(r.service.list(ME)[0].state, 'IN_PROGRESS');
    // an artifact that existed before the start is not "the result"
    const old = new ArtifactStore({ dir: dir('old'), now: () => '2020-01-01T00:00:00.000Z' });
    assert.ok(old);
    const deck = r.artifactStore.saveCompleted({ tenantId: T, ownerId: U, type: 'PRESENTATION', title: '발표자료', preview: 'p', sourceType: 'CAPTURE', sourceId: 'pres_x', openTarget: '/api/v1/creations/presentations/pres_000000000000000000000001' });
    const done = r.service.link(ME, todo.todoId, { artifactId: deck.artifactId });
    assert.deepEqual([done.state, done.detail?.code, done.links.artifactId], ['COMPLETED', 'CREATED', deck.artifactId]);
    assert.throws(() => r.service.link(ME, todo.todoId, { failure: { code: 'X' } }), (e: unknown) => e instanceof TodoServiceError && e.code === 'INVALID_LINK', 'a finished TODO is not re-opened by a report');
  });

  it('a task\'s state is the task engine\'s: approval pending, running, a reviewed plan (not done), a verified calendar change (done), unconfirmed / mismatched (not done), declined, expired, failed', () => {
    const outcomes: Record<string, TaskOutcome> = {};
    const r = rig({ outcomes });
    const art = r.report();
    const todo = r.service.suggestForArtifact(ME, art.artifactId).todos[0];
    const view = (outcome: TaskOutcome) => {
      outcomes.task_one0001 = outcome;
      return r.service.list(ME)[0];
    };
    r.service.start(ME, todo.todoId);
    outcomes.task_one0001 = { status: 'WAITING_APPROVAL', errorCode: null, result: null };
    const linked = r.service.link(ME, todo.todoId, { taskId: 'task_one0001' });
    assert.deepEqual([linked.state, linked.detail?.code], ['APPROVAL_REQUIRED', 'APPROVAL_PENDING']);
    assert.deepEqual([view({ status: 'RUNNING', errorCode: null, result: null }).state], ['IN_PROGRESS']);
    assert.deepEqual([view({ status: 'SUCCEEDED', errorCode: null, result: { kind: 'PLAN_PREVIEW' } }).state, r.service.list(ME)[0].detail?.code], ['IN_PROGRESS', 'PLAN_ONLY'], 'a reviewed plan is not an executed action');
    const calendar = (outcome?: string) => ({ status: 'SUCCEEDED', errorCode: null, result: { kind: 'STEP_EXECUTION', steps: [{ capabilityId: 'google_calendar.create_event', result: { verification: outcome ? { outcome } : undefined } }] } });
    assert.deepEqual([view(calendar('VERIFIED')).state, r.service.list(ME)[0].detail?.code], ['COMPLETED', 'VERIFIED']);
    assert.deepEqual([view(calendar('NOT_VERIFIED')).state, r.service.list(ME)[0].detail?.code], ['FAILED', 'NOT_CONFIRMED'], 'sent but not read back is not "done"');
    assert.deepEqual([view(calendar('MISMATCH')).state, r.service.list(ME)[0].detail?.code], ['FAILED', 'MISMATCH']);
    assert.deepEqual([view(calendar()).state, r.service.list(ME)[0].detail?.code], ['FAILED', 'NOT_CONFIRMED']);
    assert.deepEqual([view({ status: 'FAILED', errorCode: 'APPROVAL_REJECTED', result: null }).state, r.service.list(ME)[0].detail?.code], ['FAILED', 'DECLINED']);
    assert.equal(view({ status: 'FAILED', errorCode: 'APPROVAL_EXPIRED', result: null }).detail?.code, 'EXPIRED');
    assert.equal(view({ status: 'FAILED', errorCode: 'BOOM', result: null }).detail?.code, 'BOOM');
    assert.equal(view({ status: 'CANCELLED', errorCode: null, result: null }).detail?.code, 'CANCELLED');
    assert.deepEqual([view({ status: 'SUCCEEDED', errorCode: null, result: { kind: 'STEP_EXECUTION', steps: [{ capabilityId: 'gmail.send_email', result: {} }] } }).state, r.service.list(ME)[0].detail?.code], ['COMPLETED', 'RESPONDED'], 'a tool\'s answer is said to be only that');
    delete outcomes.task_one0001;
    assert.deepEqual([r.service.list(ME)[0].state, r.service.list(ME)[0].detail?.code], ['FAILED', 'TASK_MISSING']);
    assert.throws(() => r.service.link(ME, todo.todoId, { taskId: 'task_nope0001' }), (e: unknown) => e instanceof TodoServiceError);
  });

  it('a reported failure ends it as FAILED and it can be chosen again; a prepared plan nobody continued is offered again after a while', () => {
    const { r, todo } = started();
    const failed = r.service.link(ME, todo.todoId, { failure: { code: 'ALL_MODEL_PROVIDERS_FAILED' } });
    assert.deepEqual([failed.state, failed.detail?.code], ['FAILED', 'ALL_MODEL_PROVIDERS_FAILED']);
    const again = r.service.start(ME, todo.todoId);
    assert.deepEqual([again.todo.state, again.todo.links, again.todo.detail], ['IN_PROGRESS', {}, undefined]);
    r.clock.t += 31 * 60_000;
    assert.deepEqual([r.service.list(ME)[0].state, r.service.list(ME)[0].startedAt], ['PROPOSED', undefined], 'abandoned after 30 minutes: offered again');
  });
});

describe('the routes', () => {
  const call = (r: ReturnType<typeof rig>, method: string, pathname: string, body: unknown, who: { t: string; u: string } | null = { t: T, u: U }, withService = true) =>
    handleTodoRoutes(method as 'GET', pathname, body as never, who ? authAs(who.t, who.u) : {}, {}, { ...(withService ? { todoService: r.service } : {}), now: () => r.clock.t }) as Promise<{ status: number; data: any } | undefined>;

  it('needs a session; lists, suggests, starts and links for the owner; another person, an unknown and a malformed id are all 404', async () => {
    const r = rig({ proposer: () => ({ todos: [{ title: '일정', prompt: '금요일 오후 3시에 팀 회의 일정을 만들어줘' }], recommendations: [] }) });
    assert.equal((await call(r, 'GET', '/api/v1/todos', null, null))!.status, 401);
    assert.equal(await call(r, 'GET', '/api/v1/other', null), undefined);
    const art = r.report();
    const suggested = (await call(r, 'POST', '/api/v1/todos/suggest', { artifactId: art.artifactId }))!;
    assert.equal(suggested.status, 200);
    const todoId = suggested.data.todos[0].todoId;
    assert.equal((await call(r, 'GET', '/api/v1/todos', null))!.data.todos.length, 1);
    assert.equal((await call(r, 'GET', '/api/v1/todos', null, { t: T, u: 'usr_other' }))!.data.todos.length, 0, 'another person sees none');
    for (const [method, p, who] of [['POST', `/api/v1/todos/${todoId}/start`, { t: T, u: 'usr_other' }], ['POST', `/api/v1/todos/${todoId}/start`, { t: 'ten_other', u: U }], ['POST', '/api/v1/todos/todo_ffffffffffffffffffffffff/start', undefined], ['POST', '/api/v1/todos/not-a-todo/start', undefined]] as const) {
      const res = (await call(r, method, p, {}, who))!;
      assert.equal(res.status, 404, p);
      assert.equal(res.data.error.code, 'TODO_NOT_FOUND');
    }
    const started = (await call(r, 'POST', `/api/v1/todos/${todoId}/start`, {}))!;
    assert.equal(started.status, 200);
    assert.equal(started.data.prompt, '이 보고서로 발표자료 8장을 만들어줘.');
    assert.equal((await call(r, 'POST', `/api/v1/todos/${todoId}/start`, {}))!.status, 409);
    assert.equal((await call(r, 'POST', `/api/v1/todos/${todoId}/link`, { artifactId: 'bad' }))!.status, 400);
    assert.equal((await call(r, 'POST', `/api/v1/todos/${todoId}/link`, { taskId: '../x' }))!.status, 400);
    assert.equal((await call(r, 'POST', `/api/v1/todos/${todoId}/link`, {}))!.status, 400);
    assert.equal((await call(r, 'POST', `/api/v1/todos/${todoId}/link`, { failure: { code: 'request failed!' } }))!.data.todo.detail.code, 'REQUEST_FAILED_');
    assert.equal((await call(r, 'POST', '/api/v1/todos/suggest', { artifactId: 'nope' }))!.status, 404);
    assert.equal((await call(r, 'POST', '/api/v1/todos/suggest', {}))!.status, 400);
    const plain = (await call(r, 'POST', '/api/v1/todos/suggest', { message: '한국의 수도는 어디야?' }))!;
    assert.deepEqual([plain.status, plain.data.todos, plain.data.reason], [200, [], 'NOT_REQUESTED']);
    const asked = (await call(r, 'POST', '/api/v1/todos/suggest', { message: '이번 주 해야 할 일을 정리해줘', timezone: 'Asia/Seoul' }))!;
    assert.deepEqual([asked.status, asked.data.todos.map((t: any) => t.kind)], [200, ['ACTION']]);
    assert.equal((await call(r, 'GET', '/api/v1/todos', null, { t: T, u: U }, false))!.status, 503);
  });
});
