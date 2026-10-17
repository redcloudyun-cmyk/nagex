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
  | 'PRODUCT'
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

const TEXT_TRANSFORM_TASK = /(번역해|번역\s*좀|영어로\s*(옮겨|바꿔)|한국어로\s*(옮겨|바꿔)|교정해|첨삭|맞춤법|다듬어|고쳐\s*줘|\b(translate|proofread|paraphrase|rewrite|reword|fix the grammar)\b)/i;

// JavaScript's \b is an ASCII word boundary: between a Hangul syllable and a space (or another syllable) there is none, so a Korean word wrapped in \b never matched ("주가", "날씨", "가격" were
// invisible). Latin keywords keep their word boundaries; Korean keywords are matched as substrings, because Korean attaches particles to the word ("주가를", "날씨가").
const has = (lower: string, latin: RegExp, korean: RegExp): boolean => latin.test(lower) || korean.test(lower);

const MARKET = { latin: /\b(stock|stocks|market|crypto|btc|eth|nasdaq|dow|exchange rate|share price)\b/i, korean: /(주가|환율|시세|증시|코스피|코스닥|나스닥|비트코인|코인\s*(가격|시세))/ };
// "얼마" alone also means "how long / how much (not money)" (얼마나 걸려?) - only the price readings count
const PRICE = { latin: /\b(price of|prices of|how much is|how much does|cost of|msrp)\b/i, korean: /(가격|값이|얼마\s*(예요|에요|야|인가요?|입니까|죠|지|니|냐|일까|정도에\s*(팔|판매|살))|최저가|할인가|출고가)/ };
const PRICE_WORD_ONLY = /(가격|값이|최저가|할인가|출고가)/;
const MEASURABLE_ATTRIBUTE_BEFORE_HOW_MUCH = /(용량|무게|크기|길이|속도|시간|거리|배터리|화소|나이|온도|높이|두께|면적|해상도|주사율|전력|메모리|저장|밝기)[^\n?]{0,8}얼마/;
const FORECAST = { latin: /\b(forecast|weather|predict|prediction)\b/i, korean: /(날씨|일기\s*예보|기온|미세먼지|전망|예보)/ };
const LAW = { latin: /\b(law|laws|regulation|regulations|policy|policies|bill|act|tax rules?)\b/i, korean: /(법안|법률|규제|정책|시행령|개정안|세법|과태료|신청\s*(방법|절차)|지원금)/ };
const POLITICS = { latin: /\b(election|president|minister|politician)\b/i, korean: /(정치|선거|대통령|국회의원|국회|장관|총리)/ };
const NEWS = { latin: /\b(news|headline|headlines|breaking)\b/i, korean: /(뉴스|속보|기사|보도|논란)/ };
const TRAVEL = { latin: /\b(flight|flights|hotel|hotels|traffic|restaurant near)\b/i, korean: /(맛집|항공권|항공편|호텔|숙소|교통\s*상황|운행\s*(시간|정보)|영업\s*시간)/ };
const TECHNOLOGY = { latin: /\b(kernel|release|version|framework|library|patch|lts)\b/i, korean: /(업데이트|버전|릴리[스즈]|패치|리눅스\s*커널|지원\s*(여부|하나요|되나요|하는지))/ };
const COMPANY = { latin: /\b(company|ceo|earnings|revenue|quarterly)\b/i, korean: /(기업|실적|매출|영업\s*이익|대표이사|인수|합병)/ };

// A PRODUCT question: a thing that is sold, released or specified, where "the newest one" changes the answer and what a model remembers is the oldest part of it.
//   - a VERSIONED NAME is a name followed by a number (Fold7, iPhone 17, RTX 5090, 폴드7, S25, Pixel 10): successive models of one line differ exactly where the question is asked;
//   - RELEASE words ask whether/when something exists or is on sale; SPEC/COMPARE words ask what differs between things.
// Nothing here knows any product: the structure of the question is what is recognised.
const VERSIONED_NAME = /(?:[A-Za-z][A-Za-z+]{1,}\s?-?\d{1,4}[A-Za-z]{0,3}|[가-힣]{2,}\s?\d{1,3}(?![가-힣0-9.]*(?:개|명|번|가지|종|곳|대|건|단계|원|퍼센트|%|시|분|초|일|월|년|층|장|권|차|회|등|위))|\b[A-Z]\d{1,3}\b)/;
const RELEASE_WORDS = /(출시|발매|발표\s*(됐|되었|했|한|된|일|예정)|공개\s*(됐|되었|했|한|된|일|예정)|판매\s*(중|되|시작|하고)|판매되고|예약\s*(판매|구매|시작)|미출시|신제품|신형|후속\s*(작|모델|기종)|차기\s*(모델|작|기종)|\b(release[sd]?|launch(?:ed|es|ing)?|announce[sd]?|unveil(?:ed|s)?|on sale|available (now|in|from)|successor|upcoming|new model|pre-?order)\b)/i;
// asking whether, or when, something came out: a question about the present state of the world whatever the thing is called
const RELEASE_STATUS_QUESTION = /(출시\s*(여부|됐|되었|되나|됬|했는지|했나|예정|시기|언제|날짜|일정)|발매\s*(여부|일|됐|되었|예정)|\b(released|launched|available) yet\b|\bis (it|\S+( \S+){0,3}) (out|released|available|on sale)\b|\brelease date\b)/i;
const SPEC_WORDS =/(스펙|사양|제원|성능|배터리|카메라|디스플레이|화면\s*크기|무게|비교|차이|\b(vs\.?|versus|compare|comparison|differences?|specs?|specifications?|benchmark|battery|camera|display)\b)/i;

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

    // Work ON a text the person supplied (translate it, proofread it, rewrite it) is not a question about the world: the words inside the text ("날씨", "price") do not make it one - unless the request
    // itself asks for current material.
    if (TEXT_TRANSFORM_TASK.test(text) && !REQUIRED_RECENCY_KEYWORDS.some((kw) => lower.includes(kw) && kw !== '오늘' && kw !== 'today')) {
      return { freshness: 'NONE', category: 'GENERAL', reason: 'A request to transform text the person supplied does not need a web search.' };
    }

    // Timeless educational / generic checks
    const isTimelessTechDef = /\b(what is|explain|how does|definition of|concept of)\s+(tcp\/ip|http|https|git|binary|dns|algorithm|recursion|oop|dbms)\b/i.test(lower);
    if (isTimelessTechDef) {
      return { freshness: 'NONE', category: 'GENERAL', reason: 'Timeless concept definition does not require web search.' };
    }

    // Check category specific patterns
    if (has(lower, MARKET.latin, MARKET.korean)) {
      return { freshness: 'REQUIRED', category: 'MARKET', reason: 'Market and financial prices require current data.' };
    }

    // "얼마" is also "how much" of a measurable attribute (배터리 용량이 얼마야, 무게가 얼마야): that is a specification question, not a price
    const asksQuantityOfAttribute = MEASURABLE_ATTRIBUTE_BEFORE_HOW_MUCH.test(text);
    if (has(lower, PRICE.latin, asksQuantityOfAttribute ? PRICE_WORD_ONLY : PRICE.korean)) {
      return { freshness: 'REQUIRED', category: 'PRODUCT_PRICE', reason: 'Product price query requires current evidence.' };
    }

    if (has(lower, FORECAST.latin, FORECAST.korean)) {
      return { freshness: 'REQUIRED', category: 'FORECAST', reason: 'Forecast query depends on current facts.' };
    }

    // a named, versioned thing that is released, on sale or compared: what exists today is the question
    const versioned = VERSIONED_NAME.test(text);
    const release = RELEASE_WORDS.test(text);
    const spec = SPEC_WORDS.test(text);
    if ((versioned && (release || spec)) || RELEASE_STATUS_QUESTION.test(text) || (release && /(신제품|신형|후속|차기|출시일|발매일|\b(release date|new model|successor|upcoming)\b)/i.test(text))) {
      return { freshness: 'REQUIRED', category: 'PRODUCT', reason: 'A question about the release, availability or specifications of a named product depends on what exists today.' };
    }

    if (has(lower, LAW.latin, LAW.korean)) {
      if (REQUIRED_RECENCY_KEYWORDS.some((kw) => lower.includes(kw))) {
        return { freshness: 'REQUIRED', category: 'LAW', reason: 'Current legal/policy query requires updated evidence.' };
      }
      return { freshness: 'OPTIONAL', category: 'POLICY', reason: 'Policy query may benefit from current sources.' };
    }

    if (has(lower, POLITICS.latin, POLITICS.korean)) {
      return { freshness: 'REQUIRED', category: 'POLITICS', reason: 'Political query requires up-to-date information.' };
    }

    if (has(lower, NEWS.latin, NEWS.korean)) {
      return { freshness: 'REQUIRED', category: 'NEWS', reason: 'News queries strictly require fresh evidence.' };
    }

    if (has(lower, TRAVEL.latin, TRAVEL.korean)) {
      return { freshness: 'REQUIRED', category: 'TRAVEL', reason: 'Travel/local query requires live search.' };
    }

    if (has(lower, TECHNOLOGY.latin, TECHNOLOGY.korean)) {
      if (REQUIRED_RECENCY_KEYWORDS.some((kw) => lower.includes(kw)) || lower.includes('linux kernel')) {
        return { freshness: 'REQUIRED', category: 'TECHNOLOGY', reason: 'Technology release status requires live evidence.' };
      }
      return { freshness: 'OPTIONAL', category: 'TECHNOLOGY', reason: 'Technology topic may use recent documentation.' };
    }

    if (has(lower, COMPANY.latin, COMPANY.korean)) {
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
