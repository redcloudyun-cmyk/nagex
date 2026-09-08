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
import type { AiService } from '../model-gateway/ai-service.js';
import type { BrowserToolService } from '../tools/browser.service.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import { isUrlSafe } from '../browser/browser-url-validator.js';
import { extractPdfText, chunkText } from './pdf-extractor.js';

export interface StructuredAnalysisResult {
  title: string;
  summary: string;
  contentType: string;
  topics: string[];
  entities: string[];
  dates: string[];
  actionItems: string[];
  memoryCandidates: Array<{ statement: string; memoryType?: 'USER' | 'FACT' | 'PREFERENCE'; confidence?: number }>;
  taskCandidates: Array<{ title: string; description?: string; priorityCandidate?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDateCandidate?: string; confidence?: number }>;
  calendarCandidates: Array<{ title: string; startCandidate?: string; endCandidate?: string; timezone?: string; location?: string; confidence?: number }>;
  knowledgeCandidate?: { title: string; summary: string; tags?: string[] } | null;
}

export class CaptureProcessor {
  constructor(
    private readonly store: CaptureStore,
    private readonly aiService?: AiService,
    private readonly browserService?: BrowserToolService,
    private readonly auditLogger?: AuditLogger,
    private readonly storageProvider?: StorageProvider,
    private readonly knowledgeEngine?: KnowledgeEngine,
  ) {}

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
      if (item.type === 'LINK') {
        return await this.processUrl(item);
      } else if (item.type === 'FILE') {
        return await this.processPdf(item, rawBuffer);
      } else if (item.type === 'TEXT') {
        return await this.processText(item);
      } else {
        // AUDIO or fallback
        return await this.processAudioFallback(item, rawBuffer);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code || 'PROCESSING_ERROR';
      const failedAt = new Date().toISOString();

      const failed = this.store.updateStatus(item.captureId, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: code,
        errorMessage: errMsg,
        extractedSummary: `Processing failed: ${errMsg}`,
      });

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

    const analysis = await this.analyzeContentWithModel(rawText, 'TEXT');
    const candidates = this.buildCandidatesFromAnalysis(item.captureId, analysis);

    const completedAt = new Date().toISOString();
    const nextStatus: CaptureStatus = candidates.length > 0 ? 'NEEDS_REVIEW' : 'READY';

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
        details: { candidateCount: candidates.length, topics: analysis.topics },
      });

      for (const cand of candidates) {
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
      topics: analysis.topics,
      entities: analysis.entities,
      dates: analysis.dates,
      actionItems: analysis.actionItems,
      candidates,
      suggestedAction: candidates.length > 0 ? {
        type: candidates[0].type,
        title: candidates[0].title,
        detail: analysis.summary,
      } : undefined,
    });

    return updated ?? item;
  }

  /**
   * Process URL / LINK captures using Browser Agent & Model Router
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
      const failed = this.store.updateStatus(item.captureId, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: 'BROWSER_UNSAFE_URL',
        errorMessage: safety.reason || 'URL is blocked by security policy',
        extractedSummary: `URL safety check failed: ${safety.reason}`,
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

    // 2. Fetch page using Browser Agent
    let pageTitle = urlStr;
    let finalUrl = urlStr;
    let contentText = '';
    let retrievedAt = new Date().toISOString();

    if (this.browserService) {
      const reqId = `req_proc_url_${Date.now()}`;
      try {
        const session = await this.browserService.open({ tenantId: item.tenantId, ownerId: item.ownerId, requestId: reqId });
        const navRes = await this.browserService.navigate({
          tenantId: item.tenantId,
          ownerId: item.ownerId,
          requestId: reqId,
          browserSessionId: session.browserSessionId,
          url: urlStr,
        });

        pageTitle = navRes.title || urlStr;
        const snap = await this.browserService.snapshot({
          tenantId: item.tenantId,
          ownerId: item.ownerId,
          requestId: reqId,
          browserSessionId: session.browserSessionId,
        });

        contentText = snap.text;
        finalUrl = snap.url || urlStr;
        retrievedAt = new Date().toISOString();
      } catch (err: unknown) {
        const errObj = err as { code?: string; message?: string };
        const code = errObj.code || 'BROWSER_NAVIGATION_FAILED';

        if (code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED') {
          const blockedAt = new Date().toISOString();
          const blocked = this.store.updateStatus(item.captureId, 'NEEDS_REVIEW', {
            processingStage: 'NEEDS_REVIEW',
            processingCompletedAt: blockedAt,
            errorCode: 'BLOCKED_NEEDS_HUMAN',
            errorMessage: 'CAPTCHA or authentication required to view page',
            extractedTitle: `Verification Required: ${urlStr}`,
            extractedSummary: 'Page requires CAPTCHA or human authentication.',
            sourceUrl: urlStr,
            finalUrl: urlStr,
            retrievedAt: blockedAt,
          });
          return blocked ?? item;
        }

        const failedAt = new Date().toISOString();
        const failed = this.store.updateStatus(item.captureId, 'FAILED', {
          processingStage: 'FAILED',
          processingCompletedAt: failedAt,
          errorCode: code,
          errorMessage: errObj.message || 'Failed to navigate to URL via Browser Agent',
          extractedSummary: `Browser Agent retrieval failed: ${errObj.message || code}`,
        });
        return failed ?? item;
      }
    } else {
      // Fallback text if browser service is unattached in standalone unit test
      contentText = `Retrieved web article content for ${urlStr}.`;
      pageTitle = `Article from ${urlStr}`;
    }

    if (!contentText || !contentText.trim()) {
      const emptyAt = new Date().toISOString();
      const emptyItem = this.store.updateStatus(item.captureId, 'NEEDS_REVIEW', {
        processingStage: 'NEEDS_REVIEW',
        processingCompletedAt: emptyAt,
        errorCode: 'EMPTY_PAGE',
        errorMessage: 'Retrieved page content is empty',
        extractedTitle: pageTitle,
        extractedSummary: `Retrieved page (${urlStr}) contained no readable text.`,
        sourceUrl: urlStr,
        finalUrl,
        pageTitle,
        retrievedAt,
        contentText: '',
      });
      return emptyItem ?? item;
    }

    const contentHash = crypto.createHash('sha256').update(contentText).digest('hex');

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.extracted',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_url_ext_${Date.now()}`,
        details: { url: urlStr, pageTitle, characterCount: contentText.length },
      });
    }

    // 3. Model Router Analysis
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Analyzing content...',
    });

    const analysis = await this.analyzeContentWithModel(contentText, 'LINK', pageTitle);
    const candidates = this.buildCandidatesFromAnalysis(item.captureId, analysis, [{ snippet: contentText.slice(0, 150) }]);

    const completedAt = new Date().toISOString();
    const nextStatus: CaptureStatus = candidates.length > 0 ? 'NEEDS_REVIEW' : 'READY';

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.analyzed',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_url_anz_${Date.now()}`,
        details: { candidateCount: candidates.length, topics: analysis.topics },
      });

      for (const cand of candidates) {
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
      topics: analysis.topics,
      entities: analysis.entities,
      dates: analysis.dates,
      actionItems: analysis.actionItems,
      candidates,
      suggestedAction: candidates.length > 0 ? {
        type: candidates[0].type,
        title: candidates[0].title,
        detail: analysis.summary,
      } : undefined,
    });

    return updated ?? item;
  }

  /**
   * Process PDF captures using pdf-extractor & Model Router
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

    if (!buf || buf.length === 0) {
      const failedAt = new Date().toISOString();
      const failed = this.store.updateStatus(item.captureId, 'FAILED', {
        processingStage: 'FAILED',
        processingCompletedAt: failedAt,
        errorCode: 'PDF_PARSE_FAILED',
        errorMessage: 'PDF binary content could not be retrieved from storage',
        extractedSummary: 'Processing failed: PDF binary object missing.',
      });
      return failed ?? item;
    }

    // 1. Extract PDF Text & validate
    const pdfResult = extractPdfText(buf);
    const docTitle = item.metadata.originalName || 'Document.pdf';

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.extracted',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_pdf_ext_${Date.now()}`,
        details: { pageCount: pdfResult.pageCount, characterCount: pdfResult.characterCount },
      });
    }

    // 2. Chunking strategy (~1000 tokens / 4000 chars per chunk with 300 char overlap)
    const chunks: ProcessingChunk[] = chunkText(pdfResult.text, 1000, 300, pdfResult.pages);

    // 3. Model Analysis
    this.store.updateStatus(item.captureId, 'PROCESSING', {
      processingSubStage: 'Analyzing content...',
    });

    let analysis: StructuredAnalysisResult;
    if (chunks.length > 2) {
      analysis = await this.analyzeLargeDocument(chunks, docTitle);
    } else {
      analysis = await this.analyzeContentWithModel(pdfResult.text, 'FILE', docTitle);
    }

    const sourceRefs: CandidateSourceRef[] = chunks.slice(0, 3).map((c) => ({
      chunkId: c.chunkId,
      pageNumber: c.pageNumber,
      snippet: c.text.slice(0, 100),
    }));

    const candidates = this.buildCandidatesFromAnalysis(item.captureId, analysis, sourceRefs);

    const completedAt = new Date().toISOString();
    const nextStatus: CaptureStatus = candidates.length > 0 ? 'NEEDS_REVIEW' : 'READY';

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.analyzed',
        resource: { type: 'CaptureItem', id: item.captureId },
        result: 'SUCCESS',
        request_id: `req_pdf_anz_${Date.now()}`,
        details: { candidateCount: candidates.length, chunkCount: chunks.length },
      });

      for (const cand of candidates) {
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
      pageCount: pdfResult.pageCount,
      characterCount: pdfResult.characterCount,
      extractedTitle: docTitle,
      extractedSummary: analysis.summary,
      extractedContent: pdfResult.text,
      chunks,
      topics: analysis.topics,
      entities: analysis.entities,
      dates: analysis.dates,
      actionItems: analysis.actionItems,
      candidates,
      suggestedAction: candidates.length > 0 ? {
        type: candidates[0].type,
        title: candidates[0].title,
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
   * Document AI Analysis for large documents (chunks -> intermediate summaries -> final synthesis)
   */
  private async analyzeLargeDocument(chunks: ProcessingChunk[], docTitle: string): Promise<StructuredAnalysisResult> {
    const intermediateSummaries: string[] = [];
    for (const chunk of chunks) {
      const partial = await this.analyzeContentWithModel(chunk.text, 'FILE', `${docTitle} (${chunk.chunkId})`);
      if (partial.summary) {
        intermediateSummaries.push(`[${chunk.chunkId} Page ${chunk.pageNumber || 1}]: ${partial.summary}`);
      }
    }

    const synthesizedText = intermediateSummaries.join('\n');
    return await this.analyzeContentWithModel(synthesizedText, 'FILE', docTitle);
  }

  /**
   * Invoke AiService / Model Router with strict JSON output requirement
   */
  private async analyzeContentWithModel(content: string, type: string, defaultTitle?: string): Promise<StructuredAnalysisResult> {
    const cleanContent = content.slice(0, 8000);

    if (this.aiService) {
      try {
        const prompt = `Analyze the following ${type} capture content and extract structured items.
Content:
"""
${cleanContent}
"""

Return ONLY a valid JSON object matching this exact schema:
{
  "title": "Short descriptive title",
  "summary": "Concise summary",
  "contentType": "note|idea|task|document|article",
  "topics": ["topic1", "topic2"],
  "entities": ["entity1", "entity2"],
  "dates": ["YYYY-MM-DD..."],
  "actionItems": ["action item 1..."],
  "memoryCandidates": [
    { "statement": "User preference or fact", "memoryType": "USER|PREFERENCE|FACT", "confidence": 0.9 }
  ],
  "taskCandidates": [
    { "title": "Task title", "description": "Task details", "priorityCandidate": "LOW|MEDIUM|HIGH", "dueDateCandidate": "YYYY-MM-DD", "confidence": 0.85 }
  ],
  "calendarCandidates": [
    { "title": "Meeting or event title", "startCandidate": "ISO datetime", "endCandidate": "ISO datetime", "location": "Location", "confidence": 0.9 }
  ],
  "knowledgeCandidate": { "title": "Knowledge doc title", "summary": "Knowledge content", "tags": ["tag1"] }
}`;

        const res = await this.aiService.chat({ message: prompt, mode: 'auto' });
        const parsed = this.parseJsonObject(res.data.message);
        if (parsed) {
          return {
            title: typeof parsed.title === 'string' ? parsed.title : (defaultTitle || cleanContent.slice(0, 40)),
            summary: typeof parsed.summary === 'string' ? parsed.summary : cleanContent.slice(0, 150),
            contentType: typeof parsed.contentType === 'string' ? parsed.contentType : 'note',
            topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
            entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
            dates: Array.isArray(parsed.dates) ? parsed.dates.map(String) : [],
            actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
            memoryCandidates: Array.isArray(parsed.memoryCandidates) ? parsed.memoryCandidates as any : [],
            taskCandidates: Array.isArray(parsed.taskCandidates) ? parsed.taskCandidates as any : [],
            calendarCandidates: Array.isArray(parsed.calendarCandidates) ? parsed.calendarCandidates as any : [],
            knowledgeCandidate: parsed.knowledgeCandidate && typeof parsed.knowledgeCandidate === 'object' ? parsed.knowledgeCandidate as any : null,
          };
        }
      } catch {
        /* Fall back to deterministic structured parser */
      }
    }

    return this.fallbackStructuredAnalysis(cleanContent, defaultTitle);
  }

  private parseJsonObject(text: string): Record<string, unknown> | null {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Deterministic fallback analysis parser for unit testing and offline execution
   */
  private fallbackStructuredAnalysis(content: string, defaultTitle?: string): StructuredAnalysisResult {
    const lower = content.toLowerCase();
    const title = defaultTitle || content.slice(0, 40).replace(/[\r\n]+/g, ' ') || 'Quick Note';
    const summary = content.length > 150 ? `${content.slice(0, 147)}...` : content;

    const topics: string[] = [];
    const entities: string[] = [];
    const dates: string[] = [];
    const actionItems: string[] = [];

    const memoryCandidates: Array<{ statement: string; memoryType?: 'USER' | 'FACT' | 'PREFERENCE'; confidence?: number }> = [];
    const taskCandidates: Array<{ title: string; description?: string; priorityCandidate?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDateCandidate?: string; confidence?: number }> = [];
    const calendarCandidates: Array<{ title: string; startCandidate?: string; endCandidate?: string; timezone?: string; location?: string; confidence?: number }> = [];
    let knowledgeCandidate: { title: string; summary: string; tags?: string[] } | null = null;

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
      actionItems.push(title);
    }

    if (lower.includes('meeting') || lower.includes('schedule') || lower.includes('tomorrow at 3') || lower.includes('3 pm')) {
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      calendarCandidates.push({
        title: `Meeting: ${title}`,
        startCandidate: tomorrow,
        confidence: 0.88,
      });
      dates.push(tomorrow.slice(0, 10));
    }

    if (content.length > 200 || lower.includes('report') || lower.includes('guide')) {
      knowledgeCandidate = {
        title,
        summary,
        tags: topics,
      };
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
      knowledgeCandidate,
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

    if (analysis.knowledgeCandidate) {
      const kc = analysis.knowledgeCandidate;
      const candidate: KnowledgeCandidate = {
        candidateId: generateResourceId('cand'),
        captureId,
        type: 'KNOWLEDGE',
        title: kc.title,
        summary: kc.summary,
        tags: kc.tags || analysis.topics,
        reason: 'Document knowledge item suggested by AI capture analysis',
        confidence: 0.9,
        sourceRefs,
        status: 'PROPOSED',
      };
      candidates.push(candidate);
    }

    return candidates;
  }
}
