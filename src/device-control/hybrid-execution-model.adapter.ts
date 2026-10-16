// Which planner reads this screen? Semantic first, pixels only when they are needed.
//
//   1. the DOM / accessibility planner (GatewayExecutionModelAdapter) whenever the page offers structure to act on;
//   2. the vision planner (Astra, a screenshot-reading model) when the page has NO actionable structure (a canvas, an image-only UI) or the DOM planner is unavailable for this step.
//
// Both only PROPOSE. Neither gains any authority from being chosen: the same loop, the same domain allow-list, the same approvals and the same limits apply to whatever either of them says.
// Switching to the vision planner sends a screenshot to a different provider than the text planner uses, so it is never silent: `onFallback` is called (and audited by the composition root) every time.
import type { ProposedDeviceAction } from './device-action.types.js';
import type { ProposeNextActionInput, VisualExecutionModelPort } from './visual-execution-model.port.js';

export interface HybridPlannerOptions {
  dom?: VisualExecutionModelPort | null;
  vision?: VisualExecutionModelPort | null;
  /** called whenever the vision planner is used instead of the DOM planner, with why */
  onFallback?: (event: { reason: 'NO_ACTIONABLE_STRUCTURE' | 'DOM_PLANNER_FAILED' | 'DOM_PLANNER_UNAVAILABLE'; requestId: string; tenantId: string; ownerId: string; detail?: string }) => void;
}

export class HybridExecutionModelAdapter implements VisualExecutionModelPort {
  constructor(private readonly options: HybridPlannerOptions) {}

  public status(): { configured: boolean; dom: boolean; vision: boolean } {
    return { configured: Boolean(this.options.dom || this.options.vision), dom: Boolean(this.options.dom), vision: Boolean(this.options.vision) };
  }

  public async proposeNextAction(input: ProposeNextActionInput): Promise<ProposedDeviceAction> {
    const { dom, vision } = this.options;
    const snap = input.structuredSnapshot;
    const actionable = (snap.interactive?.length ?? 0) + snap.buttons.length + snap.links.length + snap.inputs.length;

    if (dom && (actionable > 0 || !vision)) {
      try {
        return await dom.proposeNextAction(input);
      } catch (error) {
        if (!vision || !input.screenshotRef) throw error;
        this.options.onFallback?.({ reason: 'DOM_PLANNER_FAILED', requestId: input.requestId, tenantId: input.tenantId, ownerId: input.ownerId, detail: error instanceof Error ? error.message.slice(0, 160) : 'unknown' });
        return vision.proposeNextAction(input);
      }
    }
    if (vision) {
      this.options.onFallback?.({ reason: dom ? 'NO_ACTIONABLE_STRUCTURE' : 'DOM_PLANNER_UNAVAILABLE', requestId: input.requestId, tenantId: input.tenantId, ownerId: input.ownerId });
      return vision.proposeNextAction(input);
    }
    throw new Error('No execution planner is available.');
  }
}
