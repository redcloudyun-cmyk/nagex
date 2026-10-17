// What NAgex can say about an answer AFTER it was written: how deeply it was checked, which of its claims the evidence supports, whether a second model read the same evidence independently, and the
// honest final status. Everything here is a FACT about a check that was made - never a score, never a model's opinion of itself.
//
//   VERIFIED            every material claim is supported by a source it cites, nothing is contradicted, the evidence is usable
//   PARTIALLY_VERIFIED  some material claims are supported, others could not be checked (or a stronger check the level asks for was not possible)
//   UNVERIFIED          nothing could be checked against evidence (no sources, or the claims carry nothing checkable)
//   DISPUTED            a material claim is contradicted, or sources / models disagree and the disagreement was not resolved
//   NOT_REQUIRED        the question needs no verification (level L0)
export type VerificationLevel = 'L0' | 'L1' | 'L2' | 'L3';
export const VERIFICATION_LEVELS: readonly VerificationLevel[] = ['L0', 'L1', 'L2', 'L3'];

export type VerificationStatus = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'DISPUTED' | 'NOT_REQUIRED';

/** who raised the level above the structural base - recorded so a level is never unexplained */
export type LevelBasis = 'RULES' | 'USER_PREFERENCE' | 'OBSERVED_UNCERTAINTY' | 'ADVISOR';

export type ClaimStatus =
  /** every checkable figure of the claim is in a source the claim cites */
  | 'SUPPORTED'
  /** a figure of the claim is in no retrieved source, or the cited sources do not speak of what the claim speaks of */
  | 'UNSUPPORTED'
  /** a verified source (or the independent reading of one) states something else for the same thing */
  | 'CONTRADICTED'
  /** nothing in the claim can be checked against a source (no figure, no citation) */
  | 'UNCHECKABLE';

export interface ClaimCheck {
  id: string;
  /** the claim as written (a sentence or a table row), bounded */
  text: string;
  sourceIds: string[];
  figures: string[];
  status: ClaimStatus;
  /** a coded reason, never provider text */
  reason: 'FIGURES_IN_CITED_SOURCE' | 'FIGURE_NOT_IN_ANY_SOURCE' | 'FIGURE_ONLY_IN_UNCITED_SOURCE' | 'CITED_SOURCE_OFF_TOPIC' | 'NO_CITATION' | 'NOTHING_CHECKABLE' | 'INDEPENDENT_READING_DIFFERS';
  /** a claim a person would act on or compare: a figure, a date, a release or availability statement */
  material: boolean;
  /** for CONTRADICTED / UNSUPPORTED by review: what the independent reading found instead (a verified quote), bounded */
  found?: string;
}

export type ReviewMode =
  /** a second, DISTINCT provider read the same evidence without seeing the answer */
  | 'INDEPENDENT_MODEL_REVIEW'
  /** the same provider read the evidence again with a different prompt: NOT independent, and said so */
  | 'SELF_REVIEW'
  /** the level did not ask for it */
  | 'NOT_REQUIRED'
  /** asked for, not possible (no distinct provider configured, or it failed): the check was done without it */
  | 'UNAVAILABLE';

export interface Disagreement {
  /** what the answer says and what the independent reading found, both as short text */
  answer: string;
  review: string;
  sourceId: string | null;
  resolved: boolean;
}

export interface SourceConflict {
  /** the thing and the attribute, as written in the sources ("release date of X") */
  /** what kind of disagreement (the client words it in the person's language) */
  kind: 'RELEASE_DATE' | 'ANNOUNCEMENT_DATE';
  /** the named thing it is about, as the person wrote it */
  subject: string;
  topic: string;
  values: Array<{ sourceId: string; value: string }>;
}

export interface VerificationReport {
  level: VerificationLevel;
  levelBasis: LevelBasis;
  levelReasons: string[];
  claims: ClaimCheck[];
  counts: { checked: number; material: number; supported: number; unsupported: number; contradicted: number; uncheckable: number };
  review: { mode: ReviewMode; answerProvider: string | null; reviewerProvider: string | null; independentFacts: number; disagreements: Disagreement[] };
  evidence: { sources: number; pagesRead: number; current: number; stale: number; undated: number; primaryLike: number };
  conflicts: SourceConflict[];
  /** extra searches made to settle a disagreement (bounded) */
  extraRetrievals: number;
  /** what happened to the answer because of the findings */
  revision: 'NONE' | 'REWRITTEN' | 'REDACTED';
  status: VerificationStatus;
  /** why the status is what it is, coded */
  statusReasons: string[];
}
