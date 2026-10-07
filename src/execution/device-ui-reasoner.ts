import { ModelProviderError } from '../model-gateway/model-provider.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import { MOBILE_APP_EXECUTION_POLICIES, type AccessibilityAction, type AccessibilityExecutionPlanInput, type MobileAppId } from './mobile-app-accessibility-execution.js';

export type DeviceUIPlatform = 'ANDROID' | 'WINDOWS' | 'WEB_BROWSER';
export type DeviceUIReasonerProvider = 'DETERMINISTIC' | 'LOCAL' | 'ASTRA' | 'FUTURE_PROVIDER';
export type DeviceUIProposedAction =
  | 'OPEN_APP'
  | 'FIND_ELEMENT'
  | 'SELECT_RECIPIENT'
  | 'OPEN_CHAT'
  | 'FOCUS_INPUT'
  | 'TYPE_APPROVED_TEXT'
  | 'SCROLL_BOUNDED'
  | 'NAVIGATE_BACK'
  | 'REQUEST_SEND'
  | 'OBSERVE_RESULT'
  | 'WAIT';
export type DeviceUIActionGateDecision =
  | 'AUTHORIZED_ACTION'
  | 'BLOCKED'
  | 'REAPPROVAL_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'UI_CONTRACT_MISMATCH'
  | 'REASONER_OUTPUT_INVALID'
  | 'EXECUTION_BUDGET_EXCEEDED'
  | 'USER_INTERRUPTED';

export interface DeviceUINodeProjection {
  nodeRef: string;
  resourceId?: string;
  role?: string;
  contentDescription?: string;
  text?: string;
  clickable: boolean;
  editable: boolean;
  enabled: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  sensitive?: boolean;
}

export interface DeviceUIObservation {
  platform: DeviceUIPlatform;
  deviceRef: string;
  packageName: string;
  appVersion: string;
  screenId?: string;
  foregroundState: 'FOREGROUND' | 'BACKGROUND' | 'UNKNOWN';
  nodes: DeviceUINodeProjection[];
  availableSemanticActions: DeviceUIProposedAction[];
  executionStep: string;
  timestamp: string;
  screenshotRef?: string;
  screenshotAllowed: boolean;
}

export interface DeviceUIExecutionBudget {
  maxSteps: number;
  maxClicks: number;
  maxTextInputs: number;
  maxScrolls: number;
  maxReasonerCalls: number;
  deadlineMs: number;
  usedSteps: number;
  usedClicks: number;
  usedTextInputs: number;
  usedScrolls: number;
  usedReasonerCalls: number;
  startedAtMs: number;
}

export interface DeviceUIReasoningInput {
  requestId: string;
  providerPreference: readonly DeviceUIReasonerProvider[];
  observation: DeviceUIObservation;
  executionGoal: {
    appId: MobileAppId;
    packageName: string;
    deviceId: string;
    recipientRef: string;
    displayName: string;
    approvedMessageHash: string;
    route: 'ANDROID_ACCESSIBILITY';
    approvalId?: string;
  };
  allowedActions: readonly DeviceUIProposedAction[];
  currentPlan: AccessibilityExecutionPlanInput;
  budget: DeviceUIExecutionBudget;
}

export interface DeviceUIActionProposal {
  provider: DeviceUIReasonerProvider;
  model: string;
  action: DeviceUIProposedAction;
  targetNodeRef?: string;
  semanticTarget?: string;
  expectedApp: string;
  expectedScreen?: string;
  confidence: number;
  evidence: string[];
  executionStep: string;
  requiresApproval: boolean;
  reasonCode: string;
}

export interface DeviceUIReasonerUsage {
  provider: DeviceUIReasonerProvider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface DeviceUIReasoner {
  reason(input: DeviceUIReasoningInput): Promise<DeviceUIActionProposal>;
}

export interface DeviceUIActionGateResult {
  decision: DeviceUIActionGateDecision;
  reasonCode: string;
  authorizedAction: AccessibilityAction | null;
}

export const DEVICE_UI_REASONER_ACTIONS: readonly DeviceUIProposedAction[] = [
  'OPEN_APP',
  'FIND_ELEMENT',
  'SELECT_RECIPIENT',
  'OPEN_CHAT',
  'FOCUS_INPUT',
  'TYPE_APPROVED_TEXT',
  'SCROLL_BOUNDED',
  'NAVIGATE_BACK',
  'REQUEST_SEND',
  'OBSERVE_RESULT',
  'WAIT',
] as const;

const PROPOSAL_TO_ACCESSIBILITY_ACTION: Partial<Record<DeviceUIProposedAction, AccessibilityAction>> = {
  OPEN_APP: 'OPEN_APP',
  SELECT_RECIPIENT: 'SELECT_CONTACT',
  OPEN_CHAT: 'OPEN_CHAT',
  FOCUS_INPUT: 'FOCUS_MESSAGE_BOX',
  TYPE_APPROVED_TEXT: 'TYPE_MESSAGE',
  REQUEST_SEND: 'PRESS_SEND',
  OBSERVE_RESULT: 'OBSERVE_RESULT',
  NAVIGATE_BACK: 'BACK',
};

export function isDeviceUIActionProposal(value: unknown): value is DeviceUIActionProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!DEVICE_UI_REASONER_ACTIONS.includes(v.action as DeviceUIProposedAction)) return false;
  if (typeof v.expectedApp !== 'string') return false;
  if (v.expectedScreen !== undefined && typeof v.expectedScreen !== 'string') return false;
  if (v.targetNodeRef !== undefined && typeof v.targetNodeRef !== 'string') return false;
  if (v.semanticTarget !== undefined && typeof v.semanticTarget !== 'string') return false;
  if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) return false;
  if (!Array.isArray(v.evidence) || !v.evidence.every((item) => typeof item === 'string')) return false;
  if (typeof v.executionStep !== 'string') return false;
  if (typeof v.requiresApproval !== 'boolean') return false;
  if (typeof v.reasonCode !== 'string') return false;
  if (v.provider !== 'DETERMINISTIC' && v.provider !== 'LOCAL' && v.provider !== 'ASTRA' && v.provider !== 'FUTURE_PROVIDER') return false;
  if (typeof v.model !== 'string') return false;
  return true;
}

export function redactDeviceUIObservation(observation: DeviceUIObservation): DeviceUIObservation {
  return {
    ...observation,
    screenshotRef: observation.screenshotAllowed ? observation.screenshotRef : undefined,
    nodes: observation.nodes.map((node) => {
      const sensitive = node.sensitive || /password|otp|one.?time|token|secret|bank|payment|card/i.test(`${node.resourceId ?? ''} ${node.contentDescription ?? ''} ${node.text ?? ''}`);
      return {
        nodeRef: node.nodeRef,
        resourceId: node.resourceId,
        role: node.role,
        contentDescription: sensitive ? '[REDACTED]' : node.contentDescription,
        text: sensitive ? '[REDACTED]' : node.text,
        clickable: node.clickable,
        editable: node.editable,
        enabled: node.enabled,
        bounds: node.bounds,
        sensitive,
      };
    }),
  };
}

export function containsSensitiveScreen(observation: DeviceUIObservation): boolean {
  return redactDeviceUIObservation(observation).nodes.some((node) => node.sensitive === true);
}

export function approvedMessageHash(message: string): string {
  return hashCanonicalPayload({ message });
}

export class DeviceUIActionGate {
  public validate(input: DeviceUIReasoningInput, proposal: unknown): DeviceUIActionGateResult {
    if (!isDeviceUIActionProposal(proposal)) return this.result('REASONER_OUTPUT_INVALID', 'REASONER_OUTPUT_INVALID');
    if (containsSensitiveScreen(input.observation)) return this.result('BLOCKED', 'SENSITIVE_SCREEN_REASONING_BLOCKED');
    if (this.budgetExceeded(input.budget, proposal.action)) return this.result('EXECUTION_BUDGET_EXCEEDED', 'EXECUTION_BUDGET_EXCEEDED');
    if (input.currentPlan.userInterrupted) return this.result('USER_INTERRUPTED', 'USER_INTERRUPTED');
    if (proposal.confidence < 0.5) return this.result('BLOCKED', 'LOW_CONFIDENCE');
    if (!input.allowedActions.includes(proposal.action)) return this.result('BLOCKED', 'ACTION_NOT_ALLOWLISTED');
    if (proposal.expectedApp !== input.executionGoal.packageName || input.observation.packageName !== input.executionGoal.packageName) return this.result('BLOCKED', 'WRONG_PACKAGE');
    if (input.currentPlan.deviceId !== input.executionGoal.deviceId || input.currentPlan.deviceId !== input.observation.deviceRef) return this.result('REAPPROVAL_REQUIRED', 'DEVICE_CHANGED_AFTER_APPROVAL');
    if (input.currentPlan.recipientRef !== input.executionGoal.recipientRef || input.currentPlan.observedRecipientName !== input.currentPlan.displayName) return this.result('REAPPROVAL_REQUIRED', 'RECIPIENT_CHANGED_AFTER_APPROVAL');
    if (approvedMessageHash(input.currentPlan.approvedMessage) !== input.executionGoal.approvedMessageHash || input.currentPlan.typedMessage !== input.currentPlan.approvedMessage) return this.result('REAPPROVAL_REQUIRED', 'MESSAGE_CHANGED_AFTER_APPROVAL');
    if (input.currentPlan.approval?.status !== 'APPROVED') return this.result('PERMISSION_REQUIRED', 'APPROVAL_MISSING');
    if (input.currentPlan.approval.canonicalPayload.executionRoute !== input.executionGoal.route) return this.result('REAPPROVAL_REQUIRED', 'ROUTE_CHANGED_AFTER_APPROVAL');
    const policy = MOBILE_APP_EXECUTION_POLICIES.find((item) => item.appId === input.executionGoal.appId);
    const mapped = PROPOSAL_TO_ACCESSIBILITY_ACTION[proposal.action];
    if (!policy || policy.certificationStatus !== 'CERTIFIED' || !mapped || !policy.allowedActions.includes(mapped)) return this.result('BLOCKED', 'ACTION_NOT_ALLOWLISTED');
    if (proposal.action === 'REQUEST_SEND') {
      const approvedHash = input.currentPlan.approval.canonicalPayload.materialPayloadHash;
      const currentHash = hashCanonicalPayload({
        appId: input.currentPlan.appId,
        packageName: input.currentPlan.packageName,
        recipientRef: input.currentPlan.recipientRef,
        displayName: input.currentPlan.displayName,
        messageHash: approvedMessageHash(input.currentPlan.approvedMessage),
        deviceId: input.currentPlan.deviceId,
        executionRoute: 'ANDROID_ACCESSIBILITY',
      });
      if (approvedHash !== currentHash) return this.result('REAPPROVAL_REQUIRED', 'SEND_BOUNDARY_REVALIDATION_FAILED');
    }
    return this.result('AUTHORIZED_ACTION', 'AUTHORIZED_ACTION', mapped);
  }

  private budgetExceeded(budget: DeviceUIExecutionBudget, action: DeviceUIProposedAction): boolean {
    if (Date.now() - budget.startedAtMs > budget.deadlineMs) return true;
    if (budget.usedSteps >= budget.maxSteps || budget.usedReasonerCalls >= budget.maxReasonerCalls) return true;
    if ((action === 'OPEN_APP' || action === 'FIND_ELEMENT' || action === 'SELECT_RECIPIENT' || action === 'REQUEST_SEND') && budget.usedClicks >= budget.maxClicks) return true;
    if (action === 'TYPE_APPROVED_TEXT' && budget.usedTextInputs >= budget.maxTextInputs) return true;
    if (action === 'SCROLL_BOUNDED' && budget.usedScrolls >= budget.maxScrolls) return true;
    return false;
  }

  private result(decision: DeviceUIActionGateDecision, reasonCode: string, authorizedAction: AccessibilityAction | null = null): DeviceUIActionGateResult {
    return { decision, reasonCode, authorizedAction };
  }
}

export class FakeDeviceUIReasoner implements DeviceUIReasoner {
  public readonly calls: DeviceUIReasoningInput[] = [];
  private cursor = 0;

  constructor(private readonly proposals: DeviceUIActionProposal[]) {}

  public async reason(input: DeviceUIReasoningInput): Promise<DeviceUIActionProposal> {
    this.calls.push(input);
    if (this.cursor >= this.proposals.length) {
      throw new ModelProviderError({ provider: 'fake-device-ui-reasoner', code: 'PROVIDER_EMPTY_RESPONSE', message: 'Fake reasoner exhausted.', requestId: input.requestId, retryable: false });
    }
    return this.proposals[this.cursor++];
  }
}

export interface AstraDeviceUIReasonerOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  proposeFn?: (input: DeviceUIReasoningInput) => Promise<unknown>;
}

export class AstraDeviceUIReasoner implements DeviceUIReasoner {
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly proposeFn?: (input: DeviceUIReasoningInput) => Promise<unknown>;
  private lastUsage: DeviceUIReasonerUsage | null = null;

  constructor(options: AstraDeviceUIReasonerOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null;
    this.model = options.model?.trim() || 'gpt-6-astra';
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.proposeFn = options.proposeFn;
  }

  public status(): { configured: boolean; provider: 'openai-astra'; model: string } {
    return { configured: Boolean(this.apiKey || this.proposeFn), provider: 'openai-astra', model: this.model };
  }

  public usage(): DeviceUIReasonerUsage | null {
    return this.lastUsage;
  }

  public async reason(input: DeviceUIReasoningInput): Promise<DeviceUIActionProposal> {
    if (!this.status().configured) {
      throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_NOT_CONFIGURED', message: 'Astra device UI reasoner is not configured.', requestId: input.requestId, retryable: false });
    }
    const minimized = { ...input, observation: redactDeviceUIObservation(input.observation) };
    const startedAt = Date.now();
    const raw = this.proposeFn ? await this.proposeFn(minimized) : await this.callResponsesApi(minimized);
    if (!isDeviceUIActionProposal(raw)) {
      throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_SCHEMA_INVALID', message: 'Astra device UI proposal failed schema validation.', requestId: input.requestId, retryable: false });
    }
    if (!this.lastUsage) {
      this.lastUsage = { provider: 'ASTRA', model: this.model, inputTokens: null, outputTokens: null, latencyMs: Date.now() - startedAt };
    }
    return raw;
  }

  private async callResponsesApi(input: DeviceUIReasoningInput): Promise<unknown> {
    if (!this.apiKey) {
      throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_NOT_CONFIGURED', message: 'Astra device UI reasoner is not configured.', requestId: input.requestId, retryable: false });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetchFn('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          reasoning: { effort: 'low' },
          input: [
            { role: 'system', content: [{ type: 'input_text', text: ASTRA_DEVICE_UI_SYSTEM_PROMPT }] },
            { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(safeReasonerPayload(input)) }] },
          ],
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: 'device_ui_action_proposal',
              strict: true,
              schema: DEVICE_UI_ACTION_PROPOSAL_JSON_SCHEMA,
            },
          },
        }),
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ModelProviderError({ provider: 'openai-astra', code: `PROVIDER_HTTP_${response.status}`, message: `Astra device UI request failed with HTTP ${response.status}.`, requestId: input.requestId, retryable });
      }
      const payload = await response.json();
      const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      this.lastUsage = {
        provider: 'ASTRA',
        model: this.model,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        latencyMs: Date.now() - startedAt,
      };
      return extractDeviceUIProposal(payload, input.requestId);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (controller.signal.aborted) {
        throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_TIMEOUT', message: 'Astra device UI request timed out.', requestId: input.requestId, retryable: true });
      }
      throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_NETWORK_ERROR', message: 'Astra device UI request failed.', requestId: input.requestId, retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }
}

const ASTRA_DEVICE_UI_SYSTEM_PROMPT = `You are a device UI reasoning component inside NAgex. You observe a minimized UI state and propose exactly ONE typed UI action. You never approve, execute, send, change recipients, change messages, change devices, change routes, or bypass NAgex Action Gate. Return only the strict JSON schema.`;

const DEVICE_UI_ACTION_PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string', enum: ['ASTRA'] },
    model: { type: 'string' },
    action: { type: 'string', enum: DEVICE_UI_REASONER_ACTIONS },
    targetNodeRef: { type: ['string', 'null'] },
    semanticTarget: { type: ['string', 'null'] },
    expectedApp: { type: 'string' },
    expectedScreen: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    evidence: { type: 'array', items: { type: 'string' } },
    executionStep: { type: 'string' },
    requiresApproval: { type: 'boolean' },
    reasonCode: { type: 'string' },
  },
  required: ['provider', 'model', 'action', 'targetNodeRef', 'semanticTarget', 'expectedApp', 'expectedScreen', 'confidence', 'evidence', 'executionStep', 'requiresApproval', 'reasonCode'],
  additionalProperties: false,
} as const;

function safeReasonerPayload(input: DeviceUIReasoningInput): Record<string, unknown> {
  return {
    requestId: input.requestId,
    observation: input.observation,
    executionGoal: {
      appId: input.executionGoal.appId,
      packageName: input.executionGoal.packageName,
      deviceId: input.executionGoal.deviceId,
      recipientRef: input.executionGoal.recipientRef,
      displayName: input.executionGoal.displayName,
      approvedMessageHash: input.executionGoal.approvedMessageHash,
      route: input.executionGoal.route,
    },
    allowedActions: input.allowedActions,
    executionStep: input.currentPlan.actions,
    budget: {
      maxReasonerCalls: input.budget.maxReasonerCalls,
      usedReasonerCalls: input.budget.usedReasonerCalls,
      maxSteps: input.budget.maxSteps,
      usedSteps: input.budget.usedSteps,
    },
    privacy: { screenshotDefault: 'OFF', rawMessageProvided: false, secretsProvided: false },
  };
}

function extractDeviceUIProposal(payload: unknown, requestId: string): unknown {
  const p = payload as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }> };
  const messageItems = Array.isArray(p.output) ? p.output.filter((item) => item.type === 'message') : [];
  if (messageItems.length > 1) {
    throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_MULTIPLE_ACTIONS', message: 'Astra returned more than one device UI proposal.', requestId, retryable: false });
  }
  for (const item of messageItems) {
    for (const content of item.content ?? []) {
      if (content.type === 'refusal') {
        throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_REFUSED', message: content.refusal || 'Astra refused to propose a device UI action.', requestId, retryable: false });
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        try {
          const parsed = JSON.parse(content.text);
          if (parsed && typeof parsed === 'object') {
            const v = parsed as Record<string, unknown>;
            return {
              ...v,
              targetNodeRef: v.targetNodeRef === null ? undefined : v.targetNodeRef,
              semanticTarget: v.semanticTarget === null ? undefined : v.semanticTarget,
              expectedScreen: v.expectedScreen === null ? undefined : v.expectedScreen,
            };
          }
          return parsed;
        } catch {
          throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_MALFORMED_RESPONSE', message: 'Astra returned non-JSON device UI output.', requestId, retryable: false });
        }
      }
    }
  }
  throw new ModelProviderError({ provider: 'openai-astra', code: 'PROVIDER_EMPTY_RESPONSE', message: 'Astra returned no device UI proposal.', requestId, retryable: true });
}

export class DeviceUIReasoningCoordinator {
  constructor(private readonly reasoner: DeviceUIReasoner, private readonly gate = new DeviceUIActionGate()) {}

  public async recover(input: DeviceUIReasoningInput): Promise<DeviceUIActionGateResult & { proposal: DeviceUIActionProposal | null; reasonerCalled: boolean }> {
    try {
      const proposal = await this.reasoner.reason({ ...input, observation: redactDeviceUIObservation(input.observation) });
      return { ...this.gate.validate(input, proposal), proposal, reasonerCalled: true };
    } catch (error) {
      if (error instanceof ModelProviderError) return { decision: 'BLOCKED', reasonCode: error.code, authorizedAction: null, proposal: null, reasonerCalled: true };
      return { decision: 'BLOCKED', reasonCode: 'REASONER_FAILED', authorizedAction: null, proposal: null, reasonerCalled: true };
    }
  }
}
