import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

test('admin shell has persistent nav, status bar, search, range, attention and role menu', () => {
  const html = read('apps/control-center/index.html');
  const app = read('apps/control-center/app.js');
  assert.ok(html.includes('Admin navigation'));
  assert.ok(html.includes('global-search'));
  assert.ok(html.includes('time-range'));
  assert.ok(html.includes('attention-count'));
  assert.ok(html.includes('role-select'));
  assert.ok(app.includes('role:'));
  assert.ok(app.includes('ANALYTICS_VIEWER'));
});

test('role-aware navigation covers model, analytics and security roles', () => {
  const app = read('apps/control-center/app.js');
  assert.ok(app.includes("'MODEL_ADMIN'"));
  assert.ok(app.includes("'ANALYTICS_VIEWER'"));
  assert.ok(app.includes("'SECURITY_ADMIN'"));
  assert.ok(app.includes('canSee'));
  assert.ok(app.includes('filter(canSee)'));
});

test('overview and attention queue are wired to admin read model fields', () => {
  const app = read('apps/control-center/app.js');
  for (const label of ['Active Users', 'Goals Today', 'Agent Runs', 'Tool Calls', 'Goal Completion Rate', 'Verified Outcome Rate', 'First-pass Acceptance', 'Revision Burden', 'P95 Latency', 'AI Cost Today', 'Cost per Successful Outcome']) {
    assert.ok(app.includes(label), `missing ${label}`);
  }
  assert.ok(app.includes('Attention Queue'));
  assert.ok(app.includes('systemStrip'));
});

test('data origin labels distinguish LIVE, BENCHMARK and SIMULATION', () => {
  const app = read('apps/control-center/app.js');
  const styles = read('apps/control-center/styles.css');
  assert.ok(app.includes("originBadge('LIVE'"));
  assert.ok(app.includes("originBadge('BENCHMARK'"));
  assert.ok(app.includes("originBadge('SIMULATION'"));
  assert.ok(styles.includes('.origin-live'));
  assert.ok(styles.includes('.origin-benchmark'));
  assert.ok(styles.includes('.origin-simulation'));
});

test('members UI is operational and privacy-safe by default', () => {
  const app = read('apps/control-center/app.js');
  assert.ok(app.includes('No raw private content'));
  for (const section of ['Operational Summary', 'Usage', 'Devices', 'Errors', 'Support', 'Consent / Privacy', 'Account Lifecycle']) {
    assert.ok(app.includes(section));
  }
  for (const forbidden of ['message bodies', 'email bodies', 'calendar contents', 'memory contents']) {
    assert.equal(app.includes(forbidden), false);
  }
});

test('model intelligence UI includes registry, leaderboard, detail, compare, benchmarks and routing explainer', () => {
  const app = read('apps/control-center/app.js');
  for (const label of ['Model Registry', 'Task Leaderboard', 'Routing Explainer', 'Model Detail / Compare', 'BEST FIT FOR THIS TASK', 'Benchmark Freshness', 'Live Data Volume', 'Provider Health']) {
    assert.ok(app.includes(label), `missing ${label}`);
  }
  for (const task of ['Korean Executive Writing', 'Research Synthesis', 'Contradiction Detection', 'Long-document Summary', 'Structured Output', 'Reservation Reasoning', 'Evidence-grounded Answering']) {
    assert.ok(read('apps/control-center/server.mjs').includes(task), `missing ${task}`);
  }
});

test('tool registry and governance UI require role-aware audited changes', () => {
  const app = read('apps/control-center/app.js');
  for (const label of ['Tool Registry', 'Tool Detail & Governance', 'critical reason required', 'audit event', 'OPS_ADMIN']) {
    assert.ok(app.includes(label), `missing ${label}`);
  }
});

test('operations pages cover goals, executions, quality, costs, devices and health', () => {
  const app = read('apps/control-center/app.js');
  for (const label of ['Agents & Goals', 'Executions', 'OUTCOME_UNCERTAIN', 'COST_PER_SUCCESSFUL_OUTCOME', 'Devices', 'System Health']) {
    assert.ok(app.includes(label), `missing ${label}`);
  }
});

test('security and audit explorer are role restricted and structured', () => {
  const app = read('apps/control-center/app.js');
  assert.ok(app.includes("'security', 'Security', ['SUPER_ADMIN', 'SECURITY_ADMIN']"));
  assert.ok(app.includes("'audit', 'Audit', ['SUPER_ADMIN', 'SECURITY_ADMIN']"));
  assert.ok(app.includes('Audit Explorer'));
  assert.ok(app.includes('structured decision summaries, no hidden chain-of-thought'));
});

test('server payload remains privacy safe and marks deterministic data origin', () => {
  const server = read('apps/control-center/server.mjs');
  assert.ok(server.includes('rawUserPrivateContentExposed: false'));
  assert.ok(server.includes('secretExposed: false'));
  assert.ok(server.includes("dataOrigin: 'DETERMINISTIC_CERT_DATA'"));
  for (const forbidden of ['rawPrompt', 'rawModelOutput', 'emailBody', 'messageBody', 'apiKey']) {
    assert.equal(server.includes(forbidden), false);
  }
});
