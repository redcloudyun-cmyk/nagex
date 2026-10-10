import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionRoute, MaterialTerms, ReservationProposal } from './life-execution.types.js';

export interface ApprovalBinding {
  readonly approvalId: string;
  readonly target: string;
  readonly provider: string;
  readonly date?: string;
  readonly timeWindow?: string;
  readonly partySize?: number;
  readonly price?: MaterialTerms['price'];
  readonly termsVersion: string;
  readonly routeKind: ExecutionRoute['routeKind'];
  readonly routeProviderId: string;
  readonly payloadVersion: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly payloadHash: string;
  readonly bookingAuthority: 'NOT_GRANTED' | 'GRANTED';
  readonly paymentAuthority: 'NOT_REQUIRED' | 'NOT_GRANTED' | 'GRANTED';
}

export class LifeExecutionApprovalBinder {
  bind(proposal: ReservationProposal, options: { readonly expiresAt: string; readonly nonce?: string }): ApprovalBinding {
    const nonce = options.nonce ?? randomUUID();
    const payload = {
      target: proposal.materialTerms.target,
      provider: proposal.materialTerms.provider,
      date: proposal.materialTerms.date,
      timeWindow: proposal.materialTerms.timeWindow,
      partySize: proposal.materialTerms.partySize,
      price: proposal.materialTerms.price,
      termsVersion: proposal.materialTerms.version,
      routeKind: proposal.route.routeKind,
      routeProviderId: proposal.route.providerId,
      payloadVersion: proposal.materialTerms.version,
      expiresAt: options.expiresAt,
      nonce,
    };
    return {
      approvalId: `approval_${this.hash(payload).slice(0, 16)}`,
      ...payload,
      payloadHash: this.hash(payload),
      bookingAuthority: 'GRANTED',
      paymentAuthority: proposal.materialTerms.paymentRequirement === 'NONE' || proposal.materialTerms.paymentRequirement === 'PAY_LATER'
        ? 'NOT_REQUIRED'
        : 'NOT_GRANTED',
    };
  }

  hasPayloadDrift(binding: ApprovalBinding, proposal: ReservationProposal): boolean {
    return binding.target !== proposal.materialTerms.target
      || binding.provider !== proposal.materialTerms.provider
      || binding.date !== proposal.materialTerms.date
      || binding.timeWindow !== proposal.materialTerms.timeWindow
      || binding.partySize !== proposal.materialTerms.partySize
      || binding.termsVersion !== proposal.materialTerms.version
      || binding.routeKind !== proposal.route.routeKind
      || binding.routeProviderId !== proposal.route.providerId
      || JSON.stringify(binding.price ?? null) !== JSON.stringify(proposal.materialTerms.price ?? null);
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
