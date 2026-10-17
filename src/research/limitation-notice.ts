// The sentence a person reads when NAgex could not check current facts: in THEIR language, saying what happened and what it means for the answer below it - not a bare "tool unavailable".
import type { RequestLanguage } from '../common/request-language.js';
import type { EvidencePack } from '../research/evidence-pack.types.js';
import type { WebMode } from './evidence-pack.service.js';

export function parseWebMode(body: unknown): WebMode {
  const meta = body && typeof body === 'object' ? (body as Record<string, unknown>).requestMetadata : undefined;
  const flag = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).allowWebResearch : undefined;
  return flag === false ? 'OFF' : flag === true ? 'ON' : 'UNSPECIFIED';
}

const REASON_KO: Record<string, string> = {
  DISABLED: '웹 검색이 꺼져 있어',
  UNAVAILABLE: '이 NAgex에 웹 검색 서비스가 설정되어 있지 않아',
  AUTH_FAILED: '웹 검색 서비스가 인증을 거부해',
  RATE_LIMITED: '웹 검색 서비스가 지금은 요청을 받지 않아',
  TIMEOUT: '웹 검색 서비스의 응답이 너무 늦어',
  NO_RESULTS: '검색에서 쓸 만한 출처를 찾지 못해',
};
const REASON_EN: Record<string, string> = {
  DISABLED: 'web search is turned off',
  UNAVAILABLE: 'no web search service is set up on this NAgex',
  AUTH_FAILED: 'the web search service rejected its credential',
  RATE_LIMITED: 'the web search service is not accepting requests right now',
  TIMEOUT: 'the web search service took too long to answer',
  NO_RESULTS: 'the search found no usable sources',
};

// Questions whose whole answer IS a live value - a price, a quote, the weather, a headline, an opening hour. From memory such an answer is not "possibly outdated", it is invented, so without sources
// NAgex does not answer them at all (R22.4: FAKE_SUCCESS_PATHS = 0). Every other category (a product's specifications, a technology, a company, a policy) is knowledge a model really has, so an answer
// that is clearly labelled as unverified is more useful than silence - and is what the person gets.
const LIVE_VALUE_CATEGORIES = new Set(['MARKET', 'FINANCE', 'FORECAST', 'PRODUCT_PRICE', 'NEWS', 'TRAVEL', 'LOCAL']);

export function mustNotAnswerWithoutEvidence(pack: EvidencePack | undefined): boolean {
  if (!pack || pack.sources.length > 0) return false;
  if (pack.freshnessRequirement !== 'REQUIRED' || pack.status === 'NOT_REQUIRED') return false;
  return LIVE_VALUE_CATEGORIES.has(pack.category);
}

/** The whole reply for a live-value question that could not be checked: what happened, why NAgex does not guess, and what the person can do. */
export function liveValueRefusal(pack: EvidencePack, language: RequestLanguage): string {
  if (language === 'ko') {
    const reason = REASON_KO[pack.status] ?? '웹 검색에서 출처를 가져오지 못해';
    return `${reason}, 이 질문에 필요한 현재 정보(시세·날씨·가격·최신 소식 등)를 확인할 수 없습니다. 기억에 의존해 답하면 틀린 값을 드릴 수 있어 답변을 보류합니다. 웹 검색을 켠 상태에서 다시 물어보시거나, 확인할 수 있는 공식 페이지 주소를 알려 주세요.`;
  }
  const reason = REASON_EN[pack.status] ?? 'the web search returned no sources';
  return `I can't verify current information right now because ${reason}. This question needs a current value (a price, quote, weather or latest news), and answering from memory could give you a wrong one, so I'm holding back. Ask again with web search on, or send me a link to an official page I can read.`;
}

/** Null when the answer does not need a notice (it is grounded in sources, or nothing current was asked). */
export function limitationNotice(pack: EvidencePack | undefined, language: RequestLanguage): string | null {
  if (!pack || pack.sources.length > 0) return null;
  if (pack.freshnessRequirement === 'NONE' || pack.status === 'NOT_REQUIRED') return null;
  // "may benefit from current sources" is not a promise to check: with the Web switch off, only a REQUIRED question gets the notice
  if (pack.freshnessRequirement === 'OPTIONAL' && pack.status === 'DISABLED') return null;
  if (language === 'ko') {
    const reason = REASON_KO[pack.status] ?? '웹 검색에서 출처를 가져오지 못해';
    return `※ ${reason}, 이 질문의 최신 정보를 확인하지 못했습니다. 아래 내용은 확인되지 않은 것이며 오늘 기준으로 달라졌을 수 있습니다.`;
  }
  const reason = REASON_EN[pack.status] ?? 'the web search returned no sources';
  return `Note: ${reason}, so the current facts for this question could not be checked. What follows is unverified and may be out of date as of today.`;
}
