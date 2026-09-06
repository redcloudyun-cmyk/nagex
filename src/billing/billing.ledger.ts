import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';

export type LedgerEntryType =
  | 'CHARGE'
  | 'CREDIT'
  | 'ADJUSTMENT'
  | 'REFUND'
  | 'TAX'
  | 'DISCOUNT'
  // S-07 §9.1 Phase 1 subset (Credit Engine). BYOK/Enterprise-only types
  // (BYOK_RUNTIME_USAGE, ENTERPRISE_USAGE, SUBSCRIPTION_CHARGE, TOOL_USAGE,
  // STORAGE_USAGE, WORKFLOW_USAGE) are intentionally not added yet -- those
  // flows don't exist in this codebase (see S-07 for Phase status).
  | 'CREDIT_GRANT'
  | 'CREDIT_USAGE'
  | 'CREDIT_PURCHASE'
  | 'CREDIT_REFUND'
  | 'CREDIT_ADJUSTMENT'
  | 'LLM_USAGE'
  | 'AGENT_RUNTIME_USAGE';

export interface UsageRecord {
  usage_id: string;
  tenant_id: string;
  execution_id: string;
  usage_type: string; // 예: MODEL_INPUT_TOKEN, RUNTIME_SECOND
  quantity: number;
  unit: string;
  idempotency_key: string;
  occurred_at: string;
}

export interface LedgerEntry {
  ledger_entry_id: string;
  billing_account_id: string;
  entry_type: LedgerEntryType;
  amount: string; // Float 금지 -> String Decimal 사용 (Rule 16 in S-06)
  currency: string;
  reference: string;
  occurred_at: string;
  posted_at: string;
}

export class BillingLedgerEngine {
  private usageStore: Map<string, UsageRecord> = new Map();
  private idempotencyKeys: Set<string> = new Set();
  private ledgerEntries: LedgerEntry[] = [];

  public recordUsage(record: Omit<UsageRecord, 'usage_id' | 'occurred_at'>): UsageRecord {
    // 1. Idempotency Check (Rule 39 in S-06)
    if (this.idempotencyKeys.has(record.idempotency_key)) {
      throw new NagexError({
        code: 'DUPLICATE_USAGE_RECORD',
        category: 'CONFLICT',
        message: `Usage record with idempotency key ${record.idempotency_key} already recorded.`,
        request_id: 'bill_req',
      });
    }

    const usage_id = generateResourceId('usg');
    const usage: UsageRecord = {
      ...record,
      usage_id,
      occurred_at: getCurrentISOString(),
    };

    this.idempotencyKeys.add(record.idempotency_key);
    this.usageStore.set(usage_id, usage);
    return usage;
  }

  public postLedgerEntry(
    billingAccountId: string,
    entryType: LedgerEntryType,
    amount: string,
    currency: string,
    reference: string
  ): LedgerEntry {
    const entry: LedgerEntry = {
      ledger_entry_id: generateResourceId('led'),
      billing_account_id: billingAccountId,
      entry_type: entryType,
      amount,
      currency,
      reference,
      occurred_at: getCurrentISOString(),
      posted_at: getCurrentISOString(),
    };

    // Immutable Posted Entry (Rule 56 in S-06)
    this.ledgerEntries.push(Object.freeze(entry));
    return entry;
  }

  public adjustLedger(
    billingAccountId: string,
    adjustmentAmount: string,
    currency: string,
    reasonReference: string
  ): LedgerEntry {
    // Posted entries cannot be deleted/modified. Corrections must be made via ADJUSTMENT entry.
    return this.postLedgerEntry(billingAccountId, 'ADJUSTMENT', adjustmentAmount, currency, reasonReference);
  }

  public getLedgerEntries(billingAccountId: string): LedgerEntry[] {
    return this.ledgerEntries.filter(e => e.billing_account_id === billingAccountId);
  }
}
