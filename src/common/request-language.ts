// Which language did the person write in? Decided from the request's own letters, deterministically - never from the account locale, never by a model -
// so a Korean request is answered in Korean and an English request in English whatever the screen language is.
export type RequestLanguage = 'ko' | 'en' | 'other' | 'unknown';

export function detectRequestLanguage(text: unknown): RequestLanguage {
  const value = typeof text === 'string' ? text : '';
  const hangul = (value.match(/[ㄱ-ㆎ가-힣]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  const other = (value.match(/[぀-ヿ一-鿿Ѐ-ӿ؀-ۿऀ-ॿก-๿]/g) ?? []).length;
  if (hangul === 0 && latin === 0 && other === 0) return 'unknown';
  if (other > hangul + latin) return 'other';
  // a Korean request often carries Latin words (AI, NVIDIA, PPT): Korean wins as soon as Hangul is a meaningful part of the letters
  if (hangul > 0 && hangul / (hangul + latin) >= 0.25) return 'ko';
  return latin > 0 ? 'en' : 'other';
}

// One instruction line for a model prompt. Korean is named explicitly; every other language is answered "in the language of the request".
// JSON keys, enum values, tool and skill identifiers stay in English: they are protocol, not text for the person.
export function languageInstruction(language: RequestLanguage): string {
  if (language === 'ko') {
    return 'LANGUAGE: the request is written in Korean. Write every text the person will read (answers, summaries, titles, step descriptions, suggestions, follow-up questions) in natural Korean. Keep JSON keys, enum values and tool or skill identifiers in English, and never translate names or text the person quoted.';
  }
  return 'LANGUAGE: write every text the person will read in the same language as the request (English when the request is English). Keep JSON keys, enum values and tool or skill identifiers in English, and never translate names or text the person quoted.';
}
