// DC3-B2 — human-readable Activity transformation for a verified UIA
// mutation. Proves the required "raw UIA events -> grouped execution ->
// human-readable activity" boundary at the code level: raw pattern/COM
// terminology (ValuePattern, InvokePattern, AutomationElement, RuntimeId,
// ProcessId, ControlType, …) never appears in the produced summary, and
// before/after text is carried only as SafeTextEvidence (redacted,
// length-capped) — never raw observed text — per the same redaction
// boundary this Preflight already established for window titles/control
// values.
import type { SafeTextEvidence } from './sensitive-text-redaction.js';

export type ActionKind = 'SET_VALUE' | 'INVOKE' | 'TOGGLE' | 'SELECT' | 'SCROLL';

export interface MutationActivityInput {
  action: ActionKind;
  targetLabel: string; // a plain, human label for the control (e.g. "테스트 입력값"), never an AutomationId/ControlType
  before: SafeTextEvidence;
  after: SafeTextEvidence;
  verified: boolean;
}

export interface MutationActivitySummary {
  headline: string;
  beforePreview: string;
  afterPreview: string;
  verifiedLine: string;
}

const HEADLINES: Record<ActionKind, string> = {
  SET_VALUE: '테스트 입력값을 변경했습니다.',
  INVOKE: '버튼을 실행했습니다.',
  TOGGLE: '체크 상태를 변경했습니다.',
  SELECT: '항목을 선택했습니다.',
  SCROLL: '화면을 스크롤했습니다.',
};

function evidencePreview(evidence: SafeTextEvidence): string {
  if (!evidence.present) return '(없음)';
  return evidence.redactedPreview;
}

// The only sanctioned way a completed mutation crosses into user-facing
// Activity. Raw pattern names, RuntimeIds, ProcessIds and ControlTypes are
// structurally absent from the return type — there is nothing here for a
// caller to accidentally surface.
export function toMutationActivitySummary(input: MutationActivityInput): MutationActivitySummary {
  return {
    headline: HEADLINES[input.action],
    beforePreview: evidencePreview(input.before),
    afterPreview: evidencePreview(input.after),
    verifiedLine: input.verified ? '✓ 변경 확인 완료' : '⚠ 변경 확인 실패',
  };
}

export function formatMutationActivityText(summary: MutationActivitySummary): string {
  return [summary.headline, '', 'Before', summary.beforePreview, '', 'After', summary.afterPreview, '', summary.verifiedLine].join('\n');
}
