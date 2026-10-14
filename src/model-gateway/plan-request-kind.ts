// What did the PERSON ask for: something to be DONE (an action plan, which needs at least one step and goes through resolution and approval) or only advice
// (a briefing, a recommendation, an explanation)? This is decided from the person's own words by deterministic, fail-closed rules - never from what the model says
// about itself - so a model cannot turn "schedule a meeting" into harmless-looking advice, and a model that answers an action request with no steps stays rejected.
//
// ADVISORY needs positive evidence (an advisory cue) AND the absence of every action cue. Anything else is ACTION. Being wrong in the ACTION direction costs only a
// fallback to another provider; being wrong in the other direction can only ever produce advice text: an advisory answer has no steps and is never executable.
export type PlanRequestKind = 'ADVISORY' | 'ACTION';

// Words that ask for something to be done or changed. STRONG cues count anywhere in the request ("... and send it"); WEAK cues are common nouns too ("the launch", "a call"),
// so they only count where a verb stands (the start of a clause).
const ACTION_CUES: RegExp[] = [
  /\b(send|email|e-mail|reply|respond|forward|schedule|reschedule|book|reserve|invite|cancel|postpone|rsvp|delete|erase|trash|publish|upload|submit|pay|purchase|buy|transfer|donate|refund|deploy|execute|install|approve|reject|subscribe|unsubscribe|create|add|save|store|memorize)\b/i,
  /\b(remind\s+me|set\s+up|set\s+(a|an|the)\s+(reminder|alarm|timer)|make\s+(a|an|the)\s+(call|reservation|booking|appointment|payment|purchase|reminder|event|meeting|task|note|calendar)|put\s+(it|this|that)\s+(on|in|into)|remember\s+(that|this|it|to|the\s+following)|go\s+ahead|do\s+(it|that)|proceed|carry\s+out|make\s+it\s+happen|tell\s+\w+\s+(that|to))\b/i,
  new RegExp('(?:^|[.!?;:,]\\s*|\\b(?:and|then|please|also|just|now|first|next)\\s+)(call|text|message|mail|dm|ping|notify|phone|update|change|edit|modify|rename|move|merge|replace|fix|remove|clear|archive|discard|drop|post|share|download|apply|register|file|print|export|order|charge|invoice|run|launch|start|stop|enable|disable|connect|disconnect|confirm|authorize|accept|decline|delay|snooze|sign\\s+up)\\b', 'i'),
  /(보내|전송|발송|답장|회신|전달|메일|메시지|문자|연락|전화|알려\s*줘|알림)/,
  /(예약|일정(을|도)?\s*(잡|등록|추가|생성|변경|수정|취소|옮)|잡아|초대|취소|연기|미뤄|수락|거절)/,
  /(만들|생성|추가|등록|설정|저장|기억해|기억하|리마인더|알람)/,
  /(삭제|지워|지우|제거|없애|보관)/,
  /(수정|변경|바꿔|옮겨|이동|교체|고쳐)/,
  /(게시|발행|공유|업로드|다운로드|제출|신청|가입|구독|결제|구매|주문|송금|환불|청구)/,
  /(실행|시작해|중지|활성화|비활성화|연결해|해제|설치|승인|진행해|그대로\s*해|그렇게\s*해)/,
];

// Words that ask for thinking, not doing.
const ADVISORY_CUES: RegExp[] = [
  /\b(prepare|brief(ing)?|summar(y|ize|ise)|suggest(ion)?s?|recommend(ation)?s?|advice|advise|opinion)\b/i,
  /\b(what\s+should|how\s+should|should\s+i|what\s+do\s+you\s+think|help\s+me\s+(think|decide|understand|prepare|plan|figure|prioriti[sz]e))\b/i,
  /\b(prioriti[sz]e|review|analy[sz]e|compare|ideas?|next\s+(action|step|move)s?|explain|outline|overview|tips?|pros\s+and\s+cons|think\s+through|talking\s+points|options)\b/i,
  /(준비|브리핑|요약|제안|추천|조언|의견|어떻게\s*(해야|하면)|무엇을\s*(해야|하면)|뭘\s*(해야|하면)|정리|우선순위|분석|검토|비교|아이디어|다음\s*(행동|단계|할\s*일)|설명|개요|장단점|생각해)/,
];

export function classifyPlanRequest(prompt: string): { kind: PlanRequestKind; reason: 'ACTION_CUE' | 'NO_ADVISORY_CUE' | 'ADVISORY_CUE' } {
  const text = typeof prompt === 'string' ? prompt.normalize('NFC') : '';
  if (ACTION_CUES.some((cue) => cue.test(text))) return { kind: 'ACTION', reason: 'ACTION_CUE' };
  if (ADVISORY_CUES.some((cue) => cue.test(text))) return { kind: 'ADVISORY', reason: 'ADVISORY_CUE' };
  return { kind: 'ACTION', reason: 'NO_ADVISORY_CUE' };
}

// A suggestion must be a concrete, standalone next move: not a placeholder, not a fragment.
const PLACEHOLDERS = new Set(['n/a', 'na', 'none', 'null', 'tbd', 'todo', 'string', '...', '…', 'suggestion', 'suggestions', 'next steps', 'next step', 'see above', 'various', 'etc', 'etc.', '없음', '해당 없음']);
export function isConcreteSuggestion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 15 || text.length > 400) return false;
  if (PLACEHOLDERS.has(text.toLowerCase())) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const cjk = (text.match(/[ㄱ-힝一-鿿぀-ヿ]/g) ?? []).length;
  // enough words, or (for unspaced CJK text) enough characters
  return words.length >= 3 || cjk >= 10;
}
