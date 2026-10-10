import { NagexError } from '../common/errors.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import type { MobileExecutionAuthority, CanonicalExecutionResult, DeviceCapabilityKind, RouteAuthorityRequest } from './mobile-execution-authority.js';

export type AppLinkTargetApp = 'NAGEX_ANDROID' | 'KAKAOTALK';
export type AppLinkActionKind = 'OPEN_STATUS' | 'OPEN_VOICE' | 'KAKAOTALK_SHARE_HANDOFF';

export interface AppLinkExecutionRequest {
  principalId: string;
  tenantId: string;
  deviceId: string;
  capability: DeviceCapabilityKind;
  targetApp: AppLinkTargetApp;
  uri: string;
  actionKind: AppLinkActionKind;
  approvedRoute: 'APP_LINK' | 'HUMAN_HANDOFF';
  approvalReference: {
    status: string;
    canonicalPayload: Record<string, unknown>;
  } | null;
  correlationId: string;
}

export interface AppLinkExecutionCommand {
  commandType: 'APP_LINK_OPEN';
  executionSessionId: null;
  data: {
    targetApp: AppLinkTargetApp;
    packageName: string;
    uri: string;
    actionKind: AppLinkActionKind;
    correlationId: string;
  };
}

export interface AppLinkExecutionResult {
  status: 'APP_LAUNCHED' | 'HANDOFF_STARTED' | 'FAILED_TO_LAUNCH';
  canonical: CanonicalExecutionResult;
  command: AppLinkExecutionCommand;
}

interface AppLinkAllowlistEntry {
  targetApp: AppLinkTargetApp;
  packageName: string;
  allowedSchemes: string[];
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  supportedActions: AppLinkActionKind[];
  approvalRequired: boolean;
  handoffOnly: boolean;
}

const BLOCKED_SCHEMES = new Set(['intent:', 'file:', 'javascript:', 'content:']);

export const APP_LINK_ALLOWLIST: readonly AppLinkAllowlistEntry[] = [
  {
    targetApp: 'NAGEX_ANDROID',
    packageName: 'com.nagex.mobile',
    allowedSchemes: ['nagex'],
    allowedHosts: ['status', 'voice'],
    allowedPathPrefixes: ['/open'],
    supportedActions: ['OPEN_STATUS', 'OPEN_VOICE'],
    approvalRequired: false,
    handoffOnly: false,
  },
  {
    targetApp: 'KAKAOTALK',
    packageName: 'com.kakao.talk',
    allowedSchemes: ['kakaolink'],
    allowedHosts: ['send'],
    allowedPathPrefixes: ['/share'],
    supportedActions: ['KAKAOTALK_SHARE_HANDOFF'],
    approvalRequired: true,
    handoffOnly: true,
  },
] as const;

export class AppLinkExecutionService {
  constructor(private readonly authority: MobileExecutionAuthority) {}

  public prepare(input: AppLinkExecutionRequest): AppLinkExecutionResult {
    const parsed = this.parseAndValidate(input);
    const entry = this.requireAllowedTarget(input, parsed);
    const materialPayload = {
      targetApp: input.targetApp,
      uri: parsed.toString(),
      actionKind: input.actionKind,
      approvedRoute: input.approvedRoute,
      deviceId: input.deviceId,
    };
    const capability = entry.handoffOnly ? 'KAKAOTALK_HANDOFF' : input.capability;
    const authorityRequest: RouteAuthorityRequest = {
      tenantId: input.tenantId,
      principalId: input.principalId,
      requestId: input.correlationId,
      capability,
      canonicalAction: input.actionKind,
      targetRef: parsed.toString(),
      provider: entry.targetApp,
      executionEnvironment: 'ANDROID',
      executionRoute: entry.handoffOnly ? 'KAKAOTALK_SHARE' : 'APP_LINK',
      materialPayload,
      deviceId: input.deviceId,
      approval: input.approvalReference,
      approvedContext: input.approvalReference ? {
        targetRef: String(input.approvalReference.canonicalPayload.targetRef ?? input.approvalReference.canonicalPayload.uri ?? ''),
        provider: typeof input.approvalReference.canonicalPayload.provider === 'string' ? input.approvalReference.canonicalPayload.provider : entry.targetApp,
        executionEnvironment: 'ANDROID',
        executionRoute: typeof input.approvalReference.canonicalPayload.executionRoute === 'string' ? input.approvalReference.canonicalPayload.executionRoute : input.approvedRoute,
        capability,
        materialPayloadHash: typeof input.approvalReference.canonicalPayload.materialPayloadHash === 'string' ? input.approvalReference.canonicalPayload.materialPayloadHash : hashCanonicalPayload(materialPayload),
      } : null,
    };
    const auth = this.authority.requireAllowed(authorityRequest);
    const command: AppLinkExecutionCommand = {
      commandType: 'APP_LINK_OPEN',
      executionSessionId: null,
      data: { targetApp: input.targetApp, packageName: entry.packageName, uri: parsed.toString(), actionKind: input.actionKind, correlationId: input.correlationId },
    };
    const canonical = this.authority.toCanonicalResult(auth, input.correlationId);
    if (entry.handoffOnly) {
      return { status: 'HANDOFF_STARTED', canonical: { ...canonical, status: 'HANDOFF_STARTED', confirmationStrength: 'NONE' }, command };
    }
    return { status: 'APP_LAUNCHED', canonical, command };
  }

  private parseAndValidate(input: AppLinkExecutionRequest): URL {
    let parsed: URL;
    try {
      parsed = new URL(input.uri);
    } catch {
      throw new NagexError({ code: 'APP_LINK_URI_MALFORMED', category: 'VALIDATION', message: 'Malformed app-link URI.', request_id: input.correlationId });
    }
    if (BLOCKED_SCHEMES.has(parsed.protocol)) {
      throw new NagexError({ code: 'UNKNOWN_SCHEME_EXECUTION', category: 'POLICY', message: `URI scheme ${parsed.protocol} is not allowlisted.`, request_id: input.correlationId });
    }
    if (parsed.username || parsed.password) {
      throw new NagexError({ code: 'APP_LINK_URI_CREDENTIALS_BLOCKED', category: 'POLICY', message: 'App-link URIs must not embed credentials.', request_id: input.correlationId });
    }
    return parsed;
  }

  private requireAllowedTarget(input: AppLinkExecutionRequest, parsed: URL): AppLinkAllowlistEntry {
    const entry = APP_LINK_ALLOWLIST.find((item) => item.targetApp === input.targetApp);
    if (!entry) {
      throw new NagexError({ code: 'APP_LINK_TARGET_BLOCKED', category: 'POLICY', message: `Target app ${input.targetApp} is not allowlisted.`, request_id: input.correlationId });
    }
    const scheme = parsed.protocol.replace(/:$/, '');
    const path = parsed.pathname || '/';
    if (!entry.allowedSchemes.includes(scheme)) {
      throw new NagexError({ code: 'UNKNOWN_SCHEME_EXECUTION', category: 'POLICY', message: `URI scheme ${scheme} is not allowlisted for ${input.targetApp}.`, request_id: input.correlationId });
    }
    if (!entry.allowedHosts.includes(parsed.hostname)) {
      throw new NagexError({ code: 'APP_LINK_HOST_BLOCKED', category: 'POLICY', message: `URI host ${parsed.hostname} is not allowlisted for ${input.targetApp}.`, request_id: input.correlationId });
    }
    if (!entry.allowedPathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) {
      throw new NagexError({ code: 'APP_LINK_PATH_BLOCKED', category: 'POLICY', message: `URI path ${path} is not allowlisted for ${input.targetApp}.`, request_id: input.correlationId });
    }
    if (!entry.supportedActions.includes(input.actionKind)) {
      throw new NagexError({ code: 'APP_LINK_ACTION_BLOCKED', category: 'POLICY', message: `Action ${input.actionKind} is not allowlisted for ${input.targetApp}.`, request_id: input.correlationId });
    }
    if (entry.handoffOnly && input.approvedRoute !== 'HUMAN_HANDOFF') {
      throw new NagexError({ code: 'REAPPROVAL_REQUIRED', category: 'POLICY', message: 'KakaoTalk can only be authorized as a human handoff route.', request_id: input.correlationId });
    }
    if (!entry.handoffOnly && input.approvedRoute !== 'APP_LINK') {
      throw new NagexError({ code: 'REAPPROVAL_REQUIRED', category: 'POLICY', message: 'Approved route does not match app-link execution.', request_id: input.correlationId });
    }
    return entry;
  }
}
