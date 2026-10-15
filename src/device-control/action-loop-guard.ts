// The Agent loop used to stop for exactly two reasons: a step budget and a time budget. An Agent that proposed the same useless click again and again therefore burned the whole budget (20 steps in
// the measured scenario) before anyone was told, and the only thing the person was ever told was "max steps exceeded". This guard recognises the loop itself, early, with a reason a person can
// read - and it does so on evidence, not on suspicion: a repeat is only a loop when the PAGE was in the same state each time, so paginating ("Next", "Next", "Next"), adding several items or
// scrolling through a growing list never trips it.
//   loop  =  the same action on the same target with the same value, taken when the page showed the same content, at least `threshold` times within the last `window` steps,
//            none of which was VERIFIED as having achieved something.
// It never raises an authority, never retries anything and never keeps an action alive: its only power is to stop the session and say why.
import crypto from 'node:crypto';
import type { BrowserActionOutcome, VerificationBasis } from '../modules/browser/index.js';
import type { ProposedDeviceAction } from './device-action.types.js';

export interface StepEvidence {
  action: ProposedDeviceAction['action'];
  signature: string;
  /** what the page looked like when the action was proposed */
  stateKey: string;
  /** NONE = nothing was observed for this kind of action (scroll, key press, observe) */
  outcome: BrowserActionOutcome | 'NONE';
  basis: VerificationBasis[];
  /** the action can change the world (a click, text typed into a field) as opposed to looking or moving around */
  mutating: boolean;
}

export const LOOP_WINDOW = 12;
export const LOOP_THRESHOLD = 3;

export function actionSignature(action: ProposedDeviceAction): string {
  return `${action.action}|${action.target?.selector ?? ''}|${action.value ?? ''}`;
}

/** A short fingerprint of what the observation showed: address, title, visible text and what could be clicked. Two equal keys mean "the page looked the same". */
export function snapshotStateKey(snapshot: { url: string; title: string; text: string; links: unknown[]; buttons: unknown[]; inputs: unknown[]; interactive?: unknown[] }): string {
  const material = [snapshot.url, snapshot.title, snapshot.text.slice(0, 4000), snapshot.links.length, snapshot.buttons.length, snapshot.inputs.length, snapshot.interactive ? snapshot.interactive.length : -1].join('\u0001');
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 16);
}

export interface LoopVerdict {
  loop: boolean;
  /** how many times this exact action was taken in this exact page state within the window (including the one just recorded) */
  repeats: number;
}

export class ActionLoopGuard {
  private readonly steps: StepEvidence[] = [];

  constructor(private readonly window: number = LOOP_WINDOW, private readonly threshold: number = LOOP_THRESHOLD) {}

  public record(step: StepEvidence): LoopVerdict {
    this.steps.push(step);
    if (this.steps.length > this.window) this.steps.shift();
    const same = this.steps.filter((s) => s.signature === step.signature && s.stateKey === step.stateKey);
    const progressed = same.some((s) => s.outcome === 'VERIFIED');
    return { loop: same.length >= this.threshold && !progressed, repeats: same.length };
  }

  public get recorded(): readonly StepEvidence[] {
    return this.steps;
  }
}

export type CompletionOutcome = BrowserActionOutcome;

export interface CompletionVerdict {
  /** VERIFIED only when the last action that could change anything was verified; FAILED when the page contradicts "done" */
  outcome: CompletionOutcome;
  basis: VerificationBasis[] | 'NO_ACTION_TAKEN'[];
  verifiedActions: number;
  unverifiedActions: number;
  failedActions: number;
}

/**
 * The model said STOP ("done"). Whether the task was done is not the model's word: it is the evidence of the actions that could change something.
 *   - no such action at all                       -> NOT_VERIFIED (it only looked)
 *   - the last one FAILED (error / validation)   -> FAILED (the page contradicts "done")
 *   - the last one VERIFIED                       -> VERIFIED
 *   - otherwise                                   -> NOT_VERIFIED
 */
export function summarizeCompletion(evidence: readonly StepEvidence[]): CompletionVerdict {
  const mutating = evidence.filter((e) => e.mutating);
  const last = mutating[mutating.length - 1];
  const counts = {
    verifiedActions: mutating.filter((e) => e.outcome === 'VERIFIED').length,
    unverifiedActions: mutating.filter((e) => e.outcome === 'NOT_VERIFIED' || e.outcome === 'NONE').length,
    failedActions: mutating.filter((e) => e.outcome === 'FAILED').length,
  };
  if (!last) return { outcome: 'NOT_VERIFIED', basis: ['NO_ACTION_TAKEN'], ...counts };
  if (last.outcome === 'FAILED') return { outcome: 'FAILED', basis: last.basis, ...counts };
  if (last.outcome === 'VERIFIED') return { outcome: 'VERIFIED', basis: last.basis, ...counts };
  if (last.outcome === 'USER_ACTION_REQUIRED') return { outcome: 'USER_ACTION_REQUIRED', basis: last.basis, ...counts };
  return { outcome: 'NOT_VERIFIED', basis: last.basis.length > 0 ? last.basis : ['NO_OBSERVABLE_CHANGE'], ...counts };
}
