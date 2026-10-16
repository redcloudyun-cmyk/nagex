import type { ResolvedPlan } from './plan-resolver.js';

// Which reviewed plans may be offered a "request approval to run" from Home? The smallest slice that can be done honestly with the EXISTING approval machinery:
// exactly ONE step, whose tool is approval-gated by the CapabilityBroker's own native approval continuation (calendar / mail writes, user-registered MCP tools), is
// available for this person, and has concrete arguments. Everything else stays a plan preview, with the reason said plainly:
//   * a step that needs no approval (a read) would be dispatched the moment it runs - Home never dispatches anything before a concrete human approval;
//   * several steps would need a durable multi-step approval chain the person cannot review as one decision;
//   * a blocked / unavailable / unresolved tool cannot run at all.
// This is advice for the screen AND re-checked by the server when the person asks to run; the broker and the approval store still decide.
export type RunnableReason =
  | 'PLAN_NOT_SINGLE_STEP'
  | 'STEP_NOT_APPROVAL_GATED'
  | 'TOOL_NOT_SUPPORTED_FROM_HOME'
  | 'TOOL_UNAVAILABLE'
  | 'ARGUMENTS_MISSING'
  | 'PLAN_BLOCKED';

export interface RunnableAssessment {
  ok: boolean;
  reasons: RunnableReason[];
  capabilityId: string | null;
  stepNumber: number | null;
}

export const HOME_RUNNABLE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'google_calendar.create_event',
  'google_calendar.update_event',
  'google_calendar.cancel_event',
  'google_calendar.respond_to_event',
  'gmail.send_email',
  'gmail.reply',
  'gmail.create_draft',
  'vault.save_note',
]);

export function isHomeRunnableTool(toolId: string | null | undefined): boolean {
  return typeof toolId === 'string' && (HOME_RUNNABLE_NATIVE_TOOLS.has(toolId) || /^mcp\.[^.\s]+\.[^\s]+$/.test(toolId));
}

export function assessReviewedPlan(resolved: ResolvedPlan): RunnableAssessment {
  const reasons: RunnableReason[] = [];
  const steps = resolved.steps;
  if (steps.length !== 1) reasons.push('PLAN_NOT_SINGLE_STEP');
  const step = steps[0];
  if (step) {
    if (step.executionReadiness === 'BLOCKED') reasons.push(step.toolAvailability === 'UNAVAILABLE' || step.toolAvailability === 'MOCK_ONLY' ? 'TOOL_UNAVAILABLE' : 'PLAN_BLOCKED');
    else if (step.executionReadiness !== 'APPROVAL_REQUIRED') reasons.push('STEP_NOT_APPROVAL_GATED');
    if (step.executionReadiness !== 'BLOCKED' && !isHomeRunnableTool(step.resolvedToolId)) reasons.push('TOOL_NOT_SUPPORTED_FROM_HOME');
    const parameters = step.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length === 0) reasons.push('ARGUMENTS_MISSING');
  }
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0 && Boolean(step), reasons: unique, capabilityId: step?.resolvedToolId ?? null, stepNumber: step?.step ?? null };
}

// A preview of the arguments the person is about to approve: short, flat, with anything credential-like removed. Never the model's reasoning, never a secret.
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|bearer)/i;
// A time change is read as "this event, now at X, will be at Y": the event's own title, what it is now, what it becomes, the timezone - never the provider's event id.
function previewCalendarUpdate(parameters: Record<string, unknown>): Array<{ name: string; value: string }> {
  const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  const before = parameters.before && typeof parameters.before === 'object' && !Array.isArray(parameters.before) ? (parameters.before as Record<string, unknown>) : null;
  const out: Array<{ name: string; value: string }> = [];
  if (before && text(before.summary)) out.push({ name: 'event', value: text(before.summary) });
  if (before && text(before.start)) out.push({ name: 'beforeStart', value: text(before.start) });
  if (before && text(before.end)) out.push({ name: 'beforeEnd', value: text(before.end) });
  for (const name of ['summary', 'description', 'start', 'end', 'timezone', 'calendarId']) if (text(parameters[name])) out.push({ name, value: text(parameters[name]) });
  if (Array.isArray(parameters.attendees)) out.push({ name: 'attendees', value: JSON.stringify(parameters.attendees).slice(0, 160) });
  return out;
}

export function previewArguments(parameters: unknown, toolId?: string | null): Array<{ name: string; value: string }> {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return [];
  if (toolId === 'google_calendar.update_event') return previewCalendarUpdate(parameters as Record<string, unknown>);
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(parameters as Record<string, unknown>).slice(0, 12)) {
    if (SECRET_KEY.test(name)) { out.push({ name, value: '[hidden]' }); continue; }
    // a Vault draft is approved as the EXACT text that will be stored: shown whole (bounded by the draft limits), line breaks kept - never shortened to a snippet
    if (toolId === 'vault.save_note' && name === 'content' && typeof value === 'string') { out.push({ name, value: value.slice(0, 20000) }); continue; }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    out.push({ name, value: (text ?? '').replace(/\s+/g, ' ').slice(0, 160) });
  }
  return out;
}

// The CapabilityBroker's MCP path takes `{ arguments: {...} }` (the shape of the MCP tools/call request). A plan step names the tool's arguments as a flat object, which is what the
// person reviews and approves; the wrapper only changes the envelope, never the values.
export function executionParameters(toolId: string | null | undefined, parameters: unknown): Record<string, unknown> {
  const flat = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? (parameters as Record<string, unknown>) : {};
  if (typeof toolId === 'string' && /^mcp\./.test(toolId)) {
    const keys = Object.keys(flat);
    if (keys.length === 1 && keys[0] === 'arguments' && flat.arguments && typeof flat.arguments === 'object' && !Array.isArray(flat.arguments)) return flat;
    return { arguments: flat };
  }
  return flat;
}

export function previewableArguments(toolId: string | null | undefined, parameters: unknown): Record<string, unknown> {
  const exec = executionParameters(toolId, parameters);
  return typeof toolId === 'string' && /^mcp\./.test(toolId) ? (exec.arguments as Record<string, unknown>) : exec;
}
