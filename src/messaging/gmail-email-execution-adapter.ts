import { NagexError } from '../common/errors.js';
import { GMAIL_REPLY_TOOL_ID, GMAIL_SEND_EMAIL_TOOL_ID, type NormalizedGmailExecutionResult } from '../modules/gmail/index.js';
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';
import { buildGmailApprovalBinding, GMAIL_EMAIL_EXECUTION_CAPABILITY, mapGmailCanonicalResult, mapGmailExecutionTarget } from './gmail-canonical-mapping.js';
import type { ExecutionTarget, MessagingExecutionCapability, MessagingExecutionResult } from './messaging-execution-contract.types.js';
import type { EmailApprovalBinding, SendEmailAction } from './send-email-action.types.js';

interface GmailCanonicalExecutionPort {
  getProviderAccountRef(tenantId: string, principalId: string, requestId: string): string;
  requestApproval(input: { toolId: string; tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord;
  executeSendEmail(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedGmailExecutionResult>;
  executeReply(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedGmailExecutionResult>;
}

export interface PreparedEmailExecution {
  action: SendEmailAction;
  target: ExecutionTarget;
  approvalBinding: EmailApprovalBinding;
  gmailPayload: Record<string, unknown>;
}

export class GmailEmailExecutionAdapter {
  constructor(private readonly gmail: GmailCanonicalExecutionPort) {}

  public describeCapability(): MessagingExecutionCapability { return GMAIL_EMAIL_EXECUTION_CAPABILITY; }

  public prepare(action: SendEmailAction): PreparedEmailExecution {
    const currentRef = this.gmail.getProviderAccountRef(action.tenantId, action.ownerId, action.requestId);
    if (currentRef !== action.providerAccountRef) throw new NagexError({ code: 'REAPPROVAL_REQUIRED', category: 'POLICY', message: 'The connected Google account differs from the requested email authority.', request_id: action.requestId });
    if (action.to.length === 0) throw new NagexError({ code: 'INVALID_GMAIL_PAYLOAD', category: 'VALIDATION', message: 'SEND_EMAIL requires at least one recipient.', request_id: action.requestId });
    if ((action.attachments?.length ?? 0) > 0) throw new NagexError({ code: 'ATTACHMENTS_UNSUPPORTED', category: 'VALIDATION', message: 'Gmail attachment upload is not implemented in the current runtime.', request_id: action.requestId });
    const binding = buildGmailApprovalBinding(action);
    const gmailPayload = {
      from: action.displayIdentity ?? 'me', to: action.to, cc: action.cc ?? [], bcc: action.bcc ?? [], subject: action.subject, body: action.body,
      attachments: action.attachments ?? [], threadId: binding.threadId, replyToMessageId: binding.replyToMessageId,
      canonicalAction: binding.canonicalAction, providerAccountRef: binding.providerAccountRef,
      executionEnvironment: binding.environment, executionProvider: binding.provider, executionRoute: binding.executionRoute,
    };
    return { action: Object.freeze({ ...action }), target: mapGmailExecutionTarget(action), approvalBinding: binding, gmailPayload };
  }

  public requestApproval(action: SendEmailAction): { approval: ActionApprovalRecord; prepared: PreparedEmailExecution } {
    const prepared = this.prepare(action);
    const toolId = action.replyContext ? GMAIL_REPLY_TOOL_ID : GMAIL_SEND_EMAIL_TOOL_ID;
    const approval = this.gmail.requestApproval({ toolId, tenantId: action.tenantId, principalId: action.ownerId, payload: prepared.gmailPayload, requestId: action.requestId });
    return { approval, prepared };
  }

  public async executeApproved(action: SendEmailAction, approvalId: string, approvedPayload: unknown): Promise<MessagingExecutionResult> {
    this.prepare(action); // account and supported-feature drift check at execution time
    const input = { approvalId, payload: approvedPayload, tenantId: action.tenantId, principalId: action.ownerId, requestId: action.requestId };
    const result = action.replyContext ? await this.gmail.executeReply(input) : await this.gmail.executeSendEmail(input);
    return mapGmailCanonicalResult(action, result);
  }
}
