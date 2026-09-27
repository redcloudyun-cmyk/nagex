// R23.6E Phase D — deterministic, localized report composition.
// Template-based, not model-generated: Phase C already proved
// UnifiedModelRouter prose composition is genuinely non-deterministic
// (identical facts produced different wording across two consecutive real
// calls), which is exactly the wrong property for text that becomes an
// approval-bound send payload. A template keeps the exact approved wording
// reproducible and trivially auditable, and Section 5 only ever says the
// model "may" be used for prose, never that it must be.
import type { CompetitorPricingBaselineRecord, PricingChange, UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

export type ReportLocale = 'en' | 'ko';

export interface PricingReportInput {
  competitor: string;
  current: UntrustedPricingEvidence;
  change: PricingChange;
  locale: ReportLocale;
  now: string;
}

export interface PricingReport {
  subject: string;
  body: string;
}

function formatDate(iso: string, locale: ReportLocale): string {
  try {
    return new Date(iso).toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatPrice(price: number | null, currency: string | null, locale: ReportLocale): string {
  if (price === null || currency === null) return locale === 'ko' ? '확인되지 않음' : 'Unknown';
  return `${currency} ${price}`;
}

function formatUnknown(value: string | null, locale: ReportLocale): string {
  return value ?? (locale === 'ko' ? '확인되지 않음' : 'Unknown');
}

// Section 2 — NO_BASELINE and NOT_DIRECTLY_COMPARABLE are deliberately
// distinct, truthful copy, never collapsed into a generic "no change data
// available."
function whatChangedSection(current: UntrustedPricingEvidence, change: PricingChange, previous: CompetitorPricingBaselineRecord | null, locale: ReportLocale): string {
  if (!change.comparable) {
    if (change.reason === 'NO_BASELINE') {
      return locale === 'ko'
        ? '현재 가격은 확인되었지만, 동일한 비교 기준(요금제/통화/결제 주기/지역)에 대한 이전 검증 기록이 없어 변경 여부를 판단할 수 없습니다.'
        : 'The current pricing was verified, but no previous verified record exists for the same comparison dimensions, so a change cannot be determined.';
    }
    // NOT_DIRECTLY_COMPARABLE
    return locale === 'ko'
      ? '이전 검증 기록이 존재하지만 비교 조건(요금제/통화/결제 주기/지역/세금 기준)이 달라 직접적인 가격 변동으로 볼 수 없습니다.'
      : 'A previous verified record exists, but the comparison conditions differ, so the values cannot be treated as a direct price change.';
  }

  const abs = change.absoluteChange ?? 0;
  const pct = change.percentChange;
  const prevText = previous ? formatPrice(previous.price, previous.currency, locale) : formatUnknown(null, locale);
  const pctText = pct !== undefined ? ` (${abs >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';

  if (abs === 0) {
    return locale === 'ko'
      ? `가격은 이전 검증 기록(${prevText}) 대비 변동이 없습니다.`
      : `Price is unchanged from the previous verified record (${prevText}).`;
  }
  if (abs > 0) {
    return locale === 'ko'
      ? `가격이 이전 검증 기록(${prevText}) 대비 ${current.currency} ${abs} 인상되었습니다${pctText}.`
      : `Price increased by ${current.currency} ${abs} from the previous verified record (${prevText})${pctText}.`;
  }
  return locale === 'ko'
    ? `가격이 이전 검증 기록(${prevText}) 대비 ${current.currency} ${Math.abs(abs)} 인하되었습니다${pctText}.`
    : `Price decreased by ${current.currency} ${Math.abs(abs)} from the previous verified record (${prevText})${pctText}.`;
}

// Section 4 — only safe source metadata, never raw page text/instructions.
function sourcesSection(current: UntrustedPricingEvidence, locale: ReportLocale): string {
  const label = locale === 'ko' ? '출처' : 'Source';
  const retrieved = locale === 'ko' ? '확인 시각' : 'Retrieved';
  return `- ${label}: ${current.title} (${current.sourceUrl})\n  ${retrieved}: ${current.retrievedAt}`;
}

function limitationsSection(current: UntrustedPricingEvidence, locale: ReportLocale): string {
  const missing: string[] = [];
  if (current.price === null) missing.push(locale === 'ko' ? '가격' : 'price');
  if (current.currency === null) missing.push(locale === 'ko' ? '통화' : 'currency');
  if (current.billingPeriod === null) missing.push(locale === 'ko' ? '결제 주기' : 'billing period');
  if (current.region === null) missing.push(locale === 'ko' ? '지역' : 'region');
  if (current.taxIncluded === null) missing.push(locale === 'ko' ? '세금 포함 여부' : 'tax inclusion');

  if (missing.length === 0) {
    return locale === 'ko' ? '이 보고서의 모든 항목은 확인된 출처에 근거합니다.' : 'Every item in this report is grounded in a verified source.';
  }
  return locale === 'ko'
    ? `다음 항목은 출처에서 명확히 확인되지 않아 "확인되지 않음"으로 표시했습니다: ${missing.join(', ')}.`
    : `The following were not clearly stated in the source and are reported as unknown rather than assumed: ${missing.join(', ')}.`;
}

export function composePricingReport(input: PricingReportInput): PricingReport {
  const { competitor, current, change, locale, now } = input;
  const previous = change.previous;
  const dateText = formatDate(now, locale);

  const subject = locale === 'ko'
    ? `${competitor} 가격 업데이트 — ${dateText}`
    : `${competitor} Pricing Update — ${dateText}`;

  const currentPriceLine = locale === 'ko'
    ? `현재 가격: ${formatPrice(current.price, current.currency, locale)}${current.planName ? ` (${current.planName})` : ''}${current.billingPeriod ? `, ${current.billingPeriod}` : ''}`
    : `Current price: ${formatPrice(current.price, current.currency, locale)}${current.planName ? ` (${current.planName})` : ''}${current.billingPeriod ? `, ${current.billingPeriod}` : ''}`;

  const summaryLine = locale === 'ko'
    ? `${competitor}의 최신 가격 정보를 확인했습니다.`
    : `Checked ${competitor}'s current pricing.`;

  const sections = [
    locale === 'ko' ? '1. 요약' : '1. Summary',
    summaryLine,
    '',
    locale === 'ko' ? '2. 현재 가격' : '2. Current Pricing',
    currentPriceLine,
    '',
    locale === 'ko' ? '3. 변경 사항' : '3. What Changed',
    whatChangedSection(current, change, previous, locale),
    '',
    locale === 'ko' ? '4. 출처' : '4. Sources',
    sourcesSection(current, locale),
    '',
    locale === 'ko' ? '5. 제한 사항' : '5. Limitations',
    limitationsSection(current, locale),
  ];

  return { subject, body: sections.join('\n') };
}
