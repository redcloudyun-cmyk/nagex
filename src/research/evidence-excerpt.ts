// Which passages of a fetched page bear on the question?
//
// A search result's snippet is a line or two; a specification table or a release date lives in the page. The page is read (SourceFetcher: robots.txt, the outbound policy, byte and time budgets) and
// the passages that share the most meaningful words with the question are kept - in page order, within a character budget - so the model answers from the page and not from its memory of it.
// Deterministic and free: no model is asked which passage matters.
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'with', 'what', 'which', 'that', 'this', 'from', 'about', 'how', 'does', 'did', 'is', 'of', 'in', 'on', 'to', 'a', 'an',
  '그리고', '그런데', '그래서', '있는', '어떤', '무엇', '뭐지', '뭐야', '알려줘', '알려', '대해', '대한', '있나', '있어', '입니다', '이다']);

export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}.+]+/u)) {
    const term = raw.replace(/^[.+]+|[.+]+$/g, '');
    if (term.length < 2 || STOP.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    // a Korean word carries its particle ("폴드7의", "스펙을"): the stem lets the passage match
    if (/[가-힣]/.test(term) && term.length > 2) {
      const stem = term.replace(/(으로|에서|에게|까지|부터|보다|처럼|이란|라는|이라|은|는|이|가|을|를|의|에|와|과|도|로|만)$/, '');
      if (stem.length >= 2 && stem !== term && !seen.has(stem)) { seen.add(stem); out.push(stem); }
    }
  }
  return out;
}

function scorePassage(passage: string, terms: string[]): number {
  const lower = passage.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!lower.includes(term)) continue;
    // digits and model-like tokens (7, 12gb, 5000mah) are what separates one model's passage from another's
    score += /\d/.test(term) ? 3 : 1;
  }
  return score;
}

export function selectRelevantExcerpt(pageText: string, query: string, maxChars = 1800): string {
  const text = String(pageText ?? '').replace(/\r/g, '');
  if (!text.trim()) return '';
  const terms = queryTerms(query);
  const passages = text.split(/\n{1,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length >= 20);
  if (passages.length === 0) return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  const scored = passages.map((passage, index) => ({ passage: passage.length > 700 ? passage.slice(0, 700) : passage, index, score: scorePassage(passage, terms) }));
  const ranked = scored.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof scored = [];
  let used = 0;
  // the best-scoring passages first; if nothing matches at all, the start of the page (its lead is usually its summary)
  for (const item of ranked.length > 0 ? ranked : scored.slice(0, 4)) {
    if (used + item.passage.length > maxChars) { if (chosen.length > 0) continue; }
    chosen.push(item);
    used += item.passage.length + 1;
    if (used >= maxChars) break;
  }
  return chosen.sort((a, b) => a.index - b.index).map((p) => p.passage).join('\n').slice(0, maxChars);
}

// A NAMED, VERSIONED thing in a question ("폴드6", "Switch 2", "iPhone 17", "RTX 5090"): the tokens a page must mention to be about it, spelled without spaces and in lower case. A search engine happily returns
// other products' pages for such a question (a phone question returns other phones); a source that mentions none of the named things is not evidence for the answer.
export function versionedTokens(query: string): string[] {
  const out = new Set<string>();
  for (const m of String(query ?? '').matchAll(/([\p{L}][\p{L}+]*)\s?-?(\d{1,4}[A-Za-z]{0,3})/gu)) out.add((m[1] + m[2]).toLowerCase());
  return [...out];
}

export function mentionsAny(text: string, tokens: string[]): boolean {
  const flat = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  return tokens.some((t) => flat.includes(t));
}
