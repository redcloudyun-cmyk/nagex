// HOW DEEPLY an answer is checked is decided here, deterministically, from the STRUCTURE of the request and from what has been observed - not from one keyword and not from a model's mood.
//
//   L0  simple tasks: one model, no verification.
//   L1  ordinary factual tasks: sources where the question needs them, claims checked against what was retrieved.
//   L2  current facts, research, comparative analysis: the evidence is read independently by a second model (when a distinct one exists) and every material claim is checked against the sources it cites.
//   L3  high-impact claims and decisions (health, law, money, safety): everything in L2, a primary-like source is required for VERIFIED, and the limits are stated plainly.
//
// Signals: the freshness classification (structure of the question), a comparison of named things, research intent, a high-impact domain in a decision frame or with a dosage-like figure, what the first
// answer itself revealed (it hedged / could not be grounded), and the person's explicit request for stronger checking. An ADVISOR (JEV or any provider) may only RAISE the level - never lower it, never
// change a check - and without it the rules stand, so correctness never depends on it.
import { versionedTokens } from '../research/evidence-excerpt.js';
import type { FreshnessRequirement } from '../research/question-classification.service.js';
import { VERIFICATION_LEVELS, type LevelBasis, type VerificationLevel } from './verification.types.js';

export type VerificationPreference = 'AUTO' | 'STRONG';

export interface PolicyInput {
  /** the question with its subject (the retrieval query of the turn) */
  question: string;
  freshness: FreshnessRequirement;
  category: string;
  turnKind: 'NEW_QUESTION' | 'FOLLOW_UP' | 'CORRECTION';
  preference?: VerificationPreference;
  /** the first answer hedged, or could not be grounded: the request turned out harder than it looked */
  observedUncertainty?: boolean;
  advice?: LevelAdvice | null;
}

export interface LevelAdvice { level: VerificationLevel; confidence: number; provider: string }
/** An advisor can only ask for MORE checking, and only when it is confident. */
export const ADVICE_MIN_CONFIDENCE = 0.6;

export interface StructuralSignals {
  comparison: boolean;
  research: boolean;
  highImpact: Array<'HEALTH' | 'LEGAL' | 'MONEY' | 'SAFETY'>;
  decisionFrame: boolean;
  dosageLike: boolean;
}

const COMPARE = /(비교|차이|대비|\bvs\.?\b|\bversus\b|\bcompare[sd]?\b|\bcomparison\b|\bdifferences?\b|\bbetter than\b|어느\s*쪽이|뭐가\s*더)/i;
const RESEARCH = /(조사|리서치|분석|동향|현황\s*(?:파악|정리)|\bresearch\b|\banaly[sz]e\b|\binvestigate\b|\blandscape\b|\bsurvey of\b)/i;
const HEALTH = /(복용|처방|용량|투약|부작용|진단|증상|수술|임신|\bdoses?\b|\bdosage\b|\bmedication\b|\bprescri|\bsymptoms?\b|\bdiagnos|\bside effects?\b|\bsurgery\b|\bpregnan)/i;
const LEGAL = /(소송|계약서|법적\s*책임|고소|합의금|판결|\blawsuit\b|\bliability\b|\bcontract clause\b|\bsue\b|\bcustody\b|\bvisa\b)/i;
const MONEY = /(투자|대출|주택담보|세금\s*신고|연금|보험\s*가입|\binvest(?:ment|ing)?\b|\bmortgage\b|\bloan\b|\btax\s*(?:return|filing)\b|\bretirement\b|\binsurance\b)/i;
const SAFETY = /(화재|감전|가스\s*누출|독성|중독|응급|\bpoison|\btoxic\b|\belectrocut|\bgas leak\b|\bemergency\b|\boverdose\b)/i;
const DECISION_FRAME = /(해야|해도\s*(?:돼|될까|되나|괜찮)|괜찮(?:을까|나요|은가요)|할까요?|\bshould i\b|\bis it safe\b|\bcan i\b|\bhow much should\b|얼마나\s*(?:먹|복용|투자))/i;
const DOSAGE = /\d+(?:\.\d+)?\s?(?:mg|mcg|ml|㎎|㎖|정|알|캡슐)\b/i;

export function structuralSignals(question: string): StructuralSignals {
  const text = String(question ?? '');
  const highImpact: StructuralSignals['highImpact'] = [];
  if (HEALTH.test(text) || DOSAGE.test(text)) highImpact.push('HEALTH');
  if (LEGAL.test(text)) highImpact.push('LEGAL');
  if (MONEY.test(text)) highImpact.push('MONEY');
  if (SAFETY.test(text)) highImpact.push('SAFETY');
  return {
    comparison: versionedTokens(text).length >= 2 || (COMPARE.test(text) && versionedTokens(text).length >= 1),
    research: RESEARCH.test(text),
    highImpact,
    decisionFrame: DECISION_FRAME.test(text),
    dosageLike: DOSAGE.test(text),
  };
}

const rank = (level: VerificationLevel): number => VERIFICATION_LEVELS.indexOf(level);
const raise = (level: VerificationLevel, by = 1): VerificationLevel => VERIFICATION_LEVELS[Math.min(VERIFICATION_LEVELS.length - 1, rank(level) + by)];
const atLeast = (level: VerificationLevel, floor: VerificationLevel): VerificationLevel => (rank(level) >= rank(floor) ? level : floor);

export interface LevelDecision {
  level: VerificationLevel;
  basis: LevelBasis;
  reasons: string[];
  /** L3: a primary-like source is needed for VERIFIED */
  requiresPrimarySource: boolean;
  /** L2 and above ask for a second model's independent reading when a distinct one exists */
  wantsIndependentReview: boolean;
  /** extra searches allowed to settle a disagreement */
  maxExtraRetrievals: number;
}

export function decideLevel(input: PolicyInput): LevelDecision {
  const signals = structuralSignals(input.question);
  const reasons: string[] = [];
  let level: VerificationLevel = 'L0';
  let basis: LevelBasis = 'RULES';

  if (input.freshness === 'REQUIRED') { level = 'L2'; reasons.push('CURRENT_FACTS_NEEDED'); }
  else if (input.freshness === 'OPTIONAL') { level = 'L1'; reasons.push('CURRENT_SOURCES_HELP'); }
  if (signals.comparison) { level = atLeast(level, 'L2'); reasons.push('COMPARISON_OF_NAMED_THINGS'); }
  if (signals.research) { level = atLeast(level, 'L2'); reasons.push('RESEARCH_INTENT'); }
  if (input.turnKind === 'CORRECTION') { level = atLeast(level, 'L2'); reasons.push('PERSON_CHALLENGED_AN_EARLIER_ANSWER'); }
  // a high-impact domain alone is a topic; in a decision frame (or with a dosage-like figure) the person may ACT on the answer
  if (signals.highImpact.length > 0 && (signals.decisionFrame || signals.dosageLike)) { level = 'L3'; reasons.push(`HIGH_IMPACT_${signals.highImpact.join('_')}`); }

  if (input.observedUncertainty) {
    // an answer that says "I cannot confirm part of this" shows the request was harder than it looked - one step, up to L2. It is not a reason to treat the question as high-impact (that is L3, from the request itself).
    const raised = level === 'L0' ? 'L1' : level === 'L1' ? 'L2' : level;
    if (raised !== level) { level = raised; basis = 'OBSERVED_UNCERTAINTY'; reasons.push('THE_ANSWER_ITSELF_WAS_UNCERTAIN'); }
  }
  if (input.preference === 'STRONG') {
    const raised = rank(level) >= rank('L2') ? raise(level) : 'L2';
    if (raised !== level) { level = raised; basis = 'USER_PREFERENCE'; reasons.push('THE_PERSON_ASKED_FOR_STRONGER_CHECKING'); }
  }
  const advice = input.advice;
  if (advice && advice.confidence >= ADVICE_MIN_CONFIDENCE && rank(advice.level) > rank(level)) {
    level = advice.level; basis = 'ADVISOR'; reasons.push(`ADVISOR_${advice.provider.toUpperCase()}_RAISED_THE_LEVEL`);
  }
  return {
    level, basis, reasons,
    requiresPrimarySource: level === 'L3',
    wantsIndependentReview: rank(level) >= rank('L2'),
    maxExtraRetrievals: level === 'L3' ? 2 : level === 'L2' ? 1 : 0,
  };
}

/** Did the first answer say it could not be sure? (observed uncertainty - one of the signals that raises the level) */
export function answerIsHedged(answer: string): boolean {
  return /(확인(?:할\s*수\s*없|하지\s*못|되지\s*않)|추정|예상됩니다|것으로\s*보입니다|알\s*수\s*없|자료\s*미확인|출처에서\s*확인\s*불가|\bunverified\b|\bmay be out of date\b|\bcannot confirm\b|\bnot sure\b|\bnot confirmed\b|\bdo not specify\b|\bdon't know\b)/i.test(String(answer ?? ''));
}
