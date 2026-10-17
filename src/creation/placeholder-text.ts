// Text that says that content is MISSING: a placeholder, a section or slide "withheld", a TBD field. It is honest about the gap - and still not the document or the deck the person asked for.
// Used on both sides: the deck planner never lets a slide made only of such lines reach the file (presentation-outline.ts), and the quality evaluation fails a file that contains any (quality/outcome-quality.ts).
// The list is deliberately narrow: ordinary words ("placeholder" in a developer's slide, "TODO" in a checklist) are not matched.
const PLACEHOLDER = /(입력\s*필요|작성을?\s*유보|추후\s*(?:작성|보완|공유)|해당\s*항목에\s*대한\s*(?:추가\s*)?(?:자료|정보)가\s*(?:제공되지|없)|to\s*be\s*(?:provided|determined|filled|completed)|\bTBD\b|lorem ipsum|\[\s*(?:insert|name|date|company)[^\]]*\])/gi;

export function placeholdersIn(text: string): string[] {
  return [...new Set([...String(text).matchAll(PLACEHOLDER)].map((match) => match[1].toLowerCase().replace(/\s+/g, ' ')))];
}

export const isPlaceholderText = (text: string): boolean => placeholdersIn(text).length > 0;

// "will be supplemented once it is available": a promise to fill the gap later. Meaningless on its own, harmless in a real sentence ("출시될 예정입니다") - so it is only ever read NEXT TO a placeholder.
const DEFERRAL = /(되는\s*대로|확보되면|준비되면|예정(?:입니다|이다|임)\.?$|will be (?:added|updated|provided|shared|supplemented)|once .{0,60}(?:available|ready|provided))/i;
export const isDeferral = (text: string): boolean => DEFERRAL.test(String(text).trim());

/** What a document writer is told when its draft still says content is missing: what exactly, and what to do instead. Plain instructions, no new facts. */
export function placeholderRetryInstruction(found: string[], locale: 'en' | 'ko'): string {
  const list = found.slice(0, 6).map((f) => `"${f}"`).join(', ');
  return locale === 'ko'
    ? `직전 초안에 내용이 비어 있다는 표시(${list})가 남아 있습니다. 문서 전체를 다시 쓰되, 요청에 있는 사실(이름, 날짜, 수치)은 그대로 쓰고, 자료가 없는 항목은 주어진 사실로부터 정성적으로 쓰며(새 수치·이름·날짜는 쓰지 않습니다), 값이 주어지지 않은 표의 칸은 "미정"으로 씁니다. 대괄호 자리표시는 쓰지 마세요.`
    : `Your previous draft still contains text that says content is missing (${list}). Rewrite the COMPLETE document so that none remains: use every fact the request gives (names, dates, figures) exactly; write a part without data qualitatively from the facts that ARE given (no new figure, name or date); write a table cell whose value is not given as "not set". Use no bracketed placeholders.`;
}

/** A list of lines that says nothing but "there is nothing here yet": at least one placeholder, and every other line only defers to later. */
export const saysNothingYet = (lines: string[]): boolean => lines.length > 0 && lines.some(isPlaceholderText) && lines.every((line) => isPlaceholderText(line) || isDeferral(line));
