export type ExecutionEnvironment = 'SERVER' | 'WEB' | 'BROWSER' | 'ANDROID' | 'IOS' | 'DESKTOP' | 'EXTERNAL_API';

export type CanonicalMessagingExecutionMode = 'AUTONOMOUS_VERIFIED' | 'HUMAN_HANDOFF' | 'MANUAL' | 'UNSUPPORTED';
export type CapabilityAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'DISABLED' | 'NOT_CONFIGURED' | 'NOT_CERTIFIED';
export type MessagingPolicyRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type CanonicalMessagingStatus =
  | 'ACTION_ACCEPTED'
  | 'EXECUTION_STARTED'
  | 'PROVIDER_ACCEPTED'
  | 'HANDOFF_STARTED'
  | 'NEEDS_HUMAN'
  | 'DELIVERY_CONFIRMED'
  | 'READ_CONFIRMED'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export type MessagingEvidenceType =
  | 'DEVICE_SEND_CALLBACK'
  | 'PROVIDER_API_RESPONSE'
  | 'PROVIDER_MESSAGE_ID'
  | 'DELIVERY_RECEIPT'
  | 'READ_RECEIPT'
  | 'HUMAN_HANDOFF_ONLY'
  | 'NO_CONFIRMATION_AVAILABLE';

export interface MessagingExecutionCapability {
  capabilityId: string;
  channel: string;
  environment: ExecutionEnvironment;
  provider: string;
  executionRoute: string;
  executionMode: CanonicalMessagingExecutionMode;
  recipientEnforced: boolean;
  messageEnforced: boolean;
  completionVerifiable: boolean;
  requiresHumanCompletion: boolean;
  officialApiAvailable: boolean;
  deviceLocalRequired: boolean;
  browserSessionRequired: boolean;
  authenticatedProviderRequired: boolean;
  supportsAutonomousExecution: boolean;
  supportsDeliveryEvidence: boolean;
  supportsReadEvidence: boolean;
  policyRisk: MessagingPolicyRisk;
  availabilityStatus: CapabilityAvailability;
  unavailableReason?: string;
  certificationId?: string;
}

export interface ExecutionTarget {
  readonly targetId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly channel: string;
  readonly environment: ExecutionEnvironment;
  readonly provider: string;
  readonly addressKind: 'OPAQUE_DEVICE_RECIPIENT_REF' | 'EMAIL_ADDRESS' | 'PROVIDER_USER_ID' | 'PROVIDER_CONVERSATION_ID' | 'PHONE_NUMBER_REF';
  readonly addressRef: string;
  readonly providerAccountRef?: string;
  readonly workspaceRef?: string;
  readonly deviceId?: string;
  readonly displayLabel?: string;
}

export interface MessagingExecutionEvidence {
  evidenceType: MessagingEvidenceType;
  evidenceSource: string;
  observedAt: string;
  synthetic: boolean;
  providerMessageId?: string;
  providerTimestamp?: string;
  providerStatus?: string;
  receiptId?: string;
}

export interface MessagingExecutionResult {
  executionId: string | null;
  status: CanonicalMessagingStatus;
  route: string;
  environment: ExecutionEnvironment;
  provider: string;
  channel: string;
  targetId: string;
  evidence: MessagingExecutionEvidence[];
  failureCode?: string;
  retryDisposition?: 'SAFE_RETRY' | 'REAPPROVAL_REQUIRED' | 'DO_NOT_RETRY';
  startedAt: string;
  updatedAt: string;
}

export interface MessagingApprovalBinding {
  canonicalAction: 'SEND_MESSAGE';
  recipientRef: string;
  message: string;
  channel: string;
  environment: ExecutionEnvironment;
  provider: string;
  executionRoute: string;
  deviceId?: string;
  providerAccountRef?: string;
  workspaceRef?: string;
}
