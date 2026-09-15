// DC3-B2 Preflight — Mandatory Safety Correction After Notepad Multi-Tab
// Failure.
//
// A real host incident proved PID is not authorization and PID is not
// sufficient target identity: Windows 11 Notepad reused a single existing
// process for what was believed to be a fresh test window, a UIA mutation
// was targeted using PID-level matching only, and a subsequent
// Stop-Process -Force closed the whole shared process — including the
// operator's own pre-existing, unrelated tabs — with no save prompt.
//
// This module is the permanent policy layer that incident requires. No
// DC3-B2 production automation provider may perform a state-changing UIA
// action without going through resolveUniqueTarget()/MutationSafetyGate
// below. It is deliberately pure/host-independent: real Windows UIA
// observation feeds it TargetCandidate values, but the policy itself
// (ambiguity detection, ownership enforcement, TOCTOU recheck, close
// safety) is fully unit-testable without a live desktop.
import { toSafeTextEvidence, type SafeTextEvidence } from './sensitive-text-redaction.js';

// A single process is never assumed to equal a single user document — the
// exact failure mode this incident exposed. Ownership is therefore tracked
// per logical target, not per process.
export type TargetOwnership = 'NAGEX_OWNED_TEST_TARGET' | 'USER_EXISTING_TARGET';

// The strongest available combination of identity signals for one logical
// target (one window/tab/document), not one process. `automationElementRuntimeId`
// is the UIA RuntimeId (AutomationElement.GetRuntimeId(), joined) — the
// closest thing UIA offers to a stable per-element handle, and is what
// TOCTOU re-resolution compares against. `windowTitle` is carried only as
// SafeTextEvidence (redacted metadata) — never raw text — per the
// redaction boundary this same Preflight already established.
export interface TargetIdentity {
  deviceId: string;
  executionSessionId: string;
  processId: number;
  automationElementRuntimeId: string;
  rootWindowRuntimeId?: string;
  controlAncestry: string[];
  windowTitleEvidence: SafeTextEvidence;
  applicationStableId?: string;
  ownership: TargetOwnership;
}

export interface TargetCandidate {
  automationElementRuntimeId: string;
  rootWindowRuntimeId?: string;
  controlAncestry: string[];
  windowTitle?: string | null;
  applicationStableId?: string;
  ownership: TargetOwnership;
}

export function toTargetIdentity(deviceId: string, executionSessionId: string, processId: number, candidate: TargetCandidate): TargetIdentity {
  return {
    deviceId,
    executionSessionId,
    processId,
    automationElementRuntimeId: candidate.automationElementRuntimeId,
    rootWindowRuntimeId: candidate.rootWindowRuntimeId,
    controlAncestry: candidate.controlAncestry,
    windowTitleEvidence: toSafeTextEvidence(candidate.windowTitle),
    applicationStableId: candidate.applicationStableId,
    ownership: candidate.ownership,
  };
}

export type TargetResolutionOutcome =
  | { status: 'RESOLVED'; identity: TargetIdentity }
  | { status: 'TARGET_AMBIGUOUS'; matchCount: number }
  | { status: 'TARGET_NOT_OWNED' };

// MATCH_COUNT != 1 -> never execute, never "pick the first". A process
// hosting multiple tabs/windows (the exact Notepad shape) naturally yields
// multiple candidates here when filtered by PID alone — this is what makes
// "multi-tab process assumed single target" structurally impossible: the
// caller must narrow to a single candidate through additional identity
// signals (control ancestry, application-stable id, explicit user
// selection) before this function will ever return RESOLVED.
export function resolveUniqueTarget(deviceId: string, executionSessionId: string, processId: number, candidates: TargetCandidate[]): TargetResolutionOutcome {
  if (candidates.length !== 1) {
    return { status: 'TARGET_AMBIGUOUS', matchCount: candidates.length };
  }
  return { status: 'RESOLVED', identity: toTargetIdentity(deviceId, executionSessionId, processId, candidates[0]) };
}

export type MutationGateOutcome =
  | { status: 'EXECUTED'; result: unknown }
  | { status: 'TARGET_AMBIGUOUS'; matchCount: number }
  | { status: 'TARGET_NOT_OWNED' }
  | { status: 'TARGET_CHANGED_SINCE_OBSERVATION' };

export interface MutationGateInput {
  boundIdentity: TargetIdentity;
  // Re-observed candidates at the moment of mutation, not the original
  // observation — the TOCTOU protection this incident's Section 8 requires.
  reobserve: () => TargetCandidate[];
  // Only NAGEX_OWNED_TEST_TARGET may mutate unless the user has explicitly
  // selected this exact target for a real action — modeled as an explicit,
  // separate flag rather than inferred, so silent scope creep is
  // impossible.
  explicitUserSelection?: boolean;
  execute: () => unknown;
}

// The mandatory pre-mutation sequence: resolve exact target -> prove
// unique match -> re-resolve immediately before mutating (TOCTOU) -> verify
// identity is unchanged -> only then execute. Any failed check returns a
// bounded, truthful status instead of a generic FAILED, and the action is
// never attempted.
export function runMutationSafetyGate(input: MutationGateInput): MutationGateOutcome {
  const { boundIdentity, execute } = input;

  if (boundIdentity.ownership === 'USER_EXISTING_TARGET' && input.explicitUserSelection !== true) {
    return { status: 'TARGET_NOT_OWNED' };
  }

  const reobserved = input.reobserve();
  if (reobserved.length !== 1) {
    return { status: 'TARGET_AMBIGUOUS', matchCount: reobserved.length };
  }

  const current = reobserved[0];
  const identityUnchanged =
    current.automationElementRuntimeId === boundIdentity.automationElementRuntimeId &&
    (current.rootWindowRuntimeId ?? undefined) === (boundIdentity.rootWindowRuntimeId ?? undefined);
  if (!identityUnchanged) {
    return { status: 'TARGET_CHANGED_SINCE_OBSERVATION' };
  }

  return { status: 'EXECUTED', result: execute() };
}

export type CloseSafetyOutcome = 'GRACEFUL_CLOSE_ALLOWED' | 'CLOSE_UNSAFE' | 'UNSAVED_STATE_UNKNOWN' | 'TARGET_NOT_OWNED';

export interface CloseSafetyInput {
  target: TargetIdentity;
  // Whether the OS-level process is known to host more than this one
  // logical target (the exact Notepad multi-tab shape). Unknown must be
  // treated as "yes, possibly shared", never assumed false.
  processHostsOtherTargets: boolean | 'UNKNOWN';
  unsavedStateKnown: boolean;
  explicitUserSelection?: boolean;
}

// Force-kill (Stop-Process -Force or equivalent) is never exposed as a
// close mechanism by this module at all -- there is no "force" parameter
// here to opt into. A caller wanting to close a target gets exactly one of
// these four truthful outcomes; GRACEFUL_CLOSE_ALLOWED is the only one
// that may proceed, and only via a target-specific graceful close (e.g. a
// WM_CLOSE/CloseWindowPattern to the exact element), never a process-wide
// kill.
export function evaluateCloseSafety(input: CloseSafetyInput): CloseSafetyOutcome {
  const { target, processHostsOtherTargets, unsavedStateKnown, explicitUserSelection } = input;

  if (target.ownership === 'USER_EXISTING_TARGET' && explicitUserSelection !== true) {
    return 'TARGET_NOT_OWNED';
  }

  if (processHostsOtherTargets !== false) {
    // This module has no window-scoped close primitive to offer here —
    // only the caller's own graceful, target-specific close call (never
    // exposed by this module) may be used, and only once it can prove
    // that call cannot affect sibling targets. Ownership of the target
    // itself does not change this: the exact incident that created this
    // module was a NAgex-initiated action against one tab of a process
    // that, in fact, also hosted the operator's own unrelated tabs.
    return 'CLOSE_UNSAFE';
  }

  if (!unsavedStateKnown) {
    return 'UNSAVED_STATE_UNKNOWN';
  }

  return 'GRACEFUL_CLOSE_ALLOWED';
}
