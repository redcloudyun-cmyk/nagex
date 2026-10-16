// What a request asks for, read from its words - so the answer can be held to it.
//
// Measured on the real model (a "fast" Gemini): a request with several instructions is sometimes answered in part, and "explain five features" sometimes gets four. NAgex reads the
// shape of the request (how many parts, an exact count of items), tells the model, and afterwards checks the one thing that can be checked without understanding the answer: that an
// asked-for number of items is there. Deterministic and side-effect free; a wrong guess costs at most one extra model call, never a wrong action.

export type RequestComplexity = 'SIMPLE' | 'MULTI' | 'COMPLEX';

export interface RequestShape {
  complexity: RequestComplexity;
  /** the numbered / bulleted parts the person wrote ("1) ... 2) ..."), in order */
  parts: string[];
  /** an exact number of items asked for ("5가지", "three examples"), or null */
  requestedCount: number | null;
  language: 'ko' | 'en';
}

const KO_NUMBERS: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const EN_NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const KO_COUNT = /(\d{1,2}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(가지|개|건|단계|항목|포인트|사례|예시|이유|방법|팁|기능)/;
const EN_COUNT = /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+)?(things|items|points|examples|ways|steps|reasons|tips|features|ideas|options|benefits|differences|questions|rules|conditions)\b/i;

function hasHangul(text: string): boolean {
  return /[가-힣]/.test(text);
}

function countFrom(message: string): number | null {
  const ko = KO_COUNT.exec(message);
  if (ko) {
    const n = /^\d+$/.test(ko[1]) ? Number(ko[1]) : KO_NUMBERS[ko[1]];
    // "한 가지" is one thing, not a list
    if (n && n >= 2 && n <= 20) return n;
  }
  const en = EN_COUNT.exec(message);
  if (en) {
    const raw = en[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : EN_NUMBERS[raw];
    if (n && n >= 2 && n <= 20) return n;
  }
  return null;
}

// "1) a 2) b 3) c", "1. a\n2. b", "①②③": the parts, only when they really count up from 1
function partsFrom(message: string): string[] {
  const marker = /(?:^|[\s,;:])(\d{1,2})[.)]\s+/g;
  const hits: Array<{ n: number; index: number; end: number }> = [];
  for (let match = marker.exec(message); match; match = marker.exec(message)) hits.push({ n: Number(match[1]), index: match.index, end: marker.lastIndex });
  const run: typeof hits = [];
  for (const hit of hits) {
    if (hit.n === run.length + 1) run.push(hit);
    else if (hit.n === 1) { run.length = 0; run.push(hit); }
  }
  if (run.length < 2) return [];
  return run.map((hit, i) => message.slice(hit.end, i + 1 < run.length ? run[i + 1].index : message.length).trim().replace(/[.,;]+$/, '')).filter(Boolean);
}

export function analyzeRequest(message: string): RequestShape {
  const text = String(message ?? '').trim();
  const parts = partsFrom(text);
  const requestedCount = countFrom(text);
  const questions = (text.match(/[?？]/g) ?? []).length;
  let complexity: RequestComplexity = 'SIMPLE';
  if (parts.length >= 4 || text.length > 400 || (parts.length >= 2 && requestedCount !== null)) complexity = 'COMPLEX';
  else if (parts.length >= 2 || requestedCount !== null || questions >= 2 || /,\s*(and|그리고)\s|(그리고|또한|하고)\s.*(해줘|알려|설명|정리)/.test(text) || text.length > 140) complexity = 'MULTI';
  return { complexity, parts, requestedCount, language: hasHangul(text) ? 'ko' : 'en' };
}

/** The lines added to the chat system prompt for this request. */
export function requestShapeInstructions(shape: RequestShape): string[] {
  const lines: string[] = [];
  if (shape.parts.length >= 2) {
    lines.push(`This request has ${shape.parts.length} parts: ${shape.parts.map((part, i) => `(${i + 1}) ${part}`).join(' ')}`);
    lines.push(`Answer EVERY part, in this order, and number your answer ${shape.parts.map((_, i) => i + 1).join(', ')} so each part can be found. Do not skip, merge or defer a part; if a part cannot be done, say which and why.`);
  }
  if (shape.requestedCount !== null) lines.push(`The request asks for ${shape.requestedCount} items: give exactly ${shape.requestedCount} - numbered, each with its own explanation - not fewer, not more.`);
  if (shape.complexity === 'SIMPLE') lines.push('This is a simple question: answer it directly in one to three sentences. No list, no preamble, no offer of further help.');
  else lines.push('This request deserves a complete, well-organised answer (numbered items or short headed sections). Be specific: say what each thing does and give one concrete example where examples are asked for. No filler, no repeating the question, no closing offers that only restate the request.');
  return lines;
}

function listItems(answer: string): number {
  // numbered or bulleted lines, and bold-numbered headings ("**1. ...**")
  const lines = String(answer ?? '').split(/\r?\n/);
  let items = 0;
  for (const line of lines) if (/^\s*(?:\d{1,2}[.)]|[-*•])\s+\S/.test(line) || /^\s*\*\*\s*\d{1,2}[.)]/.test(line) || /^\s*#{2,4}\s*\d{1,2}[.)]/.test(line)) items += 1;
  return items;
}

export interface CoverageIssue { code: 'COUNT_SHORT' | 'PART_MISSING'; detail: string }

/** Checks what can be checked mechanically: an asked-for number of items, and numbering of an explicitly numbered request. */
export function checkCoverage(shape: RequestShape, answer: string): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  const items = listItems(answer);
  if (shape.requestedCount !== null && items < shape.requestedCount) {
    issues.push({ code: 'COUNT_SHORT', detail: `The request asks for ${shape.requestedCount} items but the answer has ${items}.` });
  }
  if (shape.parts.length >= 2) {
    const numbered = (String(answer ?? '').match(/(?:^|\n)\s*(?:\*\*)?\s*(?:#{1,4}\s*)?(\d{1,2})[.)]/g) ?? []).map((m) => Number((m.match(/(\d{1,2})/) ?? [])[1]));
    const missing = shape.parts.map((_, i) => i + 1).filter((n) => !numbered.includes(n));
    if (missing.length > 0) issues.push({ code: 'PART_MISSING', detail: `Parts ${missing.join(', ')} of the ${shape.parts.length} requested are not answered under their numbers.` });
  }
  return issues;
}

export function coverageCorrection(issues: CoverageIssue[], shape: RequestShape): string {
  return [
    'Your previous answer does not yet cover the whole request:',
    ...issues.map((issue) => `- ${issue.detail}`),
    'Write the COMPLETE answer again from the beginning, covering everything that was asked, in the same language. Do not apologise and do not mention this correction.',
    ...(shape.parts.length >= 2 ? [`Number the parts ${shape.parts.map((_, i) => i + 1).join(', ')}.`] : []),
  ].join('\n');
}
