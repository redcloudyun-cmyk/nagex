// "핵심 결론을 한 장 추가하고 전체를 다시 구성해줘": the person asks to change an existing deck, and the size of the result follows from the words. A model is poor at counting its own slides, so
// the number is NAgex's arithmetic - deterministic, bounded, and told to the model as an exact number of content slides (the same rule slide-count.ts applies to a new deck).
//   - a size named outright ("8장으로", "make it 6 slides") sets the total (cover included), exactly as for a new deck;
//   - "한 장 추가" / "add two slides" adds to what the deck has now, "한 장 삭제" / "remove a slide" takes away;
//   - nothing about size: no number is forced (the model restructures freely within the usual range).
import { OUTLINE_LIMITS } from '../model-gateway/presentation-outline.js';
import { requestedSlideCount } from './slide-count.js';

export interface SlideRevisionTarget {
  /** content slides the revised deck must have (the title slide is added separately) */
  contentSlides: number;
  basis: 'NAMED_SIZE' | 'ADD' | 'REMOVE';
}

const KO_NUM: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const NUM = '(\\d{1,2}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)';
const KO_ADD = new RegExp(`${NUM}\\s*(?:장|개)\\s*(?:을|를)?\\s*(?:더\\s*)?(?:추가|넣|보태|늘려|더해)`);
const KO_REMOVE = new RegExp(`${NUM}\\s*(?:장|개)\\s*(?:을|를)?\\s*(?:삭제|빼|제거|줄여|덜어)`);
const EN_NUM = '(a|an|one|two|three|four|five|\\d{1,2})';
const EN_ADD = new RegExp(`\\badd\\s+${EN_NUM}\\s+(?:more\\s+|new\\s+|extra\\s+|additional\\s+)?slides?\\b`, 'i');
const EN_REMOVE = new RegExp(`\\b(?:remove|delete|drop|cut)\\s+${EN_NUM}\\s+(?:of\\s+the\\s+)?slides?\\b`, 'i');
const DELTA_WORDS = /(?:장|개)\s*(?:을|를)?\s*(?:더\s*)?(?:추가|넣어|넣고|보태|늘려|더해|삭제|빼|제거|줄여|덜어)|\b(?:add|remove|delete|drop|cut)\s+\w+\s+(?:more\s+|new\s+|extra\s+|additional\s+)?slides?\b/i;
const EN_WORDS: Record<string, number> ={ a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

function count(token: string): number {
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return KO_NUM[token] ?? EN_WORDS[token.toLowerCase()] ?? NaN;
}

function clamp(contentSlides: number): number {
  return Math.max(1, Math.min(OUTLINE_LIMITS.maxContentSlides, contentSlides));
}

export function revisionSlideTarget(instruction: string, currentContentSlides: number): SlideRevisionTarget | null {
  const text = (instruction || '').normalize('NFC');
  const request = text.split(/\n\s*\n/)[0] ?? '';
  const add = KO_ADD.exec(request) ?? EN_ADD.exec(request);
  if (add) { const n = count(add[1]); if (Number.isInteger(n) && n >= 1 && n <= 10) return { contentSlides: clamp(currentContentSlides + n), basis: 'ADD' }; }
  const remove = KO_REMOVE.exec(request) ?? EN_REMOVE.exec(request);
  if (remove) { const n = count(remove[1]); if (Number.isInteger(n) && n >= 1 && n <= 10) return { contentSlides: clamp(currentContentSlides - n), basis: 'REMOVE' }; }
  // a change in size whose number is not one NAgex reads ("스무 장 추가") is not a size: it must never fall through to "make it N slides"
  if (DELTA_WORDS.test(request)) return null;
  const named = requestedSlideCount(request);
  if (named) return { contentSlides: named.contentSlides, basis: 'NAMED_SIZE' };
  return null;
}
