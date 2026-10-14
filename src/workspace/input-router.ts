import { detectRequestLanguage, type RequestLanguage } from '../common/request-language.js';
import { classifyPlanRequest } from '../model-gateway/plan-request-kind.js';

// Legacy surface (kept compatible for every existing caller: Quick Wake, mobile, tests): what KIND of input arrived.
export type InputIntent =
  | 'ASK'
  | 'COMMAND'
  | 'CAPTURE'
  | 'UPLOAD'
  | 'LINK_CAPTURE'
  | 'AUDIO_CAPTURE';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// One Input, Any Outcome: the SERVER-OWNED routing decision for ordinary Korean / English requests.
//
// The decision tells the client WHICH EXISTING path serves the request (answer, advice, research, a created artifact, an approval-gated action plan, a capture) or
// that NAgex cannot do it (video, a running code app) or needs one more detail. It is ADVICE ABOUT ROUTING ONLY: it carries no authority. Every path it selects
// still enforces its own rights, and everything with an external consequence still ends in the unchanged Human Approval. Deterministic, bounded, stateless,
// side-effect free, no model call - a wrong guess can only choose a less fitting SAFE path (an answer instead of a document), never an unapproved action:
//   * anything that asks for something to be DONE in the world is ACTION_PLAN (a plan to review; nothing runs by itself);
//   * a negated action ("don't send", "보내지 말고") never becomes an action;
//   * when nothing is recognised the request is a plain conversation.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type RoutingKind = 'CONVERSATION' | 'ADVICE' | 'RESEARCH' | 'CREATE_ARTIFACT' | 'ACTION_PLAN' | 'CAPTURE' | 'UNSUPPORTED' | 'CLARIFY';
export type ArtifactTarget = 'DOCUMENT' | 'PRESENTATION' | 'IMAGE' | 'VIDEO' | 'CODE';
export type NeedCapability = 'ANSWER' | 'ADVICE' | 'RESEARCH' | 'DOCUMENT' | 'PRESENTATION' | 'IMAGE' | 'VIDEO' | 'CODE' | 'ACTION' | 'CAPTURE';
export type PermissionRisk = 'NONE' | 'EXTERNAL_READ' | 'LOCAL_CREATE' | 'EXTERNAL_CONSEQUENTIAL';

export interface IntentNeed {
  capability: NeedCapability;
  // false = NAgex has no real path for it in Main today (never advertised as available)
  supported: boolean;
  // set when this need ends in the person's approval before any external change
  approvalRequired?: boolean;
}

export interface RoutingDecision {
  version: 1;
  kind: RoutingKind;
  targetArtifactType: ArtifactTarget | null;
  // ordered, only what the request actually asked for; compound === needs.length > 1
  needs: IntentNeed[];
  compound: boolean;
  // true when every need has a real path today
  supported: boolean;
  language: RequestLanguage;
  confidence: number;
  ambiguity: { level: 'NONE' | 'LOW' | 'HIGH'; reason: string | null; clarifyingQuestion: { ko: string; en: string } | null };
  permissionRisk: PermissionRisk;
  destructive: boolean;
  // the person said NOT to do the consequential part ("draft it, do not send it")
  executionNegated: boolean;
  reasonCodes: string[];
}

export interface InputClassificationResult {
  primaryIntent: InputIntent;
  confidence: number;
  reason: string;
  normalizedPayload: {
    rawInput: string;
    url?: string;
    mimeType?: string;
    cleanText?: string;
  };
  decision: RoutingDecision;
}

export interface ClassifyInput {
  text?: string;
  hasFile?: boolean;
  hasAudio?: boolean;
  mimeType?: string;
  // the optional shortcut the person picked (never required, never authority)
  hint?: { artifactType?: string | null; capability?: string | null } | null;
}

// ----- cue tables (substring matches for Korean, word-aware for English) -----------------------------------------------------------------------------------

const VIDEO_MAKE = [
  /(영상|비디오|동영상|애니메이션|쇼츠|릴스|트레일러)[^.!?\n]{0,10}(만들|만드|제작|생성|뽑아)/,
  /(만들|만드|제작|생성)[^.!?\n]{0,8}(영상|비디오|동영상|애니메이션)/,
  /\b(make|create|generate|produce|render|shoot|animate)\b[^.!?\n]{0,20}\b(video|videos|animation|clip|reel|trailer|movie|film)\b/i,
  /\b(video|animation|clip|reel|trailer)\b[^.!?\n]{0,14}\b(make|create|generate|produce)\b/i,
];

// something that RUNS: a site, an app, a bot, a game - or code that has to be executed / deployed
const CODE_APP = [
  /(웹\s*사이트|웹사이트|웹\s*앱|웹앱|홈페이지|랜딩\s*페이지|앱|어플|챗봇|게임|사이트)[^.!?\n]{0,14}(만들|개발|구현|제작|코딩|짜\s*(줘|주)|배포|호스팅|실행)/,
  /(만들|개발|구현|제작|코딩)[^.!?\n]{0,10}(웹\s*사이트|웹사이트|웹\s*앱|웹앱|홈페이지|앱|어플|챗봇|게임)/,
  /\b(build|create|make|develop|code|deploy|host|launch)\b[^.!?\n]{0,24}\b(web ?site|web ?app|app|application|chatbot|bot|game|landing page)\b/i,
];
const CODE_RUN = [
  /(코드|소스|스크립트|프로그램)[^.!?\n]{0,12}(실행|돌려|배포|호스팅)|(실행|배포|호스팅)[^.!?\n]{0,12}(코드|소스|스크립트|프로그램)/,
  /\b(run|execute|deploy)\b[^.!?\n]{0,16}\b(code|script|program)\b|\b(code|script|program)\b[^.!?\n]{0,16}\b(run|execute|deploy)\b/i,
];

const DOC_NOUN = /(보고서|리포트|문서|기획서|제안서|회의록|요약서|소개서|계획서|명세서|설계서|매뉴얼|가이드|칼럼|블로그\s*글|브리프|한\s*페이지|원\s*페이저|\b(report|document|doc|memo|brief|proposal|one-?pager|minutes|white ?paper|write-?up|essay|article)\b)/i;
const SLIDE_NOUN = /(슬라이드|프레젠테이션|프리젠테이션|발표\s*자료|발표자료|피티|파워\s*포인트|파워포인트|\bppt\b|\bpptx\b|\b(slides?|slide deck|deck|presentation|powerpoint|keynote)\b)/i;
const IMAGE_NOUN = /(이미지|그림|사진|일러스트|삽화|로고|포스터|썸네일|배너|아이콘|캐릭터|\b(image|images|picture|illustration|logo|poster|thumbnail|banner|icon|artwork|drawing|photo)\b)/i;
const MAKE_VERB_KO = /(만들|만드|작성|써\s*(줘|주|라|봐)|써줘|생성|제작|그려|그리|뽑아|디자인|준비해\s*(줘|주)|정리해서|정리해\s*(줘|주)|바꿔\s*(줘|주)|변환|완성)/;
const MAKE_VERB_EN = /\b(make|create|write|draft|generate|produce|build|design|draw|compose|put together|prepare|turn (this|it|that) into|convert (this|it|that) (in)?to)\b/i;
const DRAW_KO = /그려\s*(줘|주세요|줄래|봐)/;

const RESEARCH_CUE = [
  /(조사|리서치|검색해|검색\s*해|알아봐|알아보|동향|트렌드|시장\s*분석|경쟁사\s*분석|출처|근거를?\s*(들|제시)|레퍼런스|참고\s*자료를?\s*찾)/g,
  /\b(research|investigate|look up|look into|find out|search (for|the web|online)|with (sources|citations|references)|cite (your )?sources|cite|market (analysis|trends?)|competitor analysis|latest (news|trends?|developments)|state of the art)\b/gi,
];
const EXPLICIT_RESEARCH = /(조사|리서치|출처|research|investigate|sources|citations)/i;

// A request for something to be DONE in the world (communicate, schedule, change, delete, spend, publish)
const KO_ACT_STEM = '(보내|전송|발송|답장|회신|전달|예약|잡아|취소|삭제|지워|지우|제거|초대|수락|거절|연기|미뤄|결제|구매|주문|송금|환불|게시|올려|공유|등록|추가|변경|수정|옮겨|이동|저장|설정|리마인드|연결)';
const KO_REQUEST_END = '(줘|주세요|주라|줄래|줄\\s*수\\s*있|줄\\s*수\\s*없|해\\s*줘|해\\s*주세요|해\\s*줄래|해\\s*줄\\s*수|해라|하세요|해봐|해\\s*봐|할래|합시다)';
const KO_ACTION = new RegExp(KO_ACT_STEM + '\\S{0,4}\\s*' + KO_REQUEST_END);
const KO_ACTION_EVENT = new RegExp('(일정|이벤트|리마인더|알람|약속|예약)[^.!?\\n]{0,10}(잡|등록|추가|만들|생성|변경|수정|취소|옮기)[^.!?\\n]{0,4}' + KO_REQUEST_END);
const KO_ACTION_MEETING = new RegExp('(회의|미팅)[^.!?\\n]{0,10}(잡|등록|취소|옮기|변경|수정)[^.!?\\n]{0,4}' + KO_REQUEST_END);
const EN_ACT_VERB = '(send|email|e-mail|reply|respond|forward|schedule|reschedule|book|reserve|invite|cancel|postpone|rsvp|delete|erase|trash|remove|publish|post|tweet|upload|submit|pay|purchase|buy|order|transfer|donate|refund|deploy|install|approve|reject|subscribe|unsubscribe|share|remind me|set up)';
const EN_ACTION_LEAD = '(?:^|[.!?;,:]\\s*|\\b(?:and|then|please|also|just|now|first|next|can you|could you|would you|will you|go ahead and|i want you to|i need you to|i\'d like you to|i would like you to|i need to|i want to|i have to|i\'d like to|let\'s)\\s+)';
const EN_ACTION = new RegExp(EN_ACTION_LEAD + '(?:please\\s+)?' + EN_ACT_VERB + '\\b', 'i');
const EN_ACTION_OBJECT = /\b(create|add|make|set up|put|schedule)\b[^.!?\n]{0,16}\b(calendar event|event|meeting|appointment|reminder|task|to-?do|call)\b(?!\s+(agenda|summary|notes|minutes|report|doc|document|brief|template|invitation|invite))/i;
// asking NAgex to USE something the person connected ("use my test tool to ...", "도구로 ... 실행해줘") is an action on that tool: a plan whose tool step waits for approval
const TOOL_USE = [
  /\b(use|run|call|invoke|trigger|ask)\b[^.!?\n]{0,30}\b(tool|tools|connector|integration|plugin|mcp)\b/i,
  /(도구|툴|커넥터|연동|플러그인)[^.!?\n]{0,12}(써\s*(서|줘)|사용|실행|호출|돌려)/,
];
const DESTRUCTIVE = [/(삭제|지워|지우|제거|취소|없애|폐기)\S{0,4}\s*(줘|주세요|해\s*줘|해\s*주세요|해라|하세요|줄래|해\s*줄래)/, /\b(delete|erase|remove|trash|cancel|wipe|discard)\b/i];

// "don't send it" / "보내지 말고": the negated verb is removed before the action check; a negation never creates an action
const KO_NEGATION = /(보내|전송|발송|답장|회신|삭제|지우|지워|취소|공유|게시|결제|예약|제출|구매|주문|전달|등록)(하)?지(는|를)?\s*(말고|마|말아|말라|않고|못하게|않도록|않게)/g;
const EN_NEGATION = /\b(don'?t|do not|never|without|no need to|not to|avoid|instead of)\s+(?:\w+\s+){0,2}?(send(ing)?|email(ing)?|post(ing)?|delete|deleting|schedule|scheduling|book(ing)?|cancel(ing)?|publish(ing)?|share|sharing|submit(ting)?|pay(ing)?|buy(ing)?|order(ing)?|forward(ing)?|reply(ing)?|invit(e|ing))\b/gi;
const DRAFT_ONLY = /(초안만|작성만|쓰기만|만들기만|\bdraft (only|just)\b|\bjust (a )?draft\b|\bonly (a )?draft\b|\bdraft it only\b)/i;

// plain information questions are conversation, even when an action word appears inside the question ("how do I send an email?")
const EN_INFO_QUESTION = /^\s*(how|what|why|who|when|where|which|is|are|does|do|did|explain|describe|tell me (about|how|why|what)|what's|whats)\b/i;
const KO_INFO_QUESTION = /(어떻게|무엇|뭐|왜|언제|어디|누구|방법|차이|이유|뜻|의미|인가요|나요|ㄹ까요|할까요|일까요|있을까|될까|좋을까)/;

// a plain factual question ("what is X? explain it") is a conversation; only words that really ask for a recommendation, a preparation or a priority make it advice
const STRONG_ADVICE = /(\b(what|how) should\b|\bshould i\b|\bprepare\b|\bsuggest|\brecommend|\badvi[cs]e|\bprioriti[sz]e|\bnext (action|step|move)s?\b|\btalking points\b|조언|추천|제안|준비|우선순위|어떻게\s*(해야|하면)|무엇을\s*(해야|하면)|뭘\s*(해야|하면)|다음\s*(행동|단계|할\s*일))/i;

// vague: nothing to route, ask one question
const VAGUE = [
  /^(그거|이거|저거|그것|이것|그냥|뭔가|아무거나|알아서|좀|도와줘|도와주세요|해줘|해주세요|해봐|부탁해|부탁해요|고쳐줘|바꿔줘)(\s+(그거|이거|저거|그것|이것|좀|해줘|해주세요|해봐|부탁해|부탁해요|도와줘|도와주세요|고쳐줘|바꿔줘))*[.!?]*$/,
  /^(do it|do that|do this|help|help me|please help|fix it|fix this|change it|make it better|make it good|just do it|something|anything|that one|this one)[.!?]*$/i,
];

const TOPIC_STRIP = new RegExp([
  // counts ("10장") are a size, not a topic
  '\\d+\\s*(장|페이지|개|slides?|pages?)',
  // artifact nouns
  '보고서|리포트|문서|기획서|제안서|회의록|요약서|브리프|한\\s*페이지|슬라이드|프레젠테이션|프리젠테이션|발표\\s*자료|발표자료|피티|파워\\s*포인트|파워포인트|이미지|그림|사진|일러스트|삽화|로고|포스터|썸네일|배너|아이콘|캐릭터',
  // verbs, connectives, politeness, particles, demonstratives
  '만들어|만들|만드|작성|정리|바꿔|변환|써줘|써|생성|제작|그려|그리|뽑아|디자인|완성|해서|하고|그리고|해줘|해주세요|해\\s*줄래|줘|주세요|좀|하나|한\\s*장|한|장|개|이런|그런|저런|주제|내용|이|그|저|같은|처럼|비슷한|이렇게|이걸로|이거로|이\\s*주제로|이\\s*내용으로|위\\s*내용으로|위\\s*내용|을|를|은|는|가|에|로|으로|의|도|만|해|서|고',
  // english filler
  '\\b(a|an|the|me|my|please|make|create|generate|write|draw|design|produce|image|picture|logo|poster|report|document|memo|slides?|deck|presentation|of|like|this|that|these|those|one|some|for|about|on|with|from|and|then|into)\\b',
].join('|'), 'gi');

function stripTopicNoise(text: string): string {
  return text.replace(TOPIC_STRIP, ' ').replace(/[\s.,!?;:'"“”‘’()\[\]{}\-~·…]+/g, ' ').trim();
}

const CLARIFY_TOPIC: Record<'DOCUMENT' | 'PRESENTATION' | 'IMAGE', { ko: string; en: string }> = {
  DOCUMENT: { ko: '어떤 내용으로 문서를 만들까요? 주제나 담을 내용을 알려주세요.', en: 'What should the document be about? Tell me the topic or what it should cover.' },
  PRESENTATION: { ko: '슬라이드 주제와 대략적인 장수를 알려주세요.', en: 'What is the presentation about, and roughly how many slides?' },
  IMAGE: { ko: '어떤 이미지를 원하세요? 무엇을 담을지 한 줄로 설명해 주세요.', en: 'What image would you like? Describe what it should show in a line.' },
};
const CLARIFY_VAGUE = { ko: '무엇을 도와드릴까요? 하고 싶은 일을 한 문장으로 알려주세요.', en: 'What would you like help with? Tell me what you want to get done in one sentence.' };

// "make slides from THIS topic": the words point at something said before; the client may supply that context, otherwise it asks
const CONTEXT_REFERENCE = /(이\s*주제|이\s*내용|위\s*내용|위의|이것|이거|이걸|이런|그런|방금|앞서|\bthis (topic|content|conversation)\b|\bthe above\b|\bwhat you (just )?said\b|\b(from|about) (this|that|above)\b)/i;

function hintTarget(hint: ClassifyInput['hint']): 'DOCUMENT' | 'PRESENTATION' | 'IMAGE' | 'RESEARCH' | null {
  const type = typeof hint?.artifactType === 'string' ? hint.artifactType.toUpperCase() : '';
  if (type === 'DOCUMENT' || type === 'PRESENTATION' || type === 'IMAGE') return type;
  const capability = typeof hint?.capability === 'string' ? hint.capability.toUpperCase() : '';
  return capability === 'RESEARCH' ? 'RESEARCH' : null;
}

function makeDecision(partial: Partial<RoutingDecision> & Pick<RoutingDecision, 'kind' | 'language'>): RoutingDecision {
  const needs = partial.needs ?? [];
  return {
    version: 1,
    targetArtifactType: null,
    needs,
    compound: needs.length > 1,
    supported: needs.every((n) => n.supported),
    confidence: 0.7,
    ambiguity: { level: 'NONE', reason: null, clarifyingQuestion: null },
    permissionRisk: 'NONE',
    destructive: false,
    executionNegated: false,
    reasonCodes: [],
    ...partial,
  };
}

const NO_AMBIGUITY = { level: 'NONE', reason: null, clarifyingQuestion: null } as const;

// "보내줘" alone is only an action; "설명하고 보내줘" also asks for an explanation
function asksOnlyAction(text: string): boolean {
  return text.replace(new RegExp(KO_ACT_STEM + '\\S{0,4}\\s*' + KO_REQUEST_END, 'g'), ' ').replace(/[\s.,!?]+/g, '').length < 6;
}

// The deterministic decision for a request's own words.
export function decideRouting(rawText: string, options: { hasAttachment?: boolean; hint?: ClassifyInput['hint'] } = {}): RoutingDecision {
  const text = (rawText || '').normalize('NFC').trim();
  const language = detectRequestLanguage(text);
  const hasAttachment = options.hasAttachment === true;
  const reasonCodes: string[] = [];

  if (!text) return makeDecision({ kind: 'CLARIFY', language, confidence: 0.99, ambiguity: { level: 'HIGH', reason: 'EMPTY_REQUEST', clarifyingQuestion: CLARIFY_VAGUE }, reasonCodes: ['EMPTY_REQUEST'] });

  // 1. negated execution: remove the negated verbs first, remember that the person said NOT to do it
  let work = text;
  let executionNegated = false;
  work = work.replace(KO_NEGATION, () => { executionNegated = true; return ' '; });
  work = work.replace(EN_NEGATION, () => { executionNegated = true; return ' '; });
  const draftOnly = DRAFT_ONLY.test(text);
  if (draftOnly) executionNegated = true;
  if (executionNegated) reasonCodes.push('EXECUTION_NEGATED');
  if (draftOnly) reasonCodes.push('DRAFT_ONLY');

  const makesSomething = MAKE_VERB_KO.test(work) || MAKE_VERB_EN.test(work);
  const hasDocNoun = DOC_NOUN.test(work);
  const hasSlideNoun = SLIDE_NOUN.test(work);
  const hasImageNoun = IMAGE_NOUN.test(work);

  // 2. unsupported creation kinds are detected BEFORE anything else: they must never fall through to a chat answer that pretends to be the deliverable
  if (VIDEO_MAKE.some((re) => re.test(work))) {
    return makeDecision({ kind: 'UNSUPPORTED', language, targetArtifactType: 'VIDEO', needs: [{ capability: 'VIDEO', supported: false }], confidence: 0.9, reasonCodes: [...reasonCodes, 'VIDEO_NOT_AVAILABLE'] });
  }
  const codeRun = CODE_RUN.some((re) => re.test(work));
  const codeApp = CODE_APP.some((re) => re.test(work));
  // "make a report ABOUT an app" is a document; only a request to build or run something is a code app
  if (codeRun || (codeApp && !hasDocNoun && !hasSlideNoun && !hasImageNoun)) {
    return makeDecision({ kind: 'UNSUPPORTED', language, targetArtifactType: 'CODE', needs: [{ capability: 'CODE', supported: false }], confidence: 0.85, reasonCodes: [...reasonCodes, 'CODE_APP_NOT_AVAILABLE'] });
  }

  // 3. consequential action: communicate / schedule / change / delete / spend / publish
  const koAction = KO_ACTION.test(work) || KO_ACTION_EVENT.test(work) || KO_ACTION_MEETING.test(work);
  const asksAction = koAction || EN_ACTION.test(work) || EN_ACTION_OBJECT.test(work) || TOOL_USE.some((re) => re.test(work));
  const isInfoQuestion = EN_INFO_QUESTION.test(work) || (language === 'ko' && KO_INFO_QUESTION.test(work));
  const conjoinedAction = /\b(and|then|and then)\s+(please\s+)?(send|email|forward|schedule|book|cancel|delete|post|share|publish|pay|buy|order|reply|invite)\b/i.test(work);
  // "how do I send an email?" asks for information; "explain it and send it to Alex" still asks for the send
  const actionRequested = asksAction && (!isInfoQuestion || conjoinedAction || koAction);
  const wantsResearch = RESEARCH_CUE.some((re) => { re.lastIndex = 0; return re.test(work); });
  const wantsDocument = hasDocNoun && makesSomething;
  const wantsSlides = hasSlideNoun && (makesSomething || /\d+\s*(장|페이지|slides?)/i.test(work));
  const wantsImage = (hasImageNoun && makesSomething) || DRAW_KO.test(work);

  if (actionRequested) {
    const destructive = DESTRUCTIVE.some((re) => re.test(work));
    const needs: IntentNeed[] = [];
    if (wantsResearch) needs.push({ capability: 'RESEARCH', supported: true });
    else if (/(설명|요약|정리|알려|explain|summari[sz]e)/i.test(work) && !asksOnlyAction(work)) needs.push({ capability: 'ANSWER', supported: true });
    needs.push({ capability: 'ACTION', supported: true, approvalRequired: true });
    return makeDecision({
      kind: 'ACTION_PLAN', language, needs, confidence: 0.88, permissionRisk: 'EXTERNAL_CONSEQUENTIAL', destructive, executionNegated,
      reasonCodes: [...reasonCodes, 'ACTION_REQUESTED', 'APPROVAL_REQUIRED', ...(destructive ? ['DESTRUCTIVE'] : []), ...(needs.length > 1 ? ['COMPOUND'] : [])],
    });
  }

  // 4. created artifacts (document / slides / image), possibly after research
  const target: ArtifactTarget | null = wantsSlides ? 'PRESENTATION' : wantsDocument ? 'DOCUMENT' : wantsImage ? 'IMAGE' : null;
  if (target) {
    const needs: IntentNeed[] = [];
    if (wantsResearch) needs.push({ capability: 'RESEARCH', supported: true });
    needs.push({ capability: target, supported: true });
    let topicSource = work;
    for (const re of RESEARCH_CUE) { re.lastIndex = 0; topicSource = topicSource.replace(re, ' '); }
    const topicless = stripTopicNoise(topicSource).length === 0 && !hasAttachment;
    return makeDecision({
      kind: 'CREATE_ARTIFACT', language, targetArtifactType: target, needs, confidence: topicless ? 0.6 : 0.86, permissionRisk: 'LOCAL_CREATE', executionNegated,
      ambiguity: topicless ? { level: 'HIGH', reason: 'MISSING_TOPIC', clarifyingQuestion: CLARIFY_TOPIC[target as 'DOCUMENT' | 'PRESENTATION' | 'IMAGE'] } : NO_AMBIGUITY,
      reasonCodes: [...reasonCodes, 'ARTIFACT_REQUESTED', ...(topicless ? ['MISSING_TOPIC'] : []), ...(CONTEXT_REFERENCE.test(work) ? ['CONTEXT_REFERENCE'] : []), ...(needs.length > 1 ? ['COMPOUND'] : [])],
    });
  }

  // 5. research
  if (wantsResearch && !(isInfoQuestion && !EXPLICIT_RESEARCH.test(work))) {
    return makeDecision({ kind: 'RESEARCH', language, needs: [{ capability: 'RESEARCH', supported: true }], confidence: 0.84, permissionRisk: 'EXTERNAL_READ', executionNegated, reasonCodes: [...reasonCodes, 'RESEARCH_REQUESTED'] });
  }

  // 6. the optional shortcut biases a plain request toward what the person picked - never an action, never an unsupported kind (those returned above)
  const hinted = hintTarget(options.hint);
  if (hinted === 'RESEARCH') {
    return makeDecision({ kind: 'RESEARCH', language, needs: [{ capability: 'RESEARCH', supported: true }], confidence: 0.8, permissionRisk: 'EXTERNAL_READ', executionNegated, reasonCodes: [...reasonCodes, 'EXPLICIT_SHORTCUT'] });
  }
  if (hinted) {
    const topicless = stripTopicNoise(work).length === 0 && !hasAttachment;
    return makeDecision({
      kind: 'CREATE_ARTIFACT', language, targetArtifactType: hinted, needs: [{ capability: hinted, supported: true }], confidence: 0.8, permissionRisk: 'LOCAL_CREATE', executionNegated,
      ambiguity: topicless ? { level: 'HIGH', reason: 'MISSING_TOPIC', clarifyingQuestion: CLARIFY_TOPIC[hinted] } : NO_AMBIGUITY,
      reasonCodes: [...reasonCodes, 'EXPLICIT_SHORTCUT', ...(topicless ? ['MISSING_TOPIC'] : []), ...(CONTEXT_REFERENCE.test(work) ? ['CONTEXT_REFERENCE'] : [])],
    });
  }

  // 7. vague: ask one question, run nothing
  if (!hasAttachment && VAGUE.some((re) => re.test(work.replace(/\s+/g, ' ').trim()))) {
    return makeDecision({ kind: 'CLARIFY', language, confidence: 0.9, ambiguity: { level: 'HIGH', reason: 'VAGUE_REQUEST', clarifyingQuestion: CLARIFY_VAGUE }, reasonCodes: [...reasonCodes, 'VAGUE_REQUEST'] });
  }

  // 8. advice (prepare / suggest / recommend / prioritise) - only when the plan service would also accept it as advice-only, so the advisory path never gets an action request
  if (classifyPlanRequest(work).kind === 'ADVISORY' && !(isInfoQuestion && !STRONG_ADVICE.test(work))) {
    return makeDecision({ kind: 'ADVICE', language, needs: [{ capability: 'ADVICE', supported: true }], confidence: 0.82, executionNegated, reasonCodes: [...reasonCodes, 'ADVICE_REQUESTED'] });
  }

  // 9. everything else is a conversation
  return makeDecision({ kind: 'CONVERSATION', language, needs: [{ capability: 'ANSWER', supported: true }], confidence: 0.7, executionNegated, reasonCodes: [...reasonCodes, 'CONVERSATION_DEFAULT'] });
}

export class InputRouter {
  public classify(input: ClassifyInput): InputClassificationResult {
    return InputRouter.classify(input);
  }

  public static classify(input: ClassifyInput): InputClassificationResult {

    const rawText = (input.text || '').trim();
    const hasAttachment = Boolean(input.hasFile);
    const captureDecision = (confidence: number, code: string): RoutingDecision => makeDecision({ kind: 'CAPTURE', language: detectRequestLanguage(rawText), needs: [{ capability: 'CAPTURE', supported: true }], confidence, reasonCodes: [code] });

    // 1. Audio Capture Primary Path
    if (input.hasAudio || (input.mimeType && input.mimeType.startsWith('audio/'))) {
      return {
        primaryIntent: 'AUDIO_CAPTURE',
        confidence: 0.98,
        reason: 'Input contains real audio payload or audio MIME type',
        normalizedPayload: { rawInput: rawText, mimeType: input.mimeType || 'audio/webm' },
        decision: captureDecision(0.98, 'AUDIO_PAYLOAD'),
      };
    }

    // 2. Binary File Upload Primary Path - the words that come with the file are still routed, so "summarise this" reaches an answer
    if (input.hasFile) {
      return {
        primaryIntent: 'UPLOAD',
        confidence: 0.98,
        reason: 'Input contains file payload',
        normalizedPayload: { rawInput: rawText, mimeType: input.mimeType || 'application/octet-stream' },
        decision: rawText ? decideRouting(rawText, { hasAttachment, hint: input.hint }) : captureDecision(0.98, 'FILE_PAYLOAD'),
      };
    }

    // 3. Link Capture Primary Path
    const urlMatch = rawText.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      const url = urlMatch[0];
      // If the text is ONLY a URL or "save link https://...", classify as LINK_CAPTURE
      if (rawText.length === url.length || rawText.toLowerCase().startsWith('save') || rawText.toLowerCase().startsWith('link')) {
        return {
          primaryIntent: 'LINK_CAPTURE',
          confidence: 0.95,
          reason: 'Input is a standalone URL or explicit link capture request',
          normalizedPayload: { rawInput: rawText, url },
          decision: captureDecision(0.95, 'LINK_CAPTURE'),
        };
      }
    }

    const lower = rawText.toLowerCase();

    // 4. Capture Primary Path (explicit save / note / idea / remember)
    const koCapture = /^(메모|노트|아이디어)\s*[:：]/.test(rawText) || /^(메모해|메모 해|기억해)\s*(줘|주세요|둬|두세요)?(\s|$)/.test(rawText);
    if (
      lower.startsWith('remember') ||
      lower.startsWith('note') ||
      lower.startsWith('idea:') ||
      lower.startsWith('save note') ||
      lower.startsWith('keep note') ||
      koCapture
    ) {
      return {
        primaryIntent: 'CAPTURE',
        confidence: 0.9,
        reason: 'Input contains explicit capture/note keyword prefix',
        normalizedPayload: {
          rawInput: rawText,
          cleanText: koCapture
            ? rawText.replace(/^(메모|노트|아이디어)\s*[:：]\s*/, '').replace(/^(메모해|메모 해|기억해)\s*(줘|주세요|둬|두세요)?\s*[:：,]?\s*/, '')
            : rawText.replace(/^(remember|note|idea:|save note|keep note)\s*/i, ''),
        },
        decision: captureDecision(0.9, 'CAPTURE_PREFIX'),
      };
    }

    // 5. everything else is routed by what the person asked for
    const decision = decideRouting(rawText, { hasAttachment: false, hint: input.hint });
    const primaryIntent: InputIntent = decision.kind === 'ACTION_PLAN' ? 'COMMAND' : 'ASK';
    return {
      primaryIntent,
      confidence: decision.confidence,
      reason: primaryIntent === 'COMMAND'
        ? 'Input asks for something to be done; it becomes a plan that needs approval'
        : `Input routed as ${decision.kind}${decision.targetArtifactType ? ' ' + decision.targetArtifactType : ''}`,
      normalizedPayload: { rawInput: rawText },
      decision,
    };
  }
}
