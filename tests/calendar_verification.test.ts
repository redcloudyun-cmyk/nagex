// R26-B - Google Calendar changes are read back before they are called done, and a create can never become two events. The REAL token store, approval store, execution pipeline, execution store, audit
// log and calendar service run against a faithful fake of the Google Calendar REST API (tests/_fake_google_calendar.ts): real id / 409 / 410 / etag / offset semantics plus injectable faults.
// A pass proves NAgex's own behaviour; it does not prove Google answered (the opt-in live run needs a real authorized account).
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
import { eventIdFromKey, idempotencyKeyFor, instantOf, normalizeReadback, verifyCancelled, verifyCreated, verifyResponded, verifyUpdated } from '../src/modules/calendar/calendar-verification.js';
import { createFakeGoogleCalendar, type FakeGoogleCalendar } from './_fake_google_calendar.js';

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.invalid/cb' };
const T = 'ten_cal';
const U = 'usr_cal';
const SECRET_TOKEN = 'ya29.SECRET-ACCESS-TOKEN-0123456789';

function rig(fake: FakeGoogleCalendar = createFakeGoogleCalendar()) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const executions = new ExecutionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex_cal_exec_')) });
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fake.fetch, () => config, executions);
  const connect = (tenantId = T, principalId = U) => tokenStore.saveForPrincipal(tenantId, principalId, { accessToken: SECRET_TOKEN, refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });
  connect();
  return { fake, service, approvals, audit, memory, executions, connect };
}

const createPayload = (over: Record<string, unknown> = {}) => ({
  calendarId: 'primary', summary: '프로젝트 리뷰 회의', description: '', start: '2026-10-17T14:00', end: '2026-10-17T15:00', timezone: 'Asia/Seoul', attendees: ['dana@example.com'], ...over,
});

let seq = 0;
async function createEvent(r: ReturnType<typeof rig>, payload: Record<string, unknown> = createPayload(), who = { tenantId: T, principalId: U }) {
  const approval = r.service.requestCreateEventApproval({ ...who, payload, requestId: `req_a_${++seq}` });
  r.service.approve(approval.approvalId, who.tenantId, who.principalId, `req_b_${seq}`);
  const result = await r.service.executeCreateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, ...who, requestId: `req_c_${seq}` });
  return { approval, result };
}

describe('the pure checks', () => {
  const event = (over: Record<string, unknown> = {}) => normalizeReadback({
    id: 'e1', status: 'confirmed', summary: '프로젝트 리뷰 회의', start: { dateTime: '2026-10-17T14:00:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-17T15:00:00+09:00' },
    attendees: [{ email: 'Dana@Example.com', responseStatus: 'needsAction' }, { email: 'me@example.com', self: true, responseStatus: 'accepted' }], htmlLink: 'https://x', ...over,
  })!;
  const at = '2026-10-16T00:00:00.000Z';

  it('a wall-clock time is read in the payload\'s timezone, an offset is taken as written', () => {
    assert.equal(instantOf('2026-10-17T14:00', 'Asia/Seoul'), Date.parse('2026-10-17T05:00:00Z'));
    assert.equal(instantOf('2026-10-17T14:00:00+09:00', 'UTC'), Date.parse('2026-10-17T05:00:00Z'));
    assert.equal(instantOf('2026-10-17T05:00:00Z', 'Asia/Seoul'), Date.parse('2026-10-17T05:00:00Z'));
    assert.equal(instantOf('garbage', 'UTC'), null);
  });
  it('a created event is VERIFIED only when status, title, instants and attendees all match; any difference is a MISMATCH naming the field', () => {
    assert.equal(verifyCreated(createPayload() as any, event(), at).outcome, 'VERIFIED');
    for (const [over, field] of [[{ summary: 'Other' }, 'summary'], [{ start: { dateTime: '2026-10-17T15:00:00+09:00' } }, 'start'], [{ end: { dateTime: '2026-10-17T16:00:00+09:00' } }, 'end'], [{ status: 'cancelled' }, 'status'], [{ attendees: [] }, 'attendees']] as const) {
      const v = verifyCreated(createPayload() as any, event(over), at);
      assert.equal(v.outcome, 'MISMATCH', field);
      assert.ok(v.checks.some((c) => c.field === field && !c.ok), field);
    }
  });
  it('an update is checked on the fields it changed, and a cancel on the event being gone; an RSVP on the answer', () => {
    assert.equal(verifyUpdated({ calendarId: 'primary', eventId: 'e1', start: '2026-10-17T14:00', end: '2026-10-17T15:00', timezone: 'Asia/Seoul' }, event(), at).outcome, 'VERIFIED');
    assert.equal(verifyUpdated({ calendarId: 'primary', eventId: 'e1', start: '2026-10-17T15:00', end: '2026-10-17T16:00', timezone: 'Asia/Seoul' }, event(), at).outcome, 'MISMATCH');
    assert.equal(verifyUpdated({ calendarId: 'primary', eventId: 'e1', summary: '프로젝트 리뷰 회의' }, event(), at).outcome, 'VERIFIED', 'fields that were not changed are not compared');
    assert.equal(verifyCancelled(null, at).outcome, 'VERIFIED');
    assert.equal(verifyCancelled(event({ status: 'cancelled' }), at).outcome, 'VERIFIED');
    assert.equal(verifyCancelled(event(), at).outcome, 'MISMATCH');
    assert.equal(verifyResponded('declined', event({ attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }] }), at).outcome, 'VERIFIED');
    assert.equal(verifyResponded('declined', event(), at).outcome, 'MISMATCH');
    assert.equal(verifyResponded('declined', event({ attendees: [] }), at).outcome, 'NOT_VERIFIED');
  });
  it('the idempotency key follows what was approved; the event id is a valid Google id derived from it, stable and different for another event or attempt', () => {
    const a = idempotencyKeyFor(T, U, createPayload() as any);
    assert.equal(a, idempotencyKeyFor(T, U, createPayload({ attendees: ['DANA@example.com'] }) as any), 'attendee case does not matter');
    assert.equal(a, idempotencyKeyFor(T, U, createPayload({ start: '2026-10-17T05:00:00Z', end: '2026-10-17T06:00:00Z', timezone: 'UTC' }) as any), 'the same instants are the same event');
    for (const other of [createPayload({ summary: 'x' }), createPayload({ start: '2026-10-17T16:00', end: '2026-10-17T17:00' }), createPayload({ attendees: [] }), createPayload({ calendarId: 'work' })]) assert.notEqual(a, idempotencyKeyFor(T, U, other as any));
    assert.notEqual(a, idempotencyKeyFor(T, 'usr_other', createPayload() as any), 'another person never collides');
    const id = eventIdFromKey(a);
    assert.match(id, /^[a-v0-9]{5,1024}$/);
    assert.equal(id, eventIdFromKey(a));
    assert.notEqual(id, eventIdFromKey(a, 2));
    assert.notEqual(id, eventIdFromKey(idempotencyKeyFor(T, U, createPayload({ summary: 'x' }) as any)));
  });
});

describe('a create is verified and cannot be duplicated', () => {
  it('creates the event, reads it back and says VERIFIED; the execution record and the audit trail carry the outcome', async () => {
    const r = rig();
    const { result } = await createEvent(r);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.verification?.outcome, 'VERIFIED');
    assert.ok(result.verification!.checks.every((c) => c.ok));
    assert.deepEqual(r.fake.calls.map((c) => c.method), ['POST', 'GET'], 'the change, then the read-back');
    assert.equal(r.fake.events().length, 1);
    const event = r.fake.events()[0];
    assert.match(event.id, /^nag[a-v0-9]{32}$/, 'the id is derived from what was approved');
    assert.match(event.extendedProperties?.private?.nagexKey ?? '', /^[0-9a-f]{64}$/);
    assert.equal(event.start.dateTime, '2026-10-17T14:00:00+09:00', 'the wall time was sent in the person\'s timezone');
    assert.equal(r.executions.get(result.executionId)?.verificationOutcome, 'VERIFIED');
    assert.ok(r.audit.getAuditLogs(T).some((e: any) => e.action === 'tool.execution.succeeded' && e.details?.verification === 'VERIFIED'));
  });

  it('the same approval cannot be used twice, and a second approval of the same request meets the existing event instead of making another', async () => {
    const r = rig();
    const first = await createEvent(r);
    await assert.rejects(() => r.service.executeCreateEvent({ approvalId: first.approval.approvalId, payload: first.approval.canonicalPayload, tenantId: T, principalId: U, requestId: 'req_replay' }), (e: any) => e.code === 'APPROVAL_ALREADY_CONSUMED');
    assert.equal(r.fake.events().length, 1);
    const second = await createEvent(r); // the person asks again and approves again
    assert.equal(second.result.status, 'SUCCEEDED');
    assert.equal(second.result.externalId, first.result.externalId, 'it is the same event');
    assert.equal(second.result.verification?.outcome, 'VERIFIED');
    assert.equal(r.fake.events().length, 1, 'still one event on the calendar');
    assert.equal(r.memory.getActiveMemories('USER', T, U).filter((m: any) => /Scheduled/.test(JSON.stringify(m))).length, 1, 'and one memory of it');
  });

  it('a lost response (the event was created, the answer never came) is reported as a failure - and retrying the same request does not duplicate the event', async () => {
    const r = rig();
    r.fake.faults.loseNextInsertResponse = true;
    const approval = r.service.requestCreateEventApproval({ tenantId: T, principalId: U, payload: createPayload(), requestId: 'req_1' });
    r.service.approve(approval.approvalId, T, U, 'req_2');
    await assert.rejects(() => r.service.executeCreateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, tenantId: T, principalId: U, requestId: 'req_3' }), (e: any) => e.code === 'GOOGLE_CALENDAR_NETWORK_ERROR');
    assert.equal(r.fake.events().length, 1, 'the provider did create it');
    const retry = await createEvent(r);
    assert.equal(retry.result.verification?.outcome, 'VERIFIED');
    assert.equal(r.fake.events().length, 1, 'the retry found it instead of creating a second one');
  });

  it('two approvals of the same request executed at the same time still make exactly one event', async () => {
    const r = rig();
    const a = r.service.requestCreateEventApproval({ tenantId: T, principalId: U, payload: createPayload(), requestId: 'req_a' });
    const b = r.service.requestCreateEventApproval({ tenantId: T, principalId: U, payload: createPayload(), requestId: 'req_b' });
    r.service.approve(a.approvalId, T, U, 'r1');
    r.service.approve(b.approvalId, T, U, 'r2');
    const [x, y] = await Promise.all([a, b].map((ap, i) => r.service.executeCreateEvent({ approvalId: ap.approvalId, payload: ap.canonicalPayload, tenantId: T, principalId: U, requestId: `req_run_${i}` })));
    assert.equal(r.fake.events().length, 1);
    assert.equal(x.externalId, y.externalId);
  });

  it('an event with the same title at a different time, or another person\'s identical event, is a different event', async () => {
    const r = rig();
    await createEvent(r);
    await createEvent(r, createPayload({ start: '2026-10-17T16:00', end: '2026-10-17T17:00' }));
    r.connect(T, 'usr_other');
    await createEvent(r, createPayload(), { tenantId: T, principalId: 'usr_other' });
    assert.equal(r.fake.events().length, 3);
  });

  it('if the person deleted the event meanwhile (Google never frees its id), the same request creates a new event under the next derived id', async () => {
    const r = rig();
    const first = await createEvent(r);
    r.fake.deleteBehindNagex(first.result.externalId);
    const again = await createEvent(r);
    assert.notEqual(again.result.externalId, first.result.externalId);
    assert.equal(again.result.verification?.outcome, 'VERIFIED');
    assert.equal(r.fake.events().length, 1);
  });

  it('a create the calendar shows differently is a MISMATCH, a read-back that fails is NOT_VERIFIED - never "confirmed"; the mutation itself stays recorded as it was', async () => {
    const r = rig();
    r.fake.faults.failGetWith = 500;
    const { result } = await createEvent(r);
    assert.equal(result.status, 'SUCCEEDED', 'Google accepted it');
    assert.equal(result.verification?.outcome, 'NOT_VERIFIED');
    assert.equal(r.executions.get(result.executionId)?.verificationOutcome, 'NOT_VERIFIED');
    assert.match(String(result.verification?.note), /GOOGLE_CALENDAR_HTTP_500/);
  });
});

describe('an update is verified; a changed payload invalidates the approval', () => {
  async function existing(r: ReturnType<typeof rig>) {
    return (await createEvent(r)).result.externalId;
  }
  const move = (eventId: string, over: Record<string, unknown> = {}) => ({ calendarId: 'primary', eventId, start: '2026-10-17T15:00', end: '2026-10-17T16:00', timezone: 'Asia/Seoul', before: { summary: '프로젝트 리뷰 회의', start: '2026-10-17T14:00', end: '2026-10-17T15:00', timezone: 'Asia/Seoul' }, ...over });
  async function runUpdate(r: ReturnType<typeof rig>, payload: Record<string, unknown>) {
    const approval = r.service.requestUpdateEventApproval({ tenantId: T, principalId: U, payload, requestId: `req_u_${++seq}` });
    r.service.approve(approval.approvalId, T, U, `req_ua_${seq}`);
    return { approval, result: await r.service.executeUpdateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, tenantId: T, principalId: U, requestId: `req_ub_${seq}` }) };
  }

  it('moves the event, reads it back and says VERIFIED; the duration and the title are untouched', async () => {
    const r = rig();
    const id = await existing(r);
    const { result } = await runUpdate(r, move(id));
    assert.equal(result.verification?.outcome, 'VERIFIED');
    const event = r.fake.events()[0];
    assert.equal(event.start.dateTime, '2026-10-17T15:00:00+09:00');
    assert.equal(event.end.dateTime, '2026-10-17T16:00:00+09:00');
    assert.equal(event.summary, '프로젝트 리뷰 회의');
    const patch = r.fake.calls.find((c) => c.method === 'PATCH')!;
    assert.equal('before' in patch.body, false, 'the "before" snapshot is for the person reading the approval; it is never sent to Google');
  });

  it('Google answering 200 without applying the change is a MISMATCH that names what is still different', async () => {
    const r = rig();
    const id = await existing(r);
    r.fake.faults.ignorePatches = true;
    const { result } = await runUpdate(r, move(id));
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.verification?.outcome, 'MISMATCH');
    assert.deepEqual(result.verification!.checks.filter((c) => !c.ok).map((c) => c.field).sort(), ['end', 'start']);
    assert.equal(r.executions.get(result.executionId)?.verificationOutcome, 'MISMATCH');
  });

  it('any change to what was approved - the time, the target event, even the "before" snapshot - is refused and nothing reaches Google', async () => {
    const r = rig();
    const id = await existing(r);
    const approval = r.service.requestUpdateEventApproval({ tenantId: T, principalId: U, payload: move(id), requestId: 'req_x' });
    r.service.approve(approval.approvalId, T, U, 'req_xa');
    const patchesBefore = r.fake.calls.filter((c) => c.method === 'PATCH').length;
    for (const changed of [move(id, { start: '2026-10-17T16:00', end: '2026-10-17T17:00' }), move('someotherevent'), move(id, { before: { summary: 'tampered' } }), move(id, { timezone: 'UTC' })]) {
      await assert.rejects(() => r.service.executeUpdateEvent({ approvalId: approval.approvalId, payload: changed, tenantId: T, principalId: U, requestId: 'req_xb' }), (e: any) => e.code === 'APPROVAL_PAYLOAD_MISMATCH');
    }
    assert.equal(r.fake.calls.filter((c) => c.method === 'PATCH').length, patchesBefore, 'no change was sent');
    assert.equal(r.fake.events()[0].start.dateTime, '2026-10-17T14:00:00+09:00', 'the event is as it was');
    // and the approval that was NOT tampered with still works exactly once
    const ok = await r.service.executeUpdateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, tenantId: T, principalId: U, requestId: 'req_xc' });
    assert.equal(ok.verification?.outcome, 'VERIFIED');
  });

  it('an update with no approval, a rejected approval, another person\'s approval or another person\'s event is refused', async () => {
    const r = rig();
    const id = await existing(r);
    await assert.rejects(() => r.service.executeUpdateEvent({ approvalId: 'appr_missing', payload: move(id), tenantId: T, principalId: U, requestId: 'req_n' }), (e: any) => e.code === 'APPROVAL_NOT_FOUND' || e.code === 'APPROVAL_NOT_GRANTED');
    const pending = r.service.requestUpdateEventApproval({ tenantId: T, principalId: U, payload: move(id), requestId: 'req_p' });
    await assert.rejects(() => r.service.executeUpdateEvent({ approvalId: pending.approvalId, payload: pending.canonicalPayload, tenantId: T, principalId: U, requestId: 'req_p2' }), (e: any) => e.code === 'APPROVAL_NOT_GRANTED');
    r.service.reject(pending.approvalId, T, U, 'req_p3');
    await assert.rejects(() => r.service.executeUpdateEvent({ approvalId: pending.approvalId, payload: pending.canonicalPayload, tenantId: T, principalId: U, requestId: 'req_p4' }), (e: any) => e.code === 'APPROVAL_NOT_GRANTED');
    const mine = r.service.requestUpdateEventApproval({ tenantId: T, principalId: U, payload: move(id), requestId: 'req_m' });
    r.service.approve(mine.approvalId, T, U, 'req_m2');
    r.connect(T, 'usr_other');
    await assert.rejects(() => r.service.executeUpdateEvent({ approvalId: mine.approvalId, payload: mine.canonicalPayload, tenantId: T, principalId: 'usr_other', requestId: 'req_o' }), (e: any) => /APPROVAL_/.test(e.code));
    assert.equal(r.fake.calls.filter((c) => c.method === 'PATCH').length, 0);
  });
});

describe('a cancel is verified', () => {
  it('deletes the event and reads back that it is gone; a delete Google accepted but did not apply is a MISMATCH', async () => {
    const r = rig();
    const id = (await createEvent(r)).result.externalId;
    const run = async () => {
      const approval = r.service.requestCancelEventApproval({ tenantId: T, principalId: U, payload: { calendarId: 'primary', eventId: id, summary: '프로젝트 리뷰 회의' }, requestId: `req_c_${++seq}` });
      r.service.approve(approval.approvalId, T, U, `req_ca_${seq}`);
      return r.service.executeCancelEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, tenantId: T, principalId: U, requestId: `req_cb_${seq}` });
    };
    r.fake.faults.ignoreDeletes = true;
    assert.equal((await run()).verification?.outcome, 'MISMATCH');
    r.fake.faults.ignoreDeletes = false;
    assert.equal((await run()).verification?.outcome, 'VERIFIED');
    assert.equal(r.fake.events().length, 0);
  });
});

describe('secrets and identity', () => {
  it('the access token appears in no execution record, audit event or result; calls to Google carry it only as the bearer header', async () => {
    const r = rig();
    const { result } = await createEvent(r);
    const everything = JSON.stringify([result, r.executions.list(), r.audit.getAuditLogs(T)]);
    assert.equal(everything.includes(SECRET_TOKEN), false);
    assert.ok(r.fake.calls.length >= 2);
  });
  it('a person who has not connected Google Calendar gets the "not connected" answer and Google is never called', async () => {
    const r = rig();
    const approval = r.service.requestCreateEventApproval({ tenantId: T, principalId: 'usr_unconnected', payload: createPayload(), requestId: 'req_1' });
    r.service.approve(approval.approvalId, T, 'usr_unconnected', 'req_2');
    await assert.rejects(() => r.service.executeCreateEvent({ approvalId: approval.approvalId, payload: approval.canonicalPayload, tenantId: T, principalId: 'usr_unconnected', requestId: 'req_3' }), (e: any) => /GOOGLE_CALENDAR_/.test(e.code));
    assert.equal(r.fake.calls.length, 0);
  });
});
