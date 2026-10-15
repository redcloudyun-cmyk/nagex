// Memory conflict-handling benchmark (NOT part of the product or the test gate). The SAME file runs against two builds:
//   node scratch/memory-eval/bench.cjs <distRoot> <label> <out.json>
// Synthetic people say things to NAgex through the real ConversationMemoryExtractor; the real PersonalContextService recalls for a question. Ground truth is written in the scenario:
// what the CURRENT answer is, what a STALE answer would be, and whose memory it is. Isolated temp stores; nothing touches real data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [, , DIST, LABEL, OUT] = process.argv;
const req = (p) => require(path.join(DIST, p));
const { MemoryEngine } = req('src/context/memory.engine.js');
const { ConversationMemoryExtractor } = req('src/context/conversation-memory-extractor.js');
const { PersonalContextService } = req('src/context/personal-context.service.js');

const T = 'ten_bench';
const SCENARIOS = [
  { id: 'M01', name: 'preference changes (커피 -> 차)', says: [['A', '기억해줘: 나는 아침에 커피를 마셔'], ['A', '기억해줘: 이제 나는 커피 대신 차를 마셔']], asks: [{ who: 'A', q: '내가 아침에 뭐 마시지? 커피', current: '커피 대신 차', stale: '아침에 커피를 마셔' }] },
  { id: 'M02', name: 'three different explicit preferences are all kept', says: [['A', '기억해줘: 발표자료는 간결하게 만들어줘'], ['A', '기억해줘: 보고서에는 표를 꼭 넣어줘'], ['A', '기억해줘: 회의는 오후에만 잡아줘']], asks: [{ who: 'A', q: '발표자료 스타일', current: '간결하게' }, { who: 'A', q: '보고서 형식 표', current: '표를 꼭' }, { who: 'A', q: '회의 시간 오후', current: '오후에만' }] },
  { id: 'M03', name: 'residence changes (서울 -> 부산)', says: [['A', '기억해줘: 나는 서울에 살아'], ['A', '기억해줘: 부산으로 이사했어 이제 부산에 살아']], asks: [{ who: 'A', q: '내가 어디에 살지? 살아', current: '부산', stale: '서울에 살아' }] },
  { id: 'M04', name: 'project direction changes', says: [['A', '기억해줘: 프로젝트는 모바일 퍼스트로 간다'], ['A', '기억해줘: 이제 프로젝트는 모바일 퍼스트 대신 데스크톱 우선으로 간다']], asks: [{ who: 'A', q: '프로젝트 방향 모바일 퍼스트', current: '데스크톱 우선', stale: '모바일 퍼스트로 간다' }] },
  { id: 'M05', name: 'English: preference changes', says: [['A', 'remember this: I prefer dark mode'], ['A', 'remember this: actually I now prefer light mode instead of dark mode']], asks: [{ who: 'A', q: 'which mode do I prefer? dark light mode', current: 'light mode instead', stale: 'I prefer dark mode' }] },
  { id: 'M06', name: 'a later statement WITHOUT a replacement cue does not replace', says: [['A', '기억해줘: 나는 아침에 커피를 마셔'], ['A', '기억해줘: 나는 오후에 차를 마셔']], asks: [{ who: 'A', q: '커피 마셔', current: '아침에 커피' }, { who: 'A', q: '차 마셔', current: '오후에 차' }] },
  { id: 'M07', name: 'ambiguous correction (two equally close memories) replaces nothing', says: [['A', '기억해줘: 나는 아침에 커피를 마셔'], ['A', '기억해줘: 나는 저녁에 커피를 마셔'], ['A', '기억해줘: 이제 나는 커피 대신 차를 마셔']], asks: [{ who: 'A', q: '아침에 커피', current: '아침에 커피를 마셔' }, { who: 'A', q: '저녁에 커피', current: '저녁에 커피를 마셔' }] },
  { id: 'M08', name: 'another person says the opposite: my memory is untouched', says: [['A', '기억해줘: 나는 아침에 커피를 마셔'], ['B', '기억해줘: 이제 나는 커피 대신 차를 마셔']], asks: [{ who: 'A', q: '아침에 커피', current: '아침에 커피를 마셔', stale: '커피 대신 차' }, { who: 'B', q: '커피 차', current: '커피 대신 차' }] },
  { id: 'M09', name: 'the same user id in another tenant is a different person', says: [['A', '기억해줘: 나는 아침에 커피를 마셔'], ['A2', '기억해줘: 이제 나는 커피 대신 차를 마셔']], asks: [{ who: 'A', q: '아침에 커피', current: '아침에 커피를 마셔', stale: '커피 대신 차' }, { who: 'A2', q: '커피 차', current: '커피 대신 차' }] },
  { id: 'M10', name: 'the same statement twice is one memory', says: [['A', '기억해줘: 나는 아침에 커피를 마셔'], ['A', '기억해줘: 나는 아침에 커피를 마셔']], asks: [{ who: 'A', q: '아침에 커피', current: '아침에 커피를 마셔', exactly: 1 }] },
];
const WHO = { A: { t: T, u: 'usr_a' }, A2: { t: T + '_2', u: 'usr_a' }, B: { t: T, u: 'usr_b' } };

const results = [];
for (const sc of SCENARIOS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bench-'));
  const engine = new MemoryEngine({ dir: path.join(dir, 'm'), settingsDir: path.join(dir, 's') });
  const extractor = new ConversationMemoryExtractor(engine);
  const ctx = new PersonalContextService(engine);
  let n = 0;
  for (const [who, text] of sc.says) extractor.processMessage({ tenantId: WHO[who].t, principalId: WHO[who].u, sessionId: 's', messageId: `m${n++}`, content: text });
  for (const ask of sc.asks) {
    const recalled = ctx.getRelevantMemories(WHO[ask.who].t, WHO[ask.who].u, ask.q).map((m) => String(m.content.value));
    const hasCurrent = recalled.some((v) => v.includes(ask.current));
    const staleLeak = ask.stale ? recalled.some((v) => v.includes(ask.stale)) : false;
    const count = ask.exactly ? recalled.filter((v) => v.includes(ask.current)).length : null;
    const ok = hasCurrent && !staleLeak && (ask.exactly ? count === ask.exactly : true);
    results.push({ id: sc.id, name: sc.name, q: ask.q, ok, hasCurrent, staleLeak, count, recalled });
    console.log(`${LABEL} ${sc.id} "${ask.q}" ${ok ? 'PASS' : 'FAIL'} current=${hasCurrent} stale=${staleLeak}${ask.exactly ? ' count=' + count : ''}`);
  }
}
fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, dist: DIST, results }, null, 1));
