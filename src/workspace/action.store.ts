// R19 — Action Persistence Store
import crypto from 'node:crypto';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { hashCanonicalPayload } from '../governance/action-approval.store.js';
import type { ActionRecord, ActionPreview, CreateActionParams, ActionStatus, RiskLevel } from '../actions/action.types.ts';

function buildPreview(
  actionType: string,
  target: string,
  parameters: Record<string, unknown>,
  riskLevel: RiskLevel,
  reversible: boolean
): ActionPreview {
  let whatWillHappen = `Execute ${actionType} on ${target}`;
  let affectedExternalSystem = 'External System';

  if (actionType === 'CALENDAR_CREATE') {
    const title = (parameters.title as string) || 'Untitled Event';
    const date = (parameters.start as string) || 'selected time';
    whatWillHappen = `Create Google Calendar event "${title}" on ${date}`;
    affectedExternalSystem = 'Google Calendar';
  } else if (actionType === 'CALENDAR_UPDATE') {
    const title = (parameters.title as string) || 'Event';
    whatWillHappen = `Update Google Calendar event "${title}"`;
    affectedExternalSystem = 'Google Calendar';
  } else if (actionType === 'CALENDAR_DELETE') {
    const title = (parameters.title as string) || 'Event';
    whatWillHappen = `Delete Google Calendar event "${title}"`;
    affectedExternalSystem = 'Google Calendar';
  } else if (actionType === 'EMAIL_SEND') {
    const to = (parameters.to as string) || 'recipient';
    const subject = (parameters.subject as string) || '(No Subject)';
    whatWillHappen = `Send email to ${to} with subject "${subject}"`;
    affectedExternalSystem = 'Gmail / External Mail Server';
  } else if (actionType === 'BROWSER_MUTATE') {
    whatWillHappen = `Execute browser action on ${target}`;
    affectedExternalSystem = 'Web Application';
  } else if (actionType === 'BOOKING_CREATE') {
    whatWillHappen = `Book ${target} reservation`;
    affectedExternalSystem = 'Booking Provider';
  }

  return {
    whatWillHappen,
    target,
    parameters,
    affectedExternalSystem,
    estimatedCost: (parameters.estimatedCost as string) || 'Free / Standard Plan',
    dataAffected: (parameters.dataAffected as string) || 'Target external resource',
    reversible,
    riskLevel,
  };
}

export class ActionStore {
  private actions = new Map<string, ActionRecord>();
  private idempotencyMap = new Map<string, string>(); // idempotencyKey -> actionId

  public createAction(params: CreateActionParams): ActionRecord {
    const now = getCurrentISOString();
    const actionId = generateResourceId('act');

    if (params.idempotencyKey && this.idempotencyMap.has(params.idempotencyKey)) {
      const existingId = this.idempotencyMap.get(params.idempotencyKey)!;
      const existing = this.actions.get(existingId);
      if (existing) return existing;
    }

    const defaultRisk: RiskLevel =
      params.actionType === 'CALENDAR_DELETE'
        ? 'HIGH'
        : params.actionType === 'EMAIL_SEND'
        ? 'MEDIUM'
        : params.actionType === 'CALENDAR_UPDATE'
        ? 'MEDIUM'
        : 'LOW';

    const riskLevel = params.riskLevel || defaultRisk;
    const approvalRequired = params.approvalRequired !== false;
    const reversible = params.reversible ?? (params.actionType !== 'EMAIL_SEND');

    const preview = buildPreview(params.actionType, params.target, params.parameters, riskLevel, reversible);
    const payloadHash = hashCanonicalPayload(params.parameters);

    const ttlMs = (params.expiresInSeconds || 900) * 1000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const record: ActionRecord = {
      actionId,
      userId: params.userId,
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      actionType: params.actionType,
      provider: params.provider,
      capability: params.capability,
      target: params.target,
      parameters: params.parameters,
      previousState: params.previousState,
      riskLevel,
      approvalRequired,
      approvalId: approvalRequired ? generateResourceId('appr') : undefined,
      approvalPayloadHash: payloadHash,
      expiresAt,
      idempotencyKey: params.idempotencyKey,
      status: approvalRequired ? 'WAITING_APPROVAL' : 'DRAFT',
      preview,
      reversible,
      revertCapability: params.revertCapability,
      revertedActionId: params.revertedActionId,
      createdAt: now,
      updatedAt: now,
    };

    this.actions.set(actionId, record);
    if (params.idempotencyKey) {
      this.idempotencyMap.set(params.idempotencyKey, actionId);
    }

    return record;
  }

  public getAction(actionId: string, tenantId: string, userId: string): ActionRecord | null {
    const record = this.actions.get(actionId);
    if (!record) return null;
    if (record.organizationId !== tenantId && record.workspaceId !== tenantId) {
      return null;
    }
    if (record.userId !== userId) {
      return null;
    }
    return record;
  }

  public updateAction(
    actionId: string,
    tenantId: string,
    userId: string,
    updates: Partial<ActionRecord>
  ): ActionRecord {
    const record = this.getAction(actionId, tenantId, userId);
    if (!record) {
      throw new NagexError({
        code: 'ACTION_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Action ${actionId} was not found or access was denied.`,
      });
    }

    const updated: ActionRecord = {
      ...record,
      ...updates,
      updatedAt: getCurrentISOString(),
    };

    this.actions.set(actionId, updated);
    return updated;
  }

  public listActions(tenantId: string, userId: string): ActionRecord[] {
    const result: ActionRecord[] = [];
    for (const record of this.actions.values()) {
      if ((record.organizationId === tenantId || record.workspaceId === tenantId) && record.userId === userId) {
        result.push(record);
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
