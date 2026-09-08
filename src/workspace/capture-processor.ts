import crypto from 'node:crypto';
import { generateResourceId } from '../common/utils.js';
import type { CaptureStore } from './capture.store.js';
import type {
  CalendarCandidate,
  CaptureItem,
  CaptureStatus,
  CandidateSourceRef,
  KnowledgeCandidate,
  MemoryCandidate,
  ProcessingChunk,
  TaskCandidate,
  WorkspaceCandidate,
} from './workspace.types.js';
import type { AiService, TextUnderstandingResult } from '../model-gateway/ai-service.js';
import type { BrowserToolService } from '../tools/browser.service.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import { isUrlSafe } from '../browser/browser-url-validator.js';
import { extractPdfText, chunkText } from './pdf-extractor.js';
import { CandidateStore, type UpsertCandidateInput } from './candidate.store.js';
import type { ActivityStore } from '../governance/activity.store.js';
import { classifyFailure } from '../common/failure-taxonomy.js';

// The internal analysis shape used throughout this file is exactly
// AiService's real understanding output — see ai-service.ts. Kept as a local
// alias so the deterministic offline fallback (no aiService configured) can
// produce the identical shape without importing AiService's implementation.
export type StructuredAnalysisResult = TextUnderstandingResult;

export interface ModelProvenance {
  provider: string;
  model: string;
  requestId: string;
  latencyMs: number;
}

export class CaptureProcessor {
  constructor(
    private readonly store: CaptureStore,
    private readonly aiService?: AiService,
    private readonly browserService?: BrowserToolService,
    private readonly auditLogger?: AuditLogger,
    private readonly storageProvider?: StorageProvider,
    private readonly knowledgeEngine?: KnowledgeEngine,
    // Phase 1 STEP 5 — Canonical Candidate Model. Optional so existing
    // callers/tests that construct CaptureProcessor without it keep working
    // unchanged (MASTER.md: never abruptly break processing code); when
    // wired, Understanding output is additionally upserted into the durable
    // CandidateStore alongside the existing embedded metadata.candidates
    // array (item O — the embedded array is a temporary compatibility echo,
    // not the source of truth going forward).
    private readonly candidateStore?: CandidateStore,
    // Phase 1 STEP 8 — durable, tenant-isolated consumer Activity
    // projection (item G): "Summarized X" / "Could not analyze X" / "X
    // needs your attention", never raw AuditLogger events.
    private readonly activityStore?: ActivityStore,
  ) {}

  // Phase 1 STEP 8, item G/R/S — a single place both the success and
  // failure paths of process() report through, so every capture type
  // (TEXT/LINK/FILE) gets the same truthful Activity projection without
  // duplicating this per process*() method. EMPTY_PAGE/OCR_REQUIRED are
  // genuinely inconclusive outcomes, not a clean "understood" success — no
  // Activity entry is written for those (the Inbox card already shows the
  // truthful sub-status), avoiding a misleading "Summarized" claim.
  private recordCaptureActivity(item: CaptureItem): void {
    if (!this.activityStore) return;
    const title = item.metadata.extractedTitle || item.metadata.originalName || item.content.slice(0, 60) || 'Untitled capture';
    if (item.status === 'READY' || (item.status === 'NEEDS_REVIEW' && item.metadata.errorCode !== 'BLOCKED_NEEDS_HUMAN' && item.metadata.errorCode !== 'EMPTY_PAGE' && item.metadata.errorCode !== 'OCR_REQUIRED')) {
      this.activityStore.record({
        tenantId: item.tenantId, principalId: item.ownerId, type: 'capture.understood',
        title: `Summarized "${title}"`, status: 'COMPLETED',
        source: { captureId: item.captureId }, dedupeKey: `${item.captureId}:understood`,
      });
    } else if (item.status === 'NEEDS_REVIEW' && item.metadata.errorCode === 'BLOCKED_NEEDS_HUMAN') {
      this.activityStore.record({
        tenantId: item.tenantId, principalId: item.ownerId, type: 'capture.needs_human',
        title: `"${title}" needs your attention`, status: 'NEEDS_ATTENTION',
        source: { captureId: item.captureId }, dedupeKey: `${item.captureId}:needs_human`,
      });
    }
  }

  private recordCaptureFailureActivity(item: CaptureItem): void {
    if (!this.activityStore) return;
    const title = item.metadata.extractedTitle || item.metadata.originalName || item.content.slice(0, 60) || 'Untitled capture';
    this.activityStore.record({
      tenantId: item.tenantId, principalId: item.ownerId, type: 'capture.failed',
      title: `Could not analyze "${title}"`, status: 'FAILED',
      source: { captureId: item.captureId }, dedupeKey: `${item.captureId}:failed`,
    });
  }

  // Phase 1 STEP 9, item E/R — every capture status update that carries an
  // errorCode goes through here so the failure taxonomy (RETRYABLE/
  // TERMINAL/AMBIGUOUS/NEEDS_HUMAN) and durable retry bookkeeping are
  // applied consistently, regardless of which of the several failure/
  // needs-review exit points in processUrl/processPdf/process() produced
  // it — never classified ad hoc at each call site.
  private updateStatusWithFailure(item: CaptureItem, status: CaptureStatus, metadata: Partial<CaptureItem['metadata']>): CaptureItem | null {
    if (metadata.errorCode) {
      const classification = classifyFailure(metadata.errorCode);
      metadata = {
        ...metadata,
        failureCategory: classification.category,
        retryable: classification.retryable,
        retryAttemptCount: (item.metadata.retryAttemptCount ?? 0) + 1,
        lastRetryAt: new Date().toISOString(),
      };
    }
    return this.store.updateStatus(item.captureId, status, metadata);
  }

  public async process(item: CaptureItem, rawBuffer?: Buffer): Promise<CaptureItem> {
    const startedAt = new Date().toISOString();
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingStage: 'PROCESSING',
      processingSubStage: 'Reading content...',
      processingStartedAt: startedAt,
      processorVersion: '1.0.0',
      errorCode: undefined,
      errorMessage: undefined,
    });

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.processing_started',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_proc_${Date.now()}`,
        details: { type: item.type, ownerId: item.ownerId },
      });
    }

    try {
      let result: CaptureItem;
      if (item.type === 'LINK') {
        result = await this.processUrl(item);
      } else if (item.type === 'FILE') {
        result = await this.processPdf(item, rawBuffer);
      } else if (item.type === 'TEXT') {
        result = await this.processText(item);
      } else {
        // AUDIO or fallback
        result = await this.processAudioFallback(item, rawBuffer);
      }
      this.recordCaptureActivity(result);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code || 'PROCESSING_ERROR';
      const failedAt = new Date().toISOString();

      const failed = this.updateStatusWithFailure(item, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: code,
        errorMessage: errMsg,
        extractedSummary: `Processing failed: ${errMsg}`,
      });
      this.recordCaptureFailureActivity(failed ?? item);

      if (this.auditLogger) {
        this.auditLogger.logEvent({
          actor: { type: 'system', id: 'capture-processor' },
          tenant_id: item.tenantId,
          action: 'capture.processing_failed',
          resource: { type: 'CaptureItem', id: item.captureId },
          result: 'DENIED',
          request_id: `req_proc_fail_${Date.now()}`,
          details: { errorCode: code, errorMessage: errMsg },
        });
      }

      return failed ?? item;
    }
  }

  /**
   * Process TEXT captures using Model Router
   */
  private async processText(item: CaptureItem): Promise<CaptureItem> {
    const rawText = item.content;
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Analyzing content...',
    });

    const { analysis, provenance } = await this.analyzeContentWithModel(rawText, 'TEXT');
    const freshCandidates = this.buildCandidatesFromAnalysis(item.captureId, analysis);
    const candidates = this.mergeCandidates(item.metadata.candidates, freshCandidates);
    // Phase 1 STEP 5 — even TEXT captures need a real contentHash so the
    // canonical CandidateStore can tell "same content, retried" apart from
    // "content genuinely changed" (item G).
    const contentHash = crypto.createHash('sha256').update(rawText).digest('hex');
    const candidateIds = this.upsertCanonicalCandidates(item, freshCandidates, contentHash);

    const completedAt = new Date().toISOString();
    const nextStatus: CaptureStatus = candidates.some((c) => c.status === 'PROPOSED') ? 'NEEDS_REVIEW' : 'READY';

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.extracted',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_text_ext_${Date.now()}`,
        details: { characterCount: rawText.length },
      });
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.analyzed',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_text_anz_${Date.now()}`,
        details: { candidateCount: freshCandidates.length, topics: analysis.topics, modelProvider: provenance?.provider, modelName: provenance?.model },
      });

      for (const cand of freshCandidates) {
        this.auditLogger.logEvent({
          actor: { type: 'system', id: 'capture-processor' },
          tenant_id: item.tenantId,
          action: 'candidate.proposed',
          resource: { type: 'Candidate', id: cand.candidateId },
          result: 'SUCCESS',
          request_id: `req_cand_prop_${Date.now()}`,
          details: { captureId: item.captureId, candidateType: cand.type, title: cand.title },
        });
      }
    }

    const updated = this.store.updateStatus(item.captureId, nextStatus, {
      processingStage: 'UNDERSTOOD',
      processingCompletedAt: completedAt,
      extractedTitle: analysis.title || item.metadata.originalName || 'Quick Note',
      extractedSummary: analysis.summary,
      extractedContent: rawText,
      contentHash,
      topics: analysis.topics,
      entities: analysis.entities,
      dates: analysis.dates,
      actionItems: analysis.actionItems,
      candidates,
      candidateIds,
      modelProvider: provenance?.provider,
      modelName: provenance?.model,
      modelRequestId: provenance?.requestId,
      modelLatencyMs: provenance?.latencyMs,
      suggestedAction: freshCandidates.length > 0 ? {
        type: freshCandidates[0].type,
        title: freshCandidates[0].title,
        detail: analysis.summary,
      } : undefined,
    });

    return updated ?? item;
  }

  // Best-effort session teardown (Phase 1 STEP 3, item C: "session lifecycle
  // cleanup"). Never throws — a failure to close must never mask the real
  // retrieval/understanding outcome the caller already computed.
  private async closeBrowserSession(item: CaptureItem, browserSessionId: string | null, requestId: string): Promise<void> {
    if (!browserSessionId || !this.browserService) return;
    try {
      await this.browserService.close({ tenantId: item.tenantId, ownerId: item.ownerId, requestId, browserSessionId });
    } catch {
      /* best-effort cleanup only */
    }
  }

  /**
   * Process URL / LINK captures using Browser Agent & Model Router (Phase 1
   * STEP 3). Retrieval is EXCLUSIVELY via the real Browser Agent — there is
   * no direct fetch() fallback, so every capture inherits its SSRF/private-
   * network/CAPTCHA/redirect protections. When the Browser Agent is not
   * available, this fails closed (BROWSER_UNAVAILABLE) rather than
   * fabricating page content.
   */
  private async processUrl(item: CaptureItem): Promise<CaptureItem> {
    const urlStr = item.content.trim();
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Reading page...',
    });

    // 1. URL Safety Validation
    const allowLocal = process.env.NAGEX_ALLOW_LOCAL_TEST_URLS === '1';
    const safety = isUrlSafe(urlStr, { allowLocalhostInTests: allowLocal });
    if (!safety.safe) {
      const failedAt = new Date().toISOString();
      const failed = this.updateStatusWithFailure(item, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: 'BROWSER_UNSAFE_URL',
        errorMessage: safety.reason || 'URL is blocked by security policy',
        extractedSummary: `URL safety check failed: ${safety.reason}`,
        sourceUrl: urlStr,
      });

      if (this.auditLogger) {
        this.auditLogger.logEvent({
          actor: { type: 'system', id: 'capture-processor' },
          tenant_id: item.tenantId,
          action: 'capture.processing_failed',
          resource: { type: 'CaptureItem', id: item.captureId },
          result: 'DENIED',
          request_id: `req_url_unsafe_${Date.now()}`,
          details: { url: urlStr, reason: safety.reason },
        });
      }

      return failed ?? item;
    }

    // 2. The Browser Agent is the only retrieval path (item C) — no direct
    // fetch()/scraper bypass that would skip its protections or, worse,
    // fabricate content when unavailable.
    if (!this.browserService) {
      const failedAt = new Date().toISOString();
      const failed = this.updateStatusWithFailure(item, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: 'BROWSER_UNAVAILABLE',
        errorMessage: 'The browser runtime is not available on this server.',
        extractedSummary: 'Processing failed: browser runtime unavailable.',
        sourceUrl: urlStr,
      });
      return failed ?? item;
    }

    // 3. Real retrieval via Browser Agent open -> navigate -> snapshot.
    let browserSessionId: string | null = null;
    let pageTitle: string | null = null;
    let finalUrl = urlStr;
    let contentText = '';
    let retrievedAt = new Date().toISOString();
    // The REAL pre-truncation page length and whether the Browser Agent's
    // own snapshot bound cut it (Phase 1 STEP 3 truthfulness fix) — ground
    // truth from BrowserRuntime, not re-derived from contentText.length
    // (which can never distinguish "short page" from "long page, capped").
    let browserPageTotalCharacters = 0;
    let browserTruncated = false;
    const reqId = `req_proc_url_${Date.now()}`;

    try {
      const session = await this.browserService.open({ tenantId: item.tenantId, ownerId: item.ownerId, requestId: reqId });
      browserSessionId = session.browserSessionId;

      const navRes = await this.browserService.navigate({
        tenantId: item.tenantId,
        ownerId: item.ownerId,
        requestId: reqId,
        browserSessionId,
        url: urlStr,
      });
      // Never a fabricated placeholder — a page with no real title stays
      // null (item D).
      pageTitle = navRes.title && navRes.title.trim() ? navRes.title.trim() : null;

      const snap = await this.browserService.snapshot({
        tenantId: item.tenantId,
        ownerId: item.ownerId,
        requestId: reqId,
        browserSessionId,
      });

      contentText = snap.text;
      browserPageTotalCharacters = snap.totalCharacters;
      browserTruncated = snap.truncated;
      // The real, possibly-redirected URL the browser ended up on (item D /
      // test 2) — never the originally-requested URL if they differ.
      finalUrl = snap.url || urlStr;
      retrievedAt = new Date().toISOString();
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string };
      const code = errObj.code || 'BROWSER_NAVIGATION_FAILED';

      if (code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED') {
        const blockedAt = new Date().toISOString();
        const blocked = this.updateStatusWithFailure(item, 'NEEDS_REVIEW', {
          processingStage: 'NEEDS_REVIEW',
          processingCompletedAt: blockedAt,
          errorCode: 'BLOCKED_NEEDS_HUMAN',
          errorMessage: 'CAPTCHA or authentication required to view page',
          extractedTitle: `Verification Required: ${urlStr}`,
          extractedSummary: 'Page requires CAPTCHA or human authentication.',
          sourceUrl: urlStr,
          finalUrl: urlStr,
          retrievedAt: blockedAt,
          browserSessionId,
        });
        await this.closeBrowserSession(item, browserSessionId, reqId);
        return blocked ?? item;
      }

      const failedAt = new Date().toISOString();
      const failed = this.updateStatusWithFailure(item, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: code,
        errorMessage: errObj.message || 'Failed to retrieve URL via Browser Agent',
        extractedSummary: `Browser Agent retrieval failed: ${errObj.message || code}`,
        sourceUrl: urlStr,
        browserSessionId,
      });
      await this.closeBrowserSession(item, browserSessionId, reqId);
      return failed ?? item;
    }

    // Retrieval succeeded — release the real browser resource before the
    // (potentially slow) model call rather than holding it open.
    await this.closeBrowserSession(item, browserSessionId, reqId);

    if (!contentText || !contentText.trim()) {
      const emptyAt = new Date().toISOString();
      const emptyItem = this.updateStatusWithFailure(item, 'NEEDS_REVIEW', {
        processingStage: 'NEEDS_REVIEW',
        processingCompletedAt: emptyAt,
        errorCode: 'EMPTY_PAGE',
        errorMessage: 'Retrieved page content is empty',
        extractedTitle: pageTitle || urlStr,
        extractedSummary: `Retrieved page (${urlStr}) contained no readable text.`,
        sourceUrl: urlStr,
        finalUrl,
        pageTitle,
        retrievedAt,
        contentText: '',
        browserSessionId,
      });
      return emptyItem ?? item;
    }

    // totalCharacters is the REAL pre-truncation page length from the
    // Browser Agent (browserPageTotalCharacters) — never re-derived from
    // contentText.length, which can never tell a genuinely short page apart
    // from a long one BrowserRuntime.snapshot() already capped (Phase 1
    // STEP 3 truthfulness fix). contentText itself may already be shorter
    // than totalCharacters when browserTruncated is true.
    const totalCharacters = browserPageTotalCharacters;
    const contentHash = crypto.createHash('sha256').update(contentText).digest('hex');

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.extracted',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_url_ext_${Date.now()}`,
        details: { url: urlStr, pageTitle, characterCount: totalCharacters, browserTruncated },
      });
    }

    // 4. Model Router Analysis (item H — the exact same AiService.understand()
    // as STEP 2). Large pages are never silently truncated (item J): above
    // the safe single-call input size, this reuses the same generic
    // chunk -> partial summaries -> synthesis machinery already built for
    // PDFs, covering the entirety of whatever the Browser Agent returned —
    // never pretending a chunk pass covered more of the real page than the
    // Browser Agent actually supplied (STEP 3 final fix, item C).
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Analyzing content...',
    });

    const SAFE_SINGLE_CALL_CHARS = 8000;
    let analysis: StructuredAnalysisResult;
    let provenance: ModelProvenance | undefined;
    let freshCandidates: WorkspaceCandidate[];
    // Starts from the Browser Agent's own truthful truncation flag — the
    // page may already have been longer than what we ever received.
    let modelInputTruncated = false;
    // Defaults to "we processed everything we received"; only lowered below
    // if this method's own chunk-decision logic has to cut further (the
    // rare chunkText()-produces-<=2-chunks fallback).
    let processedCharacters = contentText.length;
    if (contentText.length > SAFE_SINGLE_CALL_CHARS) {
      const chunks = chunkText(contentText, `${item.captureId}_${contentHash.slice(0, 12)}`, undefined);
      if (chunks.length > 2) {
        const large = await this.analyzeLargeDocument(item.captureId, chunks, pageTitle || urlStr);
        analysis = large.analysis;
        provenance = large.provenance;
        freshCandidates = large.candidates;
      } else {
        ({ analysis, provenance } = await this.analyzeContentWithModel(contentText, 'LINK', pageTitle || urlStr));
        modelInputTruncated = true; // analyzeContentWithModel's own safe-length slice applies
        processedCharacters = Math.min(contentText.length, SAFE_SINGLE_CALL_CHARS);
        freshCandidates = this.buildCandidatesFromAnalysis(item.captureId, analysis, [{ snippet: contentText.slice(0, 150) }]);
      }
    } else {
      ({ analysis, provenance } = await this.analyzeContentWithModel(contentText, 'LINK', pageTitle || urlStr));
      freshCandidates = this.buildCandidatesFromAnalysis(item.captureId, analysis, [{ snippet: contentText.slice(0, 150) }]);
    }
    // Truthful end-to-end: truncated if the Browser Agent capped the real
    // page before we ever saw it, OR our own model-input step cut further —
    // never claim full-page understanding when either happened.
    const truncated = browserTruncated || modelInputTruncated;

    const candidates = this.mergeCandidates(item.metadata.candidates, freshCandidates);
    const candidateIds = this.upsertCanonicalCandidates(item, freshCandidates, contentHash);

    const completedAt = new Date().toISOString();
    const nextStatus: CaptureStatus = candidates.some((c) => c.status === 'PROPOSED') ? 'NEEDS_REVIEW' : 'READY';

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.analyzed',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_url_anz_${Date.now()}`,
        details: { candidateCount: freshCandidates.length, topics: analysis.topics, modelProvider: provenance?.provider, modelName: provenance?.model },
      });

      for (const cand of freshCandidates) {
        this.auditLogger.logEvent({
          actor: { type: 'system', id: 'capture-processor' },
          tenant_id: item.tenantId,
          action: 'candidate.proposed',
          resource: { type: 'Candidate', id: cand.candidateId },
          result: 'SUCCESS',
          request_id: `req_cand_prop_${Date.now()}`,
          details: { captureId: item.captureId, candidateType: cand.type, title: cand.title },
        });
      }
    }

    const updated = this.store.updateStatus(item.captureId, nextStatus, {
      processingStage: 'UNDERSTOOD',
      processingCompletedAt: completedAt,
      extractedTitle: pageTitle || analysis.title,
      extractedSummary: analysis.summary,
      extractedContent: contentText,
      sourceUrl: urlStr,
      finalUrl,
      pageTitle,
      retrievedAt,
      contentText,
      contentHash,
      characterCount: totalCharacters,
      browserSessionId,
      truncated,
      processedCharacters,
      totalCharacters,
      topics: analysis.topics,
      entities: analysis.entities,
      dates: analysis.dates,
      actionItems: analysis.actionItems,
      candidates,
      candidateIds,
      modelProvider: provenance?.provider,
      modelName: provenance?.model,
      modelRequestId: provenance?.requestId,
      modelLatencyMs: provenance?.latencyMs,
      suggestedAction: freshCandidates.length > 0 ? {
        type: freshCandidates[0].type,
        title: freshCandidates[0].title,
        detail: analysis.summary,
      } : undefined,
    });

    return updated ?? item;
  }

  /**
   * Process PDF captures using pdf-extractor (real pdfjs-dist parsing) &
   * Model Router (Phase 1 STEP 4).
   */
  private async processPdf(item: CaptureItem, rawBuffer?: Buffer): Promise<CaptureItem> {
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Extracting PDF...',
    });

    let buf: Buffer | null = rawBuffer || null;
    if (!buf && item.metadata.objectKey && this.storageProvider) {
      const obj = await this.storageProvider.getObject(item.metadata.objectKey);
      if (obj) buf = obj.data;
    }

    if (!buf) {
      const failedAt = new Date().toISOString();
      const failed = this.updateStatusWithFailure(item, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: 'PDF_STORAGE_MISSING',
        errorMessage: 'PDF binary content could not be retrieved from storage',
        extractedSummary: 'Processing failed: PDF binary object missing.',
      });
      return failed ?? item;
    }

    // 1. Extract PDF Text & validate (real pdfjs-dist parsing — throws
    // PDF_EMPTY / INVALID_PDF / PDF_EXTRACTION_FAILED on a genuinely bad
    // file, which the outer process() catch turns into a truthful FAILED
    // status; never treated as READY, per item P).
    const docTitle = item.metadata.originalName || 'Document.pdf';
    const pdfResult = await extractPdfText(buf);
    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.extracted',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_pdf_ext_${Date.now()}`,
        details: {
          pageCount: pdfResult.pageCount,
          extractedCharacters: pdfResult.extractedCharacters,
          hasText: pdfResult.hasText,
          extractionMethod: pdfResult.extractionMethod,
        },
      });
    }

    // 2. Zero-text (e.g. scanned image) PDF — item E: never claim
    // understanding success, and never call the model on fabricated/empty
    // input. OCR is explicitly out of scope for STEP 4.
    if (!pdfResult.hasText) {
      const reviewedAt = new Date().toISOString();
      const needsReview = this.updateStatusWithFailure(item, 'NEEDS_REVIEW', {
        processingStage: 'NEEDS_REVIEW',
        processingCompletedAt: reviewedAt,
        errorCode: 'OCR_REQUIRED',
        errorMessage: 'PDF has no extractable text layer (likely a scanned image); OCR is not performed.',
        extractedTitle: docTitle,
        extractedSummary: 'This PDF appears to be a scanned image with no extractable text. OCR has not been performed.',
        pageCount: pdfResult.pageCount ?? undefined,
        characterCount: 0,
        extractedCharacters: 0,
        hasText: false,
        extractionMethod: pdfResult.extractionMethod,
        extractionWarnings: pdfResult.extractionWarnings,
        contentHash,
      });
      return needsReview ?? item;
    }

    // 3. Chunking strategy (~1000 tokens / 4000 chars per chunk with 300
    // char overlap), with stable chunk identity derived from captureId +
    // contentHash (item G/O) and a bounded maximum so a very large PDF is
    // never silently truncated without disclosure (item I).
    const identitySeed = `${item.captureId}_${contentHash.slice(0, 12)}`;
    const allChunks: ProcessingChunk[] = chunkText(pdfResult.text, identitySeed, pdfResult.pages);
    const MAX_PDF_CHUNKS = 40;
    const pdfTruncated = allChunks.length > MAX_PDF_CHUNKS;
    const chunks = pdfTruncated ? allChunks.slice(0, MAX_PDF_CHUNKS) : allChunks;
    const processedCharacters = chunks.length > 0 ? chunks[chunks.length - 1].characterEnd - chunks[0].characterStart : pdfResult.extractedCharacters;

    // 4. Model Analysis
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Analyzing content...',
    });

    let analysis: StructuredAnalysisResult;
    let provenance: ModelProvenance | undefined;
    let freshCandidates: WorkspaceCandidate[];
    if (chunks.length > 2) {
      const large = await this.analyzeLargeDocument(item.captureId, chunks, docTitle);
      analysis = large.analysis;
      provenance = large.provenance;
      freshCandidates = large.candidates;
    } else {
      ({ analysis, provenance } = await this.analyzeContentWithModel(pdfResult.text, 'FILE', docTitle));
      const sourceRefs: CandidateSourceRef[] = chunks.length > 0
        ? chunks.map((c) => ({ chunkId: c.chunkId, pageNumber: c.pageStart ?? undefined, snippet: c.text.slice(0, 150) }))
        : [{ snippet: pdfResult.text.slice(0, 150) }];
      freshCandidates = this.buildCandidatesFromAnalysis(item.captureId, analysis, sourceRefs);
    }

    const candidates = this.mergeCandidates(item.metadata.candidates, freshCandidates);
    const candidateIds = this.upsertCanonicalCandidates(item, freshCandidates, contentHash);

    const completedAt = new Date().toISOString();
    const nextStatus: CaptureStatus = candidates.some((c) => c.status === 'PROPOSED') ? 'NEEDS_REVIEW' : 'READY';

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.analyzed',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_pdf_anz_${Date.now()}`,
        details: {
          candidateCount: freshCandidates.length,
          totalChunks: allChunks.length,
          processedChunks: chunks.length,
          truncated: pdfTruncated,
          modelProvider: provenance?.provider,
          modelName: provenance?.model,
        },
      });

      for (const cand of freshCandidates) {
        this.auditLogger.logEvent({
          actor: { type: 'system', id: 'capture-processor' },
          tenant_id: item.tenantId,
          action: 'candidate.proposed',
          resource: { type: 'Candidate', id: cand.candidateId },
          result: 'SUCCESS',
          request_id: `req_cand_prop_${Date.now()}`,
          details: { captureId: item.captureId, candidateType: cand.type, title: cand.title },
        });
      }
    }

    const updated = this.store.updateStatus(item.captureId, nextStatus, {
      processingStage: 'UNDERSTOOD',
      processingCompletedAt: completedAt,
      pageCount: pdfResult.pageCount ?? undefined,
      characterCount: pdfResult.extractedCharacters,
      extractedCharacters: pdfResult.extractedCharacters,
      hasText: pdfResult.hasText,
      extractionMethod: pdfResult.extractionMethod,
      extractionWarnings: pdfResult.extractionWarnings,
      extractedTitle: docTitle,
      extractedSummary: analysis.summary,
      extractedContent: pdfResult.text,
      contentHash,
      chunks,
      totalChunks: allChunks.length,
      processedChunks: chunks.length,
      truncated: pdfTruncated,
      processedCharacters,
      totalCharacters: pdfResult.extractedCharacters,
      topics: analysis.topics,
      entities: analysis.entities,
      dates: analysis.dates,
      actionItems: analysis.actionItems,
      candidates,
      candidateIds,
      modelProvider: provenance?.provider,
      modelName: provenance?.model,
      modelRequestId: provenance?.requestId,
      modelLatencyMs: provenance?.latencyMs,
      suggestedAction: freshCandidates.length > 0 ? {
        type: freshCandidates[0].type,
        title: freshCandidates[0].title,
        detail: analysis.summary,
      } : undefined,
    });

    return updated ?? item;
  }

  /**
   * Process Audio (simulated fallback unless real STT configured)
   */
  private async processAudioFallback(item: CaptureItem, rawBuffer?: Buffer): Promise<CaptureItem> {
    const sizeKb = ((item.metadata.sizeBytes || rawBuffer?.length || 0) / 1024).toFixed(1);
    const title = item.metadata.originalName || `Voice Memo (${new Date(item.createdAt).toLocaleTimeString()})`;
    const transcriptText = `Audio recording transcript (${sizeKb} KB processed).`;

    // No real speech-to-text provider is wired yet (MASTER.md Section 8: a
    // mock must never be represented as live) — the transcript honestly
    // records only what is verifiable (size, filename), never fabricated
    // spoken content. Since the recording's actual content is unknown until
    // it is played back, a review task is proposed rather than silently
    // discarding it.
    const candidates: WorkspaceCandidate[] = [
      {
        candidateId: generateResourceId('cand'),
        captureId: item.captureId,
        type: 'TASK',
        title: `Review voice memo: ${title}`,
        description: `Listen to and review this ${sizeKb} KB audio recording — automatic transcription is not yet configured.`,
        priorityCandidate: 'MEDIUM',
        reason: 'Audio captures need manual review until a real speech-to-text provider is connected',
        confidence: 0.6,
        sourceRefs: [],
        status: 'PROPOSED',
      } as TaskCandidate,
    ];
    const completedAt = new Date().toISOString();

    const updated = this.store.updateStatus(item.captureId, 'READY', {
      processingStage: 'UNDERSTOOD',
      processingCompletedAt: completedAt,
      extractedTitle: title,
      extractedSummary: `Voice transcript (${sizeKb} KB): ${transcriptText}`,
      extractedContent: transcriptText,
      transcript: { text: transcriptText },
      candidates,
      suggestedAction: {
        type: 'TASK',
        title: candidates[0].title,
        detail: (candidates[0] as TaskCandidate).description,
      },
    });

    return updated ?? item;
  }

  /**
   * Document AI Analysis for large documents (chunks -> intermediate
   * summaries -> final synthesis). Phase 1 STEP 4, item H (critical):
   * candidates and grounded facts (entities/dates/actionItems) are built
   * from EACH chunk's own model call — never from the top-level synthesis,
   * which only ever sees already-summarized text and cannot be honestly
   * cited back to one source chunk. This makes every candidate's sourceRefs
   * point at a real chunk that was actually shown to the model, rather than
   * a guessed "first few chunks" reference.
   */
  private async analyzeLargeDocument(
    captureId: string,
    chunks: ProcessingChunk[],
    docTitle: string,
  ): Promise<{ analysis: StructuredAnalysisResult; provenance?: ModelProvenance; candidates: WorkspaceCandidate[] }> {
    const intermediateSummaries: string[] = [];
    const candidates: WorkspaceCandidate[] = [];
    const entities: StructuredAnalysisResult['entities'] = [];
    const dates: StructuredAnalysisResult['dates'] = [];
    const actionItems: StructuredAnalysisResult['actionItems'] = [];
    const topics = new Set<string>();

    for (const chunk of chunks) {
      const { analysis: partial } = await this.analyzeContentWithModel(chunk.text, 'FILE', `${docTitle} (${chunk.chunkId})`);

      if (partial.summary) {
        const pageLabel = chunk.pageStart != null
          ? `Page ${chunk.pageStart}${chunk.pageEnd && chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ''}`
          : chunk.chunkId;
        intermediateSummaries.push(`[${chunk.chunkId} ${pageLabel}]: ${partial.summary}`);
      }

      for (const e of partial.entities) if (!entities.some((x) => x.name === e.name && x.type === e.type)) entities.push(e);
      for (const d of partial.dates) if (!dates.some((x) => x.text === d.text)) dates.push(d);
      for (const a of partial.actionItems) if (!actionItems.some((x) => x.text === a.text)) actionItems.push(a);
      for (const t of partial.topics) topics.add(t);

      const chunkRefs: CandidateSourceRef[] = [{
        chunkId: chunk.chunkId,
        pageNumber: chunk.pageStart ?? undefined,
        snippet: chunk.text.slice(0, 150),
      }];
      candidates.push(...this.buildCandidatesFromAnalysis(captureId, partial, chunkRefs));
    }

    const synthesizedText = intermediateSummaries.join('\n');
    // The synthesis call's provenance is representative of this document's
    // final understanding result (per-chunk provenance is not tracked
    // separately — see MASTER.md truthfulness: it is real, just not
    // per-chunk-attributed).
    const { analysis: topLevel, provenance } = await this.analyzeContentWithModel(synthesizedText, 'FILE', docTitle);

    const analysis: StructuredAnalysisResult = {
      ...topLevel,
      entities,
      dates,
      actionItems,
      topics: topics.size > 0 ? Array.from(topics) : topLevel.topics,
      // Candidates already come from per-chunk analysis above, grounded to a
      // real chunk — the synthesis call's own candidate arrays (generated
      // from summaries-of-summaries, un-attributable to one chunk) are
      // discarded rather than trusted.
      taskCandidates: [],
      calendarCandidates: [],
      memoryCandidates: [],
      knowledgeCandidates: [],
    };

    return { analysis, provenance, candidates };
  }

  /**
   * Real, model-backed text understanding via AiService/UnifiedModelRouter
   * (Phase 1 STEP 2). When a real aiService is configured, this NEVER
   * silently substitutes the deterministic fallback on failure — a genuine
   * provider failure (none configured, all failed, or persistently invalid
   * JSON) is allowed to throw so the caller's process() marks the capture
   * FAILED instead of a fabricated READY. The fallback below is used only
   * when no aiService is wired at all (offline/unit-test mode).
   */
  private async analyzeContentWithModel(content: string, type: string, defaultTitle?: string): Promise<{ analysis: StructuredAnalysisResult; provenance?: ModelProvenance }> {
    const cleanContent = content.slice(0, 8000);

    if (this.aiService) {
      const res = await this.aiService.understand({ content: cleanContent, contentType: type, defaultTitle });
      return {
        analysis: res.data,
        provenance: { provider: res.provider, model: res.model, requestId: res.requestId, latencyMs: res.latencyMs },
      };
    }

    return { analysis: this.fallbackStructuredAnalysis(cleanContent, defaultTitle) };
  }

  // Idempotency (Phase 1 STEP 2 item H): a retry must not append duplicate
  // PROPOSED candidates for content that hasn't changed. `existing` is the
  // item's current candidate list (retryCapture() already strips PROPOSED
  // ones from it before reprocessing, but this filters defensively too);
  // a freshly generated candidate is skipped if an existing candidate of the
  // same type already carries the same identity (title, or statement for
  // MEMORY, or summary for KNOWLEDGE).
  private mergeCandidates(existing: WorkspaceCandidate[] | undefined, fresh: WorkspaceCandidate[]): WorkspaceCandidate[] {
    const preserved = (existing || []).filter((c) => c.status !== 'PROPOSED');
    const identity = (c: WorkspaceCandidate): string => {
      const key = c.type === 'MEMORY' ? c.statement : c.type === 'KNOWLEDGE' ? c.summary : c.title;
      return `${c.type}:${key.trim().toLowerCase()}`;
    };
    const preservedIdentities = new Set(preserved.map(identity));
    const dedupedFresh = fresh.filter((c) => !preservedIdentities.has(identity(c)));
    return [...preserved, ...dedupedFresh];
  }

  // Phase 1 STEP 5 — converts one understanding-derived WorkspaceCandidate
  // into the canonical CandidateStore's typed, discriminated upsert input.
  // sourceRefs are plain reference strings (item H): a real chunkId when the
  // suggestion is grounded in one, else a `capture:<captureId>` reference —
  // always something the model was genuinely shown, never fabricated.
  private toCanonicalUpsertInput(item: CaptureItem, wc: WorkspaceCandidate, contentHash: string | undefined): UpsertCandidateInput {
    const sourceRefs = wc.sourceRefs.length > 0
      ? wc.sourceRefs.map((r) => r.chunkId || `capture:${item.captureId}`)
      : [`capture:${item.captureId}`];
    const base = {
      tenantId: item.tenantId,
      principalId: item.ownerId,
      captureId: item.captureId,
      contentHash,
      sourceRefs,
      confidence: wc.confidence,
      title: wc.title,
      summary: wc.reason,
    };
    if (wc.type === 'TASK') {
      return { ...base, type: 'TASK', payload: { name: wc.title, objective: wc.description, dueAt: wc.dueDateCandidate ?? null } };
    }
    if (wc.type === 'CALENDAR') {
      return { ...base, type: 'CALENDAR', payload: { summary: wc.title, start: wc.startCandidate ?? null, end: wc.endCandidate ?? null, timezone: wc.timezone ?? null, attendees: [] } };
    }
    if (wc.type === 'MEMORY') {
      return { ...base, type: 'MEMORY', payload: { statement: wc.statement, category: wc.memoryType } };
    }
    return { ...base, type: 'KNOWLEDGE', payload: { title: wc.title, summary: wc.summary, sourceCaptureId: item.captureId } };
  }

  // Phase 1 STEP 5 — upserts this pass's understanding-derived candidates
  // into the durable CandidateStore (idempotent: item F) and expires any
  // still-PROPOSED canonical candidate for this capture whose contentHash no
  // longer matches (item G). Returns the full, deduplicated set of
  // candidateIds this capture should reference (item P) — a no-op that
  // returns the existing references unchanged when no CandidateStore is
  // wired, so offline/unit-test harnesses are unaffected.
  private upsertCanonicalCandidates(item: CaptureItem, freshCandidates: WorkspaceCandidate[], contentHash: string | undefined): string[] {
    if (!this.candidateStore) return item.metadata.candidateIds || [];
    this.candidateStore.expireStaleForCapture(item.captureId, item.tenantId, item.ownerId, contentHash);

    const merged = new Set<string>(item.metadata.candidateIds || []);
    for (const wc of freshCandidates) {
      const record = this.candidateStore.upsert(this.toCanonicalUpsertInput(item, wc, contentHash));
      merged.add(record.candidateId);
    }
    return [...merged];
  }

  /**
   * Deterministic fallback analysis parser for unit testing and offline execution
   */
  private fallbackStructuredAnalysis(content: string, defaultTitle?: string): StructuredAnalysisResult {
    const lower = content.toLowerCase();
    const title = defaultTitle || content.slice(0, 40).replace(/[\r\n]+/g, ' ') || 'Quick Note';
    const summary = content.length > 150 ? `${content.slice(0, 147)}...` : content;

    const topics: string[] = [];
    // No real NER/date-extraction is possible from keyword matching alone —
    // an offline/no-provider fallback must stay honest and leave these
    // empty rather than fabricate structured entities or dates.
    const entities: StructuredAnalysisResult['entities'] = [];
    const dates: StructuredAnalysisResult['dates'] = [];
    const actionItems: StructuredAnalysisResult['actionItems'] = [];

    const memoryCandidates: StructuredAnalysisResult['memoryCandidates'] = [];
    const taskCandidates: StructuredAnalysisResult['taskCandidates'] = [];
    const calendarCandidates: StructuredAnalysisResult['calendarCandidates'] = [];
    const knowledgeCandidates: StructuredAnalysisResult['knowledgeCandidates'] = [];

    if (lower.includes('nagex')) topics.push('NAgex');
    if (lower.includes('pdf') || lower.includes('document')) topics.push('Documents');
    if (lower.includes('meeting') || lower.includes('schedule')) topics.push('Calendar');

    if (lower.includes('선호한다') || lower.includes('prefer') || lower.includes('like to use') || lower.includes('always use')) {
      memoryCandidates.push({
        statement: content,
        memoryType: 'PREFERENCE',
        confidence: 0.95,
      });
    }

    if (
      lower.includes('todo') ||
      lower.includes('task:') ||
      lower.includes('action item') ||
      lower.includes('아이디어:') ||
      lower.includes('add feature') ||
      lower.includes('must review') ||
      lower.includes('remind me')
    ) {
      taskCandidates.push({
        title: `Task: ${title}`,
        description: content,
        priorityCandidate: lower.includes('urgent') || lower.includes('high') ? 'HIGH' : 'MEDIUM',
        confidence: 0.9,
      });
      actionItems.push({ text: title, confidence: 0.7 });
    }

    if (lower.includes('meeting') || lower.includes('schedule') || lower.includes('tomorrow at 3') || lower.includes('3 pm')) {
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      calendarCandidates.push({
        title: `Meeting: ${title}`,
        startCandidate: tomorrow,
        confidence: 0.88,
      });
    }

    if (content.length > 200 || lower.includes('report') || lower.includes('guide')) {
      knowledgeCandidates.push({
        title,
        summary,
        tags: topics,
        confidence: 0.7,
      });
    }

    return {
      title,
      summary,
      contentType: 'note',
      topics,
      entities,
      dates,
      actionItems,
      memoryCandidates,
      taskCandidates,
      calendarCandidates,
      knowledgeCandidates,
    };
  }

  /**
   * Convert analysis results into hardened candidate objects
   */
  private buildCandidatesFromAnalysis(
    captureId: string,
    analysis: StructuredAnalysisResult,
    sourceRefs: CandidateSourceRef[] = []
  ): WorkspaceCandidate[] {
    const candidates: WorkspaceCandidate[] = [];

    for (const tc of analysis.taskCandidates) {
      const candidate: TaskCandidate = {
        candidateId: generateResourceId('cand'),
        captureId,
        type: 'TASK',
        title: tc.title,
        description: tc.description,
        priorityCandidate: tc.priorityCandidate || 'MEDIUM',
        dueDateCandidate: tc.dueDateCandidate,
        reason: 'Task suggested by AI capture analysis',
        confidence: tc.confidence || 0.85,
        sourceRefs,
        status: 'PROPOSED',
      };
      candidates.push(candidate);
    }

    for (const cc of analysis.calendarCandidates) {
      const candidate: CalendarCandidate = {
        candidateId: generateResourceId('cand'),
        captureId,
        type: 'CALENDAR',
        title: cc.title,
        startCandidate: cc.startCandidate,
        endCandidate: cc.endCandidate,
        timezone: cc.timezone,
        location: cc.location,
        reason: 'Calendar meeting suggested by AI capture analysis',
        confidence: cc.confidence || 0.85,
        sourceRefs,
        status: 'PROPOSED',
      };
      candidates.push(candidate);
    }

    for (const mc of analysis.memoryCandidates) {
      const candidate: MemoryCandidate = {
        candidateId: generateResourceId('cand'),
        captureId,
        type: 'MEMORY',
        title: `Remember: ${mc.statement.slice(0, 40)}`,
        statement: mc.statement,
        memoryType: mc.memoryType || 'USER',
        reason: 'User preference or persistent fact identified by AI capture analysis',
        confidence: mc.confidence || 0.9,
        sourceRefs,
        status: 'PROPOSED',
      };
      candidates.push(candidate);
    }

    for (const kc of analysis.knowledgeCandidates) {
      const candidate: KnowledgeCandidate = {
        candidateId: generateResourceId('cand'),
        captureId,
        type: 'KNOWLEDGE',
        title: kc.title,
        summary: kc.summary,
        tags: kc.tags && kc.tags.length > 0 ? kc.tags : analysis.topics,
        reason: 'Document knowledge item suggested by AI capture analysis',
        confidence: kc.confidence || 0.9,
        sourceRefs,
        status: 'PROPOSED',
      };
      candidates.push(candidate);
    }

    return candidates;
  }
}
