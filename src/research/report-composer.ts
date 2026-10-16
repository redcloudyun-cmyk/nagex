// Turns a model's draft of a research report into the report NAgex is willing to hand over. The model proposes sections and paragraphs, each pointing at verified claims by id; NAgex decides what is kept
// and writes the Markdown itself:
//   - a FACT paragraph must cite at least one verified claim and may only contain figures those claims contain; otherwise it is dropped;
//   - an ANALYSIS paragraph is the model's own interpretation: it is labelled as such and may not introduce a figure that no verified claim contains;
//   - citation markers [1], [2] ... are generated here from the claims' sources (anything the model wrote that looks like a citation or a URL is removed) so a marker can only ever point at a source that
//     was retrieved in this run;
//   - the Sources section lists exactly the cited sources with address, publisher, publication and update dates, retrieval time and how the text was obtained;
//   - the Method section states what was searched, what was retrieved, what was rejected, and what the reader should be careful about.
// Nothing here calls a model or the network.
import { significantNumbers } from './claim-verification.js';
import type { ResearchClaimRecord, ResearchConflictRecord, ResearchSkippedSource, ResearchSourceRecord } from './research-run.types.js';

export type ParagraphDropReason = 'MALFORMED' | 'NO_VERIFIED_CITATION' | 'UNSUPPORTED_NUMBER' | 'TOO_SHORT_OR_LONG';

export interface ComposeStats {
  provider: string;
  plannedQueries: string[];
  candidateCount: number;
  retrievedCount: number;
  rejectedClaims: number;
  generatedAt: string;
}

export interface ComposedReport {
  title: string;
  summary: string;
  markdown: string;
  citedSourceIds: string[];
  keptParagraphs: number;
  droppedParagraphs: number;
  dropReasons: Partial<Record<ParagraphDropReason, number>>;
  conflicts: ResearchConflictRecord[];
}

const LABELS = {
  en: {
    analysis: 'Analysis',
    conflicts: 'Conflicting or uncertain information',
    sources: 'Sources',
    method: 'Method and limitations',
    published: 'published',
    updated: 'updated',
    publishedUnknown: 'publication date not stated',
    retrieved: 'retrieved',
    fullText: 'full page read',
    snippet: "only the search provider's excerpt was available",
    searchedWith: 'Search provider',
    queries: 'Searches',
    counts: (candidates: number, retrieved: number, cited: number) => `${candidates} candidate sources, ${retrieved} retrieved, ${cited} cited in this report.`,
    claims: (kept: number, rejected: number) => `${kept} statements were checked against the retrieved text; ${rejected} proposed statements were rejected because they could not be matched to it or were off topic.`,
    generated: 'Generated',
    analysisNote: 'Paragraphs marked "Analysis" are interpretation by NAgex, not statements made by a source.',
    snippetNote: (n: number) => `${n} source(s) could not be fetched in full and were read only through the search provider's excerpt.`,
    skippedNote: (n: number) => `${n} candidate source(s) were not used because the site did not permit retrieval or the page could not be read.`,
    staleNote: (n: number) => `${n} cited source(s) may be out of date or have no stated date.`,
    truncatedNote: (n: number) => `${n} cited page(s) were long; only the beginning of each was read.`,
    robots: 'robots.txt and site access rules were respected.',
  },
  ko: {
    analysis: '분석',
    conflicts: '상충하거나 불확실한 정보',
    sources: '출처',
    method: '조사 방법과 한계',
    published: '발행',
    updated: '수정',
    publishedUnknown: '발행일 미확인',
    retrieved: '확인',
    fullText: '원문 전체 확인',
    snippet: '검색 제공자가 준 발췌만 확인',
    searchedWith: '검색 제공자',
    queries: '검색어',
    counts: (candidates: number, retrieved: number, cited: number) => `후보 출처 ${candidates}건 중 ${retrieved}건을 가져왔고, 이 보고서는 ${cited}건을 인용합니다.`,
    claims: (kept: number, rejected: number) => `가져온 원문과 대조해 확인한 진술은 ${kept}건이며, 원문과 일치하지 않거나 주제와 맞지 않아 제외한 제안 진술은 ${rejected}건입니다.`,
    generated: '작성 시각',
    analysisNote: '"분석"으로 표시한 문단은 출처의 진술이 아니라 NAgex의 해석입니다.',
    snippetNote: (n: number) => `${n}건은 원문 전체를 가져오지 못해 검색 제공자가 준 발췌만으로 확인했습니다.`,
    skippedNote: (n: number) => `${n}건은 사이트가 수집을 허용하지 않았거나 페이지를 읽을 수 없어 사용하지 않았습니다.`,
    staleNote: (n: number) => `인용한 출처 중 ${n}건은 오래되었거나 날짜가 명시되지 않았을 수 있습니다.`,
    truncatedNote: (n: number) => `인용한 페이지 중 ${n}건은 길이가 길어 앞부분만 읽었습니다.`,
    robots: 'robots.txt와 사이트 접근 규칙을 지켰습니다.',
  },
} as const;

const URL_IN_TEXT = /\bhttps?:\/\/\S+/gi;
const CITATION_LIKE = /\[\s*(?:(?:C|S|src_?)\s*)?\d+(?:\s*[,;]\s*(?:(?:C|S|src_?)\s*)?\d+)*\s*\]/gi;

function cleanText(input: unknown, maxChars: number): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(URL_IN_TEXT, ' ')
    .replace(CITATION_LIKE, ' ')
    .replace(/[#*`_>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    .slice(0, maxChars);
}

// "Mistral AI - Wikipedia" listed under the publisher "Wikipedia" reads "Mistral AI"; the publisher is printed next to it anyway
function titleWithoutPublisher(title: string, publisher: string): string {
  const lower = title.toLowerCase();
  const tail = publisher.toLowerCase();
  for (const separator of [' - ', ' | ', ': ']) {
    if (lower.endsWith(separator + tail)) return title.slice(0, title.length - separator.length - publisher.length).trim() || title;
  }
  return title;
}

const isoDay = (iso: string | undefined): string | undefined => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);
const utcMinute = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

interface ParagraphPlan { kind: 'FACT' | 'ANALYSIS'; text: string; claimIds: string[] }

export function composeResearchReport(input: {
  raw: unknown;
  claims: ResearchClaimRecord[];
  sources: ResearchSourceRecord[];
  conflicts: ResearchConflictRecord[];
  skipped: ResearchSkippedSource[];
  locale: 'en' | 'ko';
  query: string;
  stats: ComposeStats;
}): ComposedReport | null {
  const L = LABELS[input.locale];
  const claimsById = new Map(input.claims.map((c) => [c.claimId, c]));
  const sourcesById = new Map(input.sources.map((s) => [s.sourceId, s]));
  const globalNumbers = new Set<string>(significantNumbers(input.query));
  for (const claim of input.claims) for (const n of [...significantNumbers(claim.statement), ...significantNumbers(claim.quote)]) globalNumbers.add(n);

  const dropReasons: Partial<Record<ParagraphDropReason, number>> = {};
  let dropped = 0;
  const drop = (reason: ParagraphDropReason) => { dropped++; dropReasons[reason] = (dropReasons[reason] ?? 0) + 1; };

  const planParagraph = (value: unknown): ParagraphPlan | null => {
    if (!value || typeof value !== 'object') { drop('MALFORMED'); return null; }
    const raw = value as { text?: unknown; kind?: unknown; claimIds?: unknown };
    const text = cleanText(raw.text, 1500);
    if (text.length < 20) { drop('TOO_SHORT_OR_LONG'); return null; }
    const kind: 'FACT' | 'ANALYSIS' = raw.kind === 'ANALYSIS' ? 'ANALYSIS' : 'FACT';
    const claimIds = [...new Set((Array.isArray(raw.claimIds) ? raw.claimIds : []).filter((id): id is string => typeof id === 'string' && claimsById.has(id)))];
    if (kind === 'FACT' && claimIds.length === 0) { drop('NO_VERIFIED_CITATION'); return null; }
    const allowed = new Set<string>(significantNumbers(input.query));
    if (kind === 'FACT') for (const id of claimIds) { const c = claimsById.get(id)!; for (const n of [...significantNumbers(c.statement), ...significantNumbers(c.quote)]) allowed.add(n); }
    else for (const n of globalNumbers) allowed.add(n);
    if (significantNumbers(text).some((n) => !allowed.has(n))) { drop('UNSUPPORTED_NUMBER'); return null; }
    return { kind, text, claimIds };
  };

  const root = (input.raw && typeof input.raw === 'object' ? input.raw : {}) as { title?: unknown; summary?: unknown; sections?: unknown };
  const sections: Array<{ heading: string; paragraphs: ParagraphPlan[] }> = [];
  for (const section of (Array.isArray(root.sections) ? root.sections : []).slice(0, 8)) {
    if (!section || typeof section !== 'object') continue;
    const raw = section as { heading?: unknown; paragraphs?: unknown };
    const paragraphs = (Array.isArray(raw.paragraphs) ? raw.paragraphs : []).slice(0, 6).map(planParagraph).filter((p): p is ParagraphPlan => p !== null);
    const heading = cleanText(raw.heading, 80);
    if (paragraphs.length > 0 && heading) sections.push({ heading, paragraphs });
  }
  const keptFacts = sections.reduce((n, s) => n + s.paragraphs.filter((p) => p.kind === 'FACT').length, 0);
  if (keptFacts === 0) return null;

  const summaryPlan = typeof root.summary === 'object' && root.summary !== null ? planParagraph(root.summary) : null;
  const firstFact = sections.flatMap((s) => s.paragraphs).find((p) => p.kind === 'FACT')!;
  // a summary that does not hold up is replaced by the first supported finding rather than by anything unchecked
  const summary = summaryPlan && summaryPlan.kind === 'FACT' ? summaryPlan : firstFact;

  // citation numbers follow first use in the text
  const numberOf = new Map<string, number>();
  const cite = (paragraph: ParagraphPlan): string => {
    const ids = [...new Set(paragraph.claimIds.map((id) => claimsById.get(id)!.sourceId))].filter((sid) => sourcesById.has(sid));
    for (const sid of ids) if (!numberOf.has(sid)) numberOf.set(sid, numberOf.size + 1);
    return ids.length > 0 ? ` ${ids.map((sid) => `[${numberOf.get(sid)}]`).join('')}` : '';
  };

  const title = cleanText(root.title, 120) || (input.locale === 'ko' ? '조사 보고서' : 'Research report');
  const body: string[] = [`# ${title}`, ''];
  const summaryLine = `${summary.text}${cite(summary)}`;
  body.push(`> ${summaryLine}`, '');
  for (const section of sections) {
    body.push(`## ${section.heading}`, '');
    for (const paragraph of section.paragraphs) {
      body.push(paragraph.kind === 'ANALYSIS' ? `*${L.analysis}:* ${paragraph.text}${cite(paragraph)}` : `${paragraph.text}${cite(paragraph)}`, '');
    }
  }

  const conflicts = input.conflicts.filter((c) => c.claimIds.every((id) => claimsById.has(id)));
  if (conflicts.length > 0) {
    body.push(`## ${L.conflicts}`, '');
    for (const conflict of conflicts) {
      const sids = [...new Set(conflict.claimIds.map((id) => claimsById.get(id)!.sourceId))].filter((sid) => sourcesById.has(sid));
      for (const sid of sids) if (!numberOf.has(sid)) numberOf.set(sid, numberOf.size + 1);
      const markers = sids.map((sid) => `[${numberOf.get(sid)}]`).join('');
      body.push(`- **${cleanText(conflict.topic, 200)}**: ${cleanText(conflict.note, 500)} ${markers}`.trim());
    }
    body.push('');
  }

  const cited = [...numberOf.entries()].sort((a, b) => a[1] - b[1]).map(([sid]) => sourcesById.get(sid)!);
  body.push(`## ${L.sources}`, '');
  for (const source of cited) {
    const published = isoDay(source.publishedAt);
    const updated = isoDay(source.updatedAt);
    const dates = [published ? `${L.published} ${published}` : '', updated ? `${L.updated} ${updated}` : ''].filter(Boolean).join(', ') || L.publishedUnknown;
    const basis = source.basis === 'FULL_TEXT' ? L.fullText : L.snippet;
    const shownTitle = titleWithoutPublisher(cleanText(source.title, 200), source.publisher) || source.publisher;
    body.push(`- [${numberOf.get(source.sourceId)}] ${shownTitle} - ${source.publisher}, ${dates}. ${source.finalUrl} (${L.retrieved} ${utcMinute(source.retrievedAt)}; ${basis})`);
  }
  body.push('');

  const snippetCount = cited.filter((s) => s.basis === 'SEARCH_SNIPPET').length;
  const staleCount = cited.filter((s) => s.freshness === 'STALE' || s.freshness === 'UNDATED' || s.freshness === 'UNKNOWN' || s.freshness === 'SUSPICIOUS').length;
  const truncatedCount = cited.filter((s) => s.textTruncated).length;
  body.push(`## ${L.method}`, '');
  body.push(`- ${L.searchedWith}: ${input.stats.provider}. ${L.queries}: ${input.stats.plannedQueries.map((q) => `"${cleanText(q, 120)}"`).join(', ')}.`);
  body.push(`- ${L.counts(input.stats.candidateCount, input.stats.retrievedCount, cited.length)}`);
  body.push(`- ${L.claims(input.claims.length, input.stats.rejectedClaims)}`);
  body.push(`- ${L.analysisNote}`);
  if (snippetCount > 0) body.push(`- ${L.snippetNote(snippetCount)}`);
  if (input.skipped.length > 0) body.push(`- ${L.skippedNote(input.skipped.length)}`);
  if (staleCount > 0) body.push(`- ${L.staleNote(staleCount)}`);
  if (truncatedCount > 0) body.push(`- ${L.truncatedNote(truncatedCount)}`);
  body.push(`- ${L.robots}`);
  body.push(`- ${L.generated}: ${utcMinute(input.stats.generatedAt)}.`, '');

  return {
    title,
    summary: summary.text,
    markdown: body.join('\n'),
    citedSourceIds: cited.map((s) => s.sourceId),
    keptParagraphs: sections.reduce((n, s) => n + s.paragraphs.length, 0),
    droppedParagraphs: dropped,
    dropReasons,
    conflicts,
  };
}
