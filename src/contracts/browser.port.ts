// Phase 03 — Module Contracts.
//
// The only real consumer of Browser typed against this port in this phase
// is CapabilityBroker (capability-broker.ts) — the full session lifecycle
// + navigation + read + consequential-click surface it actually calls.
// QuickCaptureService is not a consumer here: it never calls a browser
// method itself, only passes the instance through to CaptureProcessor
// (out of this phase's authorized file list) — see the Phase 03 pre-flight
// report.
import type { BrowserSessionRecord } from '../browser/browser-session.store.js';
import type { FindResult, ExtractResult, StructuredBrowserSnapshot } from '../browser/browser.types.js';
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';

// Mirrors integrations/browser/browser.runtime.ts's BrowserSnapshot —
// inlined rather than imported: contracts never import from integrations/,
// and never leak a Playwright-backed type.
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  text: string;
  totalCharacters: number;
  returnedCharacters: number;
  truncated: boolean;
}

// Mirrors tools/browser.service.ts's (unexported) BrowserActionInput.
export interface BrowserActionRequest {
  tenantId: string;
  ownerId: string;
  requestId: string;
  browserSessionId: string;
}

// Mirrors tools/browser.service.ts's BrowserActionResult/BrowserClickResult
// — inlined rather than imported from the concrete service file.
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
