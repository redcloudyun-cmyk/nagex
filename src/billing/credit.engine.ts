import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AgexError } from '../common/errors.js';
import { BillingLedgerEngine, type LedgerEntry } from './billing.ledger.js';

// docs/supplemental/S-07-billing-ai-provider.md -- Phase 1 ("Billing
// Foundation") only. Builds on BillingLedgerEngine rather than replacing it:
// every credit movement here still goes through postLedgerEntry() so the
// existing immutability/Adjustment-only-correction guarantee (S-06 Rule 56)
// applies to Credits too.

export type BillingAccountStatus = 'ACTIVE' | 'SUSPENDED';

export interface BillingAccount {
  billing_account_id: string;
  tenant_id: string;
  credit_balance: number;
  status: BillingAccountStatus;
  created_at: string;
}

// S-07 SS10.5 -- illustrative/placeholder pricing seeded from the spec's own
// SS6.2 worked example. NOT a live price feed -- there is no real outbound
// Provider call in this codebase yet (LLM integration is a separate,
// already-deferred decision).
export interface ProviderPriceCatalogEntry {
  provider: string;
  model: string;
  input_unit_price: number;
  output_unit_price: number;
  currency: string;
}

export const PROVIDER_PRICE_CATALOG: readonly ProviderPriceCatalogEntry[] = Object.freeze([
  { provider: 'anthropic', model: 'claude', input_unit_price: 0.04, output_unit_price: 0.04, currency: 'USD' },
]);

// S-07 SS6.1 Credit Usage formula. Domains that don't yet report real usage
// (tool/memory/rag/storage/premium) pass 0 or omit the field -- the formula
// itself is complete; only the inputs are partially wired until those
// domains exist.
export interface CreditCostBreakdown {
  llm_cost_unit?: number;
  runtime_unit?: number;
  tool_unit?: number;
  memory_unit?: number;
  rag_unit?: number;
  storage_unit?: number;
  premium_capability_unit?: number;
  policy_adjustment?: number;
  margin?: number;
}

// S-07 SS6.2 worked example: $0.060 internal cost -> 90 Credits.
const CREDIT_PER_USD = 1500;

// Shared by computeCreditCost() and the S-07 SS11.4 estimate endpoint (which
// needs the raw USD figure, not just the Credit-converted one) -- kept as
// one function so the two never drift apart.
export function sumBreakdownUsd(breakdown: CreditCostBreakdown): number {
  return (
    (breakdown.llm_cost_unit ?? 0) +
    (breakdown.runtime_unit ?? 0) +
    (breakdown.tool_unit ?? 0) +
    (breakdown.memory_unit ?? 0) +
    (breakdown.rag_unit ?? 0) +
    (breakdown.storage_unit ?? 0) +
    (breakdown.premium_capability_unit ?? 0) +
    (breakdown.policy_adjustment ?? 0) +
    (breakdown.margin ?? 0)
  );
}

export function computeCreditCost(breakdown: CreditCostBreakdown): number {
  return Math.round(sumBreakdownUsd(breakdown) * CREDIT_PER_USD);
}

export interface ChargeResult {
  account: BillingAccount;
  cost: number;
  ledger_entry: LedgerEntry;
}

export class CreditEngine {
  private accounts: Map<string, BillingAccount> = new Map();
  private ledger: BillingLedgerEngine;

  constructor(ledger: BillingLedgerEngine) {
    this.ledger = ledger;
  }

  public getOrCreateAccount(tenantId: string): BillingAccount {
    let account = this.accounts.get(tenantId);
    if (!account) {
      account = {
        billing_account_id: generateResourceId('bac'),
        tenant_id: tenantId,
        credit_balance: 0,
        status: 'ACTIVE',
        created_at: getCurrentISOString(),
      };
      this.accounts.set(tenantId, account);
    }
    return account;
  }

  // S-07 SS9.1 CREDIT_GRANT. Credits are a discrete count (spec examples:
  // "90 Credits", "19 Credits"), so entry amounts are plain integer strings
  // here -- not the decimal-currency-string convention (S-06 Rule 16) used
  // for real-money CHARGE/ADJUSTMENT entries elsewhere in this ledger.
  public grantCredits(tenantId: string, amount: number, reason: string): BillingAccount {
    const account = this.getOrCreateAccount(tenantId);
    account.credit_balance += amount;
    this.ledger.postLedgerEntry(account.billing_account_id, 'CREDIT_GRANT', String(amount), 'CREDIT', reason);
    return account;
  }

  // S-07 SS14.1: insufficient balance is rejected before any deduction --
  // BILLING_INSUFFICIENT_CREDIT, category QUOTA (S-07 SS23).
  public chargeCredits(
    tenantId: string,
    breakdown: CreditCostBreakdown,
    referenceExecutionId: string
  ): ChargeResult {
    const account = this.getOrCreateAccount(tenantId);
    const cost = computeCreditCost(breakdown);

    if (account.credit_balance < cost) {
      throw new AgexError({
        code: 'BILLING_INSUFFICIENT_CREDIT',
        category: 'QUOTA',
        message: `Tenant ${tenantId} has insufficient credit balance (${account.credit_balance}) for a charge of ${cost}.`,
        request_id: 'bill_req',
      });
    }

    account.credit_balance -= cost;
    const ledger_entry = this.ledger.postLedgerEntry(
      account.billing_account_id,
      'CREDIT_USAGE',
      String(cost),
      'CREDIT',
      referenceExecutionId
    );

    return { account, cost, ledger_entry };
  }
}
