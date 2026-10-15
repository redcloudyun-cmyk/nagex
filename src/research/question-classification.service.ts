export type FreshnessRequirement = 'NONE' | 'OPTIONAL' | 'REQUIRED';

export type QuestionCategory =
  | 'GENERAL'
  | 'NEWS'
  | 'MARKET'
  | 'FINANCE'
  | 'COMPANY'
  | 'POLITICS'
  | 'POLICY'
  | 'LAW'
  | 'TECHNOLOGY'
  | 'TRAVEL'
  | 'LOCAL'
  | 'PRODUCT_PRICE'
  | 'FORECAST';

export interface QuestionClassification {
  freshness: FreshnessRequirement;
  category: QuestionCategory;
  reason: string;
}

const REQUIRED_RECENCY_KEYWORDS = [
  'latest',
  'current',
  'today',
  'recent',
  'now',
  'this week',
  'this month',
  'this year',
  '2026',
  'newest',
  'real-time',
  'live',
  '최신',
  '현재',
  '오늘',
  '최근',
  '지금',
  '이번 주',
  '올해',
  '실시간',
];

const RESEARCH_INTENT_PREFIXES = [
  'research',
  'look up',
  'find current',
  'search for',
  'find latest',
  '조사',
  '검색',
  '최신 동향',
];

// Questions about the person's OWN clock, calendar or to-dos ("지금 몇 시야?", "오늘 일정 알려줘", "what is on my calendar today?"). The words "today" / "오늘" / "now" / "지금" in them mean the person's day,
// not breaking news: the answer comes from NAgex's clock and the person's connected calendar, never from a web search - and when those are unavailable the reply must say so, not claim that "live web
// search is unavailable".
const PERSONAL_CLOCK_QUESTION = /(지금|현재)\s*(몇\s*시|시간|날짜|며칠)|몇\s*시(야|예요|입니까|인가요|지)|몇\s*일(이야|이에요|인가요)|무슨\s*요일|오늘\s*(날짜|며칠|무슨\s*요일)|what('?s| is)\s+(the\s+)?(current\s+)?(time|date|day)\b|what\s+(time|day)\s+is\s+it|today'?s\s+date/i;
const PERSONAL_PLANNER_QUESTION = /((오늘|내일|모레|이번\s*주|다음\s*주|이번\s*달)[^\n]{0,20}(일정|스케줄|캘린더|약속|할\s*일)|(일정|스케줄|캘린더|약속|할\s*일)[^\n]{0,20}(오늘|내일|모레|이번\s*주|다음\s*주))|\b(my|on my)\s+(calendar|schedule|agenda|to-?do|tasks?|meetings?|appointments?)\b|\bwhat('?s| is)\s+(on\s+)?(my\s+)?(calendar|schedule|agenda)\b/i;

export class QuestionClassificationService {
  public classify(prompt: string): QuestionClassification {
    const text = (prompt || '').trim();
    if (!text) {
      return { freshness: 'NONE', category: 'GENERAL', reason: 'Empty prompt requires no external search.' };
    }

    if (PERSONAL_CLOCK_QUESTION.test(text) || PERSONAL_PLANNER_QUESTION.test(text)) {
      return { freshness: 'NONE', category: 'GENERAL', reason: "A question about the person's own clock, calendar or tasks is answered from their clock and connected sources, not the web." };
    }

    const lower = text.toLowerCase();

    // Timeless educational / generic checks
    const isTimelessTechDef = /\b(what is|explain|how does|definition of|concept of)\s+(tcp\/ip|http|https|git|binary|dns|algorithm|recursion|oop|dbms)\b/i.test(lower);
    if (isTimelessTechDef) {
      return { freshness: 'NONE', category: 'GENERAL', reason: 'Timeless concept definition does not require web search.' };
    }

    // Check category specific patterns
    if (/\b(stock|market|crypto|btc|eth|nasdaq|dow|exchange rate|주가|환율|시세)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'MARKET', reason: 'Market and financial prices require current data.' };
    }

    if (/\b(price of|how much is|cost of|가격|얼마)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'PRODUCT_PRICE', reason: 'Product price query requires current evidence.' };
    }

    if (/\b(forecast|weather|predict|날씨|일기예보|전망)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'FORECAST', reason: 'Forecast query depends on current facts.' };
    }

    if (/\b(law|regulation|policy|bill|act|법안|규제|정책)\b/i.test(lower)) {
      if (REQUIRED_RECENCY_KEYWORDS.some((kw) => lower.includes(kw))) {
        return { freshness: 'REQUIRED', category: 'LAW', reason: 'Current legal/policy query requires updated evidence.' };
      }
      return { freshness: 'OPTIONAL', category: 'POLICY', reason: 'Policy query may benefit from current sources.' };
    }

    if (/\b(election|president|minister|politician|정치|선거|대통령)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'POLITICS', reason: 'Political query requires up-to-date information.' };
    }

    if (/\b(news|headline|breaking|뉴스|속보|기사)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'NEWS', reason: 'News queries strictly require fresh evidence.' };
    }

    if (/\b(flight|hotel|traffic|restaurant near|맛집|항공권|호텔)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'TRAVEL', reason: 'Travel/local query requires live search.' };
    }

    if (/\b(kernel|release|version|framework|library|patch|업데이트|버전|리눅스 커널)\b/i.test(lower)) {
      if (REQUIRED_RECENCY_KEYWORDS.some((kw) => lower.includes(kw)) || lower.includes('linux kernel')) {
        return { freshness: 'REQUIRED', category: 'TECHNOLOGY', reason: 'Technology release status requires live evidence.' };
      }
      return { freshness: 'OPTIONAL', category: 'TECHNOLOGY', reason: 'Technology topic may use recent documentation.' };
    }

    if (/\b(company|ceo|earnings|revenue|quarterly|기업|실적)\b/i.test(lower)) {
      return { freshness: 'REQUIRED', category: 'COMPANY', reason: 'Company/corporate query requires up-to-date data.' };
    }

    // Temporal recency keywords check
    const hasRecencyKeyword = REQUIRED_RECENCY_KEYWORDS.some((kw) => lower.includes(kw));
    const hasResearchIntent = RESEARCH_INTENT_PREFIXES.some((prefix) => lower.includes(prefix));

    if (hasRecencyKeyword || hasResearchIntent) {
      return { freshness: 'REQUIRED', category: 'NEWS', reason: 'Explicit temporal or research intent detected.' };
    }

    return { freshness: 'NONE', category: 'GENERAL', reason: 'General timeless question does not require web search.' };
  }
}
