// R23.2D — Demo Canonicalization.
//
// Proves DemoScenarioService no longer builds a Home/Right Now response of
// its own (DEMO_FAKE_PERSONAL_HOME=0, DEMO_FAKE_RIGHT_NOW=0) and that the
// demo tenant's /api/v1/personal/home and /api/v1/personal/right-now
// results come from the exact same PersonalHomeService/
// RightNowIntelligenceService/CurrentPersonalContextService pipeline every
// other tenant uses (DEMO_PARALLEL_INTELLIGENCE_PIPELINE=0) — only the
// underlying data source (DemoCalendarSource/DemoGmailSource + real
// Task/Vault/Approval/Memory seed records) differs. Each test constructs
// its own fresh createNagexApplication() so it never shares state with any
// other test file (the exact cross-file pollution risk discovered while
// building this suite — see the R23.2H/R23.2D reports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

const DEMO_TENANT_ID = 'ten_demo_hackathon';
const DEMO_OWNER_ID = 'usr_demo_alex';
const DEMO_HEADERS = { 'x-nagex-demo': '1', 'x-nagex-tenant': DEMO_TENANT_ID, 'x-principal-id': DEMO_OWNER_ID };

// ─── 1. DemoScenarioService no longer intercepts personal/home ───

test('1. DemoScenarioService.handle returns undefined for GET /api/v1/personal/home', () => {
  const app = createNagexApplication();
  const result = app.demoScenarioService.handle('GET', '/api/v1/personal/home', null, DEMO_HEADERS);
  assert.equal(result, undefined, 'personal/home must fall through to the real route, never be answered here');
});

// ─── 2. GET /api/v1/personal/home (demo tenant) uses the real pipeline ───

test('2. /personal/home for the demo tenant reflects real seeded Calendar/Approval data, never fabricated fallback text', async () => {
  const app = createNagexApplication();
  const home = await app.personalHomeService.getPersonalHome({ tenantId: DEMO_TENANT_ID, principalId: DEMO_OWNER_ID });

  assert.ok(home.rightNow, 'a real primary item must be present (the seeded client meeting is always in progress)');
  assert.equal(home.rightNow?.type, 'MEETING');
  assert.equal(home.rightNow?.sourceRef, 'demo_evt_client');
  // The title legitimately matches the seeded Calendar fixture's real
  // event title ("Client strategy meeting" is real seeded data now, not a
  // hardcoded response string) — what changed is the REASON: it is now a
  // computed fact (`summary`), never the old fixed sentence.
  assert.equal(home.rightNow?.title, 'Client strategy meeting');
  assert.equal(home.rightNow?.summary, 'In progress now');
  assert.notEqual(home.rightNow?.summary, 'Pricing and delivery timing need your attention.');
});

// ─── 3. GET /api/v1/personal/right-now (demo tenant) uses the real pipeline ───

test('3. /personal/right-now for the demo tenant produces a real, grounded primary and a real suggestion', async () => {
  const app = createNagexApplication();
  const intel = await app.rightNowIntelligenceService.buildRightNow({ tenantId: DEMO_TENANT_ID, userId: DEMO_OWNER_ID });

  assert.ok(intel.primary);
  assert.equal(intel.primary?.kind, 'MEETING');
  assert.equal(intel.primary?.sourceRef.id, 'demo_evt_client');
  assert.equal(intel.primary?.reason, 'In progress now');

  const prep = intel.suggestions.find((s) => s.kind === 'MEETING_PREP');
  assert.ok(prep, 'a real MEETING_PREP suggestion must be produced from the seeded Vault/Gmail records');
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'CALENDAR' && r.id === 'demo_evt_client'));
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'GMAIL'));
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'VAULT'));
});

// ─── 4. Demo-seeded records genuinely exist in the real stores ───

test('4. seed() writes real Task/Vault/Approval/Memory records for the demo tenant', () => {
  const app = createNagexApplication();

  const tasks = app.taskStore.list(DEMO_TENANT_ID, DEMO_OWNER_ID);
  assert.ok(tasks.some((t) => t.name === 'Send follow-up after client meeting'));

  const vaultTitles = app.vaultStore.listItems(DEMO_TENANT_ID, DEMO_OWNER_ID).map((v) => v.title);
  assert.ok(vaultTitles.includes('Proposal v3'));
  assert.ok(vaultTitles.includes('Last meeting notes'));

  const approvals = app.actionApprovals.listPending(DEMO_TENANT_ID, DEMO_OWNER_ID);
  assert.ok(approvals.length >= 1);

  const memories = app.memoryEngine.getActiveMemories('USER', DEMO_TENANT_ID, DEMO_OWNER_ID);
  assert.ok(memories.some((m) => m.content.subject === 'Meeting brief preference'));
});

// ─── 5. Reset stays deterministic — no accumulation across repeated resets ───

test('5. demo reset clears and reseeds deterministically (RESET_DETERMINISTIC=1)', () => {
  const app = createNagexApplication();

  const countState = () => ({
    tasks: app.taskStore.list(DEMO_TENANT_ID, DEMO_OWNER_ID).length,
    vaultItems: app.vaultStore.listItems(DEMO_TENANT_ID, DEMO_OWNER_ID).length,
    approvals: app.actionApprovals.listPending(DEMO_TENANT_ID, DEMO_OWNER_ID).length,
  });

  const baseline = countState();
  assert.deepEqual(baseline, { tasks: 1, vaultItems: 2, approvals: 1 });

  app.demoScenarioService.handle('POST', '/api/v1/demo/reset', {}, DEMO_HEADERS);
  assert.deepEqual(countState(), baseline, 'first reset must reproduce the exact same canonical counts');

  app.demoScenarioService.handle('POST', '/api/v1/demo/reset', {}, DEMO_HEADERS);
  assert.deepEqual(countState(), baseline, 'second reset must still reproduce the exact same canonical counts — never accumulating duplicates');
});

// ─── 6. Right Now intelligence is unaffected by an unrelated tenant's data (isolation preserved) ───

test('6. demo tenant data never leaks into an unrelated real tenant\'s /personal/home (CROSS_TENANT_LEAK=0)', async () => {
  const app = createNagexApplication();
  const otherTenant = 'ten_r23_2d_unrelated';
  const otherUser = 'usr_r23_2d_unrelated';

  const home = await app.personalHomeService.getPersonalHome({ tenantId: otherTenant, principalId: otherUser });

  assert.notEqual(home.rightNow?.sourceRef, 'demo_evt_client');
  const vaultTitles = app.vaultStore.listItems(otherTenant, otherUser).map((v) => v.title);
  assert.ok(!vaultTitles.includes('Proposal v3'));
});

// ─── 7. Real (non-demo) tenants are never routed through the demo Calendar/Gmail source ───

test('7. a real tenant seeded independently reaches the same pipeline with its own real data, never the demo fixture', async () => {
  const app = createNagexApplication();
  const realTenant = 'ten_r23_2d_real';
  const realUser = 'usr_r23_2d_real';

  app.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId: realTenant, principalId: realUser, payload: {} });
  const home = await app.personalHomeService.getPersonalHome({ tenantId: realTenant, principalId: realUser });

  assert.equal(home.rightNow?.type, 'APPROVAL');
  assert.notEqual(home.rightNow?.title, 'Client strategy meeting');
});
