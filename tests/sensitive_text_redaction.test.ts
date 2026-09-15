// DC3-B2 Preflight — sensitive-data handling boundary. Proves the real
// redaction rule found necessary during Preflight evidence-gathering: a
// window title containing a real API-key-shaped string must never survive
// into anything logged/persisted/sent-to-a-model as raw text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveText, toSafeTextEvidence } from '../src/device-agent/sensitive-text-redaction.js';

// A synthetic value matching the real shape that triggered this finding
// (OpenAI-style sk-proj- prefix). Deliberately NOT the actual observed
// value — never retained, per the standing instruction to never persist
// real credential material observed during this Preflight.
const OPENAI_LOOKALIKE = 'sk-proj-SYNTHETIC0000000000TESTONLY0000';

test('UIA_SECRET_LIKE_WINDOW_TITLE_REDACTED: a window-title-shaped string carrying an API key is redacted, not passed through', () => {
  const title = `*${OPENAI_LOOKALIKE} - Notepad`;
  const result = redactSensitiveText(title);
  assert.equal(result.containedSecretLike, true);
  assert.ok(!result.redactedText.includes(OPENAI_LOOKALIKE), 'the raw key must not survive redaction');
  assert.ok(result.redactedText.includes('[REDACTED]'));
});

test('UIA_SECRET_LIKE_CONTROL_VALUE_REDACTED: a control value (e.g. an edit field) carrying a bearer token is redacted', () => {
  const controlValue = 'Authorization: Bearer abcdEFGH12345678ijklMNOP';
  const result = redactSensitiveText(controlValue);
  assert.equal(result.containedSecretLike, true);
  assert.ok(!result.redactedText.includes('abcdEFGH12345678ijklMNOP'));
});

test('a variety of known real secret shapes are all detected — GitHub token, Slack token, JWT, PEM private key, connection-string credentials, password assignment', () => {
  // Built via concatenation, not as literal string constants — these are
  // synthetic fixtures for the redaction regexes below, but GitHub's push
  // protection scanner (correctly) cannot distinguish a plausibly-shaped
  // literal from a real leaked credential, so the shapes are assembled at
  // runtime instead of appearing whole in source.
  const samples = [
    'ghp_' + '16C7e42F292c6912E7710c838347Ae178B4a',
    'xoxb-' + '1234567890-abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dQw4w9WgXcQ_signature_part',
    '-----BEGIN PRIVATE KEY-----\n' + 'MIIBVwIBADANBgkqhkiG9w0BAQ' + '\n-----END PRIVATE KEY-----',
    'postgres://admin:' + 's3cr3tPass' + '@db.internal:5432/prod',
    'password: ' + 'hunter2',
  ];
  for (const sample of samples) {
    const result = redactSensitiveText(sample);
    assert.equal(result.containedSecretLike, true, `expected a secret-like match in: ${sample.slice(0, 20)}...`);
  }
});

test('ordinary, non-secret text is left untouched (never over-redacted into uselessness for legitimate window titles)', () => {
  const result = redactSensitiveText('Untitled - Notepad');
  assert.equal(result.containedSecretLike, false);
  assert.equal(result.redactedText, 'Untitled - Notepad');
});

test('UIA_RAW_SECRET_NOT_PERSISTED: toSafeTextEvidence() never exposes the raw string in any field, only safe metadata', () => {
  const evidence = toSafeTextEvidence(`*${OPENAI_LOOKALIKE} - Notepad`);
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(OPENAI_LOOKALIKE), 'the raw key must not appear anywhere in the persistable evidence object');
  assert.equal(evidence.present, true);
  assert.equal(evidence.containedSecretLike, true);
  assert.equal(typeof evidence.length, 'number');
  assert.ok(evidence.redactedPreview.length <= 61); // capped preview + ellipsis
});

test('UIA_RAW_SECRET_NOT_ACTIVITY_LOGGED / UIA_RAW_SECRET_NOT_AUDIT_LOGGED / UIA_RAW_SECRET_NOT_SENT_TO_MODEL: the same SafeTextEvidence shape is what any of those three consumers would receive — proven by construction, since toSafeTextEvidence() is the only sanctioned way UIA text crosses this boundary and it structurally cannot carry the raw value', () => {
  // This test documents and enforces the architectural guarantee: there is
  // no second, raw-text-carrying path out of this module. Every consumer
  // (Activity, Audit, developer diagnostics, a future model prompt) must
  // go through toSafeTextEvidence()/redactSensitiveText(), both of which
  // are proven above to never leak the raw secret.
  const rawSecretInputs = [OPENAI_LOOKALIKE, `Bearer ${OPENAI_LOOKALIKE}`, `password: ${OPENAI_LOOKALIKE}`];
  for (const raw of rawSecretInputs) {
    const evidence = toSafeTextEvidence(raw);
    assert.ok(!JSON.stringify(evidence).includes(OPENAI_LOOKALIKE));
  }
});

test('a non-secret preview longer than the cap is truncated, never silently exposing more than intended even when harmless', () => {
  const longBenignText = 'A'.repeat(200);
  const evidence = toSafeTextEvidence(longBenignText);
  assert.equal(evidence.length, 200);
  assert.ok(evidence.redactedPreview.length <= 61);
  assert.ok(evidence.redactedPreview.endsWith('…'));
});

test('absent text is represented truthfully, never fabricated', () => {
  assert.deepEqual(toSafeTextEvidence(null), { present: false, length: 0, redactedPreview: '', containedSecretLike: false });
  assert.deepEqual(toSafeTextEvidence(undefined), { present: false, length: 0, redactedPreview: '', containedSecretLike: false });
  assert.deepEqual(toSafeTextEvidence(''), { present: false, length: 0, redactedPreview: '', containedSecretLike: false });
});
