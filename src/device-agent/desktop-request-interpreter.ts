// "메모장을 열고 \"...\" 라고 작성한 뒤 내 문서 폴더에 NAgex-Test.txt로 저장해줘" / "open Notepad, write \"...\" and save it as report.txt in my Documents folder" -> the three facts a desktop
// plan needs (the text, the file name, the folder) - or what is missing.
//
// This is deliberately plain and deterministic: no model is asked to guess a file name or a sentence. The result is not an authority either - it only fills in the approval card, which shows the
// person exactly what NAgex understood (the text, the name, the folder, "on your screen") and does nothing until they approve it. What cannot be read from the request is asked for, not invented.
import { validateDesktopWriteAndSave, type DesktopPlanAppId, type DesktopPlanRootAlias } from './desktop-plan.types.js';

export type DesktopRequestInterpretation =
  | { ok: true; appId: DesktopPlanAppId; text: string; fileName: string; rootAlias: DesktopPlanRootAlias }
  | { ok: false; missing: 'APP' | 'TEXT' | 'FILE_NAME' | 'FOLDER'; detail?: string };

const NOTEPAD = /메모장|노트패드|\bnotepad\b/i;
const SAVE = /저장|\bsave\b/i;
// a question about how, not a request to do it
const QUESTION = /방법|어떻게|알려\s*줘|뭐야|무엇|\bhow\s+(?:do|to|can|would|should)\b|\bwhat\s+is\b|\?\s*$/i;
const OTHER_FOLDER = /바탕\s*화면|\bdesktop\s+folder\b|\bon\s+(?:my\s+)?desktop\b|다운로드|\bdownloads?\b|사진\s*폴더|\bpictures\b|[A-Za-z]:\\|%[A-Za-z]+%|\/home\/|\bsystem32\b/i;

const QUOTES: Array<[string, string]> = [['"', '"'], ['“', '”'], ['‘', '’'], ["'", "'"], ['「', '」'], ['『', '』']];
const FILE_NAME_UNQUOTED = /(?:^|[\s("'“‘「『])([A-Za-z0-9가-힣][A-Za-z0-9가-힣._()-]{0,100}\.txt)(?![A-Za-z0-9])/i;
const TEXT_LEAD = /(?:작성|입력|써|쓰고|쓴\s*뒤|적어|적고|내용|문장|\bwrite\b|\btype\b|\bwriting\b|\btext\b|\bsentence\b|\bsays?\b)[^:：\n]*[:：]\s*([^\n]+)/i;

/** true for a request to open Notepad and save something (not for a question about how to) */
export function isDesktopWriteRequest(text: string): boolean {
  const t = String(text || '').normalize('NFC');
  return NOTEPAD.test(t) && SAVE.test(t) && !QUESTION.test(t);
}

function quotedSegments(text: string): string[] {
  const found: string[] = [];
  for (const [open, close] of QUOTES) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(open, from);
      if (start < 0) break;
      const end = text.indexOf(close, start + 1);
      if (end < 0) break;
      const inner = text.slice(start + 1, end).trim();
      if (inner) found.push(inner);
      from = end + 1;
    }
  }
  return found;
}

export function interpretDesktopWriteRequest(rawPrompt: string): DesktopRequestInterpretation {
  const prompt = String(rawPrompt || '').normalize('NFC').trim();
  if (!NOTEPAD.test(prompt)) return { ok: false, missing: 'APP' };

  // the file name: a quoted name ending in .txt (it may contain spaces), else a plain token ending in .txt
  const quoted = quotedSegments(prompt);
  const quotedName = quoted.find((q) => /\.txt$/i.test(q) && q.length <= 105);
  const plain = FILE_NAME_UNQUOTED.exec(prompt);
  const fileName = quotedName ?? (plain ? plain[1] : '');
  if (!fileName) return { ok: false, missing: 'FILE_NAME' };

  // the text: what is in quotes (other than the file name), else what follows "...: " after a writing word
  let text = '';
  const candidates = quoted.filter((q) => q !== fileName);
  if (candidates.length > 0) text = candidates.reduce((best, q) => (q.length > best.length ? q : best), '');
  if (!text) {
    const lead = TEXT_LEAD.exec(prompt);
    if (lead) text = lead[1].trim();
  }
  if (!text) return { ok: false, missing: 'TEXT' };

  // the folder: Documents (the only one NAgex may write to), by name or by saying nothing; any other place is said so
  const rest = prompt.replace(text, ' ').replace(fileName, ' ');
  if (OTHER_FOLDER.test(rest)) return { ok: false, missing: 'FOLDER', detail: 'ONLY_DOCUMENTS' };
  // naming the folder is optional: Documents is the only one, and the approval card says so
  const rootAlias: DesktopPlanRootAlias = 'DOCUMENTS';

  const check = validateDesktopWriteAndSave({ deviceId: 'x', appId: 'NOTEPAD', text, rootAlias, fileName });
  if (!check.ok) {
    if (check.code === 'DESKTOP_FILE_NAME_INVALID') return { ok: false, missing: 'FILE_NAME', detail: check.code };
    return { ok: false, missing: 'TEXT', detail: check.code };
  }
  return { ok: true, appId: 'NOTEPAD', text, fileName, rootAlias };
}
