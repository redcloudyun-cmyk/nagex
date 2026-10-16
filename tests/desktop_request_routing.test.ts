// "메모장을 열고 ... 작성한 뒤 내 문서 폴더에 NAgex-Test.txt로 저장해줘" - how NAgex reads such a request (the text, the file name, the folder, or what is missing), how it is routed, and what it does when the
// person has no PC that can do it. The reading is plain and deterministic and is not an authority: it only fills in the approval card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretDesktopWriteRequest, isDesktopWriteRequest } from '../src/device-agent/desktop-request-interpreter.js';
import { decideRouting } from '../src/workspace/input-router.js';

const SENTENCE = 'NAgex Desktop Agent 실기기 제어 검증 — 2026-10-16';

test('the scenario sentence: the quoted text, the .txt name and Documents are read - and "Desktop" inside the text is not mistaken for a folder', () => {
  const read = interpretDesktopWriteRequest(`메모장을 열고 다음 문장을 작성한 뒤, 내 문서 폴더에 NAgex-Test.txt로 저장해줘. "${SENTENCE}"`);
  assert.deepEqual(read, { ok: true, appId: 'NOTEPAD', text: SENTENCE, fileName: 'NAgex-Test.txt', rootAlias: 'DOCUMENTS' });
  // curly quotes, Korean quotes and a colon form read the same
  assert.equal((interpretDesktopWriteRequest(`메모장에 \u201c${SENTENCE}\u201d 라고 쓰고 NAgex-Test.txt 로 저장해줘`) as { text: string }).text, SENTENCE);
  assert.equal((interpretDesktopWriteRequest(`메모장 열어서 \u300c${SENTENCE}\u300d 작성하고 저장해줘 파일명 NAgex-Test.txt`) as { text: string }).text, SENTENCE);
  const colon = interpretDesktopWriteRequest('메모장 열고 아래 내용 작성해서 notes.txt로 저장해줘\n내용: 오늘 회의는 10시에 시작합니다');
  assert.deepEqual(colon, { ok: true, appId: 'NOTEPAD', text: '오늘 회의는 10시에 시작합니다', fileName: 'notes.txt', rootAlias: 'DOCUMENTS' });
});

test('English requests, a quoted file name with spaces, and the folder named or not', () => {
  assert.deepEqual(interpretDesktopWriteRequest('Open Notepad, write "Hello from NAgex" and save it as hello.txt in my Documents folder.'), { ok: true, appId: 'NOTEPAD', text: 'Hello from NAgex', fileName: 'hello.txt', rootAlias: 'DOCUMENTS' });
  const spaced = interpretDesktopWriteRequest('Use Notepad to save "my notes.txt" with the text "hi there"');
  assert.deepEqual(spaced, { ok: true, appId: 'NOTEPAD', text: 'hi there', fileName: 'my notes.txt', rootAlias: 'DOCUMENTS' });
  // naming no folder means Documents - the only one NAgex may write to; the approval card says so
  assert.equal(interpretDesktopWriteRequest('Open Notepad, type "x" and save it as a.txt').ok, true);
});

test('what cannot be read is asked for, not invented: the text, the file name, another folder, not Notepad at all', () => {
  const missing = (prompt: string) => { const r = interpretDesktopWriteRequest(prompt); return r.ok ? 'OK' : r.missing; };
  assert.equal(missing('메모장을 열고 내 문서 폴더에 a.txt로 저장해줘'), 'TEXT');
  assert.equal(missing('메모장에 "hello" 라고 쓰고 저장해줘'), 'FILE_NAME');
  assert.equal(missing('메모장에 "hello" 라고 쓰고 바탕화면에 a.txt로 저장해줘'), 'FOLDER');
  assert.equal(missing('Open Notepad, write "hello" and save it as a.txt in my Downloads folder'), 'FOLDER');
  assert.equal(missing('Open Notepad, write "hello" and save it as C:\\Windows\\a.txt'), 'FILE_NAME', 'a path is not a file name');
  assert.equal(missing('Open Notepad, write "hello" and save it as ..\\evil.txt'), 'FILE_NAME');
  assert.equal(missing('Open Word, write "hello" and save it as a.txt'), 'APP');
  // text that cannot be written as one line is said, not flattened
  assert.equal(missing('메모장에 "첫 줄\n둘째 줄" 쓰고 a.txt로 저장해줘'), 'TEXT');
});

test('a question about how, or a request not to, is not a request to do it', () => {
  for (const q of ['메모장에 저장하는 방법 알려줘', '메모장에서 어떻게 저장해?', 'How do I save a file in Notepad?', 'what is notepad save as?']) assert.equal(isDesktopWriteRequest(q), false, q);
  for (const r of ['메모장을 열고 "x" 작성한 뒤 a.txt로 저장해줘', 'open notepad and save "x" as a.txt']) assert.equal(isDesktopWriteRequest(r), true, r);
  assert.equal(isDesktopWriteRequest('오늘 일정 저장해줘'), false, 'not about Notepad');
});

test('routing: with an enrolled PC that can do it the request is an action that waits for approval; without one it is an honest "not available"; a question or a negation is left alone', () => {
  const prompt = `메모장을 열고 내 문서 폴더에 NAgex-Test.txt로 저장해줘 "${SENTENCE}"`;
  const available = decideRouting(prompt, { desktopTaskAvailable: true });
  assert.equal(available.kind, 'ACTION_PLAN');
  assert.ok(available.reasonCodes.includes('DESKTOP_TASK'));
  assert.equal(available.needs[0].approvalRequired, true);
  assert.equal(available.permissionRisk, 'LOCAL_CREATE');
  const unavailable = decideRouting(prompt, { desktopTaskAvailable: false });
  assert.equal(unavailable.kind, 'UNSUPPORTED');
  assert.ok(unavailable.reasonCodes.includes('DESKTOP_DEVICE_UNAVAILABLE'));
  assert.equal(unavailable.supported, false);
  assert.equal(decideRouting(prompt).kind, 'UNSUPPORTED', 'the default is "not available", never a pretend answer');

  for (const text of ['메모장에 저장하는 방법 알려줘', 'How do I save a file in Notepad?']) {
    assert.ok(!decideRouting(text, { desktopTaskAvailable: true }).reasonCodes.includes('DESKTOP_TASK'), text);
    assert.ok(!decideRouting(text, { desktopTaskAvailable: false }).reasonCodes.includes('DESKTOP_DEVICE_UNAVAILABLE'), text);
  }
  const negated = decideRouting('메모장에 저장하지 마, 그냥 초안만 보여줘', { desktopTaskAvailable: true });
  assert.ok(!negated.reasonCodes.includes('DESKTOP_TASK'));
  // ordinary requests are unaffected
  assert.ok(!decideRouting('다음 주 회의 일정 정리해줘', { desktopTaskAvailable: true }).reasonCodes.includes('DESKTOP_TASK'));
});
