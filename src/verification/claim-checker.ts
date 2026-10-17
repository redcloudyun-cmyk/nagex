// CLAIMS OF AN ANSWER, CHECKED AGAINST THE EVIDENCE - deterministic, no model.
//
// An answer is cut into claims (a sentence, a table row). A claim is MATERIAL when a person would act on or compare it: it carries a figure (a number, a date) or states that something is released /
// available. For each claim NAgex asks the one question it can answer exactly: is every figure of the claim in a source the claim cites? A figure that is in no retrieved source is UNSUPPORTED; a claim
// that cites a source which does not speak of what the claim speaks of is UNSUPPORTED; a claim with nothing checkable is UNCHECKABLE - never "supported". Nothing here believes a model's confidence.
//
// What this cannot do, and does not pretend to: tell whether a SUPPORTED figure is attached to the right attribute (the figure 215 may sit in the source next to something else). That is the job of the
// independent reading (independent-review.ts), which compares what a second model found in the same sources.
import { citedIdsIn, withoutCitations } from '../model-gateway/chat-grounding.js';
import { normalizeForMatch, significantNumbers } from '../research/claim-verification.js';
import { versionedTokens } from '../research/evidence-excerpt.js';
import type { EvidenceSource } from '../research/evidence-pack.types.js';
import type { ClaimCheck, SourceConflict } from './verification.types.js';

export interface RawClaim { text: string; sourceIds: string[]; figures: string[]; material: boolean }

// A calendar date is ONE figure: "2026-08-05", "2026년 8월 5일" and "2026.8.5" are the same date, whatever the digits of its parts would say (a lone 8 or 5 is not a figure at all). The rest of the text keeps
// the ordinary figure rules.
const CALENDAR_DATE = /(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})\s*일?/g;
export function figuresOf(text: string): string[] {
  const dates: string[] = [];
  const rest = String(text ?? '').replace(CALENDAR_DATE, (_m, y: string, mo: string, d: string) => {
    const [yy, mm, dd] = [Number(y), Number(mo), Number(d)];
    if (yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) dates.push(`date:${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
    return ' ';
  });
  return [...dates, ...significantNumbers(rest)];
}

// A statement that something IS / WAS released, on sale or announced - not every mention of the word ("출시 색상" is a colour list, "the available source" is not a release claim)
const RELEASE_STATEMENT = /(출시\s*(?:되|됐|했|한|된|일|예정|시기|날짜)|발매\s*(?:되|됐|했|한|된|일|예정)|판매\s*(?:중|되|시작)|공개\s*(?:되|됐|했|된)|발표\s*(?:되|됐|했|된)|\b(?:(?:has|have|had|was|were|been|is|are)\s+(?:been\s+)?(?:released|launched|announced|unveiled)|released\s+(?:in|on)|launched\s+(?:in|on)|(?:became|become|becomes|is|are|now)\s+available|on sale|unreleased)\b)/i;
const MAX_CLAIM_CHARS = 280;
const MAX_CLAIMS = 60;

/** the sentence-like units of an answer, in order: table rows (the header row and the separator are not claims), list items and sentences. `row` marks a table row (removed whole, never cut). */
export function answerUnits(answer: string): Array<{ text: string; row: boolean }> {
  const lines = String(answer ?? '').replace(/\r/g, '').split('\n');
  const units: Array<{ text: string; row: boolean }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue; // the separator row
      // the header row of a table is the row followed by a separator row
      if (/^\|[\s:|-]+\|?$/.test((lines[i + 1] ?? '').trim())) continue;
      units.push({ text: line, row: true });
      continue;
    }
    for (const sentence of line.split(/(?<=[.!?。！？])\s+/)) if (sentence.trim()) units.push({ text: sentence.trim(), row: false });
  }
  return units;
}

/** the plain text of a unit: no citation markers, no emphasis marks (what a claim is recorded as) */
const plainFull = (unit: string): string => withoutCitations(unit).replace(/\*\*|__|`/g, '').replace(/ +([.,;:!?。])/g, '$1').trim();
export const plainOfUnit = (unit: string): string => plainFull(unit).slice(0, MAX_CLAIM_CHARS);

export function extractClaims(answer: string): RawClaim[] {
  const claims: RawClaim[] = [];
  for (const { text: unit } of answerUnits(answer)) {
    const sourceIds = citedIdsIn(unit);
    const plain = plainFull(unit);
    const figures = Array.from(new Set(figuresOf(plain)));
    const material = figures.length > 0 || RELEASE_STATEMENT.test(plain);
    if (!material && sourceIds.length === 0) continue;
    claims.push({ text: plain.slice(0, MAX_CLAIM_CHARS), sourceIds, figures, material });
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

/** What a source can be checked against: the whole page text when it was read (kept in memory, never sent to the client), else the passages and the summary. */
export function sourceTextOf(source: EvidenceSource): string {
  return source.fullText ?? [source.title, source.snippet ?? '', source.excerpt ?? ''].join('\n');
}

interface SourceView { id: string; normalized: string; numbers: Set<string> }
function viewOf(sources: EvidenceSource[]): Map<string, SourceView> {
  return new Map(sources.map((s) => {
    const text = sourceTextOf(s);
    return [s.sourceId, { id: s.sourceId, normalized: normalizeForMatch(text).replace(/\s+/g, ''), numbers: new Set(figuresOf(text)) }] as const;
  }));
}

/**
 * `questionEntities`: the named, versioned things the QUESTION is about (versionedTokens of it). A claim is judged "off topic" only against those: a Hangul word followed by a number in a claim ("무게는 215g")
 * is an attribute and its value, not a product name.
 */
export function checkClaims(raw: RawClaim[], sources: EvidenceSource[], questionEntities?: string[]): ClaimCheck[] {
  const views = viewOf(sources);
  const noSources = sources.length === 0;
  return raw.map((claim, index): ClaimCheck => {
    const id = `K${index + 1}`;
    const cited = claim.sourceIds.filter((sid) => views.has(sid));
    const base = { id, text: claim.text, sourceIds: cited, figures: claim.figures, material: claim.material };
    if (noSources) return { ...base, status: 'UNCHECKABLE', reason: 'NO_CITATION' };

    // a citation to a source that speaks of other things than the claim is not support
    const entities = versionedTokens(claim.text).filter((e) => !questionEntities || questionEntities.includes(e));
    if (cited.length > 0 && entities.length > 0 && !cited.some((sid) => entities.some((e) => views.get(sid)!.normalized.includes(e)))) {
      // the cited page is about something else; when ANOTHER retrieved page is about the named thing and has the figures, the claim is supported and mis-cited - not unsupported
      const about = claim.figures.length === 0 ? [] : sources.filter((s) => !cited.includes(s.sourceId) && entities.some((e) => views.get(s.sourceId)!.normalized.includes(e)) && claim.figures.every((f) => views.get(s.sourceId)!.numbers.has(f)));
      if (about.length > 0) return { ...base, sourceIds: [...cited, ...about.map((s) => s.sourceId)], status: 'SUPPORTED', reason: 'FIGURE_ONLY_IN_UNCITED_SOURCE' };
      return { ...base, status: 'UNSUPPORTED', reason: 'CITED_SOURCE_OFF_TOPIC' };
    }
    if (claim.figures.length === 0) {
      return { ...base, status: 'UNCHECKABLE', reason: cited.length === 0 ? 'NO_CITATION' : 'NOTHING_CHECKABLE' };
    }
    const inCited = (figure: string): boolean => cited.some((sid) => views.get(sid)!.numbers.has(figure));
    const missing = claim.figures.filter((f) => !inCited(f));
    if (missing.length === 0) return { ...base, status: 'SUPPORTED', reason: 'FIGURES_IN_CITED_SOURCE' };
    const elsewhere = sources.filter((s) => !cited.includes(s.sourceId) && missing.every((f) => views.get(s.sourceId)!.numbers.has(f)));
    // the evidence has it, the claim did not cite it: supported by the evidence, and said to be mis-cited - not unsupported
    if (elsewhere.length > 0) return { ...base, sourceIds: [...cited, ...elsewhere.map((s) => s.sourceId)], status: 'SUPPORTED', reason: 'FIGURE_ONLY_IN_UNCITED_SOURCE' };
    return { ...base, status: 'UNSUPPORTED', reason: 'FIGURE_NOT_IN_ANY_SOURCE' };
  });
}

// ---- sources that disagree with each other ------------------------------------------------------------------------------------------------------------------------------------------------------
// The one disagreement that can be read mechanically and that decides whether an answer about a product is right: the DATE a named thing was released (or announced). Two sources that give different
// dates for the same named thing and the same kind of date are a conflict; an answer that picks one without saying so is not VERIFIED.
const DATE = /(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})/;
const RELEASE_WORD = /(출시|발매|판매\s*시작|release[sd]?|launch(?:ed)?|on sale|available)/i;
const ANNOUNCE_WORD = /(발표|공개|언팩|announce[sd]?|unveil(?:ed)?)/i;

function isoDate(match: RegExpExecArray): string | null {
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
}

/** the named thing as the person wrote it ("Helio Watch 4"), found again from its matching token ("watch4" / "heliowatch4"): the words of the question that spell it, plus the capitalised words just before */
function displayNameOf(question: string, token: string): string {
  const words = String(question ?? '').split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  for (let end = 0; end < words.length; end += 1) {
    for (let start = end; start >= Math.max(0, end - 2); start -= 1) {
      if (words.slice(start, end + 1).join('').toLowerCase() !== token) continue;
      let from = start;
      // a name is often longer than the token that matched: "Helio" before "Watch 4"
      while (from > 0 && from - 1 > 0 && /^\p{Lu}/u.test(words[from - 1])) from -= 1;
      return words.slice(from, end + 1).join(' ');
    }
  }
  return token;
}

const DATE_GLOBAL = new RegExp(DATE.source, 'g');
const OTHER_NAMED_THING = /[\p{L}]{2,}\d/u;

/**
 * The dates a text gives for a NAMED thing. A date is attributed to the thing only when it FOLLOWS the name closely, with a release or announcement word between them, and no other named thing
 * (a name followed by a number) stands in between: "A was announced in 2025, B is released on 2026-07-22" gives B the second date, never A. Text with no such shape gives nothing - a conflict is
 * claimed only where the reading is unambiguous.
 */
export function datesGiven(text: string, token: string): Array<{ kind: 'RELEASE' | 'ANNOUNCE'; value: string }> {
  const flat = normalizeForMatch(text).replace(/\s+/g, '');
  const found: Array<{ kind: 'RELEASE' | 'ANNOUNCE'; value: string }> = [];
  let from = 0;
  for (let at = flat.indexOf(token, from); at >= 0; at = flat.indexOf(token, from)) {
    from = at + token.length;
    const span = flat.slice(from, from + 110);
    DATE_GLOBAL.lastIndex = 0;
    const date = DATE_GLOBAL.exec(span);
    if (!date) continue;
    const iso = isoDate(date);
    const between = span.slice(0, date.index);
    // "B is the successor of A, announced on <date>": the date is B's, not A's - a relation between the name and the date makes the reading ambiguous, so nothing is claimed
    if (/(?:후속|전작|이전|successor|predecessor|previous|follow(?:s|ed|-?up)?)/i.test(between)) continue;
    // (the words of a release, and the names of months, are not other named things)
    if (!iso || OTHER_NAMED_THING.test(between.replace(/(?:출시|발매|발표|공개|언팩|release[sd]?|launch(?:ed)?|announce[sd]?|unveil(?:ed)?|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)/gi, ''))) continue;
    // the word that closes the date ("2026-07-22에 출시", "on 2026-07-22 released") or, failing that, the one that opens it ("released on 2026-07-22") decides what kind of date it is
    const kindOf = (m: string): 'RELEASE' | 'ANNOUNCE' => (RELEASE_WORD.test(m) ? 'RELEASE' : 'ANNOUNCE');
    const words = new RegExp(`${RELEASE_WORD.source}|${ANNOUNCE_WORD.source}`, 'gi');
    const afterDate = span.slice(date.index + date[0].length, date.index + date[0].length + 14);
    const closing = Array.from(afterDate.matchAll(words))[0];
    let kind: 'RELEASE' | 'ANNOUNCE' | null = closing ? kindOf(closing[0]) : null;
    if (!kind) for (const m of between.matchAll(words)) kind = kindOf(m[0]);
    if (kind) found.push({ kind, value: iso });
  }
  return found;
}

export function detectReleaseDateConflicts(sources: EvidenceSource[], question: string): SourceConflict[] {
  const tokens = versionedTokens(question);
  if (tokens.length === 0) return [];
  const conflicts: SourceConflict[] = [];
  for (const token of tokens) {
    for (const kind of ['RELEASE', 'ANNOUNCE'] as const) {
      const values: Array<{ sourceId: string; value: string }> = [];
      for (const source of sources) {
        for (const given of datesGiven(sourceTextOf(source), token)) {
          if (given.kind === kind && !values.some((v) => v.sourceId === source.sourceId && v.value === given.value)) values.push({ sourceId: source.sourceId, value: given.value });
        }
      }
      const distinct = new Set(values.map((v) => v.value));
      const bySource = new Set(values.map((v) => v.sourceId));
      // two sources that each give ONE date, and different ones; a source that lists several dates for a name is not "disagreeing with itself"
      const oneDateEach = Array.from(bySource).every((id) => new Set(values.filter((v) => v.sourceId === id).map((v) => v.value)).size === 1);
      if (distinct.size > 1 && bySource.size > 1 && oneDateEach) conflicts.push({ kind: kind === 'RELEASE' ? 'RELEASE_DATE' : 'ANNOUNCEMENT_DATE', subject: displayNameOf(question, token), topic: `${kind === 'RELEASE' ? 'release' : 'announcement'} date of ${displayNameOf(question, token)}`, values });
    }
  }
  return conflicts;
}

// ---- removing what the evidence does not support -----------------------------------------------------------------------------------------------------------------------------------------------
/** Removes the units whose claim text is in `remove` (a table row whole, a sentence whole) and says plainly that something was left out. Never rewrites what remains. */
export function redactClaims(answer: string, remove: Set<string>, language: 'ko' | 'en'): string {
  if (remove.size === 0) return String(answer ?? '');
  let out = String(answer ?? '');
  let removed = 0;
  for (const unit of answerUnits(answer)) {
    if (!remove.has(plainOfUnit(unit.text))) continue;
    const at = out.indexOf(unit.text);
    if (at < 0) continue;
    const end = at + unit.text.length;
    // a table row leaves no empty line behind
    out = out.slice(0, at) + out.slice(unit.row && out[end] === '\n' ? end + 1 : end);
    removed += 1;
  }
  if (removed === 0) return String(answer ?? '');
  // a table that lost every row keeps neither its header nor its separator
  const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|?$/.test(line.trim());
  const lines = out.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('|') && !isSeparator(lines[i]) && isSeparator(lines[i + 1] ?? '') && !(lines[i + 2] ?? '').trim().startsWith('|')) { i += 1; continue; }
    kept.push(lines[i]);
  }
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const note = language === 'ko' ? '※ 근거로 확인되지 않은 내용은 뺐습니다.' : 'Note: statements the sources do not support were left out.';
  return body ? `${body}\n\n${note}` : note;
}
