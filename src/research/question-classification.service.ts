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

export class QuestionClassificationService {
  public classify(prompt: string): QuestionClassification {
    const text = (prompt || '').trim();
    if (!text) {
      return { freshness: 'NONE', category: 'GENERAL', reason: 'Empty prompt requires no external search.' };
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
