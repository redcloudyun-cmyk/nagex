// Phase 03 — Module Contracts. Phase 04 — Browser Module Extraction moved
// the concrete implementation into src/modules/browser/ (path corrected
// below); BrowserPort's own shape is untouched by that move.
//
// The only real consumer of Browser typed against this port is
// CapabilityBroker (capability-broker.ts) — the full session lifecycle +
// navigation + read + consequential-click surface it actually calls.
// QuickCaptureService/CaptureProcessor are not consumers of BrowserPort —
// CaptureProcessor's real 4-method surface is narrower, see
// BrowserRetrievalPort below (Phase 04, added on real evidence from the
// QuickCaptureService -> CaptureProcessor -> Browser chain, not
// speculatively).
import type { BrowserSessionRecord, FindResult, ExtractResult, StructuredBrowserSnapshot } from '../modules/browser/index.js';
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';

// Mirrors modules/browser/browser.runtime.ts's BrowserSnapshot — inlined
// rather than imported: contracts never leak a Playwright-backed type.
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  text: string;
  totalCharacters: number;
  returnedCharacters: number;
  truncated: boolean;
}

// Mirrors modules/browser/browser.service.ts's (unexported) BrowserActionInput.
export interface BrowserActionRequest {
  tenantId: string;
  ownerId: string;
  requestId: string;
  browserSessionId: string;
}

// Mirrors modules/browser/browser.service.ts's BrowserActionResult/
// BrowserClickResult — inlined rather than imported from the concrete
// service file.
export interface BrowserNavigationResult {
  url: string;
  title: string;
}

export interface BrowserClickExecutedResult extends BrowserNavigationResult {
  status: 'EXECUTED';
}

export interface BrowserClickApprovalRequiredResult {
  status: 'APPROVAL_REQUIRED';
  approval: ActionApprovalRecord;
}

export type BrowserClickResult = BrowserClickExecutedResult | BrowserClickApprovalRequiredResult;

export interface BrowserPort {
  open(input: { tenantId: string; ownerId: string; requestId: string }): Promise<BrowserSessionRecord & { title: string }>;
  close(input: BrowserActionRequest): Promise<void>;
  navigate(input: BrowserActionRequest & { url: string }): Promise<BrowserNavigationResult>;
  tabs(input: BrowserActionRequest): Promise<Array<{ index: number; url: string; title: string }>>;
  snapshot(input: BrowserActionRequest): Promise<BrowserPageSnapshot>;
  structuredSnapshot(input: BrowserActionRequest): Promise<StructuredBrowserSnapshot>;
  find(input: BrowserActionRequest & { query: string }): Promise<FindResult>;
  extract(input: BrowserActionRequest & { target?: 'text' | 'links' | 'buttons' | 'inputs' | 'all' }): Promise<ExtractResult>;
  back(input: BrowserActionRequest): Promise<BrowserNavigationResult>;
  forward(input: BrowserActionRequest): Promise<BrowserNavigationResult>;
  reload(input: BrowserActionRequest): Promise<BrowserNavigationResult>;
  click(input: BrowserActionRequest & { selector: string; forceApproval?: boolean }): Promise<BrowserClickResult>;
}

// Phase 04 — added on real, confirmed evidence (not speculatively): tracing
// the QuickCaptureService -> CaptureProcessor -> Browser chain found that
// CaptureProcessor (workspace/capture-processor.ts) only ever calls 4 of
// BrowserPort's 12 methods — open/navigate/snapshot/close, to retrieve a
// URL's content. QuickCaptureService itself calls no Browser method at
// all; it only passes this same narrower reference through to
// CaptureProcessor.
export interface BrowserRetrievalPort {
  open(input: { tenantId: string; ownerId: string; requestId: string }): Promise<BrowserSessionRecord & { title: string }>;
  navigate(input: BrowserActionRequest & { url: string }): Promise<BrowserNavigationResult>;
  snapshot(input: BrowserActionRequest): Promise<BrowserPageSnapshot>;
  close(input: BrowserActionRequest): Promise<void>;
}
