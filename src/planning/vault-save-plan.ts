import { detectRequestLanguage } from '../common/request-language.js';
import type { PlanPreview } from '../model-gateway/ai-service.js';
import { checkVaultDraft, inlineVaultText, normalizeVaultText, vaultTitleFrom, VAULT_SAVE_LIMITS, type VaultDraftProblem, type VaultSaveSource } from '../workspace/vault-save-intent.js';

// D-9: the reviewed plan for "save this to my Vault". It is built from the person's own words - never by a model - so no fact can be invented: the content is EITHER the text they
// put in the request (quoted, or after "vault:") OR the previous answer they were looking at (sent by the screen), and the plan says which. When there is nothing to save, or the text
// cannot be stored as it is (too long), the answer is a plain question / reason - never a silently shortened or made-up draft. The draft then goes through the unchanged chain:
// plan seal -> "request approval" -> ActionApprovalStore -> Approve -> Capability Broker -> VaultSaveService.
export const VAULT_SAVE_TOOL_ID = 'vault.save_note';

export type VaultSavePlanResult =
  | { kind: 'PLAN'; plan: PlanPreview; source: VaultSaveSource }
  | { kind: 'NEEDS_CONTENT'; language: 'ko' | 'en'; message: { ko: string; en: string } }
  | { kind: 'INVALID'; language: 'ko' | 'en'; problem: VaultDraftProblem; message: { ko: string; en: string } };

const NEEDS_CONTENT = {
  ko: '무엇을 저장할지 알려 주세요. 저장할 내용을 큰따옴표로 감싸 함께 보내거나, 먼저 요약 같은 답변을 받은 뒤 "그 내용을 내 보관함에 저장해줘"라고 말해 주세요.',
  en: 'Tell me what to save: put the text in quotes in the same message, or first get the answer you want (for example a summary) and then say "save that to my Vault".',
};

const PROBLEM_TEXT: Record<VaultDraftProblem, { ko: string; en: string }> = {
  EMPTY: NEEDS_CONTENT,
  TOO_LONG: {
    ko: `내용이 너무 길어서 한 항목으로 저장할 수 없어요 (최대 ${VAULT_SAVE_LIMITS.contentChars.toLocaleString('en-US')}자). 아무것도 저장하지 않았어요. 더 짧게 나누어 요청해 주세요.`,
    en: `That text is too long to save as one item (up to ${VAULT_SAVE_LIMITS.contentChars.toLocaleString('en-US')} characters). Nothing was saved. Please send a shorter part.`,
  },
  BAD_CHARACTERS: { ko: '저장할 수 없는 문자가 들어 있어요. 아무것도 저장하지 않았어요.', en: 'The text contains characters that cannot be saved. Nothing was saved.' },
  BAD_SHAPE: { ko: '저장할 내용을 확인하지 못했어요. 아무것도 저장하지 않았어요.', en: 'I could not read what to save. Nothing was saved.' },
  BAD_TITLE: { ko: '제목을 만들지 못했어요. 아무것도 저장하지 않았어요.', en: 'I could not make a title. Nothing was saved.' },
  BAD_SOURCE: { ko: '저장할 내용의 출처를 확인하지 못했어요. 아무것도 저장하지 않았어요.', en: 'I could not tell where the text came from. Nothing was saved.' },
};

export function buildVaultSavePlan(input: { prompt: string; contextText?: string | null }): VaultSavePlanResult {
  const language: 'ko' | 'en' = detectRequestLanguage(input.prompt) === 'ko' ? 'ko' : 'en';
  const inline = inlineVaultText(input.prompt);
  const context = typeof input.contextText === 'string' ? input.contextText : '';
  const source: VaultSaveSource | null = inline ? 'USER_MESSAGE' : context.trim() ? 'PREVIOUS_ANSWER' : null;
  if (!source) return { kind: 'NEEDS_CONTENT', language, message: NEEDS_CONTENT };

  const content = normalizeVaultText(inline ?? context);
  const title = vaultTitleFrom(content, language);
  const checked = checkVaultDraft({ title, content, source });
  if (!checked.ok) return { kind: 'INVALID', language, problem: checked.problem, message: PROBLEM_TEXT[checked.problem] };

  const fromYou = source === 'USER_MESSAGE';
  const plan: PlanPreview = {
    goal: language === 'ko' ? '내 보관함에 저장' : 'Save to your Vault',
    summary: language === 'ko'
      ? '내 보관함에 저장합니다. 승인하기 전에는 아무것도 저장되지 않아요.'
      : 'Save to your Vault. Nothing is stored until you approve.',
    reasoningSummary: language === 'ko'
      ? (fromYou ? '요청에 직접 적어 주신 내용을 그대로 저장합니다.' : '바로 앞의 답변을 그대로 저장합니다. 요약하거나 고치지 않아요.')
      : (fromYou ? 'The text you wrote in the request is saved exactly as written.' : 'The previous answer is saved exactly as shown. It is not summarised or edited.'),
    kind: 'ACTION',
    suggestions: [],
    steps: [{
      step: 1,
      title: language === 'ko' ? '내 보관함에 저장' : 'Save to your Vault',
      reasoning: language === 'ko' ? '요청하신 대로, 아래 내용을 그대로 저장합니다.' : 'As you asked, the text below is saved as it is.',
      skill: 'skill.planning',
      tool: VAULT_SAVE_TOOL_ID,
      requiresApproval: true,
      necessity: 'REQUIRED',
      dependsOn: [],
      parameters: { title: checked.draft.title, content: checked.draft.content, source },
    }],
  };
  return { kind: 'PLAN', plan, source };
}
