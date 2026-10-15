// "8장짜리 발표자료" / "a 5-slide deck": the person named how many slides the deck has. A real run produced 9 for "8장": the model saw the number only inside the request text and read it as the number
// of CONTENT slides, and the writer then adds the title slide on top. The number is read once here - as the TOTAL, title slide included, unless the person says otherwise ("표지 제외", "excluding the
// cover", "8 content slides") - and told to the model as an exact number of content slides. Deterministic, bounded, no model call.
import { OUTLINE_LIMITS } from '../model-gateway/presentation-outline.js';

export interface RequestedSlideCount {
  /** the number the person wrote */
  requested: number;
  /** does the number count the title slide? (default: yes) */
  includesCover: boolean;
  /** content slides the model must plan (title slide not counted) */
  contentSlides: number;
  /** slides the finished file has */
  totalSlides: number;
  /** the request was larger than a deck can be and was reduced to the maximum */
  clamped: boolean;
}

const KO_NUMBERS: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
const NUMBER = '(\\d{1,2}|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)';
// "8장", "8 슬라이드", "여덟 장", "8 pages" - the unit must follow the number; "5가지", "3개월", "10분" are not slide counts
const KO = new RegExp(`(?<![\\d가-힣])${NUMBER}\\s*(?:장|매|슬라이드|페이지)`);
const EN = /(?<![\d.])(\d{1,2})[-\s]*(?:content\s+)?(?:slides?|pages?)\b/i;
const EXCLUDES_COVER = /(표지|커버|제목\s*슬라이드)\s*(?:는|을|를)?\s*(?:제외|빼고|빼|없이)|(?:본문|내용|콘텐츠|컨텐츠)\s*(?:만|으로)?\s*\d|content\s+slides?|(?:excluding|without|not counting|besides|plus)\s+(?:the\s+|a\s+)?(?:cover|title)/i;

function numberOf(token: string): number {
  return /^\d+$/.test(token) ? Number.parseInt(token, 10) : KO_NUMBERS[token] ?? NaN;
}

// Only the person's own request is read: the Main surface appends source material / research findings after a blank line, and numbers in those are not a slide count.
export function requestedSlideCount(prompt: string): RequestedSlideCount | null {
  const request = (prompt || '').normalize('NFC').split(/\n\s*\n/)[0] ?? '';
  const match = KO.exec(request) ?? EN.exec(request);
  if (!match) return null;
  const requested = numberOf(match[1]);
  if (!Number.isInteger(requested) || requested < 1) return null;
  const includesCover = !EXCLUDES_COVER.test(request);
  const wanted = includesCover ? requested - 1 : requested;
  const contentSlides = Math.max(1, Math.min(OUTLINE_LIMITS.maxContentSlides, wanted));
  return { requested, includesCover, contentSlides, totalSlides: contentSlides + 1, clamped: wanted > OUTLINE_LIMITS.maxContentSlides };
}

/** The line of the planning prompt that fixes the size of the deck: an exact number of content slides (the title slide is added separately). */
export function slideCountInstruction(contentSlides: number): string {
  return `The person asked for a deck of ${contentSlides + 1} slides in total. Create EXACTLY ${contentSlides} content slide${contentSlides === 1 ? '' : 's'} in "slides" - the title slide is added separately from "title" and "subtitle" and is NOT one of them. Do not return more or fewer content slides.`;
}
