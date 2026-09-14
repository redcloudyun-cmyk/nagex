// DC1-5 — deterministic fake VisualExecutionModelPort adapter.
//
// Mandatory per this directive's Section 6: the whole observe → propose →
// policy → execute → observe → verify → stop loop must be proven against
// a deterministic adapter BEFORE any real (Astra or otherwise) provider is
// connected — a real provider must never be used to paper over an
// orchestration defect. This adapter is a plain scripted queue: given a
// fixed list of actions up front, it returns them one at a time, in
// order — no model call, no randomness, no hidden state beyond position.
import type { ProposedDeviceAction } from './device-action.types.js';
import type { ProposeNextActionInput, VisualExecutionModelPort } from './visual-execution-model.port.js';

export class FakeVisualExecutionModelAdapter implements VisualExecutionModelPort {
  private cursor = 0;
  public readonly calls: ProposeNextActionInput[] = [];

  constructor(private readonly script: ProposedDeviceAction[]) {}

  public async proposeNextAction(input: ProposeNextActionInput): Promise<ProposedDeviceAction> {
    this.calls.push(input);
    if (this.cursor >= this.script.length) {
      // Exhausting the script is a test-harness authoring error, not a
      // real "the model had nothing to say" case — fail loudly rather
      // than silently defaulting to STOP, which would hide the mistake.
      throw new Error(`FakeVisualExecutionModelAdapter script exhausted after ${this.script.length} actions`);
    }
    return this.script[this.cursor++];
  }
}
