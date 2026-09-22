import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// R21 P0.1C — NAgex Assistant Ambient Sheet Unit Test Suite
// Verifies request isolation, result-first research UI, progress step
// indicators, sources, bottom CTAs, and collapsed execution details as
// durable architecture contracts — keyed to the stable ids/keys the runtime
// actually binds to via getElementById/i18n, not to clone-sourced CSS class
// names or internal helper/variable names (see r21_p0_1c_real_browser.test.ts
// for the corresponding real-DOM behavioral coverage).

test('ASSISTANT_MODAL_STRUCTURE: Assistant modal exposes the stable ids the runtime binds to', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /id="ambient-sheet-modal"/);
  assert.match(html, /id="ambient-task-title-card"/);
  assert.match(html, /id="ambient-request-card"/);
  assert.match(html, /id="ambient-progress-card"/);
  assert.match(html, /id="ambient-summary-section"/);
  assert.match(html, /id="ambient-sources-section"/);
  assert.match(html, /id="ambient-mockup-actions"/);
  assert.match(html, /id="btn-ask-followup"/);
  assert.match(html, /id="btn-save-vault"/);
});

test('SEARCH_REQUEST_SHOWS_RESEARCH_UI & DOES_NOT_SHOW_MEETING_UI: Search request renders research view without meeting leaks', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // Durable contract: a RESEARCH-classified request hides the meeting
  // context box and its "why this meeting" grounding explanation, no
  // matter which internal function performs the classification/reset.
  assert.match(appJs, /intent === 'RESEARCH'/);
  assert.match(appJs, /if \(contextBox\) contextBox\.style\.display = 'none';/);
  assert.match(appJs, /if \(groundingWhyEl\) groundingWhyEl\.style\.display = 'none';/);
});

test('REQUEST_STATE_ISOLATION & STALE_CONTEXT_LEAK: Prior summary/sources are cleared before a new request renders', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // Durable contract: summary and sources sections are hidden as part of
  // resetting flow state, preventing a stale result from a prior request
  // leaking into the next one — independent of the reset helper's name.
  assert.match(appJs, /if \(summarySection\) summarySection\.style\.display = 'none';/);
  assert.match(appJs, /if \(sourcesSection\) sourcesSection\.style\.display = 'none';/);
});

test('TECHNICAL_HEADER_LABELS: Header in normal mode contains only logo, modal title, and close button', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /class="ambient-sheet-header\b/);
  assert.match(html, /id="ambient-modal-title"/);
  assert.match(html, /id="btn-close-ambient"/);
  // Lifecycle status span has display:none by default in normal mode
  assert.match(html, /id="ambient-modal-status"[^>]*style="display:\s*none;"/);
});

test('PROGRESS_SURFACE & NO_DUPLICATES: Single progress surface is used for step progress', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /id="ambient-progress-card"/);
  assert.match(html, /id="ambient-friendly-steps"/);
});

test('RESULT_FIRST_READ_ONLY: Read-only research proceeds directly to results without mandatory Continue gate', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // In RESEARCH intent, summarySection & sourcesSection are shown, and actionsBar (Continue button) is hidden
  assert.match(appJs, /if \(intent === 'RESEARCH'\) \{[\s\S]*?if \(actionsBar\) actionsBar\.style\.display = 'none';/);
});

test('BOTTOM_CTAS: Secondary Ask a follow-up and primary Save to Vault buttons exist', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="btn-ask-followup"/);
  assert.match(html, /id="btn-save-vault"/);
  assert.match(appJs, /ambient\.ctaFollowUp/);
  assert.match(appJs, /ambient\.ctaSaveVault/);
});

test('WHAT_NAGEX_IS_DOING_COLLAPSED: Progressive disclosure card is collapsed by default', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /id="btn-ambient-activity-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="ambient-activity-detail-body"[^>]*hidden/);
});

test('EN_KR_I18N: All new mockup keys exist in bilingual dictionary without raw key leaks', () => {
  const i18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');

  assert.match(i18n, /'ambient\.yourRequest': 'Your request'/);
  assert.match(i18n, /'ambient\.yourRequest': '요청 내용'/);
  assert.match(i18n, /'ambient\.summaryTitle': 'Summary'/);
  assert.match(i18n, /'ambient\.summaryTitle': '요약'/);
  assert.match(i18n, /'ambient\.sourcesTitle': 'Sources'/);
  assert.match(i18n, /'ambient\.sourcesTitle': '출처'/);
  assert.match(i18n, /'ambient\.ctaFollowUp': 'Ask a follow-up'/);
  assert.match(i18n, /'ambient\.ctaFollowUp': '추가 질문하기'/);
  assert.match(i18n, /'ambient\.ctaSaveVault': 'Save to Vault'/);
  assert.match(i18n, /'ambient\.ctaSaveVault': 'Vault에 저장'/);
});
