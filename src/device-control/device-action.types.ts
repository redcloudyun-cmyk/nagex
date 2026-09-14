// DC1 — Device Control Foundation, Section 7 (Action Proposal Shape).
//
// One proposed action per model turn — the model never executes anything
// itself, only proposes. Malformed/unknown shapes must fail closed (never
// guessed into a "best effort" action).
import type { CapabilityRisk } from '../capabilities/capability.types.js';

// Deliberately the exact primitive set DC1 actually wires end to end
// (Section 8 — reuse existing + keypress only). STOP is the model's own
// signal that the goal is satisfied or unreachable; it executes nothing.
export type DeviceActionType = 'OBSERVE' | 'NAVIGATE' | 'CLICK' | 'TYPE' | 'SCROLL' | 'KEYPRESS' | 'STOP';

const DEVICE_ACTION_TYPES: ReadonlySet<string> = new Set<DeviceActionType>([
  'OBSERVE', 'NAVIGATE', 'CLICK', 'TYPE', 'SCROLL', 'KEYPRESS', 'STOP',
]);

export interface ProposedDeviceActionTarget {
  selector?: string;
  description?: string;
}

// riskHint is the model's own advisory guess — NAgex's own policy mapping
// (device-action-policy.ts) is authoritative and never simply trusts it.
export interface ProposedDeviceAction {
  action: DeviceActionType;
  target?: ProposedDeviceActionTarget;
  value?: string | null;
  expectedResult?: string;
  riskHint?: CapabilityRisk;
}

const VALID_RISK_HINTS: ReadonlySet<string> = new Set<CapabilityRisk>(['READ_ONLY', 'LOW', 'CONSEQUENTIAL', 'RESTRICTED', 'DYNAMIC']);

// Structural validation only — deliberately does not check that a
// `selector` actually resolves on the live page (that happens naturally
// when the primitive executor tries to act on it) or that riskHint is
// "correct" (it's advisory, never authoritative — see Section 10). A
// proposal that fails this check must fail the whole step closed, never
// be coerced into a best-effort guess.
export function isProposedDeviceAction(value: unknown): value is ProposedDeviceAction {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.action !== 'string' || !DEVICE_ACTION_TYPES.has(v.action)) return false;
  if (v.target !== undefined) {
    if (!v.target || typeof v.target !== 'object') return false;
    const t = v.target as Record<string, unknown>;
    if (t.selector !== undefined && typeof t.selector !== 'string') return false;
    if (t.description !== undefined && typeof t.description !== 'string') return false;
  }
  if (v.value !== undefined && v.value !== null && typeof v.value !== 'string') return false;
  if (v.expectedResult !== undefined && typeof v.expectedResult !== 'string') return false;
  if (v.riskHint !== undefined && (typeof v.riskHint !== 'string' || !VALID_RISK_HINTS.has(v.riskHint))) return false;

  // Actions that act on the page must name a selector — a CLICK/TYPE/
  // SCROLL/KEYPRESS with no target is malformed, not "act on nothing".
  if (['CLICK', 'TYPE'].includes(v.action) && !(v.target as ProposedDeviceActionTarget | undefined)?.selector) return false;
  // NAVIGATE must carry its destination in `value` (the URL) — reusing
  // `value` rather than inventing a second field, mirroring how TYPE
  // reuses `value` for the text to enter.
  if (v.action === 'NAVIGATE' && typeof v.value !== 'string') return false;
  // TYPE must carry the text to enter, even if it's an empty string —
  // `undefined`/missing is malformed, not "type nothing".
  if (v.action === 'TYPE' && typeof v.value !== 'string') return false;
  // SCROLL reuses `value` for direction (mirrors how NAVIGATE/TYPE reuse
  // `value` for their own single piece of required data) — must be exactly
  // "up" or "down", never guessed.
  if (v.action === 'SCROLL' && v.value !== 'up' && v.value !== 'down') return false;
  // KEYPRESS reuses `value` for the key name (e.g. "Enter", "Tab",
  // "Escape") — a non-empty string, matching Playwright's own key-name
  // vocabulary at the runtime layer.
  if (v.action === 'KEYPRESS' && (typeof v.value !== 'string' || v.value.length === 0)) return false;

  return true;
}
