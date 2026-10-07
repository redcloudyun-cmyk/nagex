import { createHash } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { ActionApprovalRecord, ActionApprovalStore } from '../governance/action-approval.store.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import type { DeviceIdentityStore } from '../device-agent/device-identity.store.js';
import type { RecipientRefStore } from './recipient-ref.store.js';

export const KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID = 'KAKAOTALK_ACCESSIBILITY_DRAFT';
export const KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID = 'KAKAOTALK_ACCESSIBILITY_SEND';

export interface MobileAccessibilityDraftApprovalInput {
  tenantId: string;
  principalId: string;
  requestId: string;
  deviceId: string;
  recipientRef: string;
  targetPackage: string;
  targetAppVersion: string;
  route: string;
  approvedTextHash: string;
  messageHash: string;
  displayName: string;
  actionType: string;
}

export function mobileAccessibilityDraftPayload(input: {
  deviceId: string;
  recipientRef: string;
  targetPackage: string;
  targetAppVersion: string;
  route: string;
  approvedTextHash: string;
  messageHash: string;
  displayName: string;
  actionType?: string;
}): Record<string, unknown> {
  return {
    actionType: input.actionType ?? KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
    appId: 'KAKAOTALK',
    provider: 'KAKAOTALK',
    packageName: input.targetPackage,
    targetPackage: input.targetPackage,
    targetAppVersion: input.targetAppVersion,
    recipientRef: input.recipientRef,
    displayName: input.displayName,
    approvedTextHash: input.approvedTextHash,
    messageHash: input.messageHash,
    deviceId: input.deviceId,
    executionRoute: input.route,
    materialPayloadHash: hashCanonicalPayload({
      actionType: input.actionType ?? KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
      appId: 'KAKAOTALK',
      packageName: input.targetPackage,
      recipientRef: input.recipientRef,
      displayName: input.displayName,
      approvedTextHash: input.approvedTextHash,
      messageHash: input.messageHash,
      deviceId: input.deviceId,
      executionRoute: input.route,
      targetAppVersion: input.targetAppVersion,
    }),
  };
}

export function approvedTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class MobileAccessibilityApprovalService {
  public constructor(
    private readonly devices: DeviceIdentityStore,
    private readonly recipientRefs: RecipientRefStore,
    private readonly approvals: ActionApprovalStore,
  ) {}

  public requestDraftApproval(input: MobileAccessibilityDraftApprovalInput): ActionApprovalRecord {
    const device = this.devices.getOwned(input.deviceId, input.tenantId, input.principalId);
    if (!device) throw new NagexError({ code: 'DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: 'Device was not found for this tenant/user.', request_id: input.requestId });
    if (device.status !== 'ACTIVE') throw new NagexError({ code: 'DEVICE_NOT_ACTIVE', category: 'POLICY', message: 'Device is not active.', request_id: input.requestId });
    if (!device.capabilityInventory.includes('permission:ACCESSIBILITY_SERVICE:ENABLED')) throw new NagexError({ code: 'ACCESSIBILITY_NOT_ENABLED', category: 'POLICY', message: 'Accessibility permission is not enabled for this device.', request_id: input.requestId });
    if (!this.recipientRefs.getOwned(input.recipientRef, input.tenantId, input.principalId, input.deviceId)) {
      throw new NagexError({ code: 'MOBILE_RECIPIENT_NOT_FOUND', category: 'NOT_FOUND', message: 'Recipient reference was not found for this device.', request_id: input.requestId });
    }
    if (input.actionType !== KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID) {
      throw new NagexError({ code: 'MOBILE_ACCESSIBILITY_ACTION_UNSUPPORTED', category: 'POLICY', message: 'Only KakaoTalk accessibility draft approval is supported in M4C.', request_id: input.requestId });
    }
    if (input.targetPackage !== 'com.kakao.talk') throw new NagexError({ code: 'APP_NOT_ALLOWLISTED', category: 'POLICY', message: 'Only KakaoTalk is allowlisted for this approval.', request_id: input.requestId });
    if (input.targetAppVersion !== '26.8.2') throw new NagexError({ code: 'APP_VERSION_UNSUPPORTED', category: 'POLICY', message: 'KakaoTalk version is not certified.', request_id: input.requestId });
    if (input.route !== 'ANDROID_ACCESSIBILITY') throw new NagexError({ code: 'ROUTE_UNSUPPORTED', category: 'POLICY', message: 'Only Android Accessibility route is supported.', request_id: input.requestId });
    if (!/^[a-f0-9]{64}$/i.test(input.approvedTextHash) || !input.messageHash.trim()) {
      throw new NagexError({ code: 'MESSAGE_HASH_REQUIRED', category: 'VALIDATION', message: 'approvedTextHash and messageHash are required.', request_id: input.requestId });
    }

    return this.approvals.request({
      toolId: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
      tenantId: input.tenantId,
      principalId: input.principalId,
      payload: mobileAccessibilityDraftPayload(input),
    });
  }
}
