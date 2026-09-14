// DC1-9 — Action policy/risk mapping.
//
// Reuses the EXISTING CapabilityRisk/CapabilityApprovalMode vocabulary
// (Section 10 of this directive, Section E of the Preflight) — no new
// vocabulary, no new approval system.
//
// CLICK is deliberately NOT resolved here: browserService.click() already
// resolves the target selector and runs the exact same
// classifyClickConsequence keyword table this whole codebase already uses
// for plain browser.click, returning APPROVAL_REQUIRED vs EXECUTED itself.
// Re-resolving the selector here first would be a second, redundant, and
// potentially-inconsistent classification of the same element — so
// device-control.service.ts calls browserService.click() directly for
// CLICK and branches on ITS return status, rather than asking this table.
// This table exists for the remaining, statically-classifiable actions,
// and for audit/documentation parity with CLICK's own registered
// capability risk (browser.click is DYNAMIC/CONDITIONAL — see
// capability.registry.ts).
//
// A model's own `riskHint` on a ProposedDeviceAction (Section 7) is
// advisory only and never consulted here — NAgex, not the model, decides
// risk/approval, per Section 10's own explicit rule.
import type { CapabilityApprovalMode, CapabilityRisk } from '../capabilities/capability.types.js';
import type { DeviceActionType } from './device-action.types.js';

export interface DeviceActionRiskDecision {
  risk: CapabilityRisk;
  approval: CapabilityApprovalMode;
}

export function mapDeviceActionToRisk(actionType: Exclude<DeviceActionType, 'CLICK'>): DeviceActionRiskDecision {
  switch (actionType) {
    case 'OBSERVE':
    case 'STOP':
    case 'SCROLL':
      return { risk: 'READ_ONLY', approval: 'NONE' };

    case 'KEYPRESS':
      return { risk: 'LOW', approval: 'NONE' };

    case 'NAVIGATE':
      // "policy controlled" per Section 10 means the allowedDomains gate
      // (Section 12) — a harder, non-approval block — not a human
      // approval pause.
      return { risk: 'LOW', approval: 'NONE' };

    case 'TYPE':
      // CONDITIONAL per Section 10's table, but nothing in this slice
      // escalates a TYPE to REQUIRED — filling a field is never itself
      // the consequential step; the CLICK that submits it is (handled by
      // browserService.click() as noted above).
      return { risk: 'LOW', approval: 'CONDITIONAL' };
  }
}
