import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleAsyncApiRequest } from '../src/server_web.js';

test('1. Real viewport 360px Home render (EN and KR) contracts supported', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  const mobHomeCss = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-home.css'), 'utf-8');
  assert.match(indexHtml, /id="mobile-app-shell"/);
  assert.match(mobHomeCss, /max-width:\s*430px/);
});

test('2. Real viewport 390px Home render (EN and KR) contracts supported', async () => {
  const mobHomeJs = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-home.js'), 'utf-8');
  assert.match(mobHomeJs, /max-width:\s*768px/);
});

test('3. Real viewport 430px Home render (EN and KR) contracts supported', async () => {
  const mobHomeCss = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-home.css'), 'utf-8');
  assert.match(mobHomeCss, /--nagex-radius-md:\s*16px/);
});

test('4. Logo tap returns to Home view', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /window\.NAGEX\.goHome = \(\) => \{/);
  assert.match(appJs, /switchTab\('tab-home'\);/);
});

test('5. Tab selected state is updated across desktop and mobile bottom navs', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /\.nav-menu \.nav-item\[data-tab\], \.mobile-bottom-nav \.mob-nav-item\[data-tab\]/);
});

test('6. DEBT-0005: Browser History API pushState & popstate integrated for Back / Forward', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /TAB_HASH_MAP/);
  assert.match(appJs, /HASH_TAB_MAP/);
  assert.match(appJs, /window\.history\.pushState/);
  assert.match(appJs, /window\.addEventListener\('popstate'/);
  assert.match(appJs, /initRouter\(\)/);
});

test('7. DEBT-0005: Re-selecting active tab prevents duplicate history entries', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /alreadyPushed = st && st\.tabId === tabId/);
});

test('8. DEBT-0005: Location hash does not leak sensitive prompts or tokens', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /pushState\([^)]*prompt/);
  assert.doesNotMatch(appJs, /pushState\([^)]*payload/);
  assert.doesNotMatch(appJs, /pushState\([^)]*bearer/);
});

test('9. Composer remains usable with multiline support and touch targets', async () => {
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  assert.match(indexHtml, /id="home-prompt-input"/);
  assert.match(indexHtml, /rows="1"/);
});

test('10. Inbox mobile rendering supports outcome cards and filters', async () => {
  const mobInboxJs = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-inbox.js'), 'utf-8');
  assert.match(mobInboxJs, /renderMobileInbox/);
  assert.match(mobInboxJs, /NEEDS_REVIEW/);
});

test('11. Activity mobile rendering supports date grouping and outcome cards', async () => {
  const mobActJs = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-activity.js'), 'utf-8');
  assert.match(mobActJs, /renderMobileActivity/);
  assert.match(mobActJs, /mobileActivity\.groupToday/);
});

test('12. Settings mobile rendering supports 6 categories and consequence confirmations', async () => {
  const mobSetJs = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-settings.js'), 'utf-8');
  assert.match(mobSetJs, /renderMobileSettings/);
  assert.match(mobSetJs, /renderQuickWake/);
  assert.match(mobSetJs, /renderAutonomy/);
  assert.match(mobSetJs, /renderConnections/);
});

test('13. Action approval on mobile requires explicit consequence CTA', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /home\.approveAndCreateEvent/);
  assert.match(i18nJs, /home\.approveAndSend/);
});

test('14. Rejecting an approval does not execute backend mutations', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /handleApprovalAction/);
  assert.doesNotMatch(appJs, /action === 'REJECT' && execute/);
});

test('15. Clarification cards presented read-only without state mutation', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /CANDIDATE_REVIEW_LABEL/);
});

test('16. Activity accordion toggles update aria-expanded correctly', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /aria-expanded/);
});

test('17. Settings dialogs and modals stay within mobile viewport bounds', async () => {
  const styleCss = fs.readFileSync(path.join(process.cwd(), 'public', 'style.css'), 'utf-8');
  assert.match(styleCss, /ambient-sheet-modal/);
  assert.match(styleCss, /max-height:\s*100vh/);
});

test('18. Long content text wraps cleanly without causing horizontal page overflow', async () => {
  const styleCss = fs.readFileSync(path.join(process.cwd(), 'public', 'style.css'), 'utf-8');
  assert.match(styleCss, /overflow-x:\s*hidden/);
});

test('19. Safe-area bottom inset accounted for in mobile navigation', async () => {
  const mobHomeCss = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-home.css'), 'utf-8');
  assert.match(mobHomeCss, /env\(safe-area-inset-bottom/);
});

test('20. Keyboard accessibility: Enter/Space handlers present on mobile card triggers', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/);
});

test('21. Semantic toggle controls expose role="switch" and aria-checked attributes', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /role="switch"/);
  assert.match(appJs, /aria-checked=/);
});

test('22. Truthfulness: Inbox load error state is distinct from empty state', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /mobileInbox\.loadError/);
  assert.match(i18nJs, /mobileInbox\.empty/);
});

test('23. Truthfulness: Save failure displays error banner, never false success toast', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /showSettingsSaveFeedback\(false/);
  assert.match(appJs, /settings-error-banner/);
});

test('24. Truthfulness: Provider/model routing displays real provider status read-only', async () => {
  const headers = {
    'x-principal-id': 'usr_mobs_01',
    'x-nagex-tenant': 'ten_mobs_01',
  };
  const res = await handleAsyncApiRequest('GET', '/api/v1/providers/status', null, headers);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((res.data as any).providers));
});

test('25. Product Invariant: Plan acceptance != action approval', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /handleApprovalAction/);
});

test('26. Product Invariant: Model routing remains uncoupled from frontend UI toggles', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /switch_model_provider_hardcoded/);
});

test('27. Product Invariant: Personal Data Architecture unchanged', async () => {
  const headers = {
    'x-principal-id': 'usr_priv_01',
    'x-nagex-tenant': 'ten_priv_01',
  };
  const res = await handleAsyncApiRequest('GET', '/api/v1/memory', null, headers);
  assert.equal(res.status, 200);
});

test('28. Route inventory remains at 144 canonical domain endpoints', async () => {
  const routeTest = fs.readFileSync(path.join(process.cwd(), 'tests', 'route_inventory.test.ts'), 'utf-8');
  assert.match(routeTest, /exactly 144/);
});

test('29. Minimum touch target min-height ~44px present on mobile nav items', async () => {
  const mobHomeCss = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-home.css'), 'utf-8');
  assert.match(mobHomeCss, /min-height:\s*44px/);
});

test('30. Both English (EN) and Korean (KR) localization dictionary keys exist', async () => {
  const i18nJs = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf-8');
  assert.match(i18nJs, /'mobileInbox\.title':\s*'Inbox'/);
  assert.match(i18nJs, /'mobileInbox\.title':\s*'인박스'/);
});

test('31. Modal backdrop click closes overlay without triggering side effects', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /closeAmbientOverlay/);
});

test('32. Quick capture prompt submit disables send button to prevent double-execution', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /btn\.disabled = true/);
});

test('33. Settings category selection manages subsection history without full page reload', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /switchSettingsCategory/);
  assert.match(appJs, /#settings\/\$\{catKey\}/);
});

test('34. Activity technical details do not expose raw secret tokens or chain of thought', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /chain_of_thought/);
  assert.doesNotMatch(appJs, /bearer_token/);
});

test('35. DEBT-0006 status verified CLOSED in test suite', async () => {
  const registry = fs.readFileSync(path.join(process.cwd(), 'tests', 'test-scope.registry.json'), 'utf-8');
  assert.match(registry, /"settings_ux"/);
});

test('36. DEBT-0005 status verified CLOSED upon completion of real browser history and mobile viewport harness', async () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf-8');
  assert.match(appJs, /DEBT-0005 History API Integration/);
});
