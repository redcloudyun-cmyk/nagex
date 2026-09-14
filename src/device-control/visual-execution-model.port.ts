// DC1-4 — VisualExecutionModelPort.
//
// The adapter boundary Section 6/30 of the Preflight and Section 5/6 of
// this directive require: core Device Control orchestration depends on
// this port only, never a provider name. A future Astra (or any other
// computer-use-capable provider) adapter implements this interface — it
// is never imported by device-control.service.ts directly.
import type { StructuredBrowserSnapshot } from '../modules/browser/index.js';
import type { ProposedDeviceAction } from './device-action.types.js';

export interface PriorDeviceActionContext {
  action: ProposedDeviceAction;
  // A short, truthful outcome description ("EXECUTED", "BLOCKED: reason",
  // never a fabricated summary) — enough for the model to ground its next
  // proposal without re-deriving the whole action log itself.
  outcome: string;
}

export interface ProposeNextActionInput {
  goal: string;
  structuredSnapshot: StructuredBrowserSnapshot;
  // A reference only (an evidenceId from BrowserToolService's own evidence
  // store) — never raw image bytes crossing this port, matching Section 4/
  // 21's "no raw screenshot bytes" persistence rule extended to the model
  // boundary itself. A concrete adapter resolves this reference to real
  // image bytes/URL on its own side when it actually calls a vision-
  // capable provider.
  screenshotRef: string | null;
  allowedActions: string[];
  priorActions: PriorDeviceActionContext[];
  requestId: string;
}

export interface VisualExecutionModelPort {
  // Returns exactly one proposed action — never executes it. A malformed
  // response from a real provider is the ADAPTER's problem to normalize or
  // reject before returning; this port's contract is always one valid
  // ProposedDeviceAction, or a thrown error (which the caller fails closed
  // on — see device-control.service.ts).
  proposeNextAction(input: ProposeNextActionInput): Promise<ProposedDeviceAction>;
}
