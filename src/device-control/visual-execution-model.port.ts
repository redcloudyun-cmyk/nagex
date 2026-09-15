// DC1-4 — VisualExecutionModelPort.
//
// The adapter boundary Section 6/30 of the Preflight and Section 5/6 of
// this directive require: core Device Control orchestration depends on
// this port only, never a provider name. A future Astra (or any other
// computer-use-capable provider) adapter implements this interface — it
// is never imported by device-control.service.ts directly.
import type { StructuredBrowserSnapshot } from '../modules/browser/index.js';
import type { CapabilityRisk } from '../capabilities/capability.types.js';
import type { ProposedDeviceAction } from './device-action.types.js';

export interface PriorDeviceActionContext {
  action: ProposedDeviceAction;
  // A short, truthful outcome description ("EXECUTED", "BLOCKED: reason",
  // never a fabricated summary) — enough for the model to ground its next
  // proposal without re-deriving the whole action log itself.
  outcome: string;
}

// DC2 — extended with tenantId/ownerId/allowedDomains/riskCeiling/
// stepNumber/remainingSteps. A provable contradiction, not a casual
// change: a real adapter (Astra) is one process-lifetime singleton shared
// across every tenant/session, so it cannot get tenantId/ownerId from its
// own construction-time state — they can only come from the per-call
// input, and are mandatory for any adapter that needs to resolve a
// screenshot through the ownership-scoped readEvidenceOwned() (DC1-R1).
// allowedDomains/riskCeiling/stepNumber/remainingSteps are genuinely new
// required model input per DC2's own Section 3, not derivable from any
// existing field.
export interface ProposeNextActionInput {
  tenantId: string;
  ownerId: string;
  goal: string;
  structuredSnapshot: StructuredBrowserSnapshot;
  // A reference only (an evidenceId from BrowserToolService's own evidence
  // store) — never raw image bytes crossing this port, matching Section 4/
  // 21's "no raw screenshot bytes" persistence rule extended to the model
  // boundary itself. A concrete adapter resolves this reference to real
  // image bytes on its own side, through the ownership-scoped
  // readEvidenceOwned() path, when it actually calls a vision-capable
  // provider.
  screenshotRef: string | null;
  allowedActions: string[];
  allowedDomains: string[];
  riskCeiling: CapabilityRisk;
  stepNumber: number;
  remainingSteps: number;
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
