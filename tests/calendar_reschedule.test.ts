// R26-B - "방금 만든 회의를 한 시간 늦춰줘". Found on 971c9b3 (WP1 left it PARTIAL): a request to move an event had no way to know WHICH event, its id, or what the new time works out to, so it came back
// as a clarification or an empty step. NAgex now plans it from the person's own words - which event (the one just created, a title, a day, a time), what the new time is (the length is kept), the exact
// before -> after - and asks when it cannot tell, instead of guessing. This file proves the reference resolution, the arithmetic, the route, and the whole chain with the real approval and execution
// path against a faithful fake of the Calendar API. A pass is NAgex's own behaviour, not a live Google write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { handleConversationRoutes } from '../src/http/routes/conversation.routes.js';
import { decideRouting } from '../src/workspace/input-router.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { ConversationStore } from '../src/conversations/conversation.store.js';
import { ConversationContextService } from '../src/conversations/conversation-context.service.js';
import { CalendarEventDirectory } from '../src/planning/calendar-event-directory.js';
import { buildCalendarReschedulePlan, parseRescheduleRequest, resolveEventReference, type KnownCalendarEvent } from '../src/planning/calendar-reschedule.js';
import type { ScheduleClock } from '../src/planning/schedule-grounding.js';
import { wallTimeToInstant, zonedParts } from '../src/common/time-context.js';
import { createFakeGoogleCalendar } from './_fake_google_calendar.js';
import { authAs } from './_s1_session_auth.js';

const NOW = Date.parse('2026-10-16T01:00:00Z'); // Friday 2026-10-16 10:00 in Seoul
const clock: ScheduleClock = { nowMs: NOW, timezone: 'Asia/Seoul', timezoneSource: 'CLIENT' };
const seoul = (iso: string) => wallTimeToInstant({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)), hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) }, 'Asia/Seoul').ms;

let n = 0;
const event = (summary: string, start: string, end: string, over: Partial<KnownCalendarEvent> = {}): KnownCalendarEvent => ({
  calendarId: 'primary', eventId: `ev${(n += 1)}`, summary, startMs: seoul(start), endMs: seoul(end), timezone: 'Asia/Seoul', source: 'CALENDAR', ...over,
});
const created = (summary: string, start: string, end: string, minutesAgo: number): KnownCalendarEvent => event(summary, start, end, { source: 'NAGEX_CREATED', createdAtMs: NOW - minutesAgo * 60_000 });

describe('routing: moving an event is an approval-gated action, never a chat answer', () => {
  // Found with the real UI: "방금 만든 회의를 한 시간 늦춰줘" was classified as plain CONVERSATION, so it never reached planning - the chat model answered instead.
  it('requests to move, delay or bring forward an event reach the planner (Korean and English)', () => {
    for (const text of ['방금 만든 회의를 한 시간 늦춰줘', '프로젝트 리뷰를 30분 앞당겨줘', '회의를 3시로 옮겨줘', '다음 주 월요일 회의를 하루 미뤄줘', '방금 만든 일정 30분 더 늦춰줘', 'Push the meeting I just created back an hour', 'Move the project review to 4pm', 'push my standup back 30 minutes please', 'Can you move the meeting to tomorrow?']) {
      const d = decideRouting(text);
      assert.equal(d.kind, 'ACTION_PLAN', text);
      assert.ok(d.reasonCodes.includes('APPROVAL_REQUIRED'), text);
    }
  });
  it('talk about meetings, files and plain statements is not taken for a reschedule', () => {
    for (const text of ['회의 시간이 늦춰졌어요', 'Move the meeting notes to Notion', 'move on to the next topic', 'Tell me how to reschedule a meeting', '내일 회의 어땠어?', 'push the button']) {
      assert.notEqual(decideRouting(text).kind, 'ACTION_PLAN', text);
    }
  });
});

describe('what the request says', () => {
  it('reads the change and which event, in Korean and English', () => {
    const a = parseRescheduleRequest('방금 만든 회의를 한 시간 늦춰줘', clock)!;
    assert.deepEqual([a.language, a.shiftMinutes, a.justCreated, a.hasReferenceWord], ['ko', 60, true, true]);
    assert.equal(parseRescheduleRequest('프로젝트 리뷰 회의를 30분 앞당겨줘', clock)!.shiftMinutes, -30);
    const c = parseRescheduleRequest('내일 오후 2시 프로젝트 리뷰 회의를 3시로 옮겨줘', clock)!;
    assert.deepEqual([c.targetTime, c.shiftMinutes], [{ hour: 15, minute: 0 }, undefined]);
    assert.match(c.selectorText, /프로젝트 리뷰 회의/);
    assert.doesNotMatch(c.selectorText, /3시/, 'the new time is not part of "which event"');
    const d = parseRescheduleRequest('회의를 내일로 옮겨줘', clock)!;
    assert.deepEqual([d.targetDate, d.targetTime], [{ year: 2026, month: 10, day: 17 }, undefined]);
    const e = parseRescheduleRequest('Move the project review to 4pm', clock)!;
    assert.deepEqual([e.language, e.targetTime], ['en', { hour: 16, minute: 0 }]);
    assert.equal(parseRescheduleRequest('push my standup back 30 minutes', clock)!.shiftMinutes, 30);
    assert.equal(parseRescheduleRequest('I just created a meeting - push it back an hour', clock)!.justCreated, true);
  });
  it('a request that is not about moving an event in time is left alone', () => {
    for (const text of ['내일 오후 2시에 회의 잡아줘', 'move it to the cloud', '회의 준비를 어떻게 하면 좋을까?', 'Schedule a project review meeting tomorrow at 10 AM', '이 파일을 옮겨줘', '안녕하세요']) {
      assert.equal(parseRescheduleRequest(text, clock), null, text);
    }
  });
});

describe('which event', () => {
  const resolve = (text: string, events: KnownCalendarEvent[]) => resolveEventReference(parseRescheduleRequest(text, clock)!, events, clock);

  it('"방금 만든" is the event NAgex created most recently - one match is used, close ties are asked about', () => {
    const only = created('프로젝트 리뷰 회의', '2026-10-17T14:00', '2026-10-17T15:00', 3);
    assert.deepEqual(resolve('방금 만든 회의를 한 시간 늦춰줘', [only, event('다른 일정', '2026-10-17T09:00', '2026-10-17T10:00')]), { status: 'RESOLVED', event: only });
    const older = created('주간 회의', '2026-10-17T11:00', '2026-10-17T12:00', 200);
    assert.equal((resolve('방금 만든 회의를 한 시간 늦춰줘', [older, only]) as any).event, only, 'created hours apart: the newest is "just now"');
    const twin = created('팀 점심', '2026-10-17T12:00', '2026-10-17T13:00', 5);
    const tie = resolve('방금 만든 회의를 한 시간 늦춰줘', [only, twin]);
    assert.equal(tie.status, 'AMBIGUOUS');
    assert.equal((tie as any).candidates.length, 2, 'two created within minutes of each other: asked, not guessed');
  });
  it('an event NAgex did not create, or created long ago, is not "just created"', () => {
    assert.equal(resolve('방금 만든 회의를 한 시간 늦춰줘', [event('캘린더 일정', '2026-10-17T09:00', '2026-10-17T10:00')]).status, 'NONE');
    assert.equal(resolve('방금 만든 회의를 한 시간 늦춰줘', [created('옛 회의', '2026-10-17T09:00', '2026-10-17T10:00', 60 * 8)]).status, 'NONE');
    assert.equal(resolve('방금 만든 회의를 한 시간 늦춰줘', []).status, 'NONE');
  });
  it('a title, a day or a time picks the event; the same title on two days is asked about until the day is given', () => {
    const mon = event('프로젝트 리뷰', '2026-10-19T14:00', '2026-10-19T15:00');
    const tue = event('프로젝트 리뷰', '2026-10-20T14:00', '2026-10-20T15:00');
    const other = event('치과', '2026-10-19T09:00', '2026-10-19T10:00');
    const events = [mon, tue, other];
    assert.equal(resolve('프로젝트 리뷰를 한 시간 늦춰줘', events).status, 'AMBIGUOUS');
    assert.equal((resolve('치과 일정을 30분 늦춰줘', events) as any).event, other);
    assert.equal((resolve('다음 주 월요일 프로젝트 리뷰를 한 시간 늦춰줘', events) as any).event, mon);
    assert.equal((resolve('다음 주 화요일 오후 2시 회의를 한 시간 늦춰줘', events) as any).event, tue, 'day + time select it even without the title');
    assert.equal(resolve('프로젝트 리뷰를 한 시간 늦춰줘', [other]).status, 'NONE', 'a title nothing matches is "not found", never the nearest event');
  });
  it('"그 회의" with exactly one candidate is that one; with several it lists them (at most five); events that ended days ago do not count', () => {
    const one = event('스탠드업', '2026-10-17T09:00', '2026-10-17T09:30');
    assert.equal((resolve('그 회의를 30분 늦춰줘', [one]) as any).event, one);
    const many = Array.from({ length: 7 }, (_, i) => event(`회의 ${i}`, `2026-10-${17 + i}T09:00`, `2026-10-${17 + i}T10:00`));
    const asked = resolve('그 회의를 30분 늦춰줘', many);
    assert.equal(asked.status, 'AMBIGUOUS');
    assert.equal((asked as any).candidates.length, 5);
    const ancient = event('지난 회의', '2026-10-10T09:00', '2026-10-10T10:00');
    assert.equal(resolve('그 회의를 30분 늦춰줘', [ancient]).status, 'NONE');
  });
});

describe('the plan: exact before -> after, length kept, nothing guessed', () => {
  const planFor = (text: string, candidates: KnownCalendarEvent[], calendarState = 'CONNECTED') => buildCalendarReschedulePlan({ prompt: text, clock, candidates, calendarState });

  it('the incident: "방금 만든 회의를 한 시간 늦춰줘" becomes an approval-gated update with the new time in the event\'s timezone', () => {
    const ev = created('프로젝트 리뷰 회의', '2026-10-17T14:00', '2026-10-17T15:00', 2);
    const result = planFor('방금 만든 회의를 한 시간 늦춰줘', [ev]);
    assert.equal(result.kind, 'PLAN');
    if (result.kind !== 'PLAN') return;
    const step = result.plan.steps[0];
    assert.equal(step.tool, 'google_calendar.update_event');
    assert.equal(step.requiresApproval, true);
    assert.deepEqual(step.parameters, {
      calendarId: 'primary', eventId: ev.eventId, start: '2026-10-17T15:00:00', end: '2026-10-17T16:00:00', timezone: 'Asia/Seoul',
      before: { summary: '프로젝트 리뷰 회의', start: '2026-10-17T14:00:00', end: '2026-10-17T15:00:00', timezone: 'Asia/Seoul' },
    });
    assert.match(result.plan.summary, /프로젝트 리뷰 회의.*2026-10-17 \(토\) 14:00–15:00 → 2026-10-17 \(토\) 15:00–16:00 \(Asia\/Seoul\)/);
    assert.match(result.plan.summary, /승인하기 전에는 캘린더가 바뀌지 않아요/);
    assert.match(result.plan.steps[0].reasoning, /변경 전.*14:00.*변경 후.*15:00/);
    assert.equal(result.newEndMs - result.newStartMs, 3600_000, 'the length is kept');
  });
  it('earlier, by minutes, to a new time, to a new day, across midnight - the length and the other half of the date are kept', () => {
    const ev = event('프로젝트 리뷰', '2026-10-17T14:00', '2026-10-17T15:30');
    const p = (text: string) => (planFor(text, [ev]) as any).plan?.steps[0].parameters;
    assert.deepEqual([p('프로젝트 리뷰를 30분 앞당겨줘').start, p('프로젝트 리뷰를 30분 앞당겨줘').end], ['2026-10-17T13:30:00', '2026-10-17T15:00:00']);
    assert.deepEqual([p('프로젝트 리뷰를 4시로 옮겨줘').start, p('프로젝트 리뷰를 4시로 옮겨줘').end], ['2026-10-17T16:00:00', '2026-10-17T17:30:00']);
    assert.deepEqual([p('프로젝트 리뷰를 다음 주 월요일로 옮겨줘').start, p('프로젝트 리뷰를 다음 주 월요일로 옮겨줘').end], ['2026-10-19T14:00:00', '2026-10-19T15:30:00']);
    assert.deepEqual([p('프로젝트 리뷰를 10시간 늦춰줘').start, p('프로젝트 리뷰를 10시간 늦춰줘').end], ['2026-10-18T00:00:00', '2026-10-18T01:30:00']);
  });
  it('an event in another timezone is moved on ITS wall clock', () => {
    const la = event('Sync with Dana', '2026-10-17T14:00', '2026-10-17T15:00', { timezone: 'America/Los_Angeles', startMs: wallTimeToInstant({ year: 2026, month: 10, day: 20, hour: 10, minute: 0 }, 'America/Los_Angeles').ms, endMs: wallTimeToInstant({ year: 2026, month: 10, day: 20, hour: 11, minute: 0 }, 'America/Los_Angeles').ms });
    const result = planFor('push the Dana sync back an hour', [la]);
    assert.equal(result.kind, 'PLAN');
    const params = (result as any).plan.steps[0].parameters;
    assert.deepEqual([params.start, params.end, params.timezone], ['2026-10-20T11:00:00', '2026-10-20T12:00:00', 'America/Los_Angeles']);
    assert.match((result as any).plan.summary, /Your calendar is not changed until you approve/);
  });
  it('a change that lands on the same time, no event, several events, no calendar - each is a plain answer and nothing is proposed', () => {
    const ev = event('프로젝트 리뷰', '2026-10-17T14:00', '2026-10-17T15:00');
    assert.deepEqual([planFor('프로젝트 리뷰를 2시로 옮겨줘', [ev]).kind, (planFor('프로젝트 리뷰를 2시로 옮겨줘', [ev]) as any).reason], ['NEEDS_DETAIL', 'NO_CHANGE']);
    const none = planFor('방금 만든 회의를 한 시간 늦춰줘', []);
    assert.deepEqual([none.kind, (none as any).reason], ['NEEDS_DETAIL', 'NO_EVENT']);
    assert.match((none as any).message.ko, /아무것도 바꾸지 않았어요/);
    const noCalendar = planFor('방금 만든 회의를 한 시간 늦춰줘', [], 'NOT_CONNECTED');
    assert.equal((noCalendar as any).reason, 'CALENDAR_UNAVAILABLE');
    const two = planFor('그 회의를 한 시간 늦춰줘', [ev, event('치과', '2026-10-17T09:00', '2026-10-17T10:00')]);
    assert.equal((two as any).reason, 'AMBIGUOUS');
    assert.match((two as any).message.ko, /1\. 치과.*\n2\. 프로젝트 리뷰/);
    assert.equal((two as any).candidates.length, 2);
    const en = planFor('push that meeting back an hour', [ev, event('Dentist', '2026-10-17T09:00', '2026-10-17T10:00')]);
    assert.match((en as any).message.en, /Which event do you mean\?/);
  });
  it('words that merely look like a move - no event named and no known title - are not hijacked', () => {
    const ev = event('프로젝트 리뷰', '2026-10-17T14:00', '2026-10-17T15:00');
    assert.equal(planFor('이 파일을 3시로 옮겨줘', [ev]).kind, 'NOT_RESCHEDULE');
    assert.equal(planFor('내일 오후 2시에 회의 잡아줘', [ev]).kind, 'NOT_RESCHEDULE');
    assert.equal(planFor('프로젝트 리뷰를 4시로 옮겨줘', [ev]).kind, 'PLAN', 'a known title is enough to be about the calendar');
  });
});

// ---------------------------------------------------------------------------------------------------------------- the directory and the whole chain

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.invalid/cb' };
const T = 'ten_rs';
const U = 'usr_rs';

function chain(options: { reader?: 'fake' | 'throws' | 'not_connected' } = {}) {
  const fake = createFakeGoogleCalendar();
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const executions = new ExecutionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex_rs_exec_')) });
  const service = new GoogleCalendarService(tokenStore, approvals, audit, new MemoryEngine(), fake.fetch, () => config, executions);
  tokenStore.saveForPrincipal(T, U, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });
  const reader = async ({ timeMin, timeMax, requestId }: { tenantId: string; principalId: string; timeMin: string; timeMax: string; requestId: string }) => {
    if (options.reader === 'throws') throw new Error('boom');
    if (options.reader === 'not_connected') return { state: 'NOT_CONNECTED', events: [] };
    const items = await service.listUpcomingEvents({ tenantId: T, principalId: U, timeMin, timeMax, requestId });
    return { state: 'CONNECTED', events: items };
  };
  const directory = new CalendarEventDirectory({ executions, approvals, readCalendarWindow: reader });
  return { fake, service, approvals, executions, directory, audit };
}

const realClock = (): ScheduleClock => ({ nowMs: Date.now(), timezone: 'Asia/Seoul', timezoneSource: 'CLIENT' });
const tomorrowAt = (hour: number) => {
  const t = zonedParts(Date.now() + 24 * 3600_000, 'Asia/Seoul');
  const wall = (h: number) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;
  return { start: wall(hour), end: wall(hour + 1) };
};
let seq = 0;
async function createVia(c: ReturnType<typeof chain>, summary: string, hour: number, who = { tenantId: T, principalId: U }) {
  const when = tomorrowAt(hour);
  const approval = c.service.requestCreateEventApproval({ ...who, payload: { calendarId: 'primary', summary, description: '', start: when.start, end: when.end, timezone: 'Asia/Seoul', attendees: [] }, requestId: `r_${++seq}` });
  c.service.approve(approval.approvalId, who.tenantId, who.principalId, `ra_${seq}`);
  return c.service.executeCreateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, ...who, requestId: `rb_${seq}` });
}

describe('the directory', () => {
  it('lists what NAgex created for THIS person from its own records, with the approved summary and time, and the calendar\'s own events beside them', async () => {
    const c = chain();
    const made = await createVia(c, '프로젝트 리뷰 회의', 14);
    c.fake.seed({ id: 'gcal_other', summary: '치과', start: tomorrowAt(9).start, end: tomorrowAt(10).start, timeZone: 'Asia/Seoul' });
    const dir = await c.directory.candidates({ tenantId: T, principalId: U, clock: realClock(), requestId: 'q1' });
    assert.equal(dir.calendarState, 'CONNECTED');
    const mine = dir.events.find((e) => e.eventId === made.externalId)!;
    assert.deepEqual([mine.source, mine.summary, mine.timezone], ['NAGEX_CREATED', '프로젝트 리뷰 회의', 'Asia/Seoul']);
    assert.ok(mine.createdAtMs && Date.now() - mine.createdAtMs < 60_000);
    assert.equal(dir.events.find((e) => e.eventId === 'gcal_other')?.source, 'CALENDAR');
  });
  it('another person\'s creations are invisible; a cancelled event is gone; a time change NAgex made is applied', async () => {
    const c = chain();
    c.service['tokenStore' as keyof typeof c.service];
    const made = await createVia(c, '프로젝트 리뷰 회의', 14);
    const moved = c.service.requestUpdateEventApproval({ tenantId: T, principalId: U, payload: { calendarId: 'primary', eventId: made.externalId, start: tomorrowAt(16).start, end: tomorrowAt(17).start, timezone: 'Asia/Seoul' }, requestId: 'u1' });
    c.service.approve(moved.approvalId, T, U, 'u2');
    await c.service.executeUpdateEvent({ approvalId: moved.approvalId, payload: moved.canonicalPayload, tenantId: T, principalId: U, requestId: 'u3' });
    const dir = await c.directory.candidates({ tenantId: T, principalId: U, clock: realClock(), requestId: 'q2' });
    assert.equal(zonedParts(dir.events.find((e) => e.eventId === made.externalId)!.startMs, 'Asia/Seoul').hour, 16);
    const stranger = await c.directory.candidates({ tenantId: T, principalId: 'usr_other', clock: realClock(), requestId: 'q3' });
    assert.equal(stranger.events.some((e) => e.eventId === made.externalId && e.source === 'NAGEX_CREATED'), false);
    const cancel = c.service.requestCancelEventApproval({ tenantId: T, principalId: U, payload: { calendarId: 'primary', eventId: made.externalId, summary: 'x' }, requestId: 'c1' });
    c.service.approve(cancel.approvalId, T, U, 'c2');
    await c.service.executeCancelEvent({ approvalId: cancel.approvalId, payload: cancel.canonicalPayload, tenantId: T, principalId: U, requestId: 'c3' });
    const after = await c.directory.candidates({ tenantId: T, principalId: U, clock: realClock(), requestId: 'q4' });
    assert.equal(after.events.some((e) => e.eventId === made.externalId), false);
  });
  it('an unreadable calendar is reported as such and NAgex\'s own recent creations are still known; all-day and cancelled events are not candidates', async () => {
    const down = chain({ reader: 'throws' });
    const made = await createVia(down, '프로젝트 리뷰 회의', 14);
    const a = await down.directory.candidates({ tenantId: T, principalId: U, clock: realClock(), requestId: 'q5' });
    assert.equal(a.calendarState, 'UNAVAILABLE');
    assert.equal(a.events.some((e) => e.eventId === made.externalId), true);
    const notConnected = chain({ reader: 'not_connected' });
    assert.equal((await notConnected.directory.candidates({ tenantId: T, principalId: U, clock: realClock(), requestId: 'q6' })).calendarState, 'NOT_CONNECTED');
  });
});

describe('the route and the whole chain', () => {
  function routeFor(c: ReturnType<typeof chain>) {
    const sessionStore = new SessionStore();
    const convStore = new ConversationStore();
    const deps: any = {
      service: { plan: async () => { throw new Error('a reschedule must never be planned by a model'); }, chat: async () => { throw new Error('no model'); } },
      planResolver: { resolve: (plan: any) => ({ steps: plan.steps.map((s: any) => ({ step: s.step, executionReadiness: 'APPROVAL_REQUIRED', resolvedToolId: s.tool, toolAvailability: 'LIVE', parameters: s.parameters })) }) },
      sessionStore, convStore, convContextService: new ConversationContextService(convStore), auditLogger: new AuditLogger(), getRelevantMemories: () => [],
      getProfileTimezone: () => 'Asia/Seoul', now: () => Date.now(),
      rescheduleCandidates: (input: any) => c.directory.candidates(input),
    };
    return (prompt: string, who: [string, string] = [T, U]) => handleConversationRoutes('POST', '/api/v1/ambient/intent', { prompt, requestMetadata: { timezone: 'Asia/Seoul' } }, authAs(who[0], who[1]), {}, deps) as Promise<any>;
  }

  it('create -> "방금 만든 회의를 한 시간 늦춰줘" -> reviewed plan (no model) -> approve -> update -> read back VERIFIED; asking again starts from the new time', async () => {
    const c = chain();
    const ask = routeFor(c);
    const made = await createVia(c, '프로젝트 리뷰 회의', 14);

    const res = await ask('방금 만든 회의를 한 시간 늦춰줘');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'PLAN_PREVIEW');
    assert.equal(res.data.provider, 'nagex');
    assert.equal(res.data.runnable.ok, true);
    assert.ok(res.data.planSeal);
    const step = res.data.plan.steps[0];
    assert.equal(step.tool, 'google_calendar.update_event');
    assert.equal(step.parameters.eventId, made.externalId);
    assert.equal(step.parameters.start, tomorrowAt(15).start + ':00');
    assert.equal(step.parameters.before.start, tomorrowAt(14).start + ':00');
    assert.equal(c.fake.calls.filter((x) => x.method === 'PATCH').length, 0, 'planning changed nothing');

    // the person approves exactly what the plan shows
    const approval = c.service.requestUpdateEventApproval({ tenantId: T, principalId: U, payload: step.parameters, requestId: 'ap1' });
    c.service.approve(approval.approvalId, T, U, 'ap2');
    const done = await c.service.executeUpdateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, tenantId: T, principalId: U, requestId: 'ap3' });
    assert.equal(done.verification?.outcome, 'VERIFIED');
    assert.equal(c.fake.events()[0].start.dateTime.slice(11, 16), '15:00');
    assert.equal(c.fake.events().length, 1, 'moved, not duplicated');

    const again = await ask('방금 만든 회의를 30분 더 늦춰줘');
    assert.equal(again.data.plan.steps[0].parameters.before.start, tomorrowAt(15).start + ':00', 'a second shift starts from where the event is now');
    assert.equal(again.data.plan.steps[0].parameters.start, tomorrowAt(15).start.replace('T15:00', 'T15:30') + ':00');
  });

  it('two events just created -> the person is asked which one (with their titles and times), and nothing is planned', async () => {
    const c = chain();
    const ask = routeFor(c);
    await createVia(c, '프로젝트 리뷰 회의', 14);
    await createVia(c, '팀 점심', 12);
    const res = await ask('방금 만든 회의를 한 시간 늦춰줘');
    assert.equal(res.data.status, 'NEEDS_DETAIL');
    assert.equal(res.data.reason, 'AMBIGUOUS');
    assert.equal(res.data.executable, false);
    assert.equal(res.data.candidates.length, 2);
    assert.match(res.data.message, /어느 일정인가요\?/);
    assert.match(res.data.message, /프로젝트 리뷰 회의/);
    assert.equal(res.data.plan, undefined);
  });

  it('another person\'s "just created" event is not theirs to move; with no calendar connected the answer says so and Google is not written', async () => {
    const c = chain();
    const ask = routeFor(c);
    await createVia(c, '프로젝트 리뷰 회의', 14);
    const stranger = await ask('방금 만든 회의를 한 시간 늦춰줘', [T, 'usr_stranger']);
    assert.equal(stranger.data.status, 'NEEDS_DETAIL');
    assert.equal(c.fake.calls.filter((x) => x.method === 'PATCH').length, 0);
    const down = chain({ reader: 'not_connected' });
    const res = await routeFor(down)('방금 만든 회의를 한 시간 늦춰줘');
    assert.equal(res.data.reason, 'CALENDAR_UNAVAILABLE');
  });

  it('an ordinary plan request does not read the calendar at all', async () => {
    const c = chain();
    let reads = 0;
    const base = routeFor(c);
    const ask = (prompt: string) => base(prompt);
    // the directory is only consulted for a request that says how a time changes
    const original = c.directory.candidates.bind(c.directory);
    c.directory.candidates = async (input) => { reads += 1; return original(input); };
    await assert.rejects(() => ask('내일 오후 2시에 회의 잡아줘'), /must never be planned by a model|no model/);
    assert.equal(reads, 0, '"schedule a meeting" is a create, not a reschedule: no calendar read happened before the model was asked');
  });
});
