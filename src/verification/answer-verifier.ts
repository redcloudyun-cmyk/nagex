// THE ANSWER VERIFIER: from an answer and the evidence it was written from, to an honest report.
//
//   1. the claims of the answer are checked against the sources they cite (claim-checker.ts) - deterministic;
//   2. for L2 / L3 a second, distinct model reads the SAME evidence without seeing the answer (independent-review.ts); its findings are admitted only if their quotes are in the sources, and are compared
//      with the answer - a disagreement is recorded, never settled by "the majority";
//   3. a disagreement or an unsupported material claim may cost one bounded extra search aimed at it (the number is set by the level); what comes back is evidence like any other, and the claims are checked again;
//   4. sources that give different release dates for the same named thing are a conflict;
//   5. the status follows from the facts above - VERIFIED / PARTIALLY_VERIFIED / UNVERIFIED / DISPUTED - and states why. A model's confidence is not an input anywhere.
// Deciding what to DO about a failed check (revise, redact, say so) is the caller's; this class reports.
import { normalizeForMatch } from '../research/claim-verification.js';
import { versionedTokens, queryTerms } from '../research/evidence-excerpt.js';
import type { EvidencePack, EvidenceSource } from '../research/evidence-pack.types.js';
import { checkClaims, detectReleaseDateConflicts, extractClaims, sourceTextOf } from './claim-checker.js';
import { compareWithReading, verifiedFacts, type ReviewFact, type ReviewReadingPort } from './independent-review.js';
import type { LevelDecision } from './verification-policy.js';
import type { ClaimCheck, Disagreement, ReviewMode, SourceConflict, VerificationReport, VerificationStatus } from './verification.types.js';

export interface AnswerVerifierDeps {
  reading?: ReviewReadingPort | null;
  /** one bounded, targeted extra search for a disputed claim (returns a pack, or null when search is not possible) */
  retrieve?: (query: string, requestId?: string) => Promise<EvidencePack | null>;
}

export interface VerifyInput {
  question: string;
  language: 'ko' | 'en';
  answer: string;
  pack: EvidencePack | undefined;
  decision: LevelDecision;
  /** the provider that wrote the answer (the reviewer must be a different one to count as independent) */
  answerProvider: string | null;
  requestId?: string;
  /** false when the person turned Web research off: no extra search is made */
  allowRetrieval?: boolean;
  /** a second pass over a REVISED answer: the first pass's independent reading is kept (the evidence did not change), nothing is read or searched again */
  reuse?: { facts: ReviewFact[]; review: VerificationReport['review']; sources: EvidenceSource[] };
}

export interface VerifyResult {
  report: VerificationReport;
  /** sources found by the extra search, to be shown with the others */
  addedSources: EvidenceSource[];
  /** what the independent reading found and NAgex admitted (kept for the check of a revised answer) */
  facts: ReviewFact[];
  /** every source the claims were checked against (the pack's and the extra search's) */
  sources: EvidenceSource[];
}

// a source is "primary-like" when its address says it is an authority's own page (a government, a university, a newsroom / press / support / docs area of an organisation) - a HEURISTIC, named as such
const PRIMARY_HOST = /(^|\.)(gov|edu|mil|int)(\.[a-z]{2})?$|(^|\.)(go|ac)\.kr$|(^|\.)(newsroom|press|support|docs|developer|developers)\./i;
export function primaryLike(source: EvidenceSource): boolean {
  try { return PRIMARY_HOST.test(new URL(source.url).hostname); } catch { return false; }
}

function evidenceStats(sources: EvidenceSource[]): VerificationReport['evidence'] {
  return {
    sources: sources.length,
    pagesRead: sources.filter((s) => Boolean(s.excerpt || s.fullText)).length,
    current: sources.filter((s) => s.freshnessStatus === 'CURRENT' || s.freshnessStatus === 'RECENT').length,
    stale: sources.filter((s) => s.freshnessStatus === 'STALE' || s.freshnessStatus === 'SUSPICIOUS').length,
    undated: sources.filter((s) => s.freshnessStatus === 'UNDATED' || s.freshnessStatus === 'UNKNOWN').length,
    primaryLike: sources.filter(primaryLike).length,
  };
}

function countsOf(claims: ClaimCheck[]): VerificationReport['counts'] {
  const material = claims.filter((c) => c.material);
  return {
    checked: claims.length,
    material: material.length,
    supported: material.filter((c) => c.status === 'SUPPORTED').length,
    unsupported: material.filter((c) => c.status === 'UNSUPPORTED').length,
    contradicted: material.filter((c) => c.status === 'CONTRADICTED').length,
    uncheckable: material.filter((c) => c.status === 'UNCHECKABLE').length,
  };
}

/** Does the answer tell the person that the sources disagree (it names at least two of the conflicting values)? */
function acknowledgesConflict(answer: string, conflict: SourceConflict): boolean {
  const flat = normalizeForMatch(answer).replace(/\s+/g, '');
  const mentioned = new Set(conflict.values.filter((v) => {
    const [y, m, d] = v.value.split('-').map(Number);
    return flat.includes(v.value) || flat.includes(`${y}년${m}월${d}일`) || (flat.includes(`${m}월${d}일`) && flat.includes(String(y)));
  }).map((v) => v.value));
  return mentioned.size >= 2;
}

const LIVE_VALUE = new Set(['MARKET', 'FINANCE', 'FORECAST', 'PRODUCT_PRICE', 'NEWS', 'TRAVEL', 'LOCAL']);

export interface StatusInput {
  decision: LevelDecision;
  claims: ClaimCheck[];
  sources: EvidenceSource[];
  freshnessRequired: boolean;
  /** the question's category: only a live value (a price, a headline, the weather) is spoiled by an old page - a product's specifications or a release date are facts that do not expire */
  category: string;
  review: VerificationReport['review'];
  conflicts: SourceConflict[];
  answer: string;
}

export function statusOf(input: StatusInput): { status: VerificationStatus; reasons: string[] } {
  const { decision, claims, sources, review } = input;
  if (decision.level === 'L0') return { status: 'NOT_REQUIRED', reasons: ['LEVEL_L0'] };
  if (sources.length === 0) return { status: 'UNVERIFIED', reasons: ['NO_SOURCES'] };
  const counts = countsOf(claims);
  const unresolvedDisagreements = review.disagreements.filter((d) => !d.resolved);
  if (counts.contradicted > 0) return { status: 'DISPUTED', reasons: ['A_CLAIM_IS_CONTRADICTED'] };
  if (unresolvedDisagreements.length > 0) return { status: 'DISPUTED', reasons: ['THE_READINGS_DISAGREE'] };
  const unexplained = input.conflicts.filter((c) => !acknowledgesConflict(input.answer, c));
  if (unexplained.length > 0) return { status: 'DISPUTED', reasons: ['SOURCES_DISAGREE_AND_THE_ANSWER_DOES_NOT_SAY_SO'] };
  if (counts.material === 0) return { status: 'UNVERIFIED', reasons: ['NOTHING_MATERIAL_TO_CHECK'] };
  if (counts.supported === 0) return { status: 'UNVERIFIED', reasons: ['NO_MATERIAL_CLAIM_IS_SUPPORTED'] };
  const reasons: string[] = [];
  // the answer tells the person that the sources disagree: that is honest, and it is not a settled fact - at most PARTIALLY_VERIFIED
  if (input.conflicts.length > 0) reasons.push('SOURCES_DISAGREE_AND_THE_ANSWER_SAYS_SO');
  if (counts.unsupported > 0 || counts.uncheckable > 0) reasons.push('SOME_MATERIAL_CLAIMS_ARE_NOT_SUPPORTED');
  if (decision.requiresPrimarySource && !sources.some(primaryLike)) reasons.push('NO_PRIMARY_LIKE_SOURCE');
  if (decision.level === 'L3' && review.mode !== 'INDEPENDENT_MODEL_REVIEW') reasons.push('NO_INDEPENDENT_REVIEW_AT_L3');
  if (input.freshnessRequired && LIVE_VALUE.has(input.category) && sources.every((s) => s.freshnessStatus === 'STALE' || s.freshnessStatus === 'SUSPICIOUS')) reasons.push('EVIDENCE_NOT_CURRENT');
  return reasons.length > 0 ? { status: 'PARTIALLY_VERIFIED', reasons } : { status: 'VERIFIED', reasons: ['EVERY_MATERIAL_CLAIM_IS_SUPPORTED'] };
}

const SOURCE_TEXT_FOR_REVIEW = 6_000;

export class AnswerVerifier {
  constructor(private readonly deps: AnswerVerifierDeps = {}) {}

  public async verify(input: VerifyInput): Promise<VerifyResult> {
    const { decision } = input;
    const reuse = input.reuse ?? null;
    const sources: EvidenceSource[] = reuse ? [...reuse.sources] : [...(input.pack?.sources ?? [])];
    const addedSources: EvidenceSource[] = [];
    const freshnessRequired = input.pack?.freshnessRequirement === 'REQUIRED';
    const review: VerificationReport['review'] = reuse
      ? { ...reuse.review, disagreements: [] }
      : { mode: 'NOT_REQUIRED', answerProvider: input.answerProvider, reviewerProvider: null, independentFacts: 0, disagreements: [] };

    if (decision.level === 'L0') {
      return { report: { level: 'L0', levelBasis: decision.basis, levelReasons: decision.reasons, claims: [], counts: countsOf([]), review, evidence: evidenceStats(sources), conflicts: [], extraRetrievals: 0, revision: 'NONE', status: 'NOT_REQUIRED', statusReasons: ['LEVEL_L0'] }, addedSources, facts: [], sources };
    }

    const entities = versionedTokens(input.question);
    let claims = checkClaims(extractClaims(input.answer), sources, entities);

    // ---- the independent reading ------------------------------------------------------------------------------------------------------------------------------------------------------------
    let facts: ReviewFact[] = reuse ? reuse.facts : [];
    if (reuse) {
      if (facts.length > 0) {
        const compared = compareWithReading(claims, facts);
        claims = compared.claims;
        review.disagreements = compared.disagreements;
      }
    } else if (sources.length > 0 && decision.wantsIndependentReview) {
      const reading = this.deps.reading ?? null;
      const plan = reading ? reading.plan(input.answerProvider, decision.level === 'L3') : null;
      if (!reading || !plan) review.mode = 'UNAVAILABLE';
      else {
        try {
          const result = await reading.read({
            question: input.question, language: input.language, provider: plan.provider, independent: plan.mode === 'INDEPENDENT_MODEL_REVIEW', requestId: input.requestId,
            sources: sources.map((s) => ({ sourceId: s.sourceId, title: s.title, publisher: s.sourceName ?? '', ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}), text: sourceTextOf(s).slice(0, SOURCE_TEXT_FOR_REVIEW) })),
          });
          // what actually answered decides the label: if it was the provider that wrote the answer, it was not independent
          const independent = plan.mode === 'INDEPENDENT_MODEL_REVIEW' && result.provider !== input.answerProvider;
          review.mode = independent ? 'INDEPENDENT_MODEL_REVIEW' : 'SELF_REVIEW';
          review.reviewerProvider = result.provider;
          facts = verifiedFacts(result.claims, sources);
          review.independentFacts = facts.length;
        } catch {
          review.mode = 'UNAVAILABLE';
        }
      }
      if (facts.length > 0) {
        const compared = compareWithReading(claims, facts);
        claims = compared.claims;
        review.disagreements = compared.disagreements;
      }
    }

    // ---- one bounded search aimed at what is in dispute --------------------------------------------------------------------------------------------------------------------------------------
    let extra = 0;
    const disputed = (): ClaimCheck[] => claims.filter((c) => c.material && (c.status === 'UNSUPPORTED' || c.status === 'CONTRADICTED'));
    if (!reuse && input.allowRetrieval !== false && this.deps.retrieve && decision.maxExtraRetrievals > 0 && sources.length > 0 && disputed().length > 0) {
      const entities = Array.from(new Set(versionedTokens(input.question)));
      const words = Array.from(new Set(disputed().flatMap((c) => queryTerms(c.text).filter((t) => !/^\d+$/.test(t)).slice(0, 4)))).slice(0, 6);
      const query = [...entities, ...words].join(' ').slice(0, 160).trim();
      if (query) {
        extra = 1;
        try {
          const more = await this.deps.retrieve(query, input.requestId);
          const have = new Set(sources.map((s) => s.url));
          for (const s of more?.sources ?? []) {
            if (have.has(s.url)) continue;
            have.add(s.url);
            const added = { ...s, sourceId: `src_${sources.length + 1}` };
            sources.push(added);
            addedSources.push(added);
          }
          if (addedSources.length > 0) {
            claims = checkClaims(extractClaims(input.answer), sources, entities);
            if (facts.length > 0) {
              const compared = compareWithReading(claims, facts);
              claims = compared.claims;
              review.disagreements = compared.disagreements.map((d) => ({ ...d, resolved: false }));
            }
          }
        } catch {
          // a failed extra search changes nothing: the first evidence stands
        }
      }
    }

    const conflicts = detectReleaseDateConflicts(sources, input.question);
    const { status, reasons } = statusOf({ decision, claims, sources, freshnessRequired, category: input.pack?.category ?? 'GENERAL', review, conflicts, answer: input.answer });
    return {
      report: {
        level: decision.level, levelBasis: decision.basis, levelReasons: decision.reasons,
        claims, counts: countsOf(claims), review, evidence: evidenceStats(sources), conflicts, extraRetrievals: extra,
        revision: 'NONE', status, statusReasons: reasons,
      },
      addedSources, facts, sources,
    };
  }
}

export type { ReviewMode, Disagreement };
