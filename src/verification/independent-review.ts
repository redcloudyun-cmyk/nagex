// A SECOND MODEL READS THE SAME EVIDENCE - without seeing the answer.
//
// The reviewer is given only the question and the retrieved sources (the same text the answer was written from) and is asked what the sources state about the question, each statement with an exact quote.
// NAgex then checks every quote against the source text (verifyClaims: a quote that is not in the source, or a figure that is not in the quote, is refused), so the reviewer's findings are as trustworthy as
// the sources and no more. Only then are they compared with the answer. The reviewer never sees the first model's conclusion, which keeps the two readings independent.
//
// "Independent" is a property of the PROVIDER: a second, distinct provider (a different company's model, or at least a different configured provider). The same provider reading the evidence again with a
// different prompt is SELF_REVIEW and is reported as that - it is never counted as independent verification. If the router silently answered with the provider that wrote the answer, the review is
// downgraded to SELF_REVIEW as well.
import { significantNumbers, verifyClaims } from '../research/claim-verification.js';
import { queryTerms } from '../research/evidence-excerpt.js';
import type { EvidenceSource } from '../research/evidence-pack.types.js';
import { sourceTextOf } from './claim-checker.js';
import type { ClaimCheck, Disagreement, ReviewMode } from './verification.types.js';

export interface ReadingPlan { mode: 'INDEPENDENT_MODEL_REVIEW' | 'SELF_REVIEW'; provider: string }

export interface ReviewReadingPort {
  /** which provider could read the evidence, and whether it is independent of the one that wrote the answer; null = none usable */
  plan(answerProvider: string | null, allowSelfReview: boolean): ReadingPlan | null;
  read(args: { question: string; language: 'ko' | 'en'; sources: Array<{ sourceId: string; title: string; publisher: string; publishedAt?: string; text: string }>; provider: string; independent: boolean; requestId?: string }): Promise<{ claims: unknown[]; provider: string; model: string }>;
}

/** the router and AiService, narrowed to what the review needs (so a test can stand in for either) */
// `status`: CONFIGURED (not called yet), LIVE (the last call worked) and DEGRADED (the last call failed) - a provider that has not been called yet is as usable as one that works; one that just failed is not
export interface ReviewRouter { statuses(): Array<{ provider: string; configured: boolean; status: string }> }
export interface ReviewModel {
  researchExtractClaims(input: { query: string; locale: 'en' | 'ko'; sources: Array<{ sourceId: string; title: string; publisher: string; publishedAt?: string; text: string }>; mode?: string; requestId?: string; fallbackPolicy?: 'ALLOW' | 'DISALLOW' }): Promise<{ data: { claims: unknown[] }; provider: string; model: string }>;
}

export class GatewayReviewReading implements ReviewReadingPort {
  constructor(private readonly router: ReviewRouter, private readonly model: ReviewModel) {}

  public plan(answerProvider: string | null, allowSelfReview: boolean): ReadingPlan | null {
    const usable = this.router.statuses().filter((s) => s.configured && s.status !== 'DEGRADED').map((s) => s.provider);
    const distinct = usable.find((p) => p !== answerProvider);
    if (distinct) return { mode: 'INDEPENDENT_MODEL_REVIEW', provider: distinct };
    if (allowSelfReview && answerProvider && usable.includes(answerProvider)) return { mode: 'SELF_REVIEW', provider: answerProvider };
    return null;
  }

  public async read(args: Parameters<ReviewReadingPort['read']>[0]) {
    const result = await this.model.researchExtractClaims({
      query: args.question, locale: args.language, sources: args.sources, mode: args.provider,
      // an independent reading that silently fell back to the provider that wrote the answer would not be independent
      fallbackPolicy: args.independent ? 'DISALLOW' : 'ALLOW',
      ...(args.requestId ? { requestId: `${args.requestId}_review` } : {}),
    });
    return { claims: result.data.claims, provider: result.provider, model: result.model };
  }
}

export interface ReviewFact { sourceId: string; statement: string; quote: string }

/** What the reviewer found that survives NAgex's own check: the quote is in the source, the figures are in the quote. */
export function verifiedFacts(rawClaims: unknown, sources: EvidenceSource[]): ReviewFact[] {
  const checked = verifyClaims(rawClaims, sources.map((s) => ({ sourceId: s.sourceId, text: sourceTextOf(s) })));
  return checked.verified.map((c) => ({ sourceId: c.sourceId, statement: c.statement, quote: c.quote }));
}

const distinctive = (text: string): string[] => queryTerms(text).filter((t) => !/^\d+$/.test(t) && t.length >= 2);

/**
 * Compares the answer's material claims with what the independent reading found in the same sources.
 * A claim the evidence check could not support (UNSUPPORTED) whose topic the reviewer found a verified fact about - with different figures - is CONTRADICTED by that fact; the fact is kept as `found`.
 * A claim the reviewer's facts agree with counts as an agreement. Nothing the reviewer says changes a SUPPORTED claim: the sources already support it.
 */
export function compareWithReading(claims: ClaimCheck[], facts: ReviewFact[]): { claims: ClaimCheck[]; disagreements: Disagreement[]; agreements: number } {
  const disagreements: Disagreement[] = [];
  let agreements = 0;
  const out = claims.map((claim): ClaimCheck => {
    if (!claim.material || claim.figures.length === 0) return claim;
    const claimTerms = new Set(distinctive(claim.text));
    const related = facts.filter((f) => distinctive(`${f.statement} ${f.quote}`).filter((t) => claimTerms.has(t)).length >= 2);
    if (related.length === 0) return claim;
    const factFigures = new Set(related.flatMap((f) => significantNumbers(`${f.statement} ${f.quote}`)));
    if (claim.figures.every((figure) => factFigures.has(figure))) { agreements += 1; return claim; }
    if (claim.status !== 'UNSUPPORTED') return claim;
    // the figures the reviewer found for this topic differ from the answer's, and the answer's are in no source
    const differing = related.find((f) => significantNumbers(`${f.statement} ${f.quote}`).some((n) => !claim.figures.includes(n)));
    if (!differing) return claim;
    disagreements.push({ answer: claim.text, review: differing.quote.slice(0, 240), sourceId: differing.sourceId, resolved: false });
    return { ...claim, status: 'CONTRADICTED', reason: 'INDEPENDENT_READING_DIFFERS', found: differing.quote.slice(0, 240) };
  });
  return { claims: out, disagreements, agreements };
}

export type ReviewOutcome = { mode: ReviewMode; reviewerProvider: string | null; facts: ReviewFact[]; failed: boolean };
