import { createHash } from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { ActionApprovalStore } from '../governance/action-approval.store.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import type { DeviceIdentityStore } from './device-identity.store.js';
import type { DevicePendingCommand } from './device-agent-protocol.js';
import type { DevicePendingCommandStore } from './device-pending-command.store.js';
import { KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, mobileAccessibilityDraftPayload } from '../mobile/mobile-accessibility-approval.service.js';

export const ACCESSIBILITY_PLAN_TOOL_ID = KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID;

const ALLOWED_ACTIONS = new Set([
  'OPEN_APP',
  'FIND_ELEMENT',
  'CLICK_ALLOWED_NODE',
  'SELECT_RECIPIENT',
  'VERIFY_RECIPIENT',
  'FIND_COMPOSER',
  'FOCUS_INPUT',
  'TYPE_APPROVED_RECIPIENT_QUERY',
  'TYPE_APPROVED_TEXT',
  'OBSERVE_RESULT',
  'NAVIGATE_BACK',
  'SCROLL_BOUNDED',
]);

const BLOCKED_ACTIONS = new Set(['SEND_MESSAGE', 'PRESS_SEND', 'CLICK_SEND', 'RAW_TAP', 'SHELL', 'SCRIPT', 'ARBITRARY_INTENT']);

export interface AccessibilityPlanStepInput {
  stepId: string;
  action: string;
  screenContract: string;
  semanticTarget: string;
  selectorHints?: Record<string, unknown>;
}

export interface EnqueueAccessibilityPlanInput {
  tenantId: string;
  principalId: string;
  requestId: string;
  deviceId: string;
  approvalRef: string;
  recipientRef: string;
  targetPackage: string;
  targetAppVersion: string;
  route: string;
  planId: string;
  approvedPayloadHash: string;
  approvedText?: string;
  messageHash: string;
  displayName: string;
  expiresAt: string;
  steps: AccessibilityPlanStepInput[];
  budget?: Record<string, unknown>;
}

export interface EnqueueAccessibilityPlanResult {
  status: 'QUEUED' | 'DUPLICATE_RETURNED';
  command: DevicePendingCommand;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class DeviceCommandService {
  public constructor(
    private readonly devices: DeviceIdentityStore,
    private readonly pendingCommands: DevicePendingCommandStore,
    private readonly approvals: ActionApprovalStore,
    private readonly now: () => number = Date.now,
  ) {}

  public enqueueAccessibilityPlan(input: EnqueueAccessibilityPlanInput): EnqueueAccessibilityPlanResult {
    const device = this.devices.getOwned(input.deviceId, input.tenantId, input.principalId);
    if (!device) {
      throw new NagexError({ code: 'DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: 'Device was not found for this tenant/user.', request_id: input.requestId });
    }
    if (device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'DEVICE_NOT_ACTIVE', category: 'POLICY', message: 'Device is not active.', request_id: input.requestId });
    }
    if (!device.capabilityInventory.includes('permission:ACCESSIBILITY_SERVICE:ENABLED')) {
      throw new NagexError({ code: 'ACCESSIBILITY_NOT_ENABLED', category: 'POLICY', message: 'Accessibility permission is not enabled for this device.', request_id: input.requestId });
    }
    if (input.route !== 'ANDROID_ACCESSIBILITY') {
      throw new NagexError({ code: 'ROUTE_MUTATION_REAPPROVAL_REQUIRED', category: 'POLICY', message: 'Route differs from the approved Android Accessibility route.', request_id: input.requestId });
    }
    if (input.targetPackage !== 'com.kakao.talk') {
      throw new NagexError({ code: 'APP_NOT_ALLOWLISTED', category: 'POLICY', message: 'Only the certified KakaoTalk package is allowed.', request_id: input.requestId });
    }
    if (input.targetAppVersion !== '26.8.2') {
      throw new NagexError({ code: 'APP_VERSION_UNSUPPORTED', category: 'POLICY', message: 'KakaoTalk version is not certified for this plan.', request_id: input.requestId });
    }
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new NagexError({ code: 'ACCESSIBILITY_PLAN_EXPIRED', category: 'POLICY', message: 'Accessibility plan is expired.', request_id: input.requestId });
    }
    if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 10) {
      throw new NagexError({ code: 'ACCESSIBILITY_PLAN_STEPS_INVALID', category: 'VALIDATION', message: 'Plan must contain 1-10 steps.', request_id: input.requestId });
    }
    let sawRecipientVerification = false;
    let sawType = false;
    for (const step of input.steps) {
      if (BLOCKED_ACTIONS.has(step.action) || !ALLOWED_ACTIONS.has(step.action)) {
        throw new NagexError({ code: 'ACCESSIBILITY_ACTION_NOT_ALLOWED', category: 'POLICY', message: `Action ${step.action} is not allowed.`, request_id: input.requestId });
      }
      if (step.action === 'VERIFY_RECIPIENT') sawRecipientVerification = true;
      if (step.action === 'TYPE_APPROVED_TEXT') {
        if (!sawRecipientVerification) {
          throw new NagexError({ code: 'ACCESSIBILITY_STEP_ORDER_INVALID', category: 'POLICY', message: 'Recipient must be verified before typing.', request_id: input.requestId });
        }
        sawType = true;
      }
    }
    if (sawType) {
      if (!input.approvedText) throw new NagexError({ code: 'APPROVED_TEXT_REQUIRED', category: 'VALIDATION', message: 'approvedText is required for TYPE_APPROVED_TEXT.', request_id: input.requestId });
      if (sha256Hex(input.approvedText) !== input.approvedPayloadHash) {
        throw new NagexError({ code: 'MESSAGE_HASH_MISMATCH', category: 'VALIDATION', message: 'approvedText hash does not match approvedPayloadHash.', request_id: input.requestId });
      }
    }

    const duplicate = this.pendingCommands.findByPlanId(input.deviceId, input.tenantId, input.principalId, input.planId, this.now());
    if (duplicate) return { status: 'DUPLICATE_RETURNED', command: duplicate };
    const active = this.pendingCommands.listPendingForDevice(input.deviceId, input.tenantId, input.principalId, this.now());
    if (active.length > 0) {
      throw new NagexError({ code: 'DEVICE_COMMAND_ALREADY_PENDING', category: 'CONFLICT', message: 'A pending command already exists for this device.', request_id: input.requestId });
    }

    const materialPayload = mobileAccessibilityDraftPayload({
      deviceId: input.deviceId,
      recipientRef: input.recipientRef,
      targetPackage: input.targetPackage,
      targetAppVersion: input.targetAppVersion,
      route: input.route,
      approvedTextHash: input.approvedPayloadHash,
      messageHash: input.messageHash,
      displayName: input.displayName,
    });
    const approval = this.approvals.consume(input.approvalRef, input.tenantId, input.principalId, ACCESSIBILITY_PLAN_TOOL_ID, materialPayload, input.requestId, `exec_${input.planId}`);
    const approvedPayload = approval.canonicalPayload;
    if (approvedPayload.actionType !== KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID) throw new NagexError({ code: 'APPROVAL_ACTION_MISMATCH', category: 'POLICY', message: 'Approval is not a KakaoTalk accessibility draft approval.', request_id: input.requestId });
    if (approvedPayload.deviceId !== input.deviceId) throw new NagexError({ code: 'APPROVAL_DEVICE_MISMATCH', category: 'POLICY', message: 'Approval is bound to a different device.', request_id: input.requestId });
    if (approvedPayload.recipientRef !== input.recipientRef && approvedPayload.targetRef !== input.recipientRef) throw new NagexError({ code: 'APPROVAL_RECIPIENT_MISMATCH', category: 'POLICY', message: 'Approval is bound to a different recipient.', request_id: input.requestId });
    if (approvedPayload.provider !== 'KAKAOTALK') throw new NagexError({ code: 'APPROVAL_APP_MISMATCH', category: 'POLICY', message: 'Approval is bound to a different app.', request_id: input.requestId });
    if (approvedPayload.executionRoute !== input.route) throw new NagexError({ code: 'ROUTE_MUTATION_REAPPROVAL_REQUIRED', category: 'POLICY', message: 'Route changed after approval.', request_id: input.requestId });
    if (approvedPayload.messageHash !== undefined && approvedPayload.messageHash !== input.messageHash) throw new NagexError({ code: 'APPROVAL_MESSAGE_HASH_MISMATCH', category: 'POLICY', message: 'Approval is bound to a different message hash.', request_id: input.requestId });
    if (approvedPayload.approvedTextHash !== input.approvedPayloadHash) throw new NagexError({ code: 'APPROVAL_MESSAGE_HASH_MISMATCH', category: 'POLICY', message: 'Approval is bound to a different approved text hash.', request_id: input.requestId });
    if (approvedPayload.targetPackage !== input.targetPackage || approvedPayload.targetAppVersion !== input.targetAppVersion) throw new NagexError({ code: 'APPROVAL_APP_MISMATCH', category: 'POLICY', message: 'Approval is bound to a different app package/version.', request_id: input.requestId });
    if (typeof approvedPayload.materialPayloadHash === 'string' && approvedPayload.materialPayloadHash !== materialPayload.materialPayloadHash) {
      throw new NagexError({ code: 'APPROVAL_PAYLOAD_MISMATCH', category: 'POLICY', message: 'Plan material payload does not match approval.', request_id: input.requestId });
    }

    const command = this.pendingCommands.enqueue(input.deviceId, input.tenantId, input.principalId, 'ACCESSIBILITY_EXECUTE_PLAN', null, {
      appId: 'KAKAOTALK',
      planId: input.planId,
      commandId: `acmd_${input.planId}`,
      principalId: input.principalId,
      tenantId: input.tenantId,
      capability: ACCESSIBILITY_PLAN_TOOL_ID,
      executionRoute: input.route,
      targetPackage: input.targetPackage,
      targetAppVersion: input.targetAppVersion,
      approvalRef: input.approvalRef,
      approvedPayloadHash: input.approvedPayloadHash,
      ...(sawType ? { approvedText: input.approvedText } : {}),
      packageName: input.targetPackage,
      deviceId: input.deviceId,
      recipientRef: input.recipientRef,
      displayName: input.displayName,
      messageHash: input.messageHash,
      steps: input.steps,
      budget: input.budget ?? { maxSteps: 10, maxTextInputs: 1, maxClicks: 4, maxScrolls: 2, timeoutMs: 30_000 },
      expiresAt: input.expiresAt,
      requiresForeground: true,
      requiresUserPresence: true,
    });
    return { status: 'QUEUED', command };
  }
}
