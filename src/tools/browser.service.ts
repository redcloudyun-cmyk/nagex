import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AuditLogger } from '../governance/audit.logger.js';
import { ActionApprovalStore, type ActionApprovalRecord } from '../governance/action-approval.store.js';
import { ExecutionStore } from '../governance/execution.store.js';
import { MemoryEngine } from '../context/memory.engine.js';
import { resolveNagexDataDir } from '../governance/file-record.store.js';
import { BrowserSessionStore, type BrowserSessionRecord, generateEvidenceId } from '../browser/browser-session.store.js';
import { isBrowserRuntimeAvailableSync, type BrowserRuntime, type BrowserSnapshot } from '../integrations/browser/browser.runtime.js';
import { assertUrlSafe } from '../browser/browser-url-validator.js';
import type { FindResult, ExtractResult, StructuredBrowserSnapshot } from '../browser/browser.types.js';

// Browser Agent MVP tool service (MASTER.md Section 14.5 item 06). Reuses
// the exact same shared ActionApprovalStore/ExecutionStore/AuditLogger/
// MemoryEngine approval system already proven with Google Calendar and
// Gmail — no separate approval architecture. The one thing genuinely new
// here is CLICK classification: unlike a fixed-side-effect-level tool
// (gmail.send_email is always a write), the same browser.click tool is
// sometimes a harmless navigation click and sometimes a consequential one
// (Submit/Buy/Pay/Delete/...) — see classifyClickConsequence below.
export const BROWSER_CLICK_TOOL_ID = 'browser.click';

// Explicit keyword table (never fuzzy/LLM-based resolution — same
// precedent as the Skill Registry's alias tables) of visible button/link
// text that marks a click as consequential and therefore approval-gated.
// Deliberately case-insensitive substring matching: real button labels are
// short and these phrases are the actual, common wording sites use.
const CONSEQUENTIAL_ACTION_KEYWORDS = [
  'submit', 'send', 'buy', 'purchase', 'pay', 'payment', 'checkout', 'place order',
  'delete', 'remove', 'cancel subscription', 'publish', 'post', 'confirm', 'book',
  'reserve', 'complete booking', 'change password', 'update settings', 'save changes',
  'transfer', 'donate', 'subscribe', 'unsubscribe', 'sign', 'agree', 'accept',
];

// Explicit keyword table for CAPTCHA/MFA/human-verification detection —
// never bypassed, never solved automatically (item 11: "Never bypass
// CAPTCHA/MFA").
const HUMAN_VERIFICATION_KEYWORDS = [
  'captcha', 'i am not a robot', "i'm not a robot", 'verify you are human',
  'two-factor', 'two factor authentication', '2fa', 'one-time code', 'one-time passcode', 'otp',
  'enter your password again', 'security check', 'verify your identity',
];

export function classifyClickConsequence(text: string | null, isFormControl: boolean): boolean {
  if (isFormControl) return true; // a type="submit" control is inherently consequential
  if (!text) return false;
  const normalized = text.toLowerCase();
  return CONSEQUENTIAL_ACTION_KEYWORDS.some((kw) => normalized.includes(kw));
}

export function detectsHumanVerification(snapshot: { title: string; text: string }): boolean {
  const normalized = `${snapshot.title} ${snapshot.text}`.toLowerCase();
  return HUMAN_VERIFICATION_KEYWORDS.some((kw) => normalized.includes(kw));
}

export interface BrowserActionResult {
  url: string;
  title: string;
}

export interface BrowserClickExecuted extends BrowserActionResult {
  status: 'EXECUTED';
}

export interface BrowserClickApprovalRequired {
  status: 'APPROVAL_REQUIRED';
  approval: ActionApprovalRecord;
}

export type BrowserClickResult = BrowserClickExecuted | BrowserClickApprovalRequired;

export interface BrowserEvidence {
  evidenceId: string;
  url: string;
  title: string;
  capturedAt: string;
}

interface BrowserActionInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  browserSessionId: string;
}

export class BrowserToolService {
  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly sessions: BrowserSessionStore,
    private readonly approvals: ActionApprovalStore,
    private readonly audit: AuditLogger,
    private readonly memory: MemoryEngine,
    private readonly executions: ExecutionStore = new ExecutionStore(),
    private readonly evidenceDir: string = resolveNagexDataDir('browser-evidence', 'NAGEX_BROWSER_EVIDENCE_DIR'),
    // DI seam so tests can force the "runtime unavailable" path
    // deterministically, the same pattern gmail.service.ts/
    // google-calendar.service.ts use for getConfig — never a mock of the
    // runtime itself, just this one availability check.
    private readonly isRuntimeAvailable: () => boolean = isBrowserRuntimeAvailableSync,
  ) {}

  // ── availability / session lifecycle ────────────────────────────────────

  private requireAvailable(requestId: string): void {
    if (!this.isRuntimeAvailable()) {
      throw new NagexError({ code: 'BROWSER_UNAVAILABLE', category: 'POLICY', message: 'The browser runtime is not available on this server.', request_id: requestId });
    }
  }

  private requireSession(browserSessionId: string, requestId: string): BrowserSessionRecord {
    const record = this.sessions.get(browserSessionId);
    if (!record) {
      throw new NagexError({ code: 'BROWSER_SESSION_NOT_FOUND', category: 'NOT_FOUND', message: `Browser session ${browserSessionId} was not found.`, request_id: requestId });
    }
    if (record.status === 'CLOSED') {
      throw new NagexError({ code: 'BROWSER_SESSION_CLOSED', category: 'CONFLICT', message: `Browser session ${browserSessionId} is closed.`, request_id: requestId });
    }
    if (record.status === 'BLOCKED_NEEDS_HUMAN') {
      throw new NagexError({ code: 'BROWSER_HUMAN_VERIFICATION_REQUIRED', category: 'POLICY', message: 'This browser session hit a CAPTCHA/verification/MFA page and is blocked pending a human. NAgex never attempts to bypass these.', request_id: requestId });
    }
    return record;
  }

  private auditAction(toolId: string, action: string, input: BrowserActionInput, result: 'SUCCESS' | 'FAILED' | 'PENDING_APPROVAL' | 'DENIED', extra: Record<string, unknown> = {}, reasonCode?: string): void {
    this.audit.logEvent({
      actor: { type: 'user', id: input.ownerId },
      tenant_id: input.tenantId,
      action,
      resource: { type: 'ToolExecution', id: input.browserSessionId },
      result,
      reason_code: reasonCode,
      request_id: input.requestId,
      details: { toolId, browserSessionId: input.browserSessionId, ...extra },
    });
  }

  // After every navigation, the page is checked for CAPTCHA/MFA/human-
  // verification language and, if found, the session is permanently
  // blocked (until closed and reopened) — every further write attempt on
  // it fails closed via requireSession above, and this never attempts to
  // solve or click through the verification itself.
  private async checkHumanVerification(input: BrowserActionInput, snapshot: BrowserSnapshot): Promise<void> {
    if (!detectsHumanVerification(snapshot)) return;
    this.sessions.setStatus(input.browserSessionId, 'BLOCKED_NEEDS_HUMAN');
    this.auditAction('browser.navigate', 'tool.execution.failed', input, 'FAILED', { url: snapshot.url }, 'BROWSER_HUMAN_VERIFICATION_REQUIRED');
    throw new NagexError({ code: 'BROWSER_HUMAN_VERIFICATION_REQUIRED', category: 'POLICY', message: 'This page requires human verification (CAPTCHA/MFA/sign-in). Stopping rather than attempting to bypass it.', request_id: input.requestId });
  }

  public async open(input: { tenantId: string; ownerId: string; requestId: string }): Promise<BrowserSessionRecord & { title: string }> {
    this.requireAvailable(input.requestId);
    const record = this.sessions.getOrCreate(input.tenantId, input.ownerId);
    const { url, title } = await this.runtime.openSession(record.browserSessionId);
    this.sessions.updateUrl(record.browserSessionId, url);
    this.auditAction('browser.open', 'tool.execution.succeeded', { ...input, browserSessionId: record.browserSessionId }, 'SUCCESS', { url });
    return { ...record, title };
  }

  // Deliberately does NOT go through requireSession()'s stricter guard:
  // close() must always be a safe way to release a session, including one
  // permanently BLOCKED_NEEDS_HUMAN (Phase 1 STEP 3 — a caller finishing a
  // capture attempt on a CAPTCHA-blocked page must still be able to tear
  // it down) and including an already-CLOSED one (idempotent no-op, so a
  // caller's cleanup path never itself needs special-casing).
  public async close(input: BrowserActionInput): Promise<void> {
    const record = this.sessions.get(input.browserSessionId);
    if (!record) {
      throw new NagexError({ code: 'BROWSER_SESSION_NOT_FOUND', category: 'NOT_FOUND', message: `Browser session ${input.browserSessionId} was not found.`, request_id: input.requestId });
    }
    if (record.status === 'CLOSED') return;
    await this.runtime.closeSession(record.browserSessionId);
    this.sessions.close(record.browserSessionId);
    this.auditAction('browser.close', 'tool.execution.succeeded', input, 'SUCCESS');
  }

  // ── read-only / navigational (no approval per policy) ───────────────────

  public async navigate(input: BrowserActionInput & { url: string }): Promise<BrowserActionResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const safeUrl = assertUrlSafe(input.url, input.requestId);
    this.auditAction('browser.navigate', 'tool.execution.started', input, 'PENDING_APPROVAL', { url: safeUrl });
    try {
      const result = await this.runtime.navigate(record.browserSessionId, safeUrl);
      this.sessions.updateUrl(record.browserSessionId, result.url);
      const snapshot = await this.runtime.snapshot(record.browserSessionId);
      await this.checkHumanVerification(input, snapshot);
      this.auditAction('browser.navigate', 'tool.execution.succeeded', input, 'SUCCESS', { url: result.url });
      return result;
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'BROWSER_NAVIGATE_FAILED';
      if (code !== 'BROWSER_HUMAN_VERIFICATION_REQUIRED') this.auditAction('browser.navigate', 'tool.execution.failed', input, 'FAILED', { url: input.url }, code);
      throw error;
    }
  }

  public async tabs(input: BrowserActionInput): Promise<Array<{ index: number; url: string; title: string }>> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    return this.runtime.listTabs(record.browserSessionId);
  }

  public async snapshot(input: BrowserActionInput): Promise<BrowserSnapshot> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const snapshot = await this.runtime.snapshot(record.browserSessionId);
    this.auditAction('browser.snapshot', 'tool.execution.succeeded', input, 'SUCCESS', { url: snapshot.url });
    return snapshot;
  }

  public async structuredSnapshot(input: BrowserActionInput): Promise<StructuredBrowserSnapshot> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const snapshot = await this.runtime.structuredSnapshot(record.browserSessionId);
    this.auditAction('browser.snapshot', 'tool.execution.succeeded', input, 'SUCCESS', { url: snapshot.url });
    return snapshot;
  }

  public async find(input: BrowserActionInput & { query: string }): Promise<FindResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const result = await this.runtime.find(record.browserSessionId, input.query);
    this.auditAction('browser.find', 'tool.execution.succeeded', input, 'SUCCESS', { query: input.query, matchCount: result.candidates.length });
    return result;
  }

  public async extract(input: BrowserActionInput & { target?: 'text' | 'links' | 'buttons' | 'inputs' | 'all' }): Promise<ExtractResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const result = await this.runtime.extract(record.browserSessionId, input.target);
    this.auditAction('browser.extract', 'tool.execution.succeeded', input, 'SUCCESS', { target: input.target || 'all' });
    return result;
  }

  public async back(input: BrowserActionInput): Promise<BrowserActionResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const result = await this.runtime.back(record.browserSessionId);
    this.sessions.updateUrl(record.browserSessionId, result.url);
    this.auditAction('browser.back', 'tool.execution.succeeded', input, 'SUCCESS', { url: result.url });
    return result;
  }

  public async forward(input: BrowserActionInput): Promise<BrowserActionResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const result = await this.runtime.forward(record.browserSessionId);
    this.sessions.updateUrl(record.browserSessionId, result.url);
    this.auditAction('browser.forward', 'tool.execution.succeeded', input, 'SUCCESS', { url: result.url });
    return result;
  }

  public async reload(input: BrowserActionInput): Promise<BrowserActionResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const result = await this.runtime.reload(record.browserSessionId);
    this.sessions.updateUrl(record.browserSessionId, result.url);
    this.auditAction('browser.reload', 'tool.execution.succeeded', input, 'SUCCESS', { url: result.url });
    return result;
  }

  public async clearProfile(input: BrowserActionInput): Promise<void> {
    this.requireAvailable(input.requestId);
    await this.runtime.clearProfile(input.browserSessionId);
    this.sessions.close(input.browserSessionId);
    this.auditAction('browser.clearProfile', 'tool.execution.succeeded', input, 'SUCCESS');
  }

  public async screenshot(input: BrowserActionInput): Promise<BrowserEvidence> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const bytes = await this.runtime.screenshot(record.browserSessionId);
    const evidenceId = generateEvidenceId();
    this.writeEvidence(evidenceId, bytes);
    const capturedAt = getCurrentISOString();
    this.auditAction('browser.screenshot', 'tool.execution.succeeded', input, 'SUCCESS', { evidenceId, url: record.currentUrl });
    return { evidenceId, url: record.currentUrl || '', title: '', capturedAt };
  }

  private writeEvidence(evidenceId: string, bytes: Buffer): void {
    try {
      fs.mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
      const tmpPath = path.join(this.evidenceDir, `.${evidenceId}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
      fs.renameSync(tmpPath, path.join(this.evidenceDir, `${evidenceId}.png`));
    } catch (error) {
      console.error(JSON.stringify({ event: 'nagex_browser_evidence_persist_failed', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
    }
  }

  public async scroll(input: BrowserActionInput & { direction: 'up' | 'down'; amountPx?: number }): Promise<void> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    await this.runtime.scroll(record.browserSessionId, input.direction, input.amountPx ?? 400);
    this.auditAction('browser.scroll', 'tool.execution.succeeded', input, 'SUCCESS', { direction: input.direction });
  }

  public async wait(input: BrowserActionInput & { ms: number }): Promise<void> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    await this.runtime.wait(record.browserSessionId, input.ms);
  }

  public async type(input: BrowserActionInput & { selector: string; text: string }): Promise<void> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const match = await this.runtime.resolveSelector(record.browserSessionId, input.selector);
    this.assertSelectorResolved(match, input, 'browser.type');
    await this.runtime.type(record.browserSessionId, input.selector, input.text);
    // Never audits the typed text itself — only that a field was filled —
    // mirroring gmail.service.ts's rule of never logging body/subject content.
    this.auditAction('browser.type', 'tool.execution.succeeded', input, 'SUCCESS', { selector: input.selector });
  }

  public async select(input: BrowserActionInput & { selector: string; value: string }): Promise<void> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const match = await this.runtime.resolveSelector(record.browserSessionId, input.selector);
    this.assertSelectorResolved(match, input, 'browser.select');
    await this.runtime.select(record.browserSessionId, input.selector, input.value);
    this.auditAction('browser.select', 'tool.execution.succeeded', input, 'SUCCESS', { selector: input.selector, value: input.value });
  }

  private assertSelectorResolved(match: { count: number }, input: BrowserActionInput, toolId: string = BROWSER_CLICK_TOOL_ID): void {
    if (match.count === 0) {
      this.auditAction(toolId, 'tool.execution.failed', input, 'FAILED', {}, 'BROWSER_SELECTOR_NOT_FOUND');
      throw new NagexError({ code: 'BROWSER_SELECTOR_NOT_FOUND', category: 'NOT_FOUND', message: 'No matching element was found on the page. The page may have changed.', request_id: input.requestId });
    }
    if (match.count > 1) {
      this.auditAction(toolId, 'tool.execution.failed', input, 'FAILED', {}, 'BROWSER_SELECTOR_AMBIGUOUS');
      throw new NagexError({ code: 'BROWSER_SELECTOR_AMBIGUOUS', category: 'VALIDATION', message: `${match.count} elements matched this selector — refusing to guess which one.`, request_id: input.requestId });
    }
  }

  // ── click: context-dependent — navigation vs. consequential ─────────────

  public async click(input: BrowserActionInput & { selector: string; forceApproval?: boolean }): Promise<BrowserClickResult> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const match = await this.runtime.resolveSelector(record.browserSessionId, input.selector);
    this.assertSelectorResolved(match, input);

    if (!input.forceApproval && !classifyClickConsequence(match.text, match.isFormControl)) {
      await this.runtime.click(record.browserSessionId, input.selector);
      const page = await this.runtime.snapshot(record.browserSessionId);
      this.sessions.updateUrl(record.browserSessionId, page.url);
      await this.checkHumanVerification(input, page);
      this.auditAction(BROWSER_CLICK_TOOL_ID, 'tool.execution.succeeded', input, 'SUCCESS', { selector: input.selector, consequential: false, url: page.url });
      return { status: 'EXECUTED', url: page.url, title: page.title };
    }

    // Consequential — never clicked without approval. The canonical payload
    // freezes exactly what will be clicked: the session, the selector, and
    // the visible text a human reviewed, so a payload-hash mismatch catches
    // any change to the target between request and execution.
    const payload = { browserSessionId: record.browserSessionId, selector: input.selector, targetText: match.text, url: record.currentUrl };
    const approval = this.approvals.request({ toolId: BROWSER_CLICK_TOOL_ID, tenantId: input.tenantId, principalId: input.ownerId, payload });
    this.auditAction(BROWSER_CLICK_TOOL_ID, 'approval.requested', input, 'PENDING_APPROVAL', { selector: input.selector, targetText: match.text });
    return { status: 'APPROVAL_REQUIRED', approval };
  }

  public getApproval(approvalId: string): ActionApprovalRecord | undefined {
    return this.approvals.get(approvalId);
  }

  public approve(approvalId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.approve(approvalId, requestId);
    this.audit.logEvent({ actor: { type: 'user', id: principalId }, tenant_id: record.tenantId, action: 'approval.approved', resource: { type: 'ActionApproval', id: approvalId }, result: 'SUCCESS', request_id: requestId });
    return record;
  }

  public reject(approvalId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.reject(approvalId, requestId);
    this.audit.logEvent({ actor: { type: 'user', id: principalId }, tenant_id: record.tenantId, action: 'approval.rejected', resource: { type: 'ActionApproval', id: approvalId }, result: 'DENIED', request_id: requestId });
    return record;
  }

  public async executeApprovedClick(input: { approvalId: string; browserSessionId: string; selector: string; tenantId: string; ownerId: string; requestId: string }): Promise<BrowserClickExecuted> {
    this.requireAvailable(input.requestId);
    const record = this.requireSession(input.browserSessionId, input.requestId);
    const executionId = generateResourceId('exe');
    const startedAt = getCurrentISOString();

    this.auditAction(BROWSER_CLICK_TOOL_ID, 'tool.execution.started', input, 'PENDING_APPROVAL', { approvalId: input.approvalId, selector: input.selector });

    // Re-resolve the selector NOW (not trusting the state at request time)
    // so a page that changed between approval and execution is caught here
    // too, before the approval is even consumed.
    const match = await this.runtime.resolveSelector(record.browserSessionId, input.selector);
    this.assertSelectorResolved(match, input);
    const payload = { browserSessionId: input.browserSessionId, selector: input.selector, targetText: match.text, url: record.currentUrl };

    try {
      this.approvals.consume(input.approvalId, BROWSER_CLICK_TOOL_ID, payload, input.requestId, executionId);
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'APPROVAL_VALIDATION_FAILED';
      this.auditAction(BROWSER_CLICK_TOOL_ID, 'tool.execution.failed', input, 'DENIED', { approvalId: input.approvalId }, code);
      throw error;
    }

    this.executions.start({ executionId, toolId: BROWSER_CLICK_TOOL_ID, approvalId: input.approvalId, tenantId: input.tenantId, principalId: input.ownerId, startedAt });

    try {
      await this.runtime.click(record.browserSessionId, input.selector);
      const page = await this.runtime.snapshot(record.browserSessionId);
      this.sessions.updateUrl(record.browserSessionId, page.url);
      await this.checkHumanVerification(input, page);
      const completedAt = getCurrentISOString();
      this.executions.succeed(executionId, { externalId: executionId, externalUrl: page.url, completedAt });
      this.auditAction(BROWSER_CLICK_TOOL_ID, 'tool.execution.succeeded', input, 'SUCCESS', { selector: input.selector, consequential: true, url: page.url });

      const memoryRecord = this.memory.proposeMemory('USER', input.ownerId, { subject: 'Browser Action', predicate: 'clicked', value: `Clicked "${match.text || input.selector}" on ${page.url}.` });
      this.memory.activateMemory(memoryRecord.id);

      return { status: 'EXECUTED', url: page.url, title: page.title };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'BROWSER_CLICK_FAILED';
      const completedAt = getCurrentISOString();
      this.executions.fail(executionId, { errorCode: code, completedAt });
      if (code !== 'BROWSER_HUMAN_VERIFICATION_REQUIRED') this.auditAction(BROWSER_CLICK_TOOL_ID, 'tool.execution.failed', input, 'FAILED', { selector: input.selector }, code);
      throw error;
    }
  }
}
