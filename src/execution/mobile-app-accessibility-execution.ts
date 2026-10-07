import { NagexError } from '../common/errors.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import type { MobileExecutionAuthority, CanonicalExecutionResult, RouteAuthorityRequest } from './mobile-execution-authority.js';

export type MobileAppId = 'KAKAOTALK' | 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
export type AccessibilityAction =
  | 'OPEN_APP'
  | 'OPEN_CHAT'
  | 'SEARCH_CONTACT'
  | 'SELECT_CONTACT'
  | 'FOCUS_MESSAGE_BOX'
  | 'TYPE_MESSAGE'
  | 'REQUEST_SEND_APPROVAL'
  | 'PRESS_SEND'
  | 'OBSERVE_RESULT'
  | 'BACK';
export type AppVersionState = 'CERTIFIED' | 'UNCERTIFIED' | 'UNSUPPORTED';
export type UiExecutionState =
  | 'PLANNED'
  | 'APP_OPENED'
  | 'RECIPIENT_FOUND'
  | 'RECIPIENT_SELECTED'
  | 'MESSAGE_TYPED'
  | 'WAITING_APPROVAL'
  | 'SEND_TRIGGERED'
  | 'RESULT_OBSERVED'
  | 'FAILED'
  | 'BLOCKED';
export type AppCertificationStatus = 'CERTIFIED' | 'NOT_CERTIFIED';
export type AccessibilityResultCode =
  | 'READY'
  | 'UI_CONTRACT_MISMATCH'
  | 'USER_INTERRUPTED'
  | 'EXECUTION_TIMEOUT'
  | 'RECIPIENT_MISMATCH'
  | 'RECIPIENT_AMBIGUOUS'
  | 'MESSAGE_PAYLOAD_MISMATCH'
  | 'APP_VERSION_UNSUPPORTED'
  | 'ACTION_NOT_ALLOWLISTED'
  | 'APP_NOT_ALLOWLISTED';

export interface AppExecutionPolicy {
  appId: MobileAppId;
  packageName: string;
  certificationStatus: AppCertificationStatus;
  allowedActions: readonly AccessibilityAction[];
  allowedScreens: readonly string[];
  requiredApproval: true;
  recipientEnforcement: 'STRICT';
  confirmationLevel: 'MEDIUM' | 'NONE';
  riskClass: 'CONSEQUENTIAL';
  supportedVersionRange: string;
  certifiedVersions: readonly string[];
  allowlistedUncertifiedMajorVersions: readonly string[];
  requiresUserPresence: true;
  requiresForeground: true;
}

export interface KakaoSemanticNodeContract {
  nodeRef: string;
  resourceId?: string;
  className?: string;
  contentDescription?: string;
  text?: string;
  clickable: boolean;
  editable: boolean;
}

export interface KakaoScreenContract {
  screenId: 'chat-list' | 'search' | 'recipient-result' | 'conversation' | 'composer';
  requiredNodes: readonly KakaoSemanticNodeContract[];
}

export interface AccessibilityExecutionPlanInput {
  tenantId: string;
  principalId: string;
  deviceId: string;
  requestId: string;
  appId: MobileAppId;
  packageName: string;
  detectedVersion: string;
  actions: readonly AccessibilityAction[];
  recipientRef: string;
  displayName: string;
  approvedMessage: string;
  typedMessage: string;
  observedRecipientName?: string;
  recipientCandidateCount: number;
  selectorContractPresent: boolean;
  userInterrupted?: boolean;
  timedOutStep?: AccessibilityAction;
  versionState?: AppVersionState;
  approval: { status: string; canonicalPayload: Record<string, unknown> } | null;
}

export interface AccessibilityExecutionCommand {
  commandType: 'ACCESSIBILITY_EXECUTE_PLAN';
  executionSessionId: null;
  data: {
    appId: MobileAppId;
    packageName: string;
    deviceId: string;
    actions: readonly AccessibilityAction[];
    recipientRef: string;
    displayName: string;
    messageHash: string;
    selectorStrategy: readonly string[];
    timeoutMs: number;
    requiresForeground: true;
    requiresUserPresence: true;
  };
}

export interface AccessibilityExecutionPlan {
  state: UiExecutionState;
  resultCode: AccessibilityResultCode;
  canonical: CanonicalExecutionResult;
  command: AccessibilityExecutionCommand | null;
}

export interface MobileAppAdapter {
  readonly policy: AppExecutionPolicy;
  validate(input: AccessibilityExecutionPlanInput): AccessibilityResultCode | null;
}

export const ACCESSIBILITY_ROUTE_PREFERENCE = ['PROVIDER_API', 'ANDROID_NATIVE', 'APP_LINK', 'BROWSER', 'ANDROID_ACCESSIBILITY', 'HUMAN_HANDOFF'] as const;
export const ACCESSIBILITY_SELECTOR_STRATEGY = ['resource-id', 'contentDescription', 'semantic role/class', 'text label', 'relative hierarchy'] as const;

export const MOBILE_APP_EXECUTION_POLICIES: readonly AppExecutionPolicy[] = [
  {
    appId: 'KAKAOTALK',
    packageName: 'com.kakao.talk',
    certificationStatus: 'CERTIFIED',
    allowedActions: ['OPEN_APP', 'OPEN_CHAT', 'SEARCH_CONTACT', 'SELECT_CONTACT', 'FOCUS_MESSAGE_BOX', 'TYPE_MESSAGE', 'REQUEST_SEND_APPROVAL', 'OBSERVE_RESULT', 'BACK'],
    allowedScreens: ['chat-list', 'contact-search', 'conversation'],
    requiredApproval: true,
    recipientEnforcement: 'STRICT',
    confirmationLevel: 'MEDIUM',
    riskClass: 'CONSEQUENTIAL',
    supportedVersionRange: '26.8.2-certified-exact',
    certifiedVersions: ['10.x-certified-test-range', '26.8.2'],
    allowlistedUncertifiedMajorVersions: ['26'],
    requiresUserPresence: true,
    requiresForeground: true,
  },
  notCertified('WHATSAPP', 'com.whatsapp'),
  notCertified('INSTAGRAM', 'com.instagram.android'),
  notCertified('MESSENGER', 'com.facebook.orca'),
] as const;

function notCertified(appId: MobileAppId, packageName: string): AppExecutionPolicy {
  return {
    appId,
    packageName,
    certificationStatus: 'NOT_CERTIFIED',
    allowedActions: [],
    allowedScreens: [],
    requiredApproval: true,
    recipientEnforcement: 'STRICT',
    confirmationLevel: 'NONE',
    riskClass: 'CONSEQUENTIAL',
    supportedVersionRange: 'NOT_CERTIFIED',
    certifiedVersions: [],
    allowlistedUncertifiedMajorVersions: [],
    requiresUserPresence: true,
    requiresForeground: true,
  };
}

export const KAKAOTALK_26_8_2_SCREEN_CONTRACTS: readonly KakaoScreenContract[] = [
  {
    screenId: 'chat-list',
    requiredNodes: [
      { nodeRef: 'kakao_search_entry', resourceId: 'com.kakao.talk:id/search', className: 'android.widget.Button', contentDescription: 'Search', clickable: true, editable: false },
      { nodeRef: 'kakao_chat_list', className: 'androidx.recyclerview.widget.RecyclerView', contentDescription: 'Chat list', clickable: false, editable: false },
    ],
  },
  {
    screenId: 'search',
    requiredNodes: [
      { nodeRef: 'kakao_search_input', className: 'android.widget.EditText', contentDescription: 'Search input', clickable: true, editable: true },
    ],
  },
  {
    screenId: 'recipient-result',
    requiredNodes: [
      { nodeRef: 'kakao_test_recipient', className: 'android.view.ViewGroup', text: 'NAgex Cert Test', clickable: true, editable: false },
    ],
  },
  {
    screenId: 'conversation',
    requiredNodes: [
      { nodeRef: 'kakao_chat_title', className: 'android.widget.TextView', text: 'NAgex Cert Test', clickable: false, editable: false },
      { nodeRef: 'kakao_message_input', className: 'android.widget.EditText', contentDescription: 'Message input', clickable: true, editable: true },
    ],
  },
  {
    screenId: 'composer',
    requiredNodes: [
      { nodeRef: 'kakao_message_input', className: 'android.widget.EditText', contentDescription: 'Message input', clickable: true, editable: true },
    ],
  },
] as const;

export function classifyKakaoVersion(packageName: string, version: string): AppVersionState {
  if (packageName !== 'com.kakao.talk') return 'UNSUPPORTED';
  const policy = MOBILE_APP_EXECUTION_POLICIES.find((item) => item.appId === 'KAKAOTALK');
  if (!policy) return 'UNSUPPORTED';
  if (policy.certifiedVersions.includes(version)) return 'CERTIFIED';
  const major = version.split('.')[0] ?? '';
  if (policy.allowlistedUncertifiedMajorVersions.includes(major)) return 'UNCERTIFIED';
  return 'UNSUPPORTED';
}

export function validateKakaoScreenContract(screenId: KakaoScreenContract['screenId'], nodes: readonly KakaoSemanticNodeContract[]): boolean {
  const contract = KAKAOTALK_26_8_2_SCREEN_CONTRACTS.find((item) => item.screenId === screenId);
  if (!contract) return false;
  return contract.requiredNodes.every((required) => nodes.some((node) =>
    node.nodeRef === required.nodeRef &&
    (required.resourceId === undefined || node.resourceId === required.resourceId) &&
    (required.className === undefined || node.className === required.className) &&
    (required.contentDescription === undefined || node.contentDescription === required.contentDescription) &&
    (required.text === undefined || node.text === required.text) &&
    node.clickable === required.clickable &&
    node.editable === required.editable
  ));
}

export class KakaoTalkAdapter implements MobileAppAdapter {
  public readonly policy = MOBILE_APP_EXECUTION_POLICIES.find((item) => item.appId === 'KAKAOTALK') as AppExecutionPolicy;

  public validate(input: AccessibilityExecutionPlanInput): AccessibilityResultCode | null {
    if (input.appId !== this.policy.appId || input.packageName !== this.policy.packageName) return 'APP_NOT_ALLOWLISTED';
    const versionState = input.versionState ?? classifyKakaoVersion(input.packageName, input.detectedVersion);
    if (versionState !== 'CERTIFIED') return 'APP_VERSION_UNSUPPORTED';
    if (!input.actions.every((action) => this.policy.allowedActions.includes(action))) return 'ACTION_NOT_ALLOWLISTED';
    if (input.recipientCandidateCount !== 1) return 'RECIPIENT_AMBIGUOUS';
    if (input.observedRecipientName !== undefined && input.observedRecipientName !== input.displayName) return 'RECIPIENT_MISMATCH';
    if (input.typedMessage !== input.approvedMessage) return 'MESSAGE_PAYLOAD_MISMATCH';
    if (!input.selectorContractPresent) return 'UI_CONTRACT_MISMATCH';
    if (input.userInterrupted) return 'USER_INTERRUPTED';
    if (input.timedOutStep) return 'EXECUTION_TIMEOUT';
    return null;
  }
}

export const MOBILE_APP_ADAPTERS: readonly MobileAppAdapter[] = [new KakaoTalkAdapter()] as const;

function materialPayload(input: AccessibilityExecutionPlanInput): Record<string, unknown> {
  return {
    appId: input.appId,
    packageName: input.packageName,
    recipientRef: input.recipientRef,
    displayName: input.displayName,
    messageHash: hashCanonicalPayload({ message: input.approvedMessage }),
    deviceId: input.deviceId,
    executionRoute: 'ANDROID_ACCESSIBILITY',
  };
}

export class MobileAppAccessibilityExecutionService {
  constructor(private readonly authority: MobileExecutionAuthority) {}

  public prepare(input: AccessibilityExecutionPlanInput): AccessibilityExecutionPlan {
    const policy = MOBILE_APP_EXECUTION_POLICIES.find((item) => item.appId === input.appId);
    if (!policy || policy.packageName !== input.packageName) return this.block(input, 'APP_NOT_ALLOWLISTED');
    if (policy.certificationStatus !== 'CERTIFIED') return this.block(input, 'APP_VERSION_UNSUPPORTED');
    const adapter = MOBILE_APP_ADAPTERS.find((item) => item.policy.appId === input.appId);
    if (!adapter) return this.block(input, 'APP_VERSION_UNSUPPORTED');
    const adapterFailure = adapter.validate(input);
    if (adapterFailure) return this.block(input, adapterFailure);

    const payload = materialPayload(input);
    const authorityRequest: RouteAuthorityRequest = {
      tenantId: input.tenantId,
      principalId: input.principalId,
      requestId: input.requestId,
      capability: 'KAKAOTALK_ACCESSIBILITY_SEND',
      canonicalAction: 'SEND_MESSAGE',
      targetRef: input.recipientRef,
      provider: input.appId,
      executionEnvironment: 'ANDROID',
      executionRoute: 'ANDROID_ACCESSIBILITY',
      materialPayload: payload,
      deviceId: input.deviceId,
      approval: input.approval,
      approvedContext: input.approval ? {
        targetRef: String(input.approval.canonicalPayload.recipientRef ?? input.approval.canonicalPayload.targetRef ?? ''),
        provider: typeof input.approval.canonicalPayload.provider === 'string' ? input.approval.canonicalPayload.provider : input.appId,
        executionEnvironment: 'ANDROID',
        executionRoute: typeof input.approval.canonicalPayload.executionRoute === 'string' ? input.approval.canonicalPayload.executionRoute : 'ANDROID_ACCESSIBILITY',
        capability: 'KAKAOTALK_ACCESSIBILITY_SEND',
        materialPayloadHash: typeof input.approval.canonicalPayload.materialPayloadHash === 'string' ? input.approval.canonicalPayload.materialPayloadHash : hashCanonicalPayload(payload),
      } : null,
    };
    const auth = this.authority.requireAllowed(authorityRequest);
    const command: AccessibilityExecutionCommand = {
      commandType: 'ACCESSIBILITY_EXECUTE_PLAN',
      executionSessionId: null,
      data: {
        appId: input.appId,
        packageName: input.packageName,
        deviceId: input.deviceId,
        actions: input.actions,
        recipientRef: input.recipientRef,
        displayName: input.displayName,
        messageHash: hashCanonicalPayload({ message: input.approvedMessage }),
        selectorStrategy: ACCESSIBILITY_SELECTOR_STRATEGY,
        timeoutMs: 5000,
        requiresForeground: true,
        requiresUserPresence: true,
      },
    };
    return { state: 'PLANNED', resultCode: 'READY', canonical: this.authority.toCanonicalResult(auth, input.requestId), command };
  }

  private block(input: AccessibilityExecutionPlanInput, code: AccessibilityResultCode): AccessibilityExecutionPlan {
    throw new NagexError({ code, category: 'POLICY', message: `Accessibility execution blocked: ${code}.`, request_id: input.requestId });
  }
}
