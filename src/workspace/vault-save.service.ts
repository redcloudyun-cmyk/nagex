import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import type { ActionApprovalRecord, ActionApprovalStore } from '../governance/action-approval.store.js';
import type { ActivityStore } from '../governance/activity.store.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { ExecutionStore } from '../governance/execution.store.js';
import { checkVaultDraft, type VaultDraftProblem, type VaultSaveDraft } from './vault-save-intent.js';
import type { VaultStore } from './vault.store.js';

// D-9 - the first OWNER-LOCAL, approval-gated action: "save this to my Vault". It plugs into the existing machinery and adds none of its own:
//   * the Capability Broker calls requestApproval() (the first call - nothing is written) and executeApproved() (the resume call with an approval id);
//   * the approval is the existing ActionApprovalStore: hash-bound to the exact frozen draft, owner-bound, one-time, expiring;
//   * the write goes to the same VaultStore the Vault screen reads, so the item is the one the person opens again.
// Exactly-once: the approval is CONSUMED first (one-time, synchronous), the item id is derived from the approval (a repeat can only rewrite the same item), and "saved" is only reported
// after the item has been read back for its owner. If anything fails after the approval was spent, the run FAILS truthfully and the person asks again - never a second item, never a
// fake "saved".
export const VAULT_SAVE_CAPABILITY_ID = 'vault.save_note';

export interface VaultSaveServiceDeps {
  approvals: ActionApprovalStore;
  vault: Pick<VaultStore, 'saveItemOnce' | 'getItem'>;
  activity: ActivityStore;
  audit: AuditLogger;
  executions: ExecutionStore;
}

export interface VaultSaveIdentity {
  tenantId: string;
  principalId: string;
  requestId: string;
}

export interface CanonicalVaultDraft extends VaultSaveDraft {
  destination: 'MY_VAULT';
  [key: string]: unknown;
}

export interface VaultSaveResult {
  outcome: 'SAVED_TO_VAULT';
  vaultItemId: string;
  title: string;
  bytes: number;
  executionId: string;
  destination: 'MY_VAULT';
  verification: { status: 'VERIFIED'; reason: 'REREAD_FROM_OWNER_VAULT' };
}

const PROBLEM_MESSAGE: Record<VaultDraftProblem, string> = {
  EMPTY: 'There is nothing to save.',
  TOO_LONG: 'The text is too long to save in one item.',
  BAD_CHARACTERS: 'The text contains characters that cannot be saved.',
  BAD_SHAPE: 'The Vault draft must contain exactly a title, the content and where the content came from.',
  BAD_TITLE: 'The title is missing or too long.',
  BAD_SOURCE: 'The source of the content is not recognised.',
};

export function vaultItemIdFor(tenantId: string, principalId: string, approvalId: string): string {
  return `vlt_${crypto.createHash('sha256').update(`vault.save_note|${tenantId}|${principalId}|${approvalId}`).digest('hex').slice(0, 32)}`;
}

export class VaultSaveService {
  constructor(private readonly deps: VaultSaveServiceDeps) {}

  // The frozen, canonical payload an approval is bound to (and the broker request must hash to). Throws on anything that is not a valid draft.
  public static canonicalDraft(payload: unknown, requestId: string): CanonicalVaultDraft {
    const checked = checkVaultDraft(payload);
    if (!checked.ok) {
      throw new NagexError({ code: 'VAULT_SAVE_INVALID_DRAFT', category: 'VALIDATION', message: PROBLEM_MESSAGE[checked.problem], request_id: requestId, details: { problem: checked.problem } });
    }
    return { title: checked.draft.title, content: checked.draft.content, source: checked.draft.source, destination: 'MY_VAULT' };
  }

  // First call: validates and FREEZES the draft, then asks for the approval. Nothing is stored.
  public requestApproval(request: VaultSaveIdentity & { payload: unknown }): ActionApprovalRecord {
    const draft = VaultSaveService.canonicalDraft(request.payload, request.requestId);
    const approval = this.deps.approvals.request({ toolId: VAULT_SAVE_CAPABILITY_ID, tenantId: request.tenantId, principalId: request.principalId, payload: draft });
    this.deps.audit.logEvent({
      actor: { type: 'user', id: request.principalId },
      tenant_id: request.tenantId,
      action: 'approval.requested',
      resource: { type: 'ActionApproval', id: approval.approvalId },
      result: 'PENDING_APPROVAL',
      request_id: request.requestId,
      // sizes and a short digest only - never the text or the title
      details: { toolId: VAULT_SAVE_CAPABILITY_ID, provider: 'VAULT', bytes: Buffer.byteLength(draft.content, 'utf8'), source: draft.source },
    });
    return approval;
  }

  // Resume call with the approval the person granted. Verifies the approval against the exact draft, spends it, stores the item once and proves it can be read back.
  public async executeApproved(request: VaultSaveIdentity & { payload: unknown; approvalId: string }): Promise<VaultSaveResult> {
    const draft = VaultSaveService.canonicalDraft(request.payload, request.requestId);
    const executionId = generateResourceId('exe');
    // hash-bound, owner-bound, one-time: any mismatch, replay, expiry or foreign owner throws here, BEFORE anything is written
    this.deps.approvals.consume(request.approvalId, request.tenantId, request.principalId, VAULT_SAVE_CAPABILITY_ID, draft, request.requestId, executionId);
    this.deps.executions.start({ executionId, toolId: VAULT_SAVE_CAPABILITY_ID, approvalId: request.approvalId, tenantId: request.tenantId, principalId: request.principalId, startedAt: getCurrentISOString() });
    this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.started', resource: { type: 'ToolExecution', id: executionId }, result: 'PENDING_APPROVAL', request_id: request.requestId, details: { toolId: VAULT_SAVE_CAPABILITY_ID, approvalId: request.approvalId, provider: 'VAULT' } });

    const vaultItemId = vaultItemIdFor(request.tenantId, request.principalId, request.approvalId);
    const bytes = Buffer.byteLength(draft.content, 'utf8');
    try {
      this.deps.vault.saveItemOnce({
        vaultItemId,
        tenantId: request.tenantId,
        userId: request.principalId,
        type: 'DOCUMENT',
        title: draft.title,
        mimeType: 'text/plain',
        storageRef: `approved-save:${request.approvalId}`,
        source: 'APPROVED_SAVE',
        sourceRef: request.approvalId,
        metadata: {
          contentText: draft.content,
          sizeBytes: bytes,
          category: 'NOTE',
          draftSource: draft.source,
          draftVersion: 1,
          contentSha256: crypto.createHash('sha256').update(draft.content, 'utf8').digest('hex'),
          approvalId: request.approvalId,
          executionId,
        },
      });
      // "saved" means: the owner can read exactly this text back
      const reread = this.deps.vault.getItem(vaultItemId, request.tenantId, request.principalId);
      if (!reread || reread.metadata?.contentText !== draft.content) throw new Error('VAULT_ITEM_NOT_VERIFIED');
    } catch (error) {
      const code = error instanceof Error && /^VAULT_[A-Z_]+$/.test(error.message) ? error.message : 'VAULT_SAVE_FAILED';
      this.deps.executions.fail(executionId, { errorCode: code, completedAt: getCurrentISOString() });
      this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.failed', resource: { type: 'ToolExecution', id: executionId }, result: 'FAILED', reason_code: code, request_id: request.requestId, details: { toolId: VAULT_SAVE_CAPABILITY_ID, provider: 'VAULT' } });
      this.recordActivity(request, draft.title, executionId, 'FAILED');
      throw new NagexError({ code, category: 'INTERNAL', message: 'The Vault could not store this item, so nothing was saved. The approval was used; ask again to get a fresh one.', request_id: request.requestId });
    }

    this.deps.executions.succeed(executionId, { externalId: vaultItemId, externalUrl: `/api/v1/workspace/vault/${vaultItemId}`, completedAt: getCurrentISOString() });
    this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.succeeded', resource: { type: 'ToolExecution', id: executionId }, result: 'SUCCESS', request_id: request.requestId, details: { toolId: VAULT_SAVE_CAPABILITY_ID, provider: 'VAULT', vaultItemId, bytes } });
    this.recordActivity(request, draft.title, executionId, 'COMPLETED');
    return { outcome: 'SAVED_TO_VAULT', vaultItemId, title: draft.title, bytes, executionId, destination: 'MY_VAULT', verification: { status: 'VERIFIED', reason: 'REREAD_FROM_OWNER_VAULT' } };
  }

  // The consumer Activity feed: one record per approval (dedupe key), title only - never the content. A failure to write the feed never changes the outcome of the save.
  private recordActivity(request: VaultSaveIdentity & { approvalId: string }, title: string, executionId: string, status: 'COMPLETED' | 'FAILED'): void {
    try {
      this.deps.activity.record({
        tenantId: request.tenantId,
        principalId: request.principalId,
        type: status === 'COMPLETED' ? 'vault.item_saved' : 'vault.item_save_failed',
        title: status === 'COMPLETED' ? `Saved to Vault: ${title}` : `Could not save to Vault: ${title}`,
        status,
        source: { approvalId: request.approvalId, executionId },
        dedupeKey: `vault_save:${request.approvalId}`,
      });
    } catch {
      /* the feed is a projection; the audit trail above is the record of truth */
    }
  }
}
