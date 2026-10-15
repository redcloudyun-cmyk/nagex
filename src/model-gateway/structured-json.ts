// A structured answer from a model ("return JSON with exactly this shape") is sometimes not strictly valid JSON although every value in it is intact: the object is wrapped in a code fence or a
// sentence, a string holds a raw line break or tab, a comma trails the last member. Those are repaired here, and only those: the repairs never add, drop or reword a value, so a repaired answer
// carries exactly what the model wrote. An answer that is cut off (the output limit was reached) or is not an object at all is NOT repaired - invented content is never an option - and the caller
// retries the model or fails truthfully. Deterministic, bounded, no model call.

export type StructuredJsonFailure = 'EMPTY' | 'TRUNCATED' | 'NOT_JSON' | 'NOT_OBJECT';
export type StructuredJsonRepair = 'CODE_FENCE' | 'SURROUNDING_TEXT' | 'RAW_CONTROL_CHARACTER' | 'TRAILING_COMMA';

export type StructuredJsonResult =
  | { ok: true; value: Record<string, unknown>; repairs: StructuredJsonRepair[] }
  | { ok: false; failure: StructuredJsonFailure };

const MAX_SCAN_CHARS = 2_000_000; // far beyond any real answer; keeps the scan bounded

function asObject(text: string): Record<string, unknown> | 'NOT_OBJECT' | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : 'NOT_OBJECT';
  } catch {
    return null;
  }
}

// The first top-level {...} of the text (string-aware), or how it ends: `complete`, or cut off before it closed.
function firstObject(text: string): { start: number; end: number; closed: boolean } | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { start, end: i + 1, closed: true };
  }
  return { start, end: text.length, closed: false };
}

// Raw control characters inside string literals become their JSON escapes; outside strings nothing changes.
function escapeControlCharactersInStrings(text: string): { text: string; changed: boolean } {
  let out = '';
  let inString = false;
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue; }
      if (ch === '"') inString = false;
      else if (ch.charCodeAt(0) < 0x20) {
        changed = true;
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return { text: out, changed };
}

// A comma directly before a closing brace/bracket (outside strings) is dropped.
function dropTrailingCommas(text: string): { text: string; changed: boolean } {
  let out = '';
  let inString = false;
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue; }
      if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { changed = true; continue; }
    }
    out += ch;
  }
  return { text: out, changed };
}

export function parseStructuredJson(raw: string): StructuredJsonResult {
  const original = (raw ?? '').replace(/^﻿/, '').trim();
  if (!original) return { ok: false, failure: 'EMPTY' };

  const strict = asObject(original);
  if (strict === 'NOT_OBJECT') return { ok: false, failure: 'NOT_OBJECT' };
  if (strict) return { ok: true, value: strict, repairs: [] };

  const repairs: StructuredJsonRepair[] = [];
  let text = original;
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (fenced !== text) { text = fenced; repairs.push('CODE_FENCE'); }

  // a list (or any other value) is a different answer, not a damaged object: never pick an element out of it
  if (/^\s*[[\d"-]/.test(text) || /^(?:true|false|null)\b/.test(text)) return { ok: false, failure: 'NOT_OBJECT' };
  const found = firstObject(text);
  if (!found) return { ok: false, failure: 'NOT_JSON' };
  if (!found.closed) return { ok: false, failure: 'TRUNCATED' };
  if (found.start !== 0 || found.end !== text.length) { text = text.slice(found.start, found.end); repairs.push('SURROUNDING_TEXT'); }

  const attempt = (candidate: string) => asObject(candidate);
  let parsed = attempt(text);
  if (!parsed) {
    const escaped = escapeControlCharactersInStrings(text);
    if (escaped.changed) { text = escaped.text; repairs.push('RAW_CONTROL_CHARACTER'); }
    parsed = attempt(text);
  }
  if (!parsed) {
    const trimmed = dropTrailingCommas(text);
    if (trimmed.changed) { text = trimmed.text; repairs.push('TRAILING_COMMA'); }
    parsed = attempt(text);
  }
  if (!parsed || parsed === 'NOT_OBJECT') return { ok: false, failure: 'NOT_JSON' };
  return { ok: true, value: parsed, repairs };
}
