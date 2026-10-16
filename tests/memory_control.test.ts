// R26-C - "내가 기억하라고 했던 내용을 보여주고, 오래된 내용을 수정해줘." Found on 971c9b3: the "What NAgex Knows" screen edited a memory IN PLACE (window.prompt -> PATCH): the old text was gone, no history existed
// in the UI, a statement that had ended ("금요일까지 출장 중") stayed current forever, and nothing could be restored. Now a correction is a NEW current memory with the old one kept (linked both ways, provenance and
// sensitivity intact, restorable); a statement that explicitly ends is EXPIRED after its end (kept, never recalled as current); everything is the owner's alone. Real MemoryEngine (file-backed, isolated dir),
// real PersonalContextService, real route handler; no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { NagexError } from '../src/common/errors.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ConversationMemoryExtractor } from '../src/context/conversation-memory-extractor.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { inferMemoryExpiry } from '../src/context/memory-expiry.js';
import { PersonalContextService } from '../src/context/personal-context.service.js';
import { handleMemoryRoutes } from '../src/http/routes/memory.routes.js';

const NOW = Date.parse('2026-10-16T01:00:00Z'); // Friday 2026-10-16 10:00 in Seoul
const T = 'ten_mc';
const U = 'usr_mc';

function engine(clock: { now: number } = { now: NOW }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex_mc_'))) {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex_mcs_'));
  return { dir, settingsDir, clock, engine: new MemoryEngine({ dir, settingsDir, now: () => clock.now }) };
}

const remember = (e: MemoryEngine, value: string, who = { tenantId: T, ownerId: U }) => {
  const proposed = e.proposeMemory('PERSONAL', who.tenantId, who.ownerId, { subject: 'User Preference', predicate: 'preference', value }, undefined, { type: 'PREFERENCE', userConfirmed: true, distinctFact: true, provenance: { sourceType: 'CONVERSATION', extractedAt: new Date(NOW).toISOString(), extractor: 'USER_EXPLICIT' } });
  return proposed;
};

describe('which statements bound themselves in time', () => {
  const infer = (text: string) => inferMemoryExpiry(text, NOW, 'Asia/Seoul');
  it('an explicit end date or duration is an end; a preference, a recurring rule or a past date is not', () => {
    assert.equal(infer('다음 주 금요일까지 부산 출장 중이야 기억해줘')?.expiresAt, '2026-10-23T14:59:59.999Z', 'the end of that day in the person\'s timezone');
    assert.equal(infer('내일까지 감기라서 쉬어')?.expiresAt, '2026-10-17T14:59:59.999Z');
    assert.equal(infer('12월 25일까지 휴가야')?.expiresAt, '2026-12-25T14:59:59.999Z');
    assert.equal(infer('3일 동안 출장이야')?.expiresAt, '2026-10-19T01:00:00.000Z');
    assert.equal(infer('I am in Busan until next Friday')?.expiresAt, '2026-10-23T14:59:59.999Z');
    assert.equal(infer('for the next 2 weeks I work remotely')?.expiresAt, '2026-10-30T01:00:00.000Z');
    for (const text of ['나는 커피를 좋아해', '어제까지 바빴어', '매주 금요일까지 보고해야 해', '', 'I like green tea']) assert.equal(infer(text), null, text);
  });
});

describe('a correction is a new current memory; the old one is kept', () => {
  it('the new text is current and confirmed by the person; the old is SUPERSEDED, linked both ways, with its provenance and sensitivity intact', () => {
    const { engine: e } = engine();
    const old = remember(e, '나는 커피를 좋아한다');
    const { current, previous } = e.correctMemory(old.id, T, U, { value: '나는 이제 차를 즐겨 마신다' });
    assert.deepEqual([current.lifecycle, current.userConfirmed, current.memoryOrigin, current.supersedes], ['ACTIVE', true, 'EXPLICIT_USER', old.id]);
    assert.deepEqual([current.provenance?.extractor, current.provenance?.sourceType], ['USER_EXPLICIT', 'MANUAL']);
    assert.match(String(current.sourceRef), /^correction_of:mem_/);
    assert.deepEqual([previous.lifecycle, previous.supersededBy], ['SUPERSEDED', current.id]);
    assert.equal(previous.content.value, '나는 커피를 좋아한다', 'the old text is untouched');
    assert.equal(previous.provenance?.extractor, 'USER_EXPLICIT');
    assert.equal(previous.sensitivity, old.sensitivity);
    assert.deepEqual(e.listMemories(T, U).map((m) => m.id), [current.id], 'only the current one is listed as a memory');
  });

  it('a correction can never lower the sensitivity, never stores a secret, and leaves the memory as it was when it is refused', () => {
    const { engine: e } = engine();
    const s2 = e.proposeMemory('PERSONAL', T, U, { subject: 'Health', predicate: 'note', value: '혈압약을 먹고 있다' }, undefined, { type: 'FACT', userConfirmed: true, sensitivity: 'S2' });
    e.confirmMemory(s2.id, T, U);
    const { current } = e.correctMemory(s2.id, T, U, { value: '혈압약을 먹고 있고 운동을 시작했다' });
    assert.equal(current.sensitivity, 'S2', 'the classification is kept');
    const target = remember(e, '나는 아침형 인간이다');
    for (const secret of ['내 비밀번호는 hunter2 야', 'my password is hunter2']) {
      assert.throws(() => e.correctMemory(target.id, T, U, { value: secret }), (err: any) => err instanceof NagexError && err.code === 'SECRET_MEMORY_REJECTED', secret);
    }
    assert.equal(e.get(target.id, T, U)?.lifecycle, 'ACTIVE');
    assert.equal(e.get(target.id, T, U)?.content.value, '나는 아침형 인간이다');
    assert.equal(e.listMemories(T, U).some((m) => /hunter2/.test(JSON.stringify(m))), false);
  });

  it('refuses an unchanged, empty or oversized correction, a memory that is not current, and a bad end date', () => {
    const { engine: e } = engine();
    const m = remember(e, '나는 아침형 인간이다');
    const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (err: any) { return err.code; } };
    assert.equal(code(() => e.correctMemory(m.id, T, U, { value: '나는   아침형 인간이다' })), 'MEMORY_UNCHANGED');
    assert.equal(code(() => e.correctMemory(m.id, T, U, { value: '   ' })), 'MEMORY_VALUE_INVALID');
    assert.equal(code(() => e.correctMemory(m.id, T, U, { value: 'x'.repeat(2001) })), 'MEMORY_VALUE_INVALID');
    assert.equal(code(() => e.correctMemory(m.id, T, U, { value: '새 내용', expiresAt: new Date(NOW - 1000).toISOString() })), 'MEMORY_EXPIRY_INVALID');
    assert.equal(code(() => e.correctMemory(m.id, T, U, { value: '새 내용', expiresAt: new Date(NOW + 6 * 365 * 24 * 3600_000).toISOString() })), 'MEMORY_EXPIRY_INVALID');
    const { previous } = e.correctMemory(m.id, T, U, { value: '나는 저녁형 인간이다' });
    assert.equal(code(() => e.correctMemory(previous.id, T, U, { value: '또 다른 내용' })), 'MEMORY_NOT_ACTIVE', 'a replaced memory is restored, not corrected');
    const proposed = e.proposeMemory('PERSONAL', T, U, { subject: 'x', predicate: 'y', value: '제안된 내용' }, undefined, { type: 'FACT' });
    assert.equal(proposed.lifecycle, 'PROPOSED');
    assert.equal(code(() => e.correctMemory(proposed.id, T, U, { value: '고친 내용' })), 'MEMORY_NOT_ACTIVE');
  });

  it('only the owner: another person or tenant gets "not found" - nothing is read, changed or restored', () => {
    const { engine: e } = engine();
    const m = remember(e, '나는 아침형 인간이다');
    const { previous } = e.correctMemory(m.id, T, U, { value: '나는 저녁형 인간이다' });
    for (const [tenant, owner] of [[T, 'usr_other'], ['ten_other', U]] as const) {
      for (const fn of [() => e.correctMemory(m.id, tenant, owner, { value: '남의 메모리 수정' }), () => e.restoreSuperseded(previous.id, tenant, owner), () => e.getSupersessionChain(m.id, tenant, owner)]) {
        assert.throws(fn, (err: any) => err.code === 'MEMORY_NOT_FOUND');
      }
      assert.deepEqual(e.history(tenant, owner), { groups: [], expired: [] });
    }
    assert.equal(e.get(previous.id, T, U)?.lifecycle, 'SUPERSEDED', 'the owner\'s history is untouched');
  });
});

describe('what is recalled as current', () => {
  it('after a correction only the new fact is recalled; after a restore only the restored one - an old memory never silently overrides a confirmed newer fact', () => {
    const { engine: e } = engine();
    const context = new PersonalContextService(e);
    const old = remember(e, '나는 커피를 좋아한다');
    const recalled = () => context.getRelevantMemories(T, U, '커피 차를').map((m) => String(m.content.value));
    assert.deepEqual(recalled(), ['나는 커피를 좋아한다']);
    const { current, previous } = e.correctMemory(old.id, T, U, { value: '나는 이제 차를 즐겨 마신다' });
    assert.deepEqual(recalled(), ['나는 이제 차를 즐겨 마신다']);
    e.restoreSuperseded(previous.id, T, U);
    assert.deepEqual(recalled(), ['나는 커피를 좋아한다'], 'the person chose the older one again');
    // the history of a restored memory is still reachable from it (the forward link is cleared on restore; the successor is found by its own backward link)
    assert.deepEqual(e.getSupersessionChain(old.id, T, U).map((m) => m.id), [old.id, current.id]);
    assert.deepEqual(e.history(T, U).groups[0].versions.map((v) => [v.id === old.id, v.current]), [[true, true], [false, false]]);
    assert.equal(e.get(current.id, T, U)?.lifecycle, 'SUPERSEDED');
    assert.equal(e.get(old.id, T, U)?.supersededBy, undefined);
  });

  it('a statement that explicitly ended is EXPIRED: kept, never recalled as current, and one explicit act brings it back', () => {
    const clock = { now: NOW };
    const { engine: e, dir, settingsDir } = engine(clock);
    const context = new PersonalContextService(e);
    const trip = e.proposeMemory('PERSONAL', T, U, { subject: 'Status', predicate: 'status', value: '다음 주 금요일까지 부산 출장 중' }, undefined, { type: 'WORKING_CONTEXT', userConfirmed: true, expiresAt: '2026-10-23T14:59:59.999Z' });
    const forever = remember(e, '나는 커피를 좋아한다');
    assert.equal(context.getRelevantMemories(T, U, '출장 커피').length >= 1, true);
    clock.now = Date.parse('2026-10-24T00:00:00Z');
    const after = context.getRelevantMemories(T, U, '출장 커피').map((m) => m.id);
    assert.equal(after.includes(trip.id), false, 'no longer current');
    assert.equal(after.includes(forever.id), true, 'a memory with no end is untouched');
    const stored = e.get(trip.id, T, U)!;
    assert.deepEqual([stored.lifecycle, typeof stored.expiredAt], ['EXPIRED', 'string']);
    assert.equal(stored.content.value, '다음 주 금요일까지 부산 출장 중', 'kept as it was written');
    assert.deepEqual(e.history(T, U).expired.map((v) => v.id), [trip.id]);
    // it survives a restart in the same state
    const reopened = new MemoryEngine({ dir, settingsDir, now: () => clock.now });
    assert.equal(reopened.get(trip.id, T, U)?.lifecycle, 'EXPIRED');
    // the person keeps it again - with a new end or none
    const renewed = e.renewExpired(trip.id, T, U, new Date(Date.parse('2026-11-30T00:00:00Z')).toISOString());
    assert.deepEqual([renewed.lifecycle, renewed.expiresAt, renewed.expiredAt], ['ACTIVE', '2026-11-30T00:00:00.000Z', undefined]);
    assert.throws(() => e.renewExpired(forever.id, T, U), (err: any) => err.code === 'MEMORY_NOT_EXPIRED');
    assert.throws(() => e.renewExpired(trip.id, 'ten_other', U), (err: any) => err.code === 'MEMORY_NOT_FOUND');
  });

  it('the history lists every corrected fact (oldest first, the current one flagged) and the expired ones - only the owner\'s', () => {
    const { engine: e } = engine();
    const a = remember(e, 'v1');
    const b = e.correctMemory(a.id, T, U, { value: 'v2' }).current;
    const c = e.correctMemory(b.id, T, U, { value: 'v3', expiresAt: new Date(NOW + 86_400_000).toISOString() }).current;
    remember(e, '수정한 적 없는 메모리');
    const { groups, expired } = e.history(T, U);
    assert.equal(groups.length, 1, 'a memory that was never corrected has no history');
    assert.deepEqual(groups[0].versions.map((v) => [v.value, v.lifecycle, v.current]), [['v1', 'SUPERSEDED', false], ['v2', 'SUPERSEDED', false], ['v3', 'ACTIVE', true]]);
    assert.equal(groups[0].versions[2].expiresAt, new Date(NOW + 86_400_000).toISOString());
    assert.equal(groups[0].versions[0].extractor, 'USER_EXPLICIT');
    assert.deepEqual(expired, []);
    assert.equal(e.get(c.id, T, U)!.supersedes, b.id);
  });
});

describe('secrets are never stored as memory - said in English or Korean', () => {
  // Found while testing corrections: "my password is hunter2", "password: hunter2", an API key in a sentence and a PIN were all classified S1 (ordinary memory), so they were stored and could be recalled
  // into model prompts. The credential must look like one (a digit or a symbol in it), so "the password is required" is still an ordinary sentence.
  it('a credential in a sentence is S3: refused as a memory and as a correction; ordinary talk about passwords is not', () => {
    const { engine: e } = engine();
    for (const secret of ['my password is hunter2', 'password: hunter2', '내 비밀번호는 hunter2 야', 'the api key is sk-abc123xyz', 'my pin is 4821', 'Our API key = a1b2c3d4e5', 'auth token: abc123def']) {
      assert.throws(() => e.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: secret }, undefined, { type: 'FACT', userConfirmed: true }), (err: any) => err.code === 'SECRET_MEMORY_REJECTED', secret);
    }
    for (const fine of ['the password is required to log in', 'I forgot my password', 'password managers are great', 'my pin number is on the card', 'update the api key rotation policy', 'access token expires after an hour']) {
      assert.doesNotThrow(() => e.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: fine }, undefined, { type: 'FACT', userConfirmed: true, distinctFact: true }), fine);
    }
    assert.equal(e.listMemories(T, U).some((m) => /hunter2|sk-abc|4821|a1b2c3d4e5|abc123def/.test(JSON.stringify(m))), false);
  });
  it('said in a conversation ("기억해줘"), a secret is not captured', () => {
    const { engine: e } = engine();
    const extractor = new ConversationMemoryExtractor(e);
    for (const text of ['my password is hunter2 remember this', '내 비밀번호는 hunter2 야 기억해줘']) {
      const created = extractor.processMessage({ tenantId: T, principalId: U, content: text, nowMs: NOW, timezone: 'Asia/Seoul' });
      assert.equal(created.length, 0, text);
    }
    assert.deepEqual(e.listMemories(T, U), []);
  });
});

describe('time-bound statements in a conversation', () => {
  it('"다음 주 금요일까지 부산 출장 중이야 기억해줘" is remembered with its end; a plain preference never expires', () => {
    const { engine: e } = engine();
    const extractor = new ConversationMemoryExtractor(e);
    const created = extractor.processMessage({ tenantId: T, principalId: U, content: '다음 주 금요일까지 부산 출장 중이야 기억해줘', nowMs: NOW, timezone: 'Asia/Seoul' });
    assert.equal(created.length, 1);
    assert.equal(created[0].expiresAt, '2026-10-23T14:59:59.999Z');
    const plain = extractor.processMessage({ tenantId: T, principalId: U, content: '나는 아침에 커피를 마셔 기억해줘', nowMs: NOW, timezone: 'Asia/Seoul' });
    assert.equal(plain[0].expiresAt, undefined);
  });
});

describe('the routes', () => {
  const statusOf = (error: unknown) => {
    const category = (error as NagexError).category;
    // the same shape as the server's modelErrorResult: { error: { code, category, message, request_id } }
    return { status: category === 'NOT_FOUND' ? 404 : category === 'CONFLICT' ? 409 : category === 'VALIDATION' ? 400 : category === 'POLICY' ? 403 : 500, data: (error as NagexError).toJSON() };
  };
  function call(e: MemoryEngine, who: { tenantId: string; id: string }, method: string, pathname: string, body: any = null, extra: Record<string, unknown> = {}) {
    return handleMemoryRoutes(method as any, pathname, body, {}, {}, { memoryEngine: e, pinnedMemories: new Set<string>(), tenantId: who.tenantId, principal: { type: 'user', id: who.id } as any, modelErrorResult: statusOf as any, ...extra } as any) as any;
  }
  const me = { tenantId: T, id: U };

  it('the history, correction and restoration for the signed-in owner; nothing from another person; ids only in the audit trail', () => {
    const { engine: e } = engine();
    const audit = new AuditLogger();
    const old = remember(e, '나는 커피를 좋아한다');
    const corrected = call(e, me, 'POST', `/api/v1/memory/${old.id}/correct`, { value: '나는 이제 차를 즐겨 마신다', expiresOn: '2026-10-30', timezone: 'Asia/Seoul' }, { auditLogger: audit });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.current.content.value, '나는 이제 차를 즐겨 마신다');
    assert.equal(corrected.data.current.expiresAt, '2026-10-30T14:59:59.999Z', 'a day ends at the end of that day in the person\'s timezone');
    assert.equal(corrected.data.previous.lifecycle, 'SUPERSEDED');

    const history = call(e, me, 'GET', '/api/v1/memory/history');
    assert.equal(history.status, 200);
    assert.equal(history.data.groups[0].versions.length, 2);
    const list = call(e, me, 'GET', '/api/v1/memory');
    assert.deepEqual(list.data.memories.map((m: any) => [m.id, m.hasHistory]), [[corrected.data.current.id, true]]);

    const restored = call(e, me, 'POST', `/api/v1/memory/${old.id}/restore`, {}, { auditLogger: audit });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.restored.lifecycle, 'ACTIVE');
    assert.equal(call(e, me, 'GET', '/api/v1/memory').data.memories[0].content.value, '나는 커피를 좋아한다');

    const events = audit.getAuditLogs(T);
    assert.deepEqual(events.map((x) => x.action), ['memory.corrected', 'memory.restored']);
    assert.equal(JSON.stringify(events).includes('커피'), false, 'the audit trail never carries the text of a memory');
    assert.equal(JSON.stringify(events).includes('차를'), false);
  });

  it('a correction that names its own end ("금요일까지") is time-bound; bad input is refused; a secret is refused with the memory unchanged', () => {
    const { engine: e } = engine();
    const m = remember(e, '나는 아침형 인간이다');
    const inferred = call(e, me, 'POST', `/api/v1/memory/${m.id}/correct`, { value: '다음 주 금요일까지 재택근무 중', timezone: 'Asia/Seoul' });
    assert.equal(inferred.status, 200);
    assert.ok(inferred.data.current.expiresAt, 'the end is read from the text');
    assert.match(String(inferred.data.expiryInferredFrom), /까지/);
    const m2 = remember(e, '나는 저녁에 운동한다');
    assert.equal(call(e, me, 'POST', `/api/v1/memory/${m2.id}/correct`, { value: '' }).status, 400);
    assert.equal(call(e, me, 'POST', `/api/v1/memory/${m2.id}/correct`, { value: '새 내용', expiresOn: 'tomorrow' }).status, 400);
    assert.equal(call(e, me, 'POST', `/api/v1/memory/${m2.id}/correct`, { value: '새 내용', expiresOn: '2020-01-01', timezone: 'Asia/Seoul' }).status, 400);
    const secret = call(e, me, 'POST', `/api/v1/memory/${m2.id}/correct`, { value: '내 비밀번호는 hunter2 야' });
    assert.deepEqual([secret.status, secret.data.error.code], [403, 'SECRET_MEMORY_REJECTED']);
    assert.equal(call(e, me, 'GET', `/api/v1/memory/${m2.id}`).data.content.value, '나는 저녁에 운동한다');
  });

  it('another person or tenant: the history is empty, and correcting or restoring someone else\'s memory is "not found"', () => {
    const { engine: e } = engine();
    const m = remember(e, '나는 아침형 인간이다');
    const { previous } = e.correctMemory(m.id, T, U, { value: '나는 저녁형 인간이다' });
    for (const stranger of [{ tenantId: T, id: 'usr_other' }, { tenantId: 'ten_other', id: U }]) {
      assert.deepEqual(call(e, stranger, 'GET', '/api/v1/memory/history').data, { groups: [], expired: [] });
      assert.equal(call(e, stranger, 'POST', `/api/v1/memory/${m.id}/correct`, { value: '남의 것' }).status, 404);
      assert.equal(call(e, stranger, 'POST', `/api/v1/memory/${previous.id}/restore`, {}).status, 404);
    }
    assert.equal(e.get(previous.id, T, U)?.lifecycle, 'SUPERSEDED');
    assert.equal(call(e, me, 'POST', '/api/v1/memory/no_such_memory/restore', {}).status, 404);
  });

  it('restoring something that is neither replaced nor expired is a conflict, not a silent no-op; the pin moves to the corrected memory', () => {
    const { engine: e } = engine();
    const m = remember(e, '나는 아침형 인간이다');
    assert.equal(call(e, me, 'POST', `/api/v1/memory/${m.id}/restore`, {}).status, 409);
    const pins = new Set<string>([m.id]);
    const res = handleMemoryRoutes('POST' as any, `/api/v1/memory/${m.id}/correct`, { value: '나는 저녁형 인간이다' }, {}, {}, { memoryEngine: e, pinnedMemories: pins, tenantId: T, principal: { type: 'user', id: U } as any, modelErrorResult: statusOf as any } as any) as any;
    assert.equal(res.status, 200);
    assert.deepEqual([...pins], [res.data.current.id]);
    assert.equal(res.data.current.pinned, true);
  });
});
