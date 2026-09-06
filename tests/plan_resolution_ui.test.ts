import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import type { PlanPreview } from '../src/model-gateway/ai-service.js';
import { server } from '../src/server_web.js';

// public/plan-resolution-view.js is a dependency-free browser script (IIFE) with no
// build step of its own. Executing it in a vm sandbox lets us test its real logic
// (not just regex-match its source) without pulling it into the TS/tsc program.
function loadPlanView(): {
  buildResolutionViewModel: (plan: unknown) => {
    status: string | null;
    statusLabel: string;
    statusCssClass: string;
    actionLabel: string | null;
    showRunButton: boolean;
    steps: Array<{
      title: string;
      resolvedSkillId: string | null;
      resolvedToolId: string | null;
      toolAvailability: string;
      approvalRequired: boolean;
      executionReadiness: string;
      statusLabel: string;
      statusCssClass: string;
      warnings: string[];
    }>;
    warnings: Array<{ stepTitle: string | null; message: string }>;
  };
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'plan-resolution-view.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'plan-resolution-view.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_PLAN_VIEW as ReturnType<typeof loadPlanView>;
}

const planView = loadPlanView();
const resolver = new PlanResolver(skillRegistry, toolRegistry);

function planFor(tool: string | null, skill = 'Planning', requiresApproval = false): PlanPreview {
  return {
    goal: 'Prepare safely',
    summary: 'A preparation-only plan.',
    reasoningSummary: 'Resolve registry identities before execution.',
    steps: [{ step: 1, title: 'Prepare step', reasoning: 'Test resolution.', skill, tool, requiresApproval }],
  };
}

test('ready plan UI: an execution-ready resolved plan shows "Ready to Run" and a run button', () => {
  const resolved = resolver.resolve(planFor('memory.search', 'Memory Recall'));
  const vmView = planView.buildResolutionViewModel(resolved);
  assert.equal(vmView.status, 'EXECUTION_READY');
  assert.equal(vmView.statusLabel, 'Ready to Run');
  assert.equal(vmView.statusCssClass, 'plan-status-ready');
  assert.equal(vmView.showRunButton, true);
  assert.equal(vmView.actionLabel, 'Ready to Run');
  assert.equal(vmView.warnings.length, 0);
});

test('approval-required plan UI: a consequential write shows "Review & Approve" and a run button', () => {
  const resolved = resolver.resolve(planFor('workspace.prepare_draft', 'Planning'));
  const vmView = planView.buildResolutionViewModel(resolved);
  assert.equal(vmView.status, 'APPROVAL_REQUIRED');
  assert.equal(vmView.statusLabel, 'Review & Approve');
  assert.equal(vmView.statusCssClass, 'plan-status-approval');
  assert.equal(vmView.showRunButton, true);
  assert.equal(vmView.actionLabel, 'Review & Approve');
});

test('blocked plan UI: an unresolved/hallucinated tool shows "Cannot Execute"', () => {
  const resolved = resolver.resolve(planFor('gmail.delete_everything'));
  const vmView = planView.buildResolutionViewModel(resolved);
  assert.equal(vmView.status, 'BLOCKED');
  assert.equal(vmView.statusLabel, 'Cannot Execute');
  assert.equal(vmView.statusCssClass, 'plan-status-blocked');
});

test('no Run button when blocked, for every blocking reason (unresolved, unavailable, mock)', () => {
  for (const tool of ['unknown.tool', 'notion.create_page', 'Gmail']) {
    const resolved = resolver.resolve(planFor(tool, tool === 'Gmail' ? 'Email Drafting' : 'Document Summary'));
    const vmView = planView.buildResolutionViewModel(resolved);
    assert.equal(vmView.status, 'BLOCKED', `expected BLOCKED for tool ${tool}`);
    assert.equal(vmView.showRunButton, false, `expected no run button for tool ${tool}`);
    assert.equal(vmView.actionLabel, null, `expected no action label for tool ${tool}`);
  }
});

test('warning rendering: resolver warnings surface on the blocked step and roll up to the plan', () => {
  const resolved = resolver.resolve(planFor('notion.create_page', 'Document Summary'));
  const vmView = planView.buildResolutionViewModel(resolved);
  assert.equal(vmView.steps[0].warnings.length, 1);
  assert.match(vmView.steps[0].warnings[0], /unavailable/i);
  assert.equal(vmView.warnings.length, 1);
  assert.equal(vmView.warnings[0].stepTitle, 'Prepare step');
  assert.match(vmView.warnings[0].message, /unavailable/i);
});

test('a plan with no warnings renders an empty warnings list', () => {
  const resolved = resolver.resolve(planFor('memory.search', 'Memory Recall'));
  const vmView = planView.buildResolutionViewModel(resolved);
  // vmView.warnings is an array from the vm sandbox's own realm, so compare its
  // contents rather than deep-equating against a host-realm [] literal.
  assert.equal(Array.isArray(vmView.warnings), true);
  assert.equal(vmView.warnings.length, 0);
});

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('Ambient Assistant UI is wired to resolve every generated plan before showing a run action', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /id="ambient-resolution-card"/);
    assert.match(html, /id="ambient-resolution-status"/);
    assert.match(html, /id="ambient-resolution-steps"/);
    assert.match(html, /id="ambient-resolution-warnings"/);
    assert.match(html, /id="ambient-resolution-actions"/);
    assert.match(html, /src="plan-resolution-view\.js\?v=/);

    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /api\/v1\/plans\/resolve/);
    assert.match(appJs, /resolvePlanIntoUi/);

    const planViewJs = await (await fetch(`${origin}/plan-resolution-view.js`)).text();
    assert.equal(planViewJs.length > 0, true);
    assert.equal((await fetch(`${origin}/plan-resolution-view.js`)).headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  });
});
