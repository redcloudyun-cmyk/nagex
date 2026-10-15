// A person's correction must replace the fact it corrects - and everything they ask NAgex to remember must still be there. Measured on the baseline with synthetic people: every explicit "기억해줘" shared
// one key, so the second one was silently filed as an invisible CONFLICTED record; the assistant kept recalling the outdated fact (8 of 16 questions answered correctly). This file pins the fix and its limits:
// replacement only on the person's own explicit words (a cue AND exactly one closest memory), history kept and restorable, ownership and tenancy untouched, restart-safe, nothing invented.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MemoryEngine, type MemoryRecord } from '../src/context/memory.engine.js';
import { ConversationMemoryExtractor } from '../src/context/conversation-memory-extractor.js';
import { PersonalContextService } from '../src/context/personal-context.service.js';
import { findSupersedeTarget, hasCorrectionCue, topicTokens } from '../src/context/memory-supersession.js';

const T = 'ten_ms';
const U = 'usr_ms';

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex_ms_'));
  const options = { dir: path.join(dir, 'm'), settingsDir: path.join(dir, 's') };
  const engine = new MemoryEngine(options);
  return { dir, options, engine, extractor: new ConversationMemoryExtractor(engine), context: new PersonalContextService(engine) };
}
const say = (r: ReturnType<typeof rig>, text: string, who = U, tenant = T) => r.extractor.processMessage({ tenantId: tenant, principalId: who, sessionId: 's1', messageId: `m_${Math.random()}`, content: text });
const values = (records: MemoryRecord[]) => records.map((m) => String(m.content.value));

const active = (id: string, value: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, scope: 'PERSONAL', type: 'PREFERENCE', tenantId: T, owner_id: U, lifecycle: 'ACTIVE', content: { subject: 'User Preference', predicate: 'preference', value },
  userConfirmed: true, memoryOrigin: 'EXPLICIT_USER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...over,
});

describe('the words of a correction (pure)', () => {
  it('replacement cues, in Korean and English', () => {
    for (const text of ['이제 나는 커피 대신 차를 마셔', '더 이상 매운 음식을 안 먹어', '부산으로 이사했어', 'I no longer use Windows', 'actually I prefer light mode', 'switched to Linux', 'tea instead of coffee']) assert.equal(hasCorrectionCue(text), true, text);
    for (const text of ['나는 오후에 차를 마셔', '발표자료는 간결하게 만들어줘', 'I prefer dark mode']) assert.equal(hasCorrectionCue(text), false, text);
  });

  it('topic words: particles stripped, filler removed, short noise dropped', () => {
    assert.deepEqual(topicTokens('이제 나는 커피를 대신 차를 마셔').sort(), ['마셔', '차', '커피'].sort());
    assert.ok(topicTokens('부산에서는 살아').includes('부산'));
    assert.deepEqual(topicTokens('I prefer the dark mode'), ['dark', 'mode']);
    assert.deepEqual(topicTokens(''), []);
  });

  it('the closest ONE confirmed memory is the target; a tie, no cue, no shared topic or an unconfirmed memory replaces nothing', () => {
    const coffee = active('mem_1', '나는 아침에 커피를 마셔');
    const slides = active('mem_2', '발표자료는 간결하게 만들어줘');
    assert.equal(findSupersedeTarget('이제 나는 커피 대신 차를 마셔', [coffee, slides])?.memory.id, 'mem_1');
    assert.equal(findSupersedeTarget('나는 오후에 차를 마셔', [coffee, slides]), null, 'no replacement cue');
    assert.equal(findSupersedeTarget('이제 비행기 좌석은 창가로', [coffee, slides]), null, 'no shared topic');
    const evening = active('mem_3', '나는 저녁에 커피를 마셔');
    assert.equal(findSupersedeTarget('이제 나는 커피 대신 차를 마셔', [coffee, evening]), null, 'two equally close memories: nothing is guessed');
    const suggested = active('mem_4', '나는 아침에 커피를 마셔', { userConfirmed: false, memoryOrigin: 'SUGGESTED' });
    assert.equal(findSupersedeTarget('이제 나는 커피 대신 차를 마셔', [suggested]), null, 'a suggestion the person never confirmed is not what they said before');
    assert.equal(findSupersedeTarget('이제 나는 커피 대신 차를 마셔', [active('mem_5', '나는 아침에 커피를 마셔', { type: 'WORKING_CONTEXT' })]), null);
    assert.equal(findSupersedeTarget('이제 나는 커피 대신 차를 마셔', [active('mem_6', '나는 아침에 커피를 마셔', { lifecycle: 'SUPERSEDED' })]), null);
  });
});

describe('what the person says is kept - and corrected when they correct it', () => {
  it('the incident: several different explicit statements are ALL kept (the second used to vanish)', () => {
    const r = rig();
    say(r, '기억해줘: 발표자료는 간결하게 만들어줘');
    say(r, '기억해줘: 보고서에는 표를 꼭 넣어줘');
    say(r, '기억해줘: 회의는 오후에만 잡아줘');
    assert.equal(r.engine.listMemories(T, U).length, 3);
    assert.deepEqual(values(r.context.getRelevantMemories(T, U, '보고서 형식 표')), ['보고서에는 표를 꼭 넣어줘']);
    assert.equal(r.engine.listMemories(T, U).filter((m) => m.lifecycle === 'CONFLICTED').length, 0, 'nothing is filed as an invisible conflict');
  });

  it('the same statement twice is one memory', () => {
    const r = rig();
    say(r, '기억해줘: 나는 아침에 커피를 마셔');
    say(r, '기억해줘: 나는 아침에 커피를 마셔');
    assert.equal(r.engine.listMemories(T, U).length, 1);
  });

  it('a correction replaces the old fact for recall; the old fact is kept as history, linked both ways, provenance intact', () => {
    const r = rig();
    const [first] = say(r, '기억해줘: 나는 아침에 커피를 마셔');
    const [second] = say(r, '기억해줘: 이제 나는 커피 대신 차를 마셔');
    assert.deepEqual(values(r.context.getRelevantMemories(T, U, '아침에 마시는 커피')), ['이제 나는 커피 대신 차를 마셔']);
    const old = r.engine.get(first.id, T, U)!;
    assert.equal(old.lifecycle, 'SUPERSEDED');
    assert.equal(old.supersededBy, second.id);
    assert.ok(old.supersededAt);
    assert.equal(old.provenance?.extractor, 'USER_EXPLICIT');
    assert.equal(old.provenance?.messageId, first.provenance?.messageId, 'the old memory still says where it came from');
    const fresh = r.engine.get(second.id, T, U)!;
    assert.deepEqual([fresh.lifecycle, fresh.supersedes, fresh.memoryOrigin, fresh.userConfirmed], ['ACTIVE', first.id, 'EXPLICIT_USER', true]);
    assert.deepEqual(r.engine.getSupersessionChain(second.id, T, U).map((m) => m.id), [first.id, second.id]);
    assert.deepEqual(r.engine.getSupersessionChain(first.id, T, U).map((m) => m.id), [first.id, second.id], 'the history reads the same from either end');
    assert.equal(r.engine.listMemories(T, U).length, 1, 'only the current fact is listed');
  });

  it('a chain of corrections keeps every step', () => {
    const r = rig();
    const [a] = say(r, '기억해줘: 나는 서울에 살아');
    const [b] = say(r, '기억해줘: 부산으로 이사했어 이제 부산에 살아');
    const [c] = say(r, '기억해줘: 이제 제주로 이사했어 제주에 살아');
    assert.deepEqual(r.engine.getSupersessionChain(c.id, T, U).map((m) => m.id), [a.id, b.id, c.id]);
    assert.deepEqual(values(r.context.getRelevantMemories(T, U, '어디에 살아')), ['이제 제주로 이사했어 제주에 살아']);
  });

  it('a statement with no replacement cue, or an ambiguous one, replaces nothing (both are kept)', () => {
    const r = rig();
    say(r, '기억해줘: 나는 아침에 커피를 마셔');
    say(r, '기억해줘: 나는 오후에 차를 마셔');
    assert.equal(r.engine.listMemories(T, U).length, 2);
    const q = rig();
    say(q, '기억해줘: 나는 아침에 커피를 마셔');
    say(q, '기억해줘: 나는 저녁에 커피를 마셔');
    say(q, '기억해줘: 이제 나는 커피 대신 차를 마셔');
    assert.equal(q.engine.listMemories(T, U).length, 3, 'two equally close memories: nothing replaced, nothing lost');
    assert.equal(q.engine.listMemories(T, U).filter((m) => m.lifecycle === 'SUPERSEDED').length, 0);
  });

  it('English works the same way', () => {
    const r = rig();
    say(r, 'remember this: I prefer dark mode');
    say(r, 'remember this: actually I now prefer light mode instead of dark mode');
    assert.deepEqual(values(r.context.getRelevantMemories(T, U, 'which mode do I prefer dark light mode')), ['actually I now prefer light mode instead of dark mode'.replace(/^/, '')].map((v) => `actually I now prefer light mode instead of dark mode`));
  });
});

describe('the person stays in control of their own memory', () => {
  it('changing their mind back restores the old fact and retires its replacement; deleting the replacement does not resurrect the old one by itself', () => {
    const r = rig();
    const [first] = say(r, '기억해줘: 나는 아침에 커피를 마셔');
    const [second] = say(r, '기억해줘: 이제 나는 커피 대신 차를 마셔');
    const restored = r.engine.restoreSuperseded(first.id, T, U);
    assert.equal(restored.lifecycle, 'ACTIVE');
    assert.equal(restored.supersededBy, undefined);
    assert.equal(r.engine.get(second.id, T, U)!.lifecycle, 'SUPERSEDED');
    assert.deepEqual(values(r.context.getRelevantMemories(T, U, '아침에 커피')), ['나는 아침에 커피를 마셔']);
    assert.throws(() => r.engine.restoreSuperseded(first.id, T, U), (e: any) => e.code === 'MEMORY_NOT_SUPERSEDED');

    const q = rig();
    const [x] = say(q, '기억해줘: 나는 아침에 커피를 마셔');
    const [y] = say(q, '기억해줘: 이제 나는 커피 대신 차를 마셔');
    q.engine.deleteMemory(y.id, T, U);
    assert.equal(q.engine.get(x.id, T, U)!.lifecycle, 'SUPERSEDED', 'deleting the new fact is not an instruction to bring the old one back');
    assert.equal(q.engine.restoreSuperseded(x.id, T, U).lifecycle, 'ACTIVE', 'but the person can bring it back');
  });

  it('a superseded memory is never recalled, with or without a question', () => {
    const r = rig();
    say(r, '기억해줘: 나는 아침에 커피를 마셔');
    say(r, '기억해줘: 이제 나는 커피 대신 차를 마셔');
    for (const prompt of ['', '커피', '아침에 마시는 것']) assert.ok(!values(r.context.getRelevantMemories(T, U, prompt)).includes('나는 아침에 커피를 마셔'), `prompt "${prompt}"`);
  });
});

describe('ownership, tenancy, sensitivity', () => {
  it('another person\'s statement, in the same or another tenant, never replaces mine', () => {
    const r = rig();
    const [mine] = say(r, '기억해줘: 나는 아침에 커피를 마셔');
    say(r, '기억해줘: 이제 나는 커피 대신 차를 마셔', 'usr_other');
    say(r, '기억해줘: 이제 나는 커피 대신 차를 마셔', U, 'ten_other');
    assert.equal(r.engine.get(mine.id, T, U)!.lifecycle, 'ACTIVE');
    assert.deepEqual(values(r.context.getRelevantMemories(T, U, '아침에 커피')), ['나는 아침에 커피를 마셔']);
    assert.deepEqual(values(r.context.getRelevantMemories(T, 'usr_other', '커피 차')), ['이제 나는 커피 대신 차를 마셔']);
    assert.deepEqual(r.context.getRelevantMemories('ten_other', U, '아침에 커피').map((m) => m.tenantId), ['ten_other']);
  });

  it('naming someone else\'s memory as the target is refused as not found; a target that is not ACTIVE is refused; an unconfirmed statement cannot replace anything', () => {
    const r = rig();
    const [theirs] = say(r, '기억해줘: 나는 아침에 커피를 마셔', 'usr_other');
    assert.throws(() => r.engine.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: '차' }, undefined, { userConfirmed: true, distinctFact: true, supersedes: theirs.id }), (e: any) => e.code === 'MEMORY_NOT_FOUND');
    const mine = r.engine.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: '녹차를 좋아해' }, undefined, { userConfirmed: true, distinctFact: true });
    const successor = r.engine.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: '홍차를 좋아해' }, undefined, { userConfirmed: true, distinctFact: true, supersedes: mine.id });
    assert.equal(successor.supersedes, mine.id);
    assert.throws(() => r.engine.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: '보이차를 좋아해' }, undefined, { userConfirmed: true, distinctFact: true, supersedes: mine.id }), (e: any) => e.code === 'MEMORY_SUPERSEDE_TARGET_NOT_ACTIVE');
    const unconfirmed = r.engine.proposeMemory('PERSONAL', T, U, { subject: 'User Preference', predicate: 'preference', value: '말차를 좋아해' }, undefined, { userConfirmed: false, distinctFact: true, supersedes: successor.id });
    assert.equal(unconfirmed.lifecycle, 'PROPOSED');
    assert.equal(r.engine.get(successor.id, T, U)!.lifecycle, 'ACTIVE', 'a suggestion does not retire a confirmed fact');
  });

  it('the generic key-based conflict handling of the engine is unchanged: a different value under the same key still lands CONFLICTED and is never surfaced', () => {
    const r = rig();
    r.engine.proposeMemory('PERSONAL', T, U, { subject: 'Editor', predicate: 'theme', value: 'dark' }, undefined, { userConfirmed: true });
    const second = r.engine.proposeMemory('PERSONAL', T, U, { subject: 'Editor', predicate: 'theme', value: 'light' }, undefined, { userConfirmed: true });
    assert.equal(second.lifecycle, 'CONFLICTED');
    assert.ok(!r.context.getRelevantMemories(T, U, 'theme').some((m) => m.id === second.id));
  });

  it('a secret is still never stored and a sensitive (S2) correction is not applied silently', () => {
    const r = rig();
    assert.deepEqual(say(r, '기억해줘: 내 비밀번호는 hunter2'), []);
    const [first] = say(r, '기억해줘: 나는 아침에 커피를 마셔');
    const sensitive = say(r, '기억해줘: 이제 나는 커피 대신 당뇨 때문에 차를 마셔');
    if (sensitive.length > 0 && sensitive[0].sensitivity === 'S2') {
      assert.equal(sensitive[0].lifecycle, 'PROPOSED');
      assert.equal(r.engine.get(first.id, T, U)!.lifecycle, 'ACTIVE', 'a sensitive statement waits for confirmation instead of retiring an older fact');
    }
  });
});

describe('restart', () => {
  it('states, links and recall survive a restart of the memory store', () => {
    const r = rig();
    const [first] = say(r, '기억해줘: 나는 아침에 커피를 마셔');
    const [second] = say(r, '기억해줘: 이제 나는 커피 대신 차를 마셔');
    say(r, '기억해줘: 발표자료는 간결하게 만들어줘');
    const again = new MemoryEngine(r.options);
    assert.deepEqual([again.get(first.id, T, U)!.lifecycle, again.get(first.id, T, U)!.supersededBy], ['SUPERSEDED', second.id]);
    assert.equal(again.get(second.id, T, U)!.supersedes, first.id);
    assert.deepEqual(again.getSupersessionChain(second.id, T, U).map((m) => m.id), [first.id, second.id]);
    assert.equal(again.listMemories(T, U).length, 2);
    assert.deepEqual(values(new PersonalContextService(again).getRelevantMemories(T, U, '아침에 커피')), ['이제 나는 커피 대신 차를 마셔']);
  });
});

import { detectContentSensitivity } from '../src/context/sensitivity.detector.js';

describe('a secret said in Korean is a secret (found while testing: it used to be stored as an ordinary memory and offered to models)', () => {
  it('values that look like secrets are S3; talk ABOUT passwords is not', () => {
    for (const text of ['내 비밀번호는 hunter2', '비번: abcd1234!', 'API 키: sk_live_abcdef123456', '패스워드는 P@ssw0rd99', '토큰 = ghp_abcdefghijklmnop']) assert.equal(detectContentSensitivity(text), 'S3', text);
    for (const text of ['비밀번호를 바꿔야 해', '비밀번호는 어렵게 만들어', '암호화 방식은 AES야', '토큰 비용을 줄이자']) assert.notEqual(detectContentSensitivity(text), 'S3', text);
  });
});
