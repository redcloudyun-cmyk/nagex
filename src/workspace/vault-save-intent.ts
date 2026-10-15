// D-9: "save this to my Vault" - the one owner-local action NAgex asks the person to approve. Pure functions, no I/O, no model: the words of the request decide WHETHER this is a
// Vault save and WHICH text is meant; nothing is ever composed by a model, so nothing can be invented. Used by the input router (to route it as an approval-gated plan) and by the
// plan builder (to freeze the exact draft the person will approve).

const VAULT_WORD = /(보관함|볼트|\bvault\b)/i;

// Korean: "<...>보관함에 저장해줘 / 넣어줘 / 보관해줘"; English: "save/store/put/add/keep ... (to|in|into) (my) vault"
const SAVE_KO = /(저장|보관(?!함)|넣|담아|담아서|올려|추가)[^.!?\n]{0,8}(줘|주세요|줄래|주라|달라|해\s*줘|해\s*주세요|할래|해라)/;
const SAVE_EN = /\b(save|store|put|add|file|keep|stash|copy)\b[^.!?\n]{0,120}\b(to|in|into|on)\s+(my\s+|the\s+|your\s+)?vault\b/i;
// a question about how/where to do it is information, not a request ("보관함에 어떻게 저장해?", "How do I save something to my Vault?")
const INFO_KO = /(어떻게|어디|무엇|뭐가|왜|할\s*수\s*있|가능한가|가능해|방법)/;
const INFO_EN = /^\s*(how|where|what|why|which|when|is it possible|can i|could i|do i|does)\b/i;

export function isVaultSaveRequest(text: string): boolean {
  const t = (text || '').normalize('NFC');
  if (!VAULT_WORD.test(t)) return false;
  const asksSave = SAVE_KO.test(t) || SAVE_EN.test(t);
  if (!asksSave) return false;
  if (INFO_EN.test(t) || (/[가-힣]/.test(t) && INFO_KO.test(t) && !/(줘|주세요|줄래)/.test(t))) return false;
  return true;
}

// The text the person put in the request itself: quoted ("..." or Korean quotes), or everything after "vault:" / "보관함에 저장해줘:". Nothing else is "supplied".
export function inlineVaultText(text: string): string | null {
  const t = (text || '').normalize('NFC');
  const colon = /^[^:：\n]{0,80}?(?:보관함|볼트|vault)[^:：\n]{0,40}[:：]\s*([\s\S]+)$/i.exec(t);
  if (colon && colon[1].trim()) return colon[1].trim();
  const quoted = /["“”「『]([^"“”」』]{1,20000})["“”」』]/.exec(t);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  return null;
}

export type VaultSaveSource = 'USER_MESSAGE' | 'PREVIOUS_ANSWER';

export const VAULT_SAVE_LIMITS = { titleChars: 120, contentChars: 20000, contentBytes: 64 * 1024 } as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function normalizeVaultText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

// A short title taken from the text itself (first meaningful line, markdown marks removed) - never invented.
export function vaultTitleFrom(content: string, language: 'ko' | 'en'): string {
  const first = content.split('\n').map((l) => l.replace(/^[\s#>*\-+\d.)]+/, '').replace(/[*_`]+/g, '').trim()).find((l) => l.length > 0) ?? '';
  if (!first) return language === 'ko' ? '저장한 노트' : 'Saved note';
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return (space > 30 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

export interface VaultSaveDraft {
  title: string;
  content: string;
  source: VaultSaveSource;
}

export type VaultDraftProblem = 'EMPTY' | 'TOO_LONG' | 'BAD_CHARACTERS' | 'BAD_SHAPE' | 'BAD_TITLE' | 'BAD_SOURCE';

// Strict: exactly {title, content, source}, bounded, printable text. The same function validates the plan the person is shown AND the payload at request/execute time.
export function checkVaultDraft(payload: unknown): { ok: true; draft: VaultSaveDraft } | { ok: false; problem: VaultDraftProblem } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, problem: 'BAD_SHAPE' };
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.includes('title') || !keys.includes('content') || !keys.includes('source')) return { ok: false, problem: 'BAD_SHAPE' };
  if (record.source !== 'USER_MESSAGE' && record.source !== 'PREVIOUS_ANSWER') return { ok: false, problem: 'BAD_SOURCE' };
  if (typeof record.title !== 'string' || typeof record.content !== 'string') return { ok: false, problem: 'BAD_SHAPE' };
  const title = record.title.replace(/\s+/g, ' ').trim();
  const content = normalizeVaultText(record.content);
  if (!title || title.length > VAULT_SAVE_LIMITS.titleChars || CONTROL.test(title)) return { ok: false, problem: 'BAD_TITLE' };
  if (!content) return { ok: false, problem: 'EMPTY' };
  if (CONTROL.test(content)) return { ok: false, problem: 'BAD_CHARACTERS' };
  if (content.length > VAULT_SAVE_LIMITS.contentChars || Buffer.byteLength(content, 'utf8') > VAULT_SAVE_LIMITS.contentBytes) return { ok: false, problem: 'TOO_LONG' };
  return { ok: true, draft: { title, content, source: record.source } };
}
