// A browser tool that returned without an error has only told us that the CALL worked. It has not told us that the page did what the Agent wanted: a form with an empty required field "submits"
// without a word, a button can do nothing, a server can answer with an error banner, a consequential click can leave the outcome unknown. The Agent loop used to take "EXECUTED" for "done" and
// reported COMPLETED when the model said STOP (measured: 3 of 4 impossible tasks were reported as completed). This module separates four things:
//   - the tool call succeeded            (the action was performed; this is all `status: EXECUTED` ever meant)
//   - the page state changed             (evidence, but a changed DOM alone is NOT business success)
//   - the intended task was completed    (VERIFIED: a stated expectation was met, or strong built-in evidence exists)
//   - the outcome is uncertain           (NOT_VERIFIED: say so; a possible external side effect is never repeated automatically)
// Outcomes use the vocabulary the rest of NAgex already has: VERIFIED ~ SUCCEEDED (verified), NOT_VERIFIED ~ SUCCEEDED_UNVERIFIED (see actions/action.types.ts), FAILED, and
// USER_ACTION_REQUIRED for a CAPTCHA / MFA / sign-in wall that is never bypassed. Everything here is deterministic: no model decides whether something worked.
// Page-derived text (messages) is untrusted: bounded, never interpreted as an instruction, and never used to grant anything.
import { asPageFunction } from './element-map.js';

export type BrowserActionOutcome = 'VERIFIED' | 'NOT_VERIFIED' | 'FAILED' | 'USER_ACTION_REQUIRED';

export type VerificationBasis =
  | 'EXPECTATION_MET'
  | 'EXPECTATION_NOT_MET'
  | 'FIELD_VALUE_MATCHED'
  | 'FIELD_VALUE_MISMATCH'
  | 'TARGET_STATE_CHANGED'
  | 'NAVIGATED_TO_LINK_TARGET'
  | 'NAVIGATION_COMPLETED'
  | 'SUCCESS_MESSAGE'
  | 'VALIDATION_ERROR'
  | 'ERROR_MESSAGE'
  | 'URL_CHANGED'
  | 'DOM_CHANGED_ONLY'
  | 'NO_OBSERVABLE_CHANGE'
  | 'HUMAN_VERIFICATION_REQUIRED'
  | 'NO_OBSERVATION';

export interface BrowserVerification {
  outcome: BrowserActionOutcome;
  basis: VerificationBasis[];
  /** a fixed sentence per outcome/basis - never page text */
  summary: string;
  /** page messages that were seen (untrusted page content, bounded) */
  messages?: string[];
  /** true only when repeating the action cannot duplicate an external effect (reads, navigation, field edits) */
  retrySafe: boolean;
  /** an approved consequential action ran: an external effect may have happened whatever the page shows */
  sideEffectPossible: boolean;
  urlBefore?: string;
  urlAfter?: string;
}

/** What the caller expects a click to achieve. Every given condition must hold. */
export interface ClickExpectation {
  urlIncludes?: string;
  textIncludes?: string;
  targetGone?: boolean;
}

export interface PageMessage {
  kind: 'ERROR' | 'SUCCESS' | 'INFO';
  text: string;
}

export interface PageObservation {
  url: string;
  title: string;
  /** node count : visible text length : hash of the normalized visible text */
  signature: string;
  messages: PageMessage[];
  invalidFields: number;
  validationMessages: string[];
  dialogOpen: boolean;
  /** the visible text itself, bounded - only used to evaluate an explicit `textIncludes` expectation */
  text: string;
}

export interface TargetObservation {
  connected: boolean;
  visible: boolean;
  enabled: boolean;
  tag: string;
  checked?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  selected?: boolean;
  href?: string;
}

export interface FieldState {
  found: boolean;
  /** the field now holds exactly the text that was written (compared in the page; the value itself is never returned) */
  matches: boolean;
  length: number;
  password: boolean;
}

const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 160;
const OBSERVED_TEXT_CHARS = 20_000;

// ------------------------------------------------------------------------------------------------ in-page observation
// Serialized with toString() into one script (see element-map.ts: asPageFunction); each function may use only its arguments, the others of this group and globalThis.

function verifyClean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function verifyIsVisible(el: any): boolean {
  const g = globalThis as any;
  const style = g.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function verifyMessageKind(el: any, text: string): 'ERROR' | 'SUCCESS' | 'INFO' {
  const errorWords = /\b(error|errors|failed|failure|invalid|incorrect|required|not valid|unable|cannot|can't|denied|rejected|wrong|try again|something went wrong|unauthori[sz]ed|forbidden)\b|오류|실패|잘못|필수|올바르지|유효하지|다시 시도|거부|불가/i;
  const successWords = /\b(success|successful|successfully|thank you|thanks|submitted|completed|saved|confirmed|created|sent|updated|done|received|ordered|placed|purchased|booked|registered|added|published|posted|uploaded|deleted|removed)\b|성공|완료|감사합니다|제출되었|저장되었|등록되었|전송되었|접수|되었습니다|됐습니다/i;
  if (errorWords.test(text)) return 'ERROR';
  if (successWords.test(text)) return 'SUCCESS';
  const cls = String(el.getAttribute('class') || '').toLowerCase();
  if (/error|invalid|danger/.test(cls)) return 'ERROR';
  return 'INFO';
}

function verifyObservePage(args: { textChars: number; maxMessages: number; messageChars: number }): { signature: string; messages: Array<{ kind: string; text: string }>; invalidFields: number; validationMessages: string[]; dialogOpen: boolean; text: string } {
  const g = globalThis as any;
  const doc = g.document;
  const body = doc && doc.body;
  const raw = body ? String(body.innerText || '') : '';
  const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 60000);
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  const nodeCount = doc ? doc.getElementsByTagName('*').length : 0;
  const messages: Array<{ kind: string; text: string }> = [];
  if (doc) {
    const nodes = Array.from(doc.querySelectorAll('[role="alert"], [role="status"], [aria-live], [class*="error" i], [class*="success" i], [class*="alert" i], [class*="toast" i], [class*="notif" i], [class*="invalid" i], [class*="feedback" i], [class*="flash" i]') as ArrayLike<any>);
    for (const el of nodes) {
      if (messages.length >= args.maxMessages) break;
      if (!verifyIsVisible(el)) continue;
      const text = verifyClean(el.innerText !== undefined ? el.innerText : el.textContent, args.messageChars);
      if (text.length < 2 || messages.some((m) => m.text === text)) continue;
      messages.push({ kind: verifyMessageKind(el, text), text });
    }
  }
  const controls = doc ? (Array.from(doc.querySelectorAll('input, select, textarea') as ArrayLike<any>) as any[]).filter(verifyIsVisible) : [];
  const invalid = controls.filter((c: any) => (c.matches && c.matches(':invalid')) || c.getAttribute('aria-invalid') === 'true');
  const validationMessages = invalid.map((c: any) => verifyClean(c.validationMessage, 120)).filter(Boolean).slice(0, 3);
  const dialogOpen = doc ? Array.from(doc.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]') as ArrayLike<any>).some(verifyIsVisible) : false;
  return { signature: `${nodeCount}:${normalized.length}:${hash}`, messages, invalidFields: invalid.length, validationMessages, dialogOpen, text: normalized.slice(0, args.textChars) };
}

function verifyObserveTarget(el: any): { connected: boolean; visible: boolean; enabled: boolean; tag: string; checked?: boolean; expanded?: boolean; pressed?: boolean; selected?: boolean; href?: string } {
  const attr = (n: string) => (el.getAttribute ? el.getAttribute(n) : null);
  const out: any = {
    connected: Boolean(el.isConnected),
    visible: Boolean(el.isConnected) && verifyIsVisible(el),
    enabled: !(el.matches && el.matches(':disabled')) && attr('aria-disabled') !== 'true',
    tag: String(el.tagName || '').toLowerCase(),
  };
  if (typeof el.checked === 'boolean') out.checked = el.checked;
  else if (attr('aria-checked') !== null) out.checked = attr('aria-checked') === 'true';
  if (attr('aria-expanded') !== null) out.expanded = attr('aria-expanded') === 'true';
  if (attr('aria-pressed') !== null) out.pressed = attr('aria-pressed') === 'true';
  if (attr('aria-selected') !== null) out.selected = attr('aria-selected') === 'true';
  if (out.tag === 'a' && typeof el.href === 'string') out.href = el.href;
  return out;
}

function verifyReadField(el: any, expected: string): { found: boolean; matches: boolean; length: number; password: boolean } {
  const tag = String(el.tagName || '').toLowerCase();
  const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
  let value: string;
  if (tag === 'select') value = String(el.value);
  else if (tag === 'input' || tag === 'textarea') value = String(el.value);
  else value = String(el.innerText !== undefined ? el.innerText : el.textContent || '');
  return { found: true, matches: value === expected, length: value.length, password: type === 'password' };
}

const OBSERVE_HELPERS = [verifyClean, verifyIsVisible, verifyMessageKind].map((fn) => fn.toString()).join('\n');
export const observePageInPage = asPageFunction<(args: { textChars: number; maxMessages: number; messageChars: number }) => ReturnType<typeof verifyObservePage>>(`(args) => {\n${OBSERVE_HELPERS}\n${verifyObservePage.toString()}\nreturn verifyObservePage(args);\n}`);
export const observeTargetInPage = asPageFunction<(el: unknown) => ReturnType<typeof verifyObserveTarget>>(`(el) => {\n${OBSERVE_HELPERS}\n${verifyObserveTarget.toString()}\nreturn verifyObserveTarget(el);\n}`);
export const readFieldInPage = asPageFunction<(el: unknown, expected: string) => ReturnType<typeof verifyReadField>>(`(el, expected) => {\n${OBSERVE_HELPERS}\n${verifyReadField.toString()}\nreturn verifyReadField(el, expected);\n}`);

export const OBSERVE_PAGE_ARGS = { textChars: OBSERVED_TEXT_CHARS, maxMessages: MAX_MESSAGES, messageChars: MAX_MESSAGE_CHARS } as const;

// ------------------------------------------------------------------------------------------------ evaluation (pure)

const SUMMARY: Record<string, string> = {
  EXPECTATION_MET: 'The expected result was observed.',
  EXPECTATION_NOT_MET: 'The expected result was not observed.',
  FIELD_VALUE_MATCHED: 'The field holds the text that was entered.',
  FIELD_VALUE_MISMATCH: 'The field does not hold the text that was entered.',
  TARGET_STATE_CHANGED: 'The control changed state (checked, expanded, pressed or selected).',
  NAVIGATED_TO_LINK_TARGET: 'The page navigated to the destination of the link.',
  NAVIGATION_COMPLETED: 'The page loaded the requested address.',
  SUCCESS_MESSAGE: 'The page shows a success message.',
  VALIDATION_ERROR: 'The page reports a form validation error; nothing was submitted.',
  ERROR_MESSAGE: 'The page shows an error message.',
  URL_CHANGED: 'The address changed, but nothing shows that the intended result was reached.',
  DOM_CHANGED_ONLY: 'The page content changed, but nothing shows that the intended result was reached.',
  NO_OBSERVABLE_CHANGE: 'Nothing observable changed on the page.',
  HUMAN_VERIFICATION_REQUIRED: 'The page asks for human verification (CAPTCHA, sign-in or a security check). NAgex does not bypass it.',
  NO_OBSERVATION: 'The page could not be observed after the action.',
};

function stripHash(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function build(outcome: BrowserActionOutcome, basis: VerificationBasis[], input: { sideEffectPossible: boolean; urlBefore?: string; urlAfter?: string; messages?: string[] }): BrowserVerification {
  const summaryCore = basis.map((b) => SUMMARY[b]).filter(Boolean).join(' ');
  const caution = input.sideEffectPossible && outcome !== 'VERIFIED'
    ? ' The action may have had an external effect: it will not be repeated automatically.'
    : '';
  return {
    outcome,
    basis,
    summary: `${summaryCore}${caution}`.trim(),
    ...(input.messages && input.messages.length > 0 ? { messages: input.messages.slice(0, 4) } : {}),
    retrySafe: !input.sideEffectPossible,
    sideEffectPossible: input.sideEffectPossible,
    ...(input.urlBefore ? { urlBefore: input.urlBefore } : {}),
    ...(input.urlAfter ? { urlAfter: input.urlAfter } : {}),
  };
}

export interface ClickVerificationInput {
  before: PageObservation | null;
  after: PageObservation | null;
  targetBefore: TargetObservation | null;
  targetAfter: TargetObservation | null;
  expectation?: ClickExpectation;
  /** an approved consequential click: an external effect is possible whatever the page shows */
  sideEffectPossible: boolean;
}

/**
 * What the page shows after a click, in strict order of evidence:
 *   1. an explicit expectation of the caller (all conditions must hold)            -> VERIFIED / NOT_VERIFIED, or FAILED when an error is shown
 *   2. an error or validation message that was not there before                   -> FAILED
 *   3. the control's own state flipped (checked / expanded / pressed / selected)  -> VERIFIED
 *   4. a link click that arrived at the link's destination                         -> VERIFIED
 *   5. a success message that was not there before                                 -> VERIFIED
 *   6. only the address / only the content changed, or nothing changed             -> NOT_VERIFIED (a changed DOM is not business success)
 */
export function verifyClick(input: ClickVerificationInput): BrowserVerification {
  const { before, after, targetBefore, targetAfter, expectation, sideEffectPossible } = input;
  if (!before || !after) return build('NOT_VERIFIED', ['NO_OBSERVATION'], { sideEffectPossible });
  const common = { sideEffectPossible, urlBefore: before.url, urlAfter: after.url };
  const knownBefore = new Set(before.messages.map((m) => m.text));
  const fresh = after.messages.filter((m) => !knownBefore.has(m.text));
  const freshErrors = fresh.filter((m) => m.kind === 'ERROR');
  const freshSuccess = fresh.filter((m) => m.kind === 'SUCCESS');
  // a form that was already invalid when the click was made and still is, with the page otherwise unchanged, is a submit that the browser refused
  const unchangedPage = stripHash(before.url) === stripHash(after.url) && before.signature === after.signature;
  const blockedSubmit = after.invalidFields > 0 && unchangedPage && (targetBefore ? targetBefore.tag === 'button' || targetBefore.tag === 'input' : false);
  const newInvalid = after.invalidFields > before.invalidFields || blockedSubmit;
  const errorEvidence = freshErrors.length > 0 || newInvalid;
  const messagesShown = [...freshErrors, ...fresh.filter((m) => m.kind !== 'ERROR')].map((m) => m.text).concat(newInvalid ? after.validationMessages : []);

  if (expectation && (expectation.urlIncludes !== undefined || expectation.textIncludes !== undefined || expectation.targetGone !== undefined)) {
    const met: boolean[] = [];
    if (expectation.urlIncludes !== undefined) met.push(after.url.includes(expectation.urlIncludes));
    if (expectation.textIncludes !== undefined) met.push(after.text.includes(expectation.textIncludes));
    if (expectation.targetGone !== undefined) met.push(expectation.targetGone === (targetAfter === null || !targetAfter.connected || !targetAfter.visible));
    if (met.every(Boolean)) return build('VERIFIED', ['EXPECTATION_MET'], { ...common, messages: messagesShown });
    return build(errorEvidence ? 'FAILED' : 'NOT_VERIFIED', ['EXPECTATION_NOT_MET', ...(errorEvidence ? [freshErrors.length > 0 ? 'ERROR_MESSAGE' as const : 'VALIDATION_ERROR' as const] : [])], { ...common, messages: messagesShown });
  }

  if (errorEvidence) return build('FAILED', [freshErrors.length > 0 ? 'ERROR_MESSAGE' : 'VALIDATION_ERROR'], { ...common, messages: messagesShown });

  if (targetBefore && targetAfter) {
    const flipped = (['checked', 'expanded', 'pressed', 'selected'] as const).some((k) => targetBefore[k] !== undefined && targetAfter[k] !== undefined && targetBefore[k] !== targetAfter[k]);
    if (flipped) return build('VERIFIED', ['TARGET_STATE_CHANGED'], common);
  }
  if (targetBefore?.href && stripHash(after.url) === stripHash(targetBefore.href) && stripHash(before.url) !== stripHash(after.url)) return build('VERIFIED', ['NAVIGATED_TO_LINK_TARGET'], common);
  if (freshSuccess.length > 0) return build('VERIFIED', ['SUCCESS_MESSAGE'], { ...common, messages: freshSuccess.map((m) => m.text) });

  if (stripHash(before.url) !== stripHash(after.url)) return build('NOT_VERIFIED', ['URL_CHANGED'], common);
  if (before.signature !== after.signature) return build('NOT_VERIFIED', ['DOM_CHANGED_ONLY'], common);
  return build('NOT_VERIFIED', ['NO_OBSERVABLE_CHANGE'], common);
}

/** A field write is verified by reading the field back (compared in the page; a password's content is never returned). */
export function verifyFieldWrite(state: FieldState | null, urlAfter?: string): BrowserVerification {
  if (!state || !state.found) return build('NOT_VERIFIED', ['NO_OBSERVATION'], { sideEffectPossible: false, urlAfter });
  return state.matches
    ? build('VERIFIED', ['FIELD_VALUE_MATCHED'], { sideEffectPossible: false, urlAfter })
    : build('FAILED', ['FIELD_VALUE_MISMATCH'], { sideEffectPossible: false, urlAfter });
}

/** A navigation is verified when the page that loaded is the page that was asked for (a redirect elsewhere is reported, not hidden). */
export function verifyNavigation(requestedUrl: string, finalUrl: string): BrowserVerification {
  let sameOrigin = false;
  try { sameOrigin = new URL(requestedUrl).origin === new URL(finalUrl).origin; } catch { sameOrigin = false; }
  return sameOrigin
    ? build('VERIFIED', ['NAVIGATION_COMPLETED'], { sideEffectPossible: false, urlAfter: finalUrl })
    : build('NOT_VERIFIED', ['URL_CHANGED'], { sideEffectPossible: false, urlBefore: requestedUrl, urlAfter: finalUrl });
}

export function humanVerificationRequired(urlAfter?: string): BrowserVerification {
  return build('USER_ACTION_REQUIRED', ['HUMAN_VERIFICATION_REQUIRED'], { sideEffectPossible: false, urlAfter });
}
