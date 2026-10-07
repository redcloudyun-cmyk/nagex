import { NagexError } from '../common/errors.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import type { DeviceConnectionStatusRecord, DeviceConnectionStatusStore } from '../device-agent/device-connection-status.store.js';
import type { DeviceIdentityRecord, DeviceIdentityStore } from '../device-agent/device-identity.store.js';

export type DeviceCapabilityKind =
  | 'VOICE_CAPTURE'
  | 'CONTACT_READ'
  | 'SMS_SEND'
  | 'NOTIFICATION_POST'
  | 'DEEP_LINK_OPEN'
  | 'BROWSER_EXECUTION'
  | 'GMAIL_SEND'
  | 'CALENDAR_WRITE'
  | 'TELEGRAM_SELF_DELIVERY'
  | 'SLACK_SELF_DELIVERY'
  | 'KAKAOTALK_HANDOFF'
  | 'KAKAOTALK_ACCESSIBILITY_SEND'
  | 'ANDROID_UI_AUTOMATION'
  | 'PHONE_CALL'
  | 'PAYMENT';

export type DevicePlatform = 'ANDROID' | 'SERVER' | 'BROWSER' | 'CHANNEL';
export type DeviceCapabilityStatus = 'AVAILABLE' | 'PERMISSION_REQUIRED' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'BLOCKED';
export type PermissionState = 'GRANTED' | 'DENIED' | 'NOT_REQUESTED' | 'REVOKED' | 'UNAVAILABLE' | 'ENABLED' | 'DISABLED';
export type PermissionSource = 'ANDROID_RUNTIME' | 'PROVIDER_OAUTH' | 'CHANNEL_OWNERSHIP' | 'NAGEX_POLICY';
export type CanonicalExecutionRoute = 'PROVIDER_API' | 'ANDROID_NATIVE' | 'APP_LINK' | 'BROWSER' | 'ANDROID_ACCESSIBILITY' | 'HUMAN_HANDOFF' | 'UNSUPPORTED_FUTURE';
export type AuthorityDisposition = 'ALLOW' | 'APPROVAL_REQUIRED' | 'REAPPROVAL_REQUIRED' | 'PERMISSION_REQUIRED' | 'BLOCKED' | 'UNSUPPORTED';
export type ConfirmationStrength = 'NONE' | 'HANDOFF_STARTED' | 'PROVIDER_ACCEPTED' | 'DEVICE_SEND_CALLBACK' | 'DELIVERY_CONFIRMED' | 'OBSERVED_BROWSER_STATE';
export type CanonicalConfirmationStrength = 'STRONG' | 'MEDIUM' | 'WEAK' | 'NONE';
export type CanonicalExecutionResultStatus =
  | 'EXECUTED_CONFIRMED'
  | 'EXECUTED_UNCONFIRMED'
  | 'HANDOFF_STARTED'
  | 'REAPPROVAL_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'BLOCKED'
  | 'FAILED';

export type RouteAuthorityReasonCode =
  | 'CAPABILITY_UNSUPPORTED'
  | 'DEVICE_UNAVAILABLE'
  | 'PERMISSION_NOT_GRANTED'
  | 'PROVIDER_DISCONNECTED'
  | 'RECIPIENT_UNENFORCEABLE'
  | 'APPROVAL_MISSING'
  | 'APPROVAL_SCOPE_MISMATCH'
  | 'ROUTE_CHANGED_AFTER_APPROVAL'
  | 'ACCOUNT_CHANGED_AFTER_APPROVAL'
  | 'TARGET_CHANGED_AFTER_APPROVAL'
  | 'PAYLOAD_CHANGED_AFTER_APPROVAL'
  | 'ROUTE_UNCONFIRMABLE'
  | 'MANUAL_HANDOFF_ONLY'
  | 'ACCESSIBILITY_NOT_ENABLED'
  | 'STALE_PERMISSION_GRANT'
  | 'CROSS_TENANT_DEVICE'
  | 'CROSS_USER_DEVICE';

export interface PermissionRecord {
  capability: DeviceCapabilityKind;
  deviceId?: string;
  principalId: string;
  tenantId: string;
  platform: DevicePlatform;
  permissionState: PermissionState;
  observedAt: string;
  source: PermissionSource;
}

export interface DeviceCapability {
  id: string;
  kind: DeviceCapabilityKind;
  platform: DevicePlatform;
  status: DeviceCapabilityStatus;
  permissionRequirement: PermissionRecord | null;
  availableRoutes: CanonicalExecutionRoute[];
  riskClass: 'READ_ONLY' | 'LOW' | 'CONSEQUENTIAL' | 'RESTRICTED';
  requiresUserPresence: boolean;
  supportsConfirmation: ConfirmationStrength;
}

export interface AndroidCapabilityReport {
  platform: 'ANDROID';
  appVersion: string;
  deviceId: string;
  tenantId: string;
  principalId: string;
  deviceStatus: DeviceIdentityRecord['status'];
  connectionState: DeviceConnectionStatusRecord['connectionState'] | 'UNKNOWN';
  supportedCapabilities: DeviceCapabilityKind[];
  permissions: PermissionRecord[];
  routeAvailability: Record<string, DeviceCapabilityStatus>;
}

export interface RouteCandidate {
  route: CanonicalExecutionRoute;
  capability: DeviceCapabilityKind;
  availability: DeviceCapabilityStatus;
  permissionState: PermissionState;
  approvalRequired: boolean;
  confirmationStrength: ConfirmationStrength;
  reasonCodes: RouteAuthorityReasonCode[];
}

export interface ApprovalBoundExecutionContext {
  canonicalAction: string;
  targetRef?: string;
  accountRef?: string;
  provider: string;
  executionEnvironment: string;
  executionRoute: string;
  capability: DeviceCapabilityKind;
  materialPayloadHash?: string;
}

export interface RouteAuthorityRequest {
  tenantId: string;
  principalId: string;
  requestId: string;
  capability: DeviceCapabilityKind;
  canonicalAction: string;
  targetRef?: string;
  accountRef?: string;
  provider: string;
  executionEnvironment: string;
  executionRoute: string;
  materialPayload?: Record<string, unknown>;
  deviceId?: string;
  approval?: { status: string; canonicalPayload: Record<string, unknown> } | null;
  approvedContext?: Partial<ApprovalBoundExecutionContext> | null;
  providerConnected?: boolean;
  channelOwnershipVerified?: boolean;
}

export interface RouteAuthorityResult {
  disposition: AuthorityDisposition;
  capability: DeviceCapabilityKind;
  selectedRoute: CanonicalExecutionRoute | null;
  candidates: RouteCandidate[];
  reasonCodes: RouteAuthorityReasonCode[];
  approvalRequired: boolean;
  confirmationStrength: ConfirmationStrength;
}

export interface CanonicalExecutionResult {
  status: CanonicalExecutionResultStatus;
  capability: DeviceCapabilityKind;
  route: CanonicalExecutionRoute | null;
  confirmationStrength: CanonicalConfirmationStrength;
  reasonCodes: RouteAuthorityReasonCode[];
  externalRef?: string;
}

interface CapabilityDefinition {
  platform: DevicePlatform;
  route: CanonicalExecutionRoute;
  permissionSource: PermissionSource;
  approvalRequired: boolean;
  confirmationStrength: ConfirmationStrength;
  requiresDevice: boolean;
  requiresProviderConnection: boolean;
  recipientEnforced: boolean;
  statusWhenSupported: DeviceCapabilityStatus;
  manualHandoffOnly?: boolean;
  accessibilityRequired?: boolean;
}

const CAPABILITY_DEFINITIONS: Record<DeviceCapabilityKind, CapabilityDefinition> = {
  VOICE_CAPTURE: { platform: 'ANDROID', route: 'ANDROID_NATIVE', permissionSource: 'ANDROID_RUNTIME', approvalRequired: false, confirmationStrength: 'NONE', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  CONTACT_READ: { platform: 'ANDROID', route: 'ANDROID_NATIVE', permissionSource: 'ANDROID_RUNTIME', approvalRequired: false, confirmationStrength: 'NONE', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  SMS_SEND: { platform: 'ANDROID', route: 'ANDROID_NATIVE', permissionSource: 'ANDROID_RUNTIME', approvalRequired: true, confirmationStrength: 'DEVICE_SEND_CALLBACK', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  NOTIFICATION_POST: { platform: 'ANDROID', route: 'ANDROID_NATIVE', permissionSource: 'ANDROID_RUNTIME', approvalRequired: false, confirmationStrength: 'NONE', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  DEEP_LINK_OPEN: { platform: 'ANDROID', route: 'APP_LINK', permissionSource: 'NAGEX_POLICY', approvalRequired: true, confirmationStrength: 'HANDOFF_STARTED', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: false, statusWhenSupported: 'AVAILABLE' },
  BROWSER_EXECUTION: { platform: 'BROWSER', route: 'BROWSER', permissionSource: 'NAGEX_POLICY', approvalRequired: true, confirmationStrength: 'OBSERVED_BROWSER_STATE', requiresDevice: false, requiresProviderConnection: true, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  GMAIL_SEND: { platform: 'SERVER', route: 'PROVIDER_API', permissionSource: 'PROVIDER_OAUTH', approvalRequired: true, confirmationStrength: 'PROVIDER_ACCEPTED', requiresDevice: false, requiresProviderConnection: true, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  CALENDAR_WRITE: { platform: 'SERVER', route: 'PROVIDER_API', permissionSource: 'PROVIDER_OAUTH', approvalRequired: true, confirmationStrength: 'PROVIDER_ACCEPTED', requiresDevice: false, requiresProviderConnection: true, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  TELEGRAM_SELF_DELIVERY: { platform: 'CHANNEL', route: 'PROVIDER_API', permissionSource: 'CHANNEL_OWNERSHIP', approvalRequired: true, confirmationStrength: 'PROVIDER_ACCEPTED', requiresDevice: false, requiresProviderConnection: true, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  SLACK_SELF_DELIVERY: { platform: 'CHANNEL', route: 'PROVIDER_API', permissionSource: 'CHANNEL_OWNERSHIP', approvalRequired: true, confirmationStrength: 'PROVIDER_ACCEPTED', requiresDevice: false, requiresProviderConnection: true, recipientEnforced: true, statusWhenSupported: 'AVAILABLE' },
  KAKAOTALK_HANDOFF: { platform: 'ANDROID', route: 'HUMAN_HANDOFF', permissionSource: 'NAGEX_POLICY', approvalRequired: true, confirmationStrength: 'HANDOFF_STARTED', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: false, statusWhenSupported: 'AVAILABLE', manualHandoffOnly: true },
  KAKAOTALK_ACCESSIBILITY_SEND: { platform: 'ANDROID', route: 'ANDROID_ACCESSIBILITY', permissionSource: 'ANDROID_RUNTIME', approvalRequired: true, confirmationStrength: 'OBSERVED_BROWSER_STATE', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: true, statusWhenSupported: 'AVAILABLE', accessibilityRequired: true },
  ANDROID_UI_AUTOMATION: { platform: 'ANDROID', route: 'UNSUPPORTED_FUTURE', permissionSource: 'ANDROID_RUNTIME', approvalRequired: true, confirmationStrength: 'NONE', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: false, statusWhenSupported: 'UNSUPPORTED' },
  PHONE_CALL: { platform: 'ANDROID', route: 'UNSUPPORTED_FUTURE', permissionSource: 'ANDROID_RUNTIME', approvalRequired: true, confirmationStrength: 'NONE', requiresDevice: true, requiresProviderConnection: false, recipientEnforced: false, statusWhenSupported: 'UNSUPPORTED' },
  PAYMENT: { platform: 'SERVER', route: 'UNSUPPORTED_FUTURE', permissionSource: 'NAGEX_POLICY', approvalRequired: true, confirmationStrength: 'NONE', requiresDevice: false, requiresProviderConnection: true, recipientEnforced: true, statusWhenSupported: 'UNSUPPORTED' },
};

export const SUPPORTED_M2_CAPABILITIES: readonly DeviceCapabilityKind[] = [
  'VOICE_CAPTURE',
  'CONTACT_READ',
  'SMS_SEND',
  'NOTIFICATION_POST',
  'DEEP_LINK_OPEN',
  'BROWSER_EXECUTION',
  'GMAIL_SEND',
  'CALENDAR_WRITE',
  'TELEGRAM_SELF_DELIVERY',
  'SLACK_SELF_DELIVERY',
  'KAKAOTALK_HANDOFF',
] as const;

export const SUPPORTED_M4_CAPABILITIES: readonly DeviceCapabilityKind[] = [...SUPPORTED_M2_CAPABILITIES, 'KAKAOTALK_ACCESSIBILITY_SEND'] as const;
export const SUPPORTED_M2_ROUTES: readonly CanonicalExecutionRoute[] = ['PROVIDER_API', 'ANDROID_NATIVE', 'APP_LINK', 'BROWSER', 'HUMAN_HANDOFF'] as const;
export const SUPPORTED_M4_ROUTES: readonly CanonicalExecutionRoute[] = ['PROVIDER_API', 'ANDROID_NATIVE', 'APP_LINK', 'BROWSER', 'ANDROID_ACCESSIBILITY', 'HUMAN_HANDOFF'] as const;

const ANDROID_PERMISSION_BY_CAPABILITY: Partial<Record<DeviceCapabilityKind, string>> = {
  VOICE_CAPTURE: 'RECORD_AUDIO',
  CONTACT_READ: 'READ_CONTACTS',
  SMS_SEND: 'SEND_SMS',
  NOTIFICATION_POST: 'POST_NOTIFICATIONS',
  KAKAOTALK_ACCESSIBILITY_SEND: 'ACCESSIBILITY_SERVICE',
};

function materialPayloadHash(payload: Record<string, unknown> | undefined): string | undefined {
  return payload ? hashCanonicalPayload(payload) : undefined;
}

export function parseCapabilityInventoryPermission(capability: DeviceCapabilityKind, inventory: readonly string[]): PermissionState {
  const permission = ANDROID_PERMISSION_BY_CAPABILITY[capability];
  if (!permission) return 'GRANTED';
  const exact = inventory.find((item) => item.startsWith(`permission:${permission}:`));
  if (!exact) return 'NOT_REQUESTED';
  const state = exact.split(':')[2];
  if (state === 'GRANTED' || state === 'DENIED' || state === 'NOT_REQUESTED' || state === 'REVOKED' || state === 'UNAVAILABLE' || state === 'ENABLED' || state === 'DISABLED') return state;
  return 'UNAVAILABLE';
}

export function buildAndroidCapabilityReport(input: { device: DeviceIdentityRecord; connection: DeviceConnectionStatusRecord | null; observedAt?: string }): AndroidCapabilityReport {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const supportedCapabilities = SUPPORTED_M4_CAPABILITIES.filter((capability) => CAPABILITY_DEFINITIONS[capability].platform === 'ANDROID');
  const permissions = supportedCapabilities
    .filter((capability) => ANDROID_PERMISSION_BY_CAPABILITY[capability])
    .map((capability) => ({
      capability,
      deviceId: input.device.deviceId,
      tenantId: input.device.tenantId,
      principalId: input.device.ownerId,
      platform: 'ANDROID' as const,
      permissionState: parseCapabilityInventoryPermission(capability, input.device.capabilityInventory),
      observedAt,
      source: 'ANDROID_RUNTIME' as const,
    }));
  const routeAvailability = Object.fromEntries(supportedCapabilities.map((capability) => {
    const permission = permissions.find((record) => record.capability === capability)?.permissionState ?? 'GRANTED';
    const requiresAccessibility = CAPABILITY_DEFINITIONS[capability].accessibilityRequired === true;
    const permissionSatisfied = requiresAccessibility ? permission === 'ENABLED' : permission === 'GRANTED';
    const status: DeviceCapabilityStatus = input.device.status !== 'ACTIVE'
      ? 'BLOCKED'
      : input.connection?.connectionState !== 'CONNECTED'
        ? 'UNAVAILABLE'
        : permissionSatisfied
          ? 'AVAILABLE'
          : 'PERMISSION_REQUIRED';
    return [capability, status];
  }));
  return {
    platform: 'ANDROID',
    appVersion: input.device.agentVersion,
    deviceId: input.device.deviceId,
    tenantId: input.device.tenantId,
    principalId: input.device.ownerId,
    deviceStatus: input.device.status,
    connectionState: input.connection?.connectionState ?? 'UNKNOWN',
    supportedCapabilities,
    permissions,
    routeAvailability,
  };
}

export class MobileExecutionAuthority {
  constructor(
    private readonly devices?: DeviceIdentityStore,
    private readonly connections?: DeviceConnectionStatusStore,
  ) {}

  public evaluate(request: RouteAuthorityRequest): RouteAuthorityResult {
    const definition = CAPABILITY_DEFINITIONS[request.capability];
    if (!definition || definition.statusWhenSupported === 'UNSUPPORTED') {
      return this.result(request, null, ['CAPABILITY_UNSUPPORTED'], 'UNSUPPORTED', false, 'NONE');
    }

    const reasons: RouteAuthorityReasonCode[] = [];
    let permissionState: PermissionState = 'GRANTED';
    let availability: DeviceCapabilityStatus = definition.statusWhenSupported;

    if (definition.requiresDevice) {
      const device = this.resolveDevice(request);
      if (!device) {
        return this.candidateResult(request, definition, 'UNAVAILABLE', 'UNAVAILABLE', ['DEVICE_UNAVAILABLE'], 'BLOCKED');
      }
      const connection = this.connections?.getStatus(device.deviceId, request.tenantId, request.principalId) ?? null;
      if (device.status !== 'ACTIVE') reasons.push('DEVICE_UNAVAILABLE');
      if (connection?.connectionState !== 'CONNECTED') reasons.push('DEVICE_UNAVAILABLE');
      permissionState = parseCapabilityInventoryPermission(request.capability, device.capabilityInventory);
      const permissionSatisfied = definition.accessibilityRequired ? permissionState === 'ENABLED' : permissionState === 'GRANTED';
      if (!permissionSatisfied) {
        reasons.push(definition.accessibilityRequired ? 'ACCESSIBILITY_NOT_ENABLED' : permissionState === 'REVOKED' ? 'STALE_PERMISSION_GRANT' : 'PERMISSION_NOT_GRANTED');
        availability = 'PERMISSION_REQUIRED';
      }
      if (device.status !== 'ACTIVE' || connection?.connectionState !== 'CONNECTED') availability = 'UNAVAILABLE';
    }

    if (definition.requiresProviderConnection && request.providerConnected === false) {
      reasons.push('PROVIDER_DISCONNECTED');
      availability = 'UNAVAILABLE';
    }
    if ((request.capability === 'TELEGRAM_SELF_DELIVERY' || request.capability === 'SLACK_SELF_DELIVERY') && request.channelOwnershipVerified === false) {
      reasons.push('RECIPIENT_UNENFORCEABLE');
      availability = 'BLOCKED';
    }
    if (!definition.recipientEnforced) reasons.push(definition.manualHandoffOnly ? 'MANUAL_HANDOFF_ONLY' : 'RECIPIENT_UNENFORCEABLE');

    const candidate = this.candidate(request, definition, availability, permissionState, reasons);
    if (availability === 'PERMISSION_REQUIRED') return this.fromCandidate(request, candidate, 'PERMISSION_REQUIRED');
    if (availability === 'UNAVAILABLE' || availability === 'BLOCKED') return this.fromCandidate(request, candidate, 'BLOCKED');

    const approvalDrift = this.evaluateApproval(request, definition);
    if (approvalDrift.length > 0) return this.fromCandidate(request, { ...candidate, reasonCodes: [...candidate.reasonCodes, ...approvalDrift] }, 'REAPPROVAL_REQUIRED');
    if (definition.approvalRequired && request.approval?.status !== 'APPROVED') {
      return this.fromCandidate(request, { ...candidate, reasonCodes: [...candidate.reasonCodes, 'APPROVAL_MISSING'] }, 'APPROVAL_REQUIRED');
    }
    return this.fromCandidate(request, candidate, 'ALLOW');
  }

  public evaluateRouteFailover(input: { approved: RouteAuthorityRequest; candidate: RouteAuthorityRequest; consequential: boolean }): RouteAuthorityResult {
    if (input.consequential && input.approved.executionRoute !== input.candidate.executionRoute) {
      return {
        disposition: 'REAPPROVAL_REQUIRED',
        capability: input.candidate.capability,
        selectedRoute: null,
        candidates: [],
        reasonCodes: ['ROUTE_CHANGED_AFTER_APPROVAL'],
        approvalRequired: true,
        confirmationStrength: 'NONE',
      };
    }
    return this.evaluate(input.candidate);
  }

  public toCanonicalResult(authority: RouteAuthorityResult, externalRef?: string): CanonicalExecutionResult {
    const confirmationStrength = canonicalConfirmationStrength(authority.confirmationStrength);
    if (authority.disposition === 'REAPPROVAL_REQUIRED') return { status: 'REAPPROVAL_REQUIRED', capability: authority.capability, route: null, confirmationStrength, reasonCodes: authority.reasonCodes };
    if (authority.disposition === 'PERMISSION_REQUIRED') return { status: 'PERMISSION_REQUIRED', capability: authority.capability, route: null, confirmationStrength, reasonCodes: authority.reasonCodes };
    if (authority.disposition === 'BLOCKED' || authority.disposition === 'UNSUPPORTED' || authority.disposition === 'APPROVAL_REQUIRED') return { status: 'BLOCKED', capability: authority.capability, route: null, confirmationStrength, reasonCodes: authority.reasonCodes };
    if (authority.selectedRoute === 'HUMAN_HANDOFF') return { status: 'HANDOFF_STARTED', capability: authority.capability, route: authority.selectedRoute, confirmationStrength: 'NONE', reasonCodes: authority.reasonCodes, externalRef };
    return {
      status: confirmationStrength === 'STRONG' ? 'EXECUTED_CONFIRMED' : 'EXECUTED_UNCONFIRMED',
      capability: authority.capability,
      route: authority.selectedRoute,
      confirmationStrength,
      reasonCodes: authority.reasonCodes,
      externalRef,
    };
  }

  public requireAllowed(request: RouteAuthorityRequest): RouteAuthorityResult {
    const result = this.evaluate(request);
    if (result.disposition === 'ALLOW') return result;
    throw new NagexError({
      code: result.disposition,
      category: result.disposition === 'UNSUPPORTED' ? 'VALIDATION' : 'POLICY',
      message: `Execution authority denied for ${request.capability}: ${result.reasonCodes.join(', ') || result.disposition}.`,
      request_id: request.requestId,
    });
  }

  private resolveDevice(request: RouteAuthorityRequest): DeviceIdentityRecord | null {
    if (!request.deviceId || !this.devices) return null;
    return this.devices.getOwned(request.deviceId, request.tenantId, request.principalId);
  }

  private evaluateApproval(request: RouteAuthorityRequest, definition: CapabilityDefinition): RouteAuthorityReasonCode[] {
    if (!definition.approvalRequired || !request.approval || request.approval.status !== 'APPROVED') return [];
    const approved = request.approvedContext ?? this.contextFromPayload(request.approval.canonicalPayload);
    const current: ApprovalBoundExecutionContext = {
      canonicalAction: request.canonicalAction,
      targetRef: request.targetRef,
      accountRef: request.accountRef,
      provider: request.provider,
      executionEnvironment: request.executionEnvironment,
      executionRoute: request.executionRoute,
      capability: request.capability,
      materialPayloadHash: materialPayloadHash(request.materialPayload),
    };
    const reasons: RouteAuthorityReasonCode[] = [];
    if (approved.targetRef !== undefined && approved.targetRef !== current.targetRef) reasons.push('TARGET_CHANGED_AFTER_APPROVAL');
    if (approved.accountRef !== undefined && approved.accountRef !== current.accountRef) reasons.push('ACCOUNT_CHANGED_AFTER_APPROVAL');
    if (approved.executionRoute !== undefined && approved.executionRoute !== current.executionRoute) reasons.push('ROUTE_CHANGED_AFTER_APPROVAL');
    if (approved.executionEnvironment !== undefined && approved.executionEnvironment !== current.executionEnvironment) reasons.push('APPROVAL_SCOPE_MISMATCH');
    if (approved.provider !== undefined && approved.provider !== current.provider) reasons.push('APPROVAL_SCOPE_MISMATCH');
    if (approved.capability !== undefined && approved.capability !== current.capability) reasons.push('APPROVAL_SCOPE_MISMATCH');
    if (approved.materialPayloadHash !== undefined && approved.materialPayloadHash !== current.materialPayloadHash) reasons.push('PAYLOAD_CHANGED_AFTER_APPROVAL');
    return reasons;
  }

  private contextFromPayload(payload: Record<string, unknown>): Partial<ApprovalBoundExecutionContext> {
    return {
      canonicalAction: typeof payload.canonicalAction === 'string' ? payload.canonicalAction : undefined,
      targetRef: typeof payload.targetRef === 'string' ? payload.targetRef : typeof payload.recipientRef === 'string' ? payload.recipientRef : typeof payload.to === 'string' ? payload.to : undefined,
      accountRef: typeof payload.providerAccountRef === 'string' ? payload.providerAccountRef : typeof payload.accountRef === 'string' ? payload.accountRef : undefined,
      provider: typeof payload.provider === 'string' ? payload.provider : undefined,
      executionEnvironment: typeof payload.environment === 'string' ? payload.environment : typeof payload.executionEnvironment === 'string' ? payload.executionEnvironment : undefined,
      executionRoute: typeof payload.executionRoute === 'string' ? payload.executionRoute : undefined,
      capability: typeof payload.capability === 'string' ? payload.capability as DeviceCapabilityKind : undefined,
      materialPayloadHash: typeof payload.materialPayloadHash === 'string' ? payload.materialPayloadHash : undefined,
    };
  }

  private candidate(request: RouteAuthorityRequest, definition: CapabilityDefinition, availability: DeviceCapabilityStatus, permissionState: PermissionState, reasonCodes: RouteAuthorityReasonCode[]): RouteCandidate {
    return {
      route: definition.route,
      capability: request.capability,
      availability,
      permissionState,
      approvalRequired: definition.approvalRequired,
      confirmationStrength: definition.confirmationStrength,
      reasonCodes: [...new Set(reasonCodes)],
    };
  }

  private candidateResult(request: RouteAuthorityRequest, definition: CapabilityDefinition, availability: DeviceCapabilityStatus, permissionState: PermissionState, reasonCodes: RouteAuthorityReasonCode[], disposition: AuthorityDisposition): RouteAuthorityResult {
    return this.fromCandidate(request, this.candidate(request, definition, availability, permissionState, reasonCodes), disposition);
  }

  private fromCandidate(_request: RouteAuthorityRequest, candidate: RouteCandidate, disposition: AuthorityDisposition): RouteAuthorityResult {
    return {
      disposition,
      capability: candidate.capability,
      selectedRoute: disposition === 'ALLOW' ? candidate.route : null,
      candidates: [candidate],
      reasonCodes: [...new Set(candidate.reasonCodes)],
      approvalRequired: candidate.approvalRequired,
      confirmationStrength: candidate.confirmationStrength,
    };
  }

  private result(request: RouteAuthorityRequest, selectedRoute: CanonicalExecutionRoute | null, reasonCodes: RouteAuthorityReasonCode[], disposition: AuthorityDisposition, approvalRequired: boolean, confirmationStrength: ConfirmationStrength): RouteAuthorityResult {
    return { disposition, capability: request.capability, selectedRoute, candidates: [], reasonCodes, approvalRequired, confirmationStrength };
  }
}

export function canonicalConfirmationStrength(strength: ConfirmationStrength): CanonicalConfirmationStrength {
  if (strength === 'DEVICE_SEND_CALLBACK' || strength === 'DELIVERY_CONFIRMED' || strength === 'PROVIDER_ACCEPTED') return 'STRONG';
  if (strength === 'OBSERVED_BROWSER_STATE') return 'MEDIUM';
  if (strength === 'HANDOFF_STARTED') return 'WEAK';
  return 'NONE';
}
