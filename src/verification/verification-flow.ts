// THE FLOW AROUND ONE ANSWER: decide how deeply to check, check it, and - only when a material claim is not supported - give the model ONE chance to correct it from the sources, then remove what is still
// unsupported. Bounded by construction: one verification, at most one extra search (inside the verifier), at most one rewrite, one deterministic removal. Nothing loops, and nothing is ever delivered as
// VERIFIED that the evidence does not support.
import { redactClaims } from './claim-checker.js';
import { AnswerVerifier } from './answer-verifier.js';
import { answerIsHedged, decideLevel, type LevelAdvice, type VerificationPreference } from './verification-policy.js';
import type { EvidencePack, EvidenceSource } from '../research/evidence-pack.types.js';
import type { VerificationLevel, VerificationReport } from './verification.types.js';

/** An advisor (JEV or any provider) may only ask for MORE checking; it sees buckets, never content. */
export interface VerificationAdvisorPort {
  advise(features: AdviceFeatures): Promise<LevelAdvice | null>;
}

/** What an advisor is told: enumerated kinds and buckets, nothing the person wrote. */
export interface AdviceFeatures {
  freshness: string;
  category: string;
  turnKind: string;
  comparison: boolean;
  research: boolean;
  highImpact: string[];
  hedged: boolean;
  sourcesBucket: 'NONE' | 'FEW' | 'SEVERAL';
  baseLevel: VerificationLevel;
}

export interface FlowInput {
  verifier: AnswerVerifier;
  advisor?: VerificationAdvisorPort | null;
  question: string;
  language: 'ko' | 'en';
  answer: string;
  pack: EvidencePack | undefined;
  turnKind: 'NEW_QUESTION' | 'FOLLOW_UP' | 'CORRECTION';
  preference: VerificationPreference;
  allowRetrieval: boolean;
  answerProvider: string | null;
  requestId?: string;
  /** asks the model to write the answer again, once, correcting the listed statements; null when it cannot */
  revise: (problems: string[], previousAnswer: string, pack: EvidencePack | undefined) => Promise<string | null>;
}

export interface FlowResult { message: string; report: VerificationReport; sources: EvidenceSource[] }

const rankOf = (level: VerificationLevel): number => ['L0', 'L1', 'L2', 'L3'].indexOf(level);
const bad = (report: VerificationReport) => report.claims.filter((c) => c.material && (c.status === 'UNSUPPORTED' || c.status === 'CONTRADICTED'));
/** sources disagree (on a release date) and the answer does not tell the person */
const silentConflict = (report: VerificationReport): boolean => report.statusReasons.includes('SOURCES_DISAGREE_AND_THE_ANSWER_DOES_NOT_SAY_SO');
const conflictProblems = (report: VerificationReport): string[] => (silentConflict(report)
  ? report.conflicts.map((c) => `The sources disagree about the ${c.topic}: ${c.values.map((v) => `${v.sourceId} says ${v.value}`).join('; ')}. State both, and say which source you rely on and why (more authoritative, more recent).`)
  : []);

export function parseVerificationPreference(body: unknown): VerificationPreference {
  const meta = body && typeof body === 'object' ? (body as Record<string, unknown>).requestMetadata : undefined;
  const value = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).verificationPreference : undefined;
  return value === 'STRONG' ? 'STRONG' : 'AUTO';
}

export async function runVerificationFlow(input: FlowInput): Promise<FlowResult> {
  const sourcesNow = input.pack?.sources ?? [];
  const hedged = answerIsHedged(input.answer);
  const base = decideLevel({ question: input.question, freshness: input.pack?.freshnessRequirement ?? 'NONE', category: input.pack?.category ?? 'GENERAL', turnKind: input.turnKind, preference: input.preference, observedUncertainty: hedged });
  // the advisor is asked about the level the rules chose; it may only raise it, and a failing advisor is no advice
  let advice: LevelAdvice | null = null;
  if (input.advisor) {
    try {
      advice = await input.advisor.advise({
        freshness: input.pack?.freshnessRequirement ?? 'NONE', category: input.pack?.category ?? 'GENERAL', turnKind: input.turnKind, comparison: base.reasons.includes('COMPARISON_OF_NAMED_THINGS'),
        research: base.reasons.includes('RESEARCH_INTENT'), highImpact: base.reasons.filter((r) => r.startsWith('HIGH_IMPACT_')), hedged,
        sourcesBucket: sourcesNow.length === 0 ? 'NONE' : sourcesNow.length < 3 ? 'FEW' : 'SEVERAL', baseLevel: base.level,
      });
    } catch { advice = null; }
  }
  const decision = advice ? decideLevel({ question: input.question, freshness: input.pack?.freshnessRequirement ?? 'NONE', category: input.pack?.category ?? 'GENERAL', turnKind: input.turnKind, preference: input.preference, observedUncertainty: hedged, advice }) : base;

  const common = { question: input.question, language: input.language, pack: input.pack, decision, answerProvider: input.answerProvider, requestId: input.requestId, allowRetrieval: input.allowRetrieval };
  const first = await input.verifier.verify({ ...common, answer: input.answer });
  let message = input.answer;
  let report = first.report;
  let sources = first.sources;

  // ---- one chance to correct, from the sources, then removal of what is still not supported ------------------------------------------------------------------------------------------------
  if (rankOf(decision.level) >= rankOf('L2') && (bad(report).length > 0 || silentConflict(report)) && sources.length > 0) {
    const problems = [...bad(report).map((c) => (c.status === 'CONTRADICTED' && c.found ? `${c.text} (a source states: ${c.found})` : c.text)), ...conflictProblems(report)];
    const packWithAdded: EvidencePack | undefined = input.pack ? { ...input.pack, sources } : undefined;
    const revised = await input.revise(problems, message, packWithAdded).catch(() => null);
    if (revised && revised.trim()) {
      const second = await input.verifier.verify({ ...common, answer: revised, reuse: { facts: first.facts, review: first.report.review, sources } });
      // accepted only when it is better: fewer unsupported statements, or a disagreement between sources that the answer now says out loud
      if (bad(second.report).length < bad(report).length || (silentConflict(report) && !silentConflict(second.report) && bad(second.report).length <= bad(report).length)) {
        message = revised;
        report = { ...second.report, extraRetrievals: first.report.extraRetrievals, revision: 'REWRITTEN' };
        sources = second.sources;
      }
    }
    if (bad(report).length > 0) {
      const remaining = new Set(bad(report).map((c) => c.text));
      const redacted = redactClaims(message, remaining, input.language);
      if (redacted !== message) {
        const third = await input.verifier.verify({ ...common, answer: redacted, reuse: { facts: first.facts, review: first.report.review, sources } });
        message = redacted;
        report = { ...third.report, extraRetrievals: first.report.extraRetrievals, revision: 'REDACTED' };
        sources = third.sources;
      }
    }
  }
  return { message, report, sources };
}

/** What the client (and the audit trail) may know of a report: counts and states, the statements that need attention, never a provider's name or an internal id. */
export function summarizeReport(report: VerificationReport): Record<string, unknown> {
  return {
    level: report.level,
    levelBasis: report.levelBasis,
    status: report.status,
    statusReasons: report.statusReasons,
    counts: report.counts,
    review: { mode: report.review.mode, independentFacts: report.review.independentFacts, disagreements: report.review.disagreements.length },
    evidence: report.evidence,
    conflicts: report.conflicts.map((c) => ({ kind: c.kind, subject: c.subject, values: c.values.map((v) => ({ sourceId: v.sourceId, value: v.value })) })),
    extraRetrievals: report.extraRetrievals,
    revision: report.revision,
    claimsNeedingAttention: report.claims.filter((c) => c.material && c.status !== 'SUPPORTED').slice(0, 8).map((c) => ({ text: c.text, status: c.status, reason: c.reason })),
  };
}

/** What a person is told when nothing could be checked (no sources at all). Same shape as summarizeReport. */
export function uncheckedSummary(level: VerificationLevel = 'L2'): Record<string, unknown> {
  return {
    level, levelBasis: 'RULES', status: 'UNVERIFIED', statusReasons: ['NO_SOURCES'],
    counts: { checked: 0, material: 0, supported: 0, unsupported: 0, contradicted: 0, uncheckable: 0 },
    review: { mode: 'NOT_REQUIRED', independentFacts: 0, disagreements: 0 },
    evidence: { sources: 0, pagesRead: 0, current: 0, stale: 0, undated: 0, primaryLike: 0 },
    conflicts: [], extraRetrievals: 0, revision: 'NONE', claimsNeedingAttention: [],
  };
}
