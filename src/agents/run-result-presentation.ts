// R23.6E Phase F Section 8 — the one place a run's persisted status is
// translated into truthful, localized, user-facing copy. Never exposes an
// internal status code or failureReason directly (Section 24 of the
// original directive). SEND_STATUS_UNKNOWN is deliberately a DERIVED
// classification, not a new persisted E2EAgentRunStatus value (Section 6 —
// "prefer not to expand the persisted state enum unless necessary").
import type { CompetitorPricingRunRecord } from './competitor-pricing-email.types.js';
import type { ReportLocale } from './pricing-report-composer.js';

export type UserFacingResultKind = 'IN_PROGRESS' | 'SENT_CONFIRMED' | 'NOT_SENT' | 'SEND_FAILED' | 'SEND_STATUS_UNKNOWN';

export interface UserFacingRunResult {
  kind: UserFacingResultKind;
  message: string;
}

export function deriveUserFacingResult(run: CompetitorPricingRunRecord, locale: ReportLocale = 'en'): UserFacingRunResult {
  if (run.status === 'SENT_CONFIRMED') {
    const recipient = run.recipientEmail ?? (locale === 'ko' ? '수신자' : 'your recipient');
    return {
      kind: 'SENT_CONFIRMED',
      message: locale === 'ko' ? `가격 업데이트를 ${recipient}(으)로 보냈습니다.` : `The pricing update was sent to ${recipient}.`,
    };
  }

  if (run.status === 'BLOCKED') {
    return { kind: 'NOT_SENT', message: locale === 'ko' ? '이메일을 보내지 않았습니다.' : 'The email was not sent.' };
  }

  if (run.status === 'FAILED') {
    return { kind: 'SEND_FAILED', message: locale === 'ko' ? '이메일을 보낼 수 없었습니다.' : 'The email could not be sent.' };
  }

  // SEND_ATTEMPTED with no further transition is the truthful ambiguous
  // crash-window outcome from Phase E's executeApprovedSend() — never
  // presented as either a success or a failure, and never a signal to
  // retry automatically (Section 7 — UNKNOWN_SEND_AUTO_RETRY=0).
  if (run.status === 'SEND_ATTEMPTED') {
    return {
      kind: 'SEND_STATUS_UNKNOWN',
      message: locale === 'ko'
        ? 'NAgex가 전송을 시도했지만 최종 상태를 확인할 수 없습니다. 중복 발송을 피하기 위해 자동으로 다시 보내지 않습니다.'
        : 'NAgex attempted the send but cannot confirm its final status. It will not resend automatically to avoid a duplicate.',
    };
  }

  return { kind: 'IN_PROGRESS', message: locale === 'ko' ? '진행 중입니다.' : 'This is still in progress.' };
}
