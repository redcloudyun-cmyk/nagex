import crypto from 'node:crypto';
import type { NormalizedGmailExecutionResult } from '../modules/gmail/index.js';
import { assertRuntimeMessagingEvidence } from './messaging-capability-registry.js';
import type { ExecutionTarget, MessagingExecutionCapability, MessagingExecutionEvidence, MessagingExecutionResult } from './messaging-execution-contract.types.js';
import type { EmailApprovalBinding, SendEmailAction } from './send-email-action.types.js';

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const GMAIL_EMAIL_EXECUTION_CAPABILITY: MessagingExecutionCapability = Object.freeze({
  capabilityId: 'email.gmail.api.send', channel: 'EMAIL', environment: 'SERVER', provider: 'GOOGLE', executionRoute: 'GMAIL_API', executionMode: 'AUTONOMOUS_VERIFIED',
  recipientEnforced: true, messageEnforced: true, completionVerifiable: true, requiresHumanCompletion: false,
  officialApiAvailable: true, deviceLocalRequired: false, browserSessionRequired: false, authenticatedProviderRequired: true,
  supportsAutonomousExecution: true, supportsDeliveryEvidence: false, supportsReadEvidence: false,
  // Risk is a policy-engine output, not a permanent property of OAuth/email.
  policyRisk: 'HIGH', availabilityStatus: 'AVAILABLE', certificationId: 'R23.6M-D4B-AUTOMATED',
});

export function mapGmailExecutionTarget(action: SendEmailAction): ExecutionTarget {
  return Object.freeze({
    targetId: `target_gmail_${digest({ to: action.to, cc: action.cc ?? [], bcc: action.bcc ?? [] }).slice(0, 24)}`,
    tenantId: action.tenantId, ownerId: action.ownerId, channel: 'EMAIL', environment: 'SERVER', provider: 'GOOGLE',
    addressKind: 'EMAIL_ADDRESS', addressRef: action.to[0]!, providerAccountRef: action.providerAccountRef,
    displayLabel: action.to.join(', '),
  });
}

export function buildGmailApprovalBinding(action: SendEmailAction): EmailApprovalBinding {
  return {
    canonicalAction: 'SEND_EMAIL', providerAccountRef: action.providerAccountRef,
    to: [...action.to], cc: [...(action.cc ?? [])], bcc: [...(action.bcc ?? [])], subject: action.subject,
    contentDigest: digest(action.body), attachmentDigest: digest(action.attachments ?? []),
    environment: 'SERVER', provider: 'GOOGLE', executionRoute: 'GMAIL_API',
    threadId: action.replyContext?.threadId ?? null, replyToMessageId: action.replyContext?.replyToMessageId ?? null,
  };
}

export function mapGmailCanonicalResult(action: SendEmailAction, result: NormalizedGmailExecutionResult): MessagingExecutionResult {
  const target = mapGmailExecutionTarget(action);
  const evidence: MessagingExecutionEvidence[] = [
    { evidenceType: 'PROVIDER_API_RESPONSE', evidenceSource: 'GOOGLE_GMAIL_API', observedAt: result.completedAt, synthetic: false, providerStatus: 'ACCEPTED' },
    { evidenceType: 'PROVIDER_MESSAGE_ID', evidenceSource: 'GOOGLE_GMAIL_API', observedAt: result.completedAt, synthetic: false, providerMessageId: result.externalId },
  ];
  evidence.forEach(assertRuntimeMessagingEvidence);
  return { executionId: result.executionId, status: 'PROVIDER_ACCEPTED', route: 'GMAIL_API', environment: 'SERVER', provider: 'GOOGLE', channel: 'EMAIL', targetId: target.targetId, evidence, startedAt: result.startedAt, updatedAt: result.completedAt };
}
