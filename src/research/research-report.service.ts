// "Research this with sources and give me a report" - the bounded workflow behind it:
//   PLAN      the model proposes up to three searches (if it cannot, the question itself is searched);
//   SEARCH    the configured search provider is asked (nothing is invented when none is configured - the run says UNAVAILABLE and nothing else happens);
//   RETRIEVE  the pages are fetched under the SSRF policy, robots.txt and rate limits (see source-fetcher.ts); a page that cannot be fetched may still be represented by the excerpt the search provider
//             returned, and is then marked as such;
//   EXTRACT   the model proposes claims with verbatim quotes; NAgex keeps only those whose quote is in the retrieved text and whose figures are in the quote (claim-verification.ts);
//   COMPOSE   the model drafts the report from the verified claims; NAgex keeps only what cites verified claims, writes the citations itself and lists exactly the sources that were retrieved (report-composer.ts);
//   PUBLISH   the report becomes a real document (downloadable as .docx) and the whole run - sources, retrieval times, hashes, claims, rejections - is stored for later inspection.
// The model never decides what counts as evidence. Every step's outcome is reported as it happened.
import crypto from 'node:crypto';
import type { AiService } from '../model-gateway/ai-service.js';
import type { DocumentExecutor } from '../creation/executors/document-executor.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import { CLAIM_LIMITS, relevantExcerpt, validateConflicts, verifyClaims } from './claim-verification.js';
import type { EvidencePack, EvidenceSource } from './evidence-pack.types.js';
import type { EvidencePackService } from './evidence-pack.service.js';
import { composeResearchReport } from './report-composer.js';
import type { ResearchRunStore } from './research-run.store.js';
import type { ResearchClaimRecord, ResearchRunRecord, ResearchSkippedSource, ResearchSourceRecord, ResearchStepRecord } from './research-run.types.js';
import { SourceFreshnessValidator } from './source-freshness.validator.js';
import type { SourceFetcher } from './source-fetcher.js';

export interface ResearchReportRequest {
  query: string;
  tenantId: string;
  ownerId: string;
  requestId: string;
  locale: 'en' | 'ko';
  maxSources?: number;
}

export interface PublicResearchSource {
  sourceId: string;
  title: string;
  publisher: string;
  url: string;
  publishedAt?: string;
  retrievedAt: string;
  basis: ResearchSourceRecord['basis'];
}

export type ResearchReportOutcome =
  | {
      status: 'SUCCESS';
      runId: string;
      documentId: string;
      artifactId?: string;
      title: string;
      summary: string;
      openTarget: string;
      downloadTarget: string;
      provenanceTarget: string;
      provider: string;
      sources: PublicResearchSource[];
      stats: { candidates: number; retrieved: number; cited: number; claimsVerified: number; claimsRejected: number; paragraphsDropped: number };
      steps: ResearchStepRecord[];
    }
  | {
      status: 'UNAVAILABLE' | 'NO_RESULTS' | 'NO_EVIDENCE' | 'FAILED';
      code: string;
      message: string;
      runId?: string;
      provider: string;
      steps: ResearchStepRecord[];
    };

export interface ResearchReportServiceDeps {
  aiService: Pick<AiService, 'researchPlanQueries' | 'researchExtractClaims' | 'researchWriteReport'>;
  evidencePackService: Pick<EvidencePackService, 'isWebSearchAvailable' | 'buildEvidencePack'>;
  fetcher: Pick<SourceFetcher, 'fetch'>;
  runStore: ResearchRunStore;
  documentExecutor: Pick<DocumentExecutor, 'createFromContent'>;
  providerName: () => string;
  auditLogger?: Pick<AuditLogger, 'logEvent'>;
  now?: () => Date;
}

const DEFAULT_MAX_SOURCES = 6;
const MAX_CANDIDATES = 10;
const FETCH_BATCH = 3;
const MODEL_EXCERPT_CHARS = 5000;
const MIN_SNIPPET_CHARS = 80;
const MIN_VERIFIED_CLAIMS = 2;
const MIN_RELEVANCE = 3;

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const normalizedUrl = (url: string): string => { try { const u = new URL(url); return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`; } catch { return url.toLowerCase(); } };

export class ResearchReportService {
  private readonly inFlight = new Map<string, Promise<ResearchReportOutcome>>();

  constructor(private readonly deps: ResearchReportServiceDeps) {}

  public isAvailable(): boolean {
    return this.deps.evidencePackService.isWebSearchAvailable();
  }

  // The same question asked twice at once (a double click, a client retry) is one run and one report.
  public run(request: ResearchReportRequest): Promise<ResearchReportOutcome> {
    const key = crypto.createHash('sha256').update(JSON.stringify([request.tenantId, request.ownerId, request.query.trim().toLowerCase(), request.locale])).digest('hex');
    const running = this.inFlight.get(key);
    if (running) return running;
    const started = this.execute(request).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, started);
    return started;
  }

  private async execute(request: ResearchReportRequest): Promise<ResearchReportOutcome> {
    const { deps } = this;
    const now = deps.now ?? (() => new Date());
    const provider = deps.providerName();
    const steps: ResearchStepRecord[] = [];
    const runId = `run_${crypto.randomBytes(12).toString('hex')}`;
    const startedAt = now().toISOString();
    const query = request.query.trim();
    const maxSources = Math.max(2, Math.min(request.maxSources ?? DEFAULT_MAX_SOURCES, 8));

    if (!deps.evidencePackService.isWebSearchAvailable()) {
      steps.push({ step: 'SEARCH', status: 'FAILED', detail: 'No web search provider is configured.' });
      return { status: 'UNAVAILABLE', code: 'SEARCH_UNAVAILABLE', message: 'Live web search is not configured, so no research was performed and no report was written.', provider, steps };
    }

    const record: ResearchRunRecord = {
      runId, tenantId: request.tenantId, ownerId: request.ownerId, query, locale: request.locale, status: 'FAILED', provider,
      plannedQueries: [], startedAt, completedAt: startedAt, sources: [], skipped: [], claims: [], rejectedClaims: 0, rejectionReasons: {}, rejectedSamples: [], conflicts: [], droppedParagraphs: 0, steps,
    };
    const finish = (status: ResearchRunRecord['status'], failure?: { code: string; message: string }): void => {
      record.status = status;
      record.completedAt = now().toISOString();
      if (failure) record.failure = failure;
      deps.runStore.save(record);
    };
    const fail = (status: 'NO_RESULTS' | 'NO_EVIDENCE' | 'FAILED', code: string, message: string): ResearchReportOutcome => {
      finish(status === 'FAILED' ? 'FAILED' : status, { code, message });
      deps.auditLogger?.logEvent({ actor: { type: 'user', id: request.ownerId }, tenant_id: request.tenantId, action: 'research.report.created', resource: { type: 'ResearchRun', id: runId }, result: 'FAILED', request_id: request.requestId, details: { code, status } });
      return { status, code, message, runId, provider, steps };
    };

    let phase: ResearchStepRecord['step'] = 'PLAN';
    try {
      // ---- PLAN
      let plannedQueries = [query];
      try {
        const planned = await deps.aiService.researchPlanQueries({ query, locale: request.locale, today: startedAt.slice(0, 10), requestId: request.requestId });
        if (planned.data.queries.length > 0) plannedQueries = planned.data.queries;
        steps.push({ step: 'PLAN', status: 'DONE', detail: `${plannedQueries.length} search(es)` });
      } catch {
        steps.push({ step: 'PLAN', status: 'SKIPPED', detail: 'The model could not plan searches; the question itself was searched.' });
      }
      record.plannedQueries = plannedQueries;

      // ---- SEARCH
      phase = 'SEARCH';
      const packs: EvidencePack[] = [];
      for (const q of plannedQueries) packs.push(await deps.evidencePackService.buildEvidencePack(q, { forceSearch: true, maxSources: maxSources, requestId: request.requestId }));
      const usable = packs.filter((p) => p.status === 'SUCCESS' && p.sources.length > 0);
      if (usable.length === 0) {
        const worst = packs.find((p) => p.status === 'AUTH_FAILED') ?? packs.find((p) => p.status === 'RATE_LIMITED') ?? packs.find((p) => p.status === 'TIMEOUT' || p.status === 'PROVIDER_ERROR' || p.status === 'INVALID_RESPONSE' || p.status === 'FAILED');
        steps.push({ step: 'SEARCH', status: 'FAILED', detail: worst ? worst.status : 'NO_RESULTS' });
        if (worst) return fail('FAILED', `SEARCH_${worst.status}`, worst.status === 'AUTH_FAILED' ? 'The search provider rejected its credentials; no research was performed.' : worst.status === 'RATE_LIMITED' ? 'The search provider is rate limiting requests; try again later.' : 'The search provider failed; no research was performed.');
        return fail('NO_RESULTS', 'SEARCH_NO_RESULTS', 'The search found no sources for this question.');
      }
      const category = usable[0].category;
      const candidates: EvidenceSource[] = [];
      const seen = new Set<string>();
      for (let rank = 0; candidates.length < MAX_CANDIDATES; rank++) {
        let progressed = false;
        for (const pack of usable) {
          const source = pack.sources[rank];
          if (!source) continue;
          progressed = true;
          const key = normalizedUrl(source.url);
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push(source);
          if (candidates.length >= MAX_CANDIDATES) break;
        }
        if (!progressed) break;
      }
      steps.push({ step: 'SEARCH', status: 'DONE', detail: `${candidates.length} candidate source(s)` });

      // ---- RETRIEVE
      phase = 'RETRIEVE';
      const retrieved: Array<ResearchSourceRecord & { text: string }> = [];
      const skipped: ResearchSkippedSource[] = [];
      for (let i = 0; i < candidates.length && retrieved.length < maxSources; i += FETCH_BATCH) {
        const batch = candidates.slice(i, i + FETCH_BATCH);
        const outcomes = await Promise.all(batch.map((candidate) => deps.fetcher.fetch(candidate.url)));
        batch.forEach((candidate, index) => {
          if (retrieved.length >= maxSources) return;
          const outcome = outcomes[index];
          const retrievedAt = now().toISOString();
          if (outcome.ok) {
            const s = outcome.source;
            const publishedAt = s.publishedAt ?? candidate.publishedAt;
            const updatedAt = s.modifiedAt ?? candidate.observedAt;
            const newest = [publishedAt, updatedAt].filter((d): d is string => !!d && Number.isFinite(Date.parse(d))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
            retrieved.push({
              sourceId: `S${retrieved.length + 1}`, title: s.title || candidate.title, publisher: candidate.sourceName || hostOf(s.finalUrl), url: candidate.url, finalUrl: s.finalUrl,
              ...(publishedAt ? { publishedAt } : {}), ...(updatedAt ? { updatedAt } : {}), retrievedAt: s.retrievedAt, basis: 'FULL_TEXT', contentHash: s.contentHash, textLength: s.text.length, textTruncated: s.textTruncated,
              httpStatus: s.httpStatus, robots: s.robots, freshness: SourceFreshnessValidator.validateFreshness(newest, s.retrievedAt, category), provider, text: s.text,
            });
            return;
          }
          const snippet = (candidate.snippet || '').replace(/\s+/g, ' ').trim();
          if (snippet.length >= MIN_SNIPPET_CHARS) {
            retrieved.push({
              sourceId: `S${retrieved.length + 1}`, title: candidate.title, publisher: candidate.sourceName || hostOf(candidate.url), url: candidate.url, finalUrl: candidate.url,
              ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}), retrievedAt: candidate.retrievedAt || retrievedAt, basis: 'SEARCH_SNIPPET',
              contentHash: crypto.createHash('sha256').update(snippet).digest('hex'), textLength: snippet.length, textTruncated: false, robots: 'NOT_APPLICABLE',
              freshness: SourceFreshnessValidator.validateFreshness(candidate.publishedAt, candidate.retrievedAt || retrievedAt, category), provider, fetchNote: `${outcome.code}: ${outcome.message}`, text: snippet,
            });
            return;
          }
          skipped.push({ url: candidate.url, title: candidate.title, reason: outcome.code, message: outcome.message });
        });
      }
      record.skipped = skipped;
      record.sources = retrieved.map(({ text: _text, ...rest }) => rest);
      steps.push({ step: 'RETRIEVE', status: retrieved.length > 0 ? 'DONE' : 'FAILED', detail: `${retrieved.length} retrieved, ${skipped.length} not usable` });
      if (retrieved.length === 0) return fail('NO_EVIDENCE', 'NO_SOURCE_RETRIEVED', 'No source could be retrieved (the sites did not permit it or the pages could not be read), so no report was written.');

      // ---- EXTRACT
      phase = 'EXTRACT';
      const extraction = await deps.aiService.researchExtractClaims({
        query, locale: request.locale,
        sources: retrieved.map((s) => ({ sourceId: s.sourceId, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, text: relevantExcerpt(s.text, query, MODEL_EXCERPT_CHARS) })),
        requestId: request.requestId,
      });
      // a statement the model itself rates as tangential to the question is not evidence for the report (relevance 1-5; a missing rating is not held against it)
      const onTopic = extraction.data.claims.filter((c) => c.relevance === undefined || c.relevance >= MIN_RELEVANCE);
      const offTopic = extraction.data.claims.length - onTopic.length;
      const verification = verifyClaims(onTopic, retrieved.map((s) => ({ sourceId: s.sourceId, text: s.text })));
      const reasons: Record<string, number> = {};
      for (const r of verification.rejected) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      if (offTopic > 0) reasons.OFF_TOPIC = offTopic;
      record.claims = verification.verified;
      record.rejectedClaims = verification.rejected.length + offTopic;
      record.rejectionReasons = reasons;
      record.rejectedSamples = verification.rejected.slice(0, 8).map((r) => ({ reason: r.reason, ...(r.sourceId ? { sourceId: r.sourceId } : {}), ...(r.statement ? { statement: r.statement } : {}) }));
      steps.push({ step: 'EXTRACT', status: verification.verified.length >= MIN_VERIFIED_CLAIMS ? 'DONE' : 'FAILED', detail: `${verification.verified.length} verified, ${verification.rejected.length + offTopic} rejected` });
      if (verification.verified.length < MIN_VERIFIED_CLAIMS) return fail('NO_EVIDENCE', 'NO_VERIFIABLE_CLAIMS', 'The retrieved sources did not contain enough statements that could be verified against their text, so no report was written.');

      // ---- COMPOSE
      phase = 'COMPOSE';
      const claimsForModel = verification.verified.slice(0, CLAIM_LIMITS.maxTotal).map((c: ResearchClaimRecord) => {
        const source = retrieved.find((s) => s.sourceId === c.sourceId)!;
        return { claimId: c.claimId, statement: c.statement, sourceTitle: source.title, publishedAt: source.publishedAt };
      });
      const drafted = await deps.aiService.researchWriteReport({ query, locale: request.locale, today: startedAt.slice(0, 10), claims: claimsForModel, requestId: request.requestId });
      const conflicts = validateConflicts(drafted.data.report.conflicts, verification.verified);
      const composed = composeResearchReport({
        raw: drafted.data.report, claims: verification.verified, sources: record.sources, conflicts, skipped, locale: request.locale, query,
        stats: { provider, plannedQueries, candidateCount: candidates.length, retrievedCount: retrieved.length, rejectedClaims: verification.rejected.length + offTopic, generatedAt: now().toISOString() },
      });
      if (!composed) {
        steps.push({ step: 'COMPOSE', status: 'FAILED', detail: 'No paragraph survived verification.' });
        return fail('NO_EVIDENCE', 'NO_SUPPORTED_REPORT', 'The draft contained nothing that the verified sources support, so no report was written.');
      }
      record.conflicts = composed.conflicts;
      record.droppedParagraphs = composed.droppedParagraphs;
      record.citedSourceIds = composed.citedSourceIds;
      steps.push({ step: 'COMPOSE', status: 'DONE', detail: `${composed.keptParagraphs} paragraph(s) kept, ${composed.droppedParagraphs} dropped` });

      // ---- PUBLISH
      phase = 'PUBLISH';
      const created = deps.documentExecutor.createFromContent({
        tenantId: request.tenantId, ownerId: request.ownerId, requestId: request.requestId, idSeed: runId, title: composed.title, summary: composed.summary, content: composed.markdown,
        locale: request.locale, documentKind: 'REPORT', researchRunId: runId,
      });
      record.documentId = created.creationId;
      record.artifactId = created.artifactId;
      steps.push({ step: 'PUBLISH', status: 'DONE', detail: created.creationId });
      finish('COMPLETED');
      deps.auditLogger?.logEvent({
        actor: { type: 'user', id: request.ownerId }, tenant_id: request.tenantId, action: 'research.report.created', resource: { type: 'ResearchRun', id: runId }, result: 'SUCCESS', request_id: request.requestId,
        details: { documentId: created.creationId, provider, sources: composed.citedSourceIds.length, claims: verification.verified.length, rejectedClaims: verification.rejected.length + offTopic },
      });

      const cited = new Set(composed.citedSourceIds);
      return {
        status: 'SUCCESS',
        runId,
        documentId: created.creationId,
        artifactId: created.artifactId,
        title: composed.title,
        summary: composed.summary,
        openTarget: created.openTarget,
        downloadTarget: `${created.openTarget}/download`,
        provenanceTarget: `/api/v1/research/runs/${runId}`,
        provider,
        sources: record.sources.filter((s) => cited.has(s.sourceId)).map((s) => ({ sourceId: s.sourceId, title: s.title, publisher: s.publisher, url: s.finalUrl, publishedAt: s.publishedAt, retrievedAt: s.retrievedAt, basis: s.basis })),
        stats: { candidates: candidates.length, retrieved: retrieved.length, cited: composed.citedSourceIds.length, claimsVerified: verification.verified.length, claimsRejected: verification.rejected.length + offTopic, paragraphsDropped: composed.droppedParagraphs },
        steps,
      };
    } catch (error) {
      const code = (error as { code?: string })?.code || 'RESEARCH_FAILED';
      steps.push({ step: phase, status: 'FAILED', detail: 'The step failed.' });
      return fail('FAILED', typeof code === 'string' ? code : 'RESEARCH_FAILED', 'A step of the research failed before a verified report could be written; nothing was saved as a report.');
    }
  }
}
