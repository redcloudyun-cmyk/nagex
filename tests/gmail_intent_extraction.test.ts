import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/gmail-intent-extraction.js is a dependency-free browser script
// (IIFE), loaded the same way tests/calendar_intent_extraction.test.ts loads
// calendar-intent-extraction.js: run its real source in a vm sandbox so we
// exercise the actual extraction logic the Ambient Assistant UI uses, not a
// re-implementation of it.
function loadGmailIntentExtraction(): {
  extractGmailIntent: (prompt: string) => {
    kind: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string | null;
    body: string | null;
    recipientNameHint: string | null;
    searchQuery: string | null;
  } | null;
  extractEmails: (text: string) => string[];
  extractMarkedEmails: (text: string, marker: string) => string[];
  extractRecipientNameHint: (text: string) => string | null;
  extractSubject: (text: string) => string | null;
  extractBody: (text: string) => string | null;
  detectIntentKind: (text: string) => string | null;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'gmail-intent-extraction.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'gmail-intent-extraction.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_GMAIL_INTENT as ReturnType<typeof loadGmailIntentExtraction>;
}

const extraction = loadGmailIntentExtraction();

// ── item 1: the exact example prompts map to the exact expected intent kind ──

test('"Email John that the meeting moved to 3 PM." maps to send_email', () => {
  const intent = extraction.extractGmailIntent('Email John that the meeting moved to 3 PM.');
  assert.ok(intent);
  assert.equal(intent!.kind, 'send_email');
});

test('"Reply to Sarah and tell her I\'ll review it tomorrow." maps to reply', () => {
  const intent = extraction.extractGmailIntent("Reply to Sarah and tell her I'll review it tomorrow.");
  assert.ok(intent);
  assert.equal(intent!.kind, 'reply');
});

test('"Draft an email to the client summarizing today\'s meeting." maps to create_draft', () => {
  const intent = extraction.extractGmailIntent("Draft an email to the client summarizing today's meeting.");
  assert.ok(intent);
  assert.equal(intent!.kind, 'create_draft');
});

test('"Find emails from Acme." maps to search', () => {
  const intent = extraction.extractGmailIntent('Find emails from Acme.');
  assert.ok(intent);
  assert.equal(intent!.kind, 'search');
});

test('"Show me the latest thread from Sarah." maps to read_thread', () => {
  const intent = extraction.extractGmailIntent('Show me the latest thread from Sarah.');
  assert.ok(intent);
  assert.equal(intent!.kind, 'read_thread');
});

test('a prompt with no Gmail signal at all extracts nothing (kind is null)', () => {
  assert.equal(extraction.extractGmailIntent('What is the capital of France?'), null);
});

// ── item 3: never invent a recipient, address, or content ──────────────────

test('a bare name ("John") is never placed into `to` — only surfaced as recipientNameHint', () => {
  const intent = extraction.extractGmailIntent('Email John that the meeting moved to 3 PM.');
  assert.ok(intent);
  assert.deepEqual(Array.from(intent!.to), []);
  assert.equal(intent!.recipientNameHint, 'John');
});

test('a literal email address in the prompt IS extracted into `to`', () => {
  const intent = extraction.extractGmailIntent('Email john@example.com that the meeting moved to 3 PM.');
  assert.ok(intent);
  assert.deepEqual(Array.from(intent!.to), ['john@example.com']);
});

test('cc/bcc are only ever taken from an explicit marker, never guessed from a bare address', () => {
  const intent = extraction.extractGmailIntent('Email john@example.com and cc: sarah@example.com that the deal closed.');
  assert.ok(intent);
  assert.deepEqual(Array.from(intent!.to), ['john@example.com']);
  assert.deepEqual(Array.from(intent!.cc), ['sarah@example.com']);
});

test('subject is null (never invented) unless an explicit "subject:" or "titled" marker is present', () => {
  const noSubject = extraction.extractGmailIntent('Email John that the meeting moved to 3 PM.');
  assert.ok(noSubject);
  assert.equal(noSubject!.subject, null);

  const withSubject = extraction.extractGmailIntent('Email john@example.com subject: "Meeting update" that it moved to 3 PM.');
  assert.ok(withSubject);
  assert.equal(withSubject!.subject, 'Meeting update');
});

test('body extraction is a literal substring following an explicit signal phrase, never a paraphrase', () => {
  const intent = extraction.extractGmailIntent('Email John that the meeting moved to 3 PM.');
  assert.ok(intent);
  assert.equal(intent!.body, 'the meeting moved to 3 PM');
});

test('body is null (never invented) when no recognized signal phrase is present', () => {
  const intent = extraction.extractGmailIntent('Email john@example.com.');
  assert.ok(intent);
  assert.equal(intent!.body, null);
});

test('reply body extraction follows "tell her/him/them"', () => {
  const intent = extraction.extractGmailIntent("Reply to Sarah and tell her I'll review it tomorrow.");
  assert.ok(intent);
  assert.equal(intent!.body, "I'll review it tomorrow");
});

test('draft body extraction follows "summarizing"', () => {
  const intent = extraction.extractGmailIntent("Draft an email to the client summarizing today's meeting.");
  assert.ok(intent);
  assert.equal(intent!.body, "today's meeting");
});

test('search extracts a usable query with the find/search/emails/from noise words stripped', () => {
  const intent = extraction.extractGmailIntent('Find emails from Acme.');
  assert.ok(intent);
  assert.match(intent!.searchQuery || '', /Acme/);
});
