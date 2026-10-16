import { asPageFunction } from './element-map.js';

// "Verify the totals" cannot be answered by the model saying so. An Agent states what the page MUST show (a labelled total, a name, a status) and NAgex checks the page itself: the visible text of the
// page (or of one element) and the values currently held by its visible fields. The match is deterministic:
//   * text: whitespace and case are ignored, currency marks and thousands separators are ignored ("Total: 1,100,000" matches "Total: ₩1,100,000"), and a number inside the text must be a whole
//     number (1100000 does not match 11000000);
//   * a bare number: it matches only a standalone number of the same value anywhere on the page. A bare number can be a subtotal or an invoice date; state the label ("Total: 1,100,000") when the
//     label matters.
// A page that does not show it makes the expectation FAILED, which in turn makes a STOP that claims "done" untrue. What the page shows is untrusted content: it is compared, never obeyed.

declare const document: any;

export interface ExpectationSurface {
  found: boolean;
  /** visible text blocks and the values of visible fields (never a password field) */
  texts: string[];
  truncated: boolean;
}

function readExpectationSurface(root: any, maxChars: number): ExpectationSurface {
  if (!root) return { found: false, texts: [], truncated: false };

  const texts: string[] = [];
  let used = 0;
  let truncated = false;
  const push = (value: string): void => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (used + text.length > maxChars) { truncated = true; return; }
    used += text.length;
    texts.push(text);
  };
  const visible = (el: any): boolean => {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  push(root.innerText || root.textContent || '');
  const fields: any[] = Array.prototype.slice.call(root.querySelectorAll('input, textarea, select, output'));
  if (root.matches && root.matches('input, textarea, select, output')) fields.unshift(root);
  for (const el of fields) {
    const tag = String(el.tagName).toLowerCase();
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || !visible(el)) continue;
    if (tag === 'select') {
      Array.prototype.slice.call(el.selectedOptions || []).forEach((option: any) => { push(option.text); push(option.value); });
    } else if (tag === 'output') {
      push(el.textContent || '');
    } else if (type === 'checkbox' || type === 'radio') {
      continue;
    } else {
      push(el.value);
    }
  }
  return { found: true, texts, truncated };
}

/** (element, maxChars) => ExpectationSurface - evaluate on a locator (`body` for the whole page) */
export const readExpectationSurfaceInPage = asPageFunction<(el: unknown, maxChars: number) => ExpectationSurface>(`(el, maxChars) => {\n${readExpectationSurface.toString()}\nreturn readExpectationSurface(el, maxChars);\n}`);

export const EXPECTATION_SURFACE_CHARS = 60_000;
export const MAX_EXPECTATION_CHARS = 300;

/** "₩1,100,000원" / "1 100 000" / "1100000.00" -> 1100000 ; anything that is not just a number -> null */
export function numericValue(value: string): number | null {
  const stripped = value.normalize('NFC').replace(/[\s, ₩$€£¥원円元]/g, '').replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return null;
  const number = Number(stripped);
  return Number.isFinite(number) ? number : null;
}

/** lower case, no currency marks, no thousands separators inside numbers, one space between words, "label: value" spacing */
function canon(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[₩$€£¥]|원/g, '')
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `needle` occurs in `haystack`; when it starts or ends with a digit the occurrence must not be part of a longer number */
function includesWhole(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const latin = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);
  const digit = (c: string | undefined): boolean => c !== undefined && /\d/.test(c);
  const first = needle[0];
  const last = needle[needle.length - 1];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const afterNext = haystack[at + needle.length + 1];
    // an occurrence inside a longer Latin word or number is not the thing asked for: "total" is not in "subtotal", 1100000 is not in 11000000 or in 0.1100000
    const beforeOk = !(latin(first) && (latin(before) || (digit(first) && before === '.')));
    const afterOk = !(latin(last) && (latin(after) || (digit(last) && after === '.' && digit(afterNext))));
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
}

export type ExpectationMatch = { found: true; as: 'TEXT' | 'NUMBER' } | { found: false };

export function matchExpectation(expected: string, surface: ExpectationSurface): ExpectationMatch {
  if (!surface.found || !expected.trim()) return { found: false };
  const wantedNumber = numericValue(expected);
  if (wantedNumber !== null) {
    // a standalone number of the same value, wherever it is written on the page
    for (const block of surface.texts) {
      for (const token of block.match(/(?<![\w#.,])-?\d[\d,]*(?:\.\d+)?(?!\w)/g) ?? []) {
        const value = numericValue(token);
        if (value !== null && Math.abs(value - wantedNumber) < 0.005) return { found: true, as: 'NUMBER' };
      }
    }
    return { found: false };
  }
  const wanted = canon(expected);
  return surface.texts.some((block) => includesWhole(canon(block), wanted)) ? { found: true, as: 'TEXT' } : { found: false };
}
