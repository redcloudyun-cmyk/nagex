import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// R21 P0 — Enforce Existing NAGEX UX Intent Interaction Principles Unit Test Suite
// Verifies that docs/NAGEX_PRODUCT_UX_INTENT_INTERACTION_PRINCIPLES.md is enforced
// across DOM elements, i18n keys, app.js modal handlers, and progressive disclosure rules.

test('UX_GOVERNING_MD_APPLIED: Governing UX document exists and governs Plan Preview UI', () => {
  const docPath = path.join(process.cwd(), 'docs', 'NAGEX_PRODUCT_UX_INTENT_INTERACTION_PRINCIPLES.md');
  assert.equal(fs.existsSync(docPath), true, 'docs/NAGEX_PRODUCT_UX_INTENT_INTERACTION_PRINCIPLES.md must exist');

  const content = fs.readFileSync(docPath, 'utf8');
  assert.match(content, /Progressive Disclosure/);
  assert.match(content, /One Clear Next Action/);
  assert.match(content, /Plan Acceptance != Action Approval/);
  assert.match(content, /Domain-Neutral Agent Work UI/);
});

test('TECHNICAL_TABS_HIDDEN_NORMAL_MODE: Stepper and technical lifecycle tabs are hidden in normal mode', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // Stepper element has display:none by default in index.html
  assert.match(html, /id="ambient-flow-stepper"[^>]*style="display:\s*none;"/);

  // app.js updateFlowStage checks isDebugMode() before exposing stepper
  assert.match(appJs, /if\s*\(!isDebugMode\(\)\)\s*{\s*el\.style\.display\s*=\s*'none';/);
});

test('PROGRESSIVE_DISCLOSURE: Canonical user presentation card is present and activity details are collapsed', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="ambient-understanding-card"/);
  assert.match(html, /id="ambient-activity-detail"/);
  assert.match(html, /data-i18n="ambient\.activityToggle"/);

  // Activity body is hidden by default
  assert.match(html, /id="ambient-activity-detail-body"[^>]*hidden/);
  // Toggle handler toggles hidden attribute
  assert.match(appJs, /body\.hidden\s*=\s*expanded;/);
});

test('ONE_CLEAR_NEXT_ACTION: Single obvious next action container is present with clear CTA buttons', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="ambient-understanding-actions"/);
  assert.match(appJs, /btn-ambient-understanding-continue/);
  assert.match(appJs, /btn-ambient-understanding-edit/);
});

test('DOMAIN_NEUTRAL_WORK_UI: Friendly steps container is present for domain-neutral progress', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="ambient-friendly-steps"/);
  assert.match(appJs, /user-friendly-step-item/);
  assert.match(appJs, /Checked your availability/);
});

test('SHOW_CURRENT_UNDERSTANDING: Summary box renders understanding summary', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="ambient-understanding-summary"/);
  assert.match(appJs, /ambient\.understanding\.title/);
});

test('CONTEXT_PRESENTATION: Context items and grounding why notice are rendered', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="ambient-surfaced-context"/);
  assert.match(html, /id="ambient-grounding-why"/);
  assert.match(appJs, /ambient\.context\.found/);
});

test('PLAN_ACCEPTANCE_NOT_ACTION_APPROVAL: Plan acceptance does not execute external mutations', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // Continuing plan acceptance updates button label to Accepted and renders separate user approval card
  assert.match(appJs, /renderUserApprovalCard\(resolved,\s*promptText\);/);
});

test('CONSEQUENTIAL_APPROVAL_STILL_ENFORCED: Action approval card requires explicit user confirmation', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(html, /id="ambient-user-approval-card"/);
  assert.match(appJs, /btn-ambient-approve-mutation/);
});

test('FRIENDLY_MUTATION_CTA: CTA text states the real action (Add to calendar / Send email)', () => {
  const i18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');

  assert.match(i18n, /ambient\.approval\.addToCalendar/);
  assert.match(i18n, /ambient\.approval\.sendEmail/);
  assert.match(i18n, /캘린더에 추가/);
  assert.match(i18n, /이메일 전송/);
});

test('DEBUG_DETAILS_AVAILABLE: Debug mode (?debug=1) exposes technical steppers and plan details', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  assert.match(appJs, /function isDebugMode\(\)/);
  assert.match(appJs, /params\.get\('debug'\)\s*===\s*'1'/);
  assert.match(appJs, /preview\.style\.display\s*=\s*isDebugMode\(\)\s*\?\s*'block'\s*:\s*'none';/);
});

test('MODAL_CLOSE_DOES_NOT_ABORT_BACKGROUND_WORK: Close button only dismisses overlay view', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');

  // closeAmbientOverlay sets backdrop to none without calling abort or cancel on background tasks
  assert.match(appJs, /function closeAmbientOverlay\(\)/);
  assert.match(appJs, /backdrop\.style\.display\s*=\s*'none';/);
});

test('HOME_WORKING_STATE_SYNC: Home view and My Space retain working state visibility', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /id="view-home"/);
  assert.match(html, /id="plans-list-container"/);
});

test('EN_KR: Bilingual dictionaries exist for all new R21 P0 keys', () => {
  const i18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');

  // EN
  assert.match(i18n, /'ambient\.modalTitle': 'NAgex Assistant'/);
  assert.match(i18n, /'ambient\.understanding\.continue': 'Continue'/);
  // KR
  assert.match(i18n, /'ambient\.modalTitle': 'NAgex 어시스턴트'/);
  assert.match(i18n, /'ambient\.understanding\.continue': '진행하기'/);
});

test('MOBILE_360_390_430: Responsive modal styles handle mobile viewports cleanly', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'style.css'), 'utf8');

  assert.match(css, /@media\s*\(max-width:\s*768px\)/);
  assert.match(css, /\.ambient-sheet-modal\s*{\s*max-width:\s*100%;/);
});

test('ACCESSIBILITY: Modal has role=dialog, aria-modal=true, and polite aria-live sections', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /id="ambient-understanding-card"[^>]*aria-live="polite"/);
  assert.match(html, /id="ambient-user-approval-card"[^>]*aria-live="polite"/);
});
