// R19 — Action Domain Types & Contracts

export type ActionType =
  | 'CALENDAR_CREATE'
  | 'CALENDAR_UPDATE'
  | 'CALENDAR_DELETE'
  | 'EMAIL_SEND'
  | 'BROWSER_MUTATE'
  | 'BOOKING_CREATE';

export type ActionStatus =
  | 'DRAFT'
  | 'WAITING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'SUCCEEDED_UNVERIFIED'
  | 'FAILED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'REVERTED';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ActionVerification {
  verified: boolean;
  method: 'READ_BACK' | 'PROVIDER_RESPONSE' | 'UNKNOWN';
  providerRef?: string;
  detail?: string;
  verifiedAt?: string;
}

export interface ActionPreview {
  whatWillHappen: string;
  target: string;
  parameters: Record<string, unknown>;
  affectedExternalSystem: string;
  estimatedCost?: string;
  dataAffected?: string;
  reversible: boolean;
  riskLevel: RiskLevel;
}

export interface ActionRecord {
  actionId: string;
  userId: string;
  organizationId: string;
  workspaceId: string;

  actionType: ActionType;
  provider: 'google' | 'microsoft' | 'browser' | 'booking' | string;
  capability: string;

  target: string;
  parameters: Record<string, unknown>;
  previousState?: Record<string, unknown>; // Captured prior to update for revert

  riskLevel: RiskLevel;
  approvalRequired: boolean;
  approvalId?: string;
  approvalPayloadHash?: string;
  expiresAt?: string;
  idempotencyKey?: string;

  status: ActionStatus;

  preview: ActionPreview;
  verification?: ActionVerification;

  reversible: boolean;
  revertCapability?: string;
  revertedActionId?: string; // Points to the original action if this record is a revert action

  createdAt: string;
  updatedAt: string;
  executedAt?: string;
  error?: string;
}

export interface CreateActionParams {
  userId: string;
  organizationId: string;
  workspaceId: string;
  actionType: ActionType;
  provider: string;
  capability: string;
  target: string;
  parameters: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  riskLevel?: RiskLevel;
  approvalRequired?: boolean;
  expiresInSeconds?: number;
  idempotencyKey?: string;
  reversible?: boolean;
  revertCapability?: string;
  revertedActionId?: string;
}
