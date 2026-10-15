// "3쪽 분량의 보고서" / "a 2-page report": the person named a length. The model only sees it as one more word of the request and answers with a few bullets (a real run returned 1,118 characters
// for "3쪽"), so the number of pages is read once here, turned into a concrete minimum, and checked against what came back. Deterministic, bounded, no model call.
const MAX_PAGES = 30;
const EN_PAGES = /(?<!\d)\b(\d{1,2})[-\s]*(?:pages?|pgs?\.?)\b/i;

// The page count the request asks for, or null. "장" counts as pages only next to a length word (슬라이드 N장 belongs to slides, not here).
export function requestedPages(prompt: string): number | null {
  const text = (prompt || '').normalize('NFC');
  const ko = /(?<!\d)(\d{1,2})\s*장\s*(?:짜리|분량|정도|내외|이내|이상)/.exec(text) ?? /(?<!\d)(\d{1,2})\s*(?:쪽|페이지)/.exec(text);
  const en = EN_PAGES.exec(text);
  const raw = ko?.[1] ?? en?.[1];
  const pages = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(pages) && pages >= 1 && pages <= MAX_PAGES ? pages : null;
}

// What one page of the .docx NAgex produces holds (measured in Microsoft Word, A4, 10 pt, headings and spacing included): about 1,300 Korean characters or about 2,400 English ones. The floor is that size;
// the second call below only fires when an answer comes back clearly short of it, never to count words.
export function minimumCharacters(pages: number, locale: 'en' | 'ko'): number {
  return Math.round(pages * (locale === 'ko' ? 1300 : 2400));
}

// What the model is told: the target as a concrete size, and how to reach it honestly.
export function lengthInstruction(pages: number, locale: 'en' | 'ko'): string {
  const min = minimumCharacters(pages, locale);
  return locale === 'ko'
    ? `분량: 요청한 분량은 A4 약 ${pages}쪽입니다. 본문(content)을 공백 포함 최소 ${min}자 이상으로 쓰세요. 각 절은 개조식 조각만 나열하지 말고 여러 문장의 문단으로 풀어 쓰고, 근거·사례·시사점을 포함하세요. 분량을 채우려고 같은 말을 반복하거나 없는 사실을 지어내지 마세요.`
    : `Length: the request is for about ${pages} A4 page${pages === 1 ? '' : 's'}. Write the content with at least ${min} characters. Develop every section into full paragraphs rather than bullet fragments, with reasoning, examples and implications. Do not pad with repetition or invented facts.`;
}

export function tooShortInstruction(pages: number, locale: 'en' | 'ko', actual: number): string {
  const min = minimumCharacters(pages, locale);
  return locale === 'ko'
    ? `앞선 초안은 ${actual}자로 요청한 약 ${pages}쪽(최소 ${min}자)에 크게 못 미칩니다. 같은 주제로 처음부터 다시 쓰되 각 절을 문단으로 충분히 전개해 ${min}자 이상이 되게 하세요.`
    : `The previous draft has ${actual} characters, far below the requested ~${pages} page${pages === 1 ? '' : 's'} (at least ${min}). Write it again from the start on the same topic, developing every section into full paragraphs, so it reaches at least ${min} characters.`;
}
