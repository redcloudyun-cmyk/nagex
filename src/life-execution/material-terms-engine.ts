import type { MaterialTerms, ReservationCandidate, ReservationIntent } from './life-execution.types.js';

export class MaterialTermsEngine {
  normalize(intent: ReservationIntent, candidate: ReservationCandidate): MaterialTerms {
    const evidence = candidate.availability;
    const status = evidence.identityVerified
      && evidence.dateTimeVerified
      && evidence.availabilityVerified
      && evidence.termsVerified
      ? 'VERIFIED'
      : evidence.identityVerified || evidence.availabilityVerified
        ? 'PARTIAL'
        : 'UNKNOWN';

    return {
      target: candidate.title,
      provider: candidate.providerName,
      date: candidate.date ?? intent.date,
      timeWindow: candidate.timeWindow ?? intent.timeWindow,
      partySize: candidate.partySize ?? intent.partySize,
      quantity: candidate.quantity ?? intent.quantity,
      price: candidate.price,
      cancellationPolicy: evidence.termsVerified ? 'provider-disclosed' : undefined,
      refundPolicy: evidence.termsVerified ? 'provider-disclosed' : undefined,
      depositRequired: intent.paymentRequirement === 'DEPOSIT',
      paymentRequirement: intent.paymentRequirement,
      personalDataRequired: ['name', 'contact'],
      status,
      evidenceRefs: evidence.rawEvidenceRef ? [evidence.rawEvidenceRef] : [evidence.source],
      version: this.versionFor({
        target: candidate.title,
        provider: candidate.providerName,
        date: candidate.date ?? intent.date,
        timeWindow: candidate.timeWindow ?? intent.timeWindow,
        partySize: candidate.partySize ?? intent.partySize,
        quantity: candidate.quantity ?? intent.quantity,
        price: candidate.price,
        paymentRequirement: intent.paymentRequirement,
      }),
    };
  }

  classifyChange(previous: MaterialTerms, next: MaterialTerms): MaterialTerms['status'] {
    return this.materiallyEqual(previous, next) ? next.status : 'CHANGED';
  }

  requiresReapproval(previous: MaterialTerms, next: MaterialTerms): boolean {
    return this.classifyChange(previous, next) === 'CHANGED';
  }

  private materiallyEqual(previous: MaterialTerms, next: MaterialTerms): boolean {
    return previous.target === next.target
      && previous.provider === next.provider
      && previous.date === next.date
      && previous.timeWindow === next.timeWindow
      && previous.partySize === next.partySize
      && previous.quantity === next.quantity
      && previous.paymentRequirement === next.paymentRequirement
      && this.moneyKey(previous.price) === this.moneyKey(next.price)
      && previous.cancellationPolicy === next.cancellationPolicy
      && previous.refundPolicy === next.refundPolicy
      && previous.depositRequired === next.depositRequired;
  }

  private moneyKey(price: MaterialTerms['price']): string {
    return price ? `${price.currency}:${price.amount}` : 'none';
  }

  private versionFor(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }
}
