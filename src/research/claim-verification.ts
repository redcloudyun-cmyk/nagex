// A claim in a research report is only as good as the text it was found in. A model extracts claims from retrieved source text; NAgex decides which of them are admitted:
//   - the claim must name a source that was actually retrieved in this run;
//   - its quote must really occur in that source's text (after harmless normalisation) - a paraphrase, a memory or an invention does not;
//   - the figures in the statement must be in the quote - a rounded, converted or invented number is refused;
//   - it must not repeat an admitted claim.
// Everything here is pure and deterministic; the model never gets to vouch for its own output.
import type { ResearchClaimRecord, ResearchConflictRecord } from './research-run.types.js';

export interface ClaimSourceText {
  sourceId: string;
  text: string;
}

export interface RawClaim {
  sourceId?: unknown;
  statement?: unknown;
  quote?: unknown;
}

export type ClaimRejectionReason = 'MALFORMED' | 'UNKNOWN_SOURCE' | 'QUOTE_TOO_SHORT' | 'QUOTE_NOT_IN_SOURCE' | 'NUMBER_NOT_IN_QUOTE' | 'STATEMENT_LENGTH' | 'DUPLICATE' | 'OVER_LIMIT';

export interface ClaimVerification {
  verified: ResearchClaimRecord[];
  rejected: Array<{ reason: ClaimRejectionReason; sourceId?: string; statement?: string }>;
}

export const CLAIM_LIMITS = { minQuoteChars: 20, maxQuoteChars: 500, minStatementChars: 15, maxStatementChars: 600, maxPerSource: 8, maxTotal: 40 } as const;

/** Text normalised for matching only: case, width, quotation marks, dashes, reference markers like [12] and whitespace do not make two texts different. */
export function normalizeForMatch(input: string): string {
  return String(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\[(?:\d{1,3}|[a-z]|citation needed|note \d{1,3})\]/g, '')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

// a unit or scale word that turns a lone digit into a figure: "5 billion", "3x", "8억", "9 달러"
const FIGURE_UNIT = /^\s?(?:(?:billion|million|trillion|thousand|bn|percent|pct|times)(?![a-z])|x(?![a-z])|%|배|억|만|조|천|백|달러|원|명|퍼센트)/i;

/**
 * The figures in a text: numbers with 2+ digits or a decimal part, and a lone digit that carries a percent sign, a currency symbol or a unit / scale word ("5 billion", "8억"). A lone small digit in
 * prose ("3 trends", "Q3") is not a figure. A claim whose statement has a figure its quote does not have is refused - which also catches a converted scale ("$830 million" written as "8억 3천만 달러").
 */
export function significantNumbers(text: string): string[] {
  const found: string[] = [];
  const source = String(text).normalize('NFKC');
  for (const match of source.matchAll(/([$€£¥₩])?\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const core = match[2].replace(/,/g, '');
    const after = source.slice((match.index ?? 0) + match[0].length);
    const hasCurrency = Boolean(match[1]);
    const hasUnit = FIGURE_UNIT.test(after);
    if (core.replace('.', '').length >= 2 || core.includes('.') || hasCurrency || hasUnit) found.push(core.replace(/^0+(?=\d)/, ''));
  }
  return found;
}

function quoteOccursIn(normalizedQuote: string, normalizedText: string): boolean {
  // "...", "…" inside a quote mean "something was left out here": every segment must occur, in order
  const segments = normalizedQuote.split(/\.{3}|…/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  let from = 0;
  for (const segment of segments) {
    if (segments.length > 1 && segment.length < 10) return false;
    const at = normalizedText.indexOf(segment, from);
    if (at < 0) return false;
    from = at + segment.length;
  }
  return true;
}

export function verifyClaims(rawClaims: unknown, sources: ClaimSourceText[]): ClaimVerification {
  const verified: ResearchClaimRecord[] = [];
  const rejected: ClaimVerification['rejected'] = [];
  const normalizedBySource = new Map(sources.map((s) => [s.sourceId, normalizeForMatch(s.text)]));
  const perSource = new Map<string, number>();
  const seen = new Set<string>();
  const list = Array.isArray(rawClaims) ? rawClaims : [];

  for (const item of list) {
    const raw = (item && typeof item === 'object' ? item : {}) as RawClaim;
    const sourceId = typeof raw.sourceId === 'string' ? raw.sourceId.trim() : '';
    const statement = typeof raw.statement === 'string' ? raw.statement.replace(/\s+/g, ' ').trim() : '';
    const quote = typeof raw.quote === 'string' ? raw.quote.replace(/\s+/g, ' ').trim() : '';
    const refuse = (reason: ClaimRejectionReason) => { rejected.push({ reason, sourceId: sourceId || undefined, ...(statement ? { statement: statement.slice(0, 200) } : {}) }); };
    if (!sourceId || !statement || !quote) { refuse('MALFORMED'); continue; }
    const sourceText = normalizedBySource.get(sourceId);
    if (sourceText === undefined) { refuse('UNKNOWN_SOURCE'); continue; }
    if (statement.length < CLAIM_LIMITS.minStatementChars || statement.length > CLAIM_LIMITS.maxStatementChars) { refuse('STATEMENT_LENGTH'); continue; }
    const normalizedQuote = normalizeForMatch(quote);
    if (normalizedQuote.length < CLAIM_LIMITS.minQuoteChars || quote.length > CLAIM_LIMITS.maxQuoteChars) { refuse('QUOTE_TOO_SHORT'); continue; }
    if (!quoteOccursIn(normalizedQuote, sourceText)) { refuse('QUOTE_NOT_IN_SOURCE'); continue; }
    const quoteNumbers = new Set(significantNumbers(quote));
    if (significantNumbers(statement).some((n) => !quoteNumbers.has(n))) { refuse('NUMBER_NOT_IN_QUOTE'); continue; }
    const key = normalizeForMatch(statement);
    if (seen.has(key)) { refuse('DUPLICATE'); continue; }
    if ((perSource.get(sourceId) ?? 0) >= CLAIM_LIMITS.maxPerSource || verified.length >= CLAIM_LIMITS.maxTotal) { refuse('OVER_LIMIT'); continue; }
    seen.add(key);
    perSource.set(sourceId, (perSource.get(sourceId) ?? 0) + 1);
    verified.push({ claimId: `C${verified.length + 1}`, sourceId, statement, quote });
  }
  return { verified, rejected };
}

/** Conflicts the model flagged are kept only when they point at two or more distinct claims that exist. */
export function validateConflicts(rawConflicts: unknown, claims: ResearchClaimRecord[]): ResearchConflictRecord[] {
  const known = new Set(claims.map((c) => c.claimId));
  const out: ResearchConflictRecord[] = [];
  for (const item of Array.isArray(rawConflicts) ? rawConflicts : []) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as { topic?: unknown; note?: unknown; claimIds?: unknown };
    const topic = typeof raw.topic === 'string' ? raw.topic.replace(/\s+/g, ' ').trim() : '';
    const note = typeof raw.note === 'string' ? raw.note.replace(/\s+/g, ' ').trim() : '';
    const ids = [...new Set((Array.isArray(raw.claimIds) ? raw.claimIds : []).filter((id): id is string => typeof id === 'string' && known.has(id)))];
    if (!topic || ids.length < 2) continue;
    out.push({ topic: topic.slice(0, 200), claimIds: ids, note: note.slice(0, 500) });
    if (out.length >= 6) break;
  }
  return out;
}

/** The part of a long page worth giving the model: the opening, then the paragraphs that share the most words with the question, in their original order. */
export function relevantExcerpt(text: string, query: string, budget: number): string {
  if (text.length <= budget) return text;
  const paragraphs = text.split('\n').filter((p) => p.trim().length > 0);
  const terms = [...new Set(normalizeForMatch(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];
  const scored = paragraphs.map((p, index) => {
    const lower = normalizeForMatch(p);
    return { index, p, score: terms.filter((t) => lower.includes(t)).length + (p.length > 60 ? 0.5 : 0) };
  });
  const chosen = new Set<number>();
  let used = 0;
  const take = (entry: { index: number; p: string }) => {
    if (chosen.has(entry.index) || used + entry.p.length + 1 > budget) return;
    chosen.add(entry.index);
    used += entry.p.length + 1;
  };
  if (scored[0]) take(scored[0]);
  for (const entry of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) take(entry);
  return scored.filter((e) => chosen.has(e.index)).map((e) => e.p).join('\n');
}
