import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PermissionDecisionService, PERMISSION_POLICY_VERSION } from '../src/governance/permission/index.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { NagexError } from '../src/common/errors.js';
import type { CapabilityDefinition, CapabilityRequest } from '../src/capabilities/capability.types.js';

function request(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    capabilityId: 'gmail.search',
    tenantId: 'ten_r233t',
    principalId: 'usr_r233t',
    requestId: 'req_r233t',
    payload: { query: 'pricing', secret: 'must-never-be-audited' },
    source: 'WEB',
    ...overrides,
  };
}

function definition(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: 'gmail.search',
    provider: 'GMAIL',
    risk: 'READ_ONLY',
    approval: 'NONE',
    enabled: true,
    ...overrides,
  };
}

test('R23.3T Permission Authority — deterministic hard-policy boundary', async (t) => {
  await t.test('read-only capability is ALLOW', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);
    const decision = service.evaluate({
      request: request(),
      definition: definition(),
      providerAvailable: true,
    });

    assert.equal(decision.disposition, 'ALLOW');
    assert.equal(decision.effectiveApproval, 'NONE');
    assert.equal(decision.policyVersion, PERMISSION_POLICY_VERSION);
  });

  await t.test('consequential registered capability requiring approval cannot become ALLOW', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);
    const req = request({
      capabilityId: 'gmail.send_email',
      payload: { to: ['a@example.com'], subject: 'Hi', body: 'Body' },
    });
    const def = definition({
      id: 'gmail.send_email',
      risk: 'CONSEQUENTIAL',
      approval: 'REQUIRED',
    });

    const decision = service.evaluate({ request: req, definition: def, providerAvailable: true });

    assert.equal(decision.disposition, 'REQUIRE_APPROVAL');
    assert.equal(decision.effectiveApproval, 'REQUIRED');
  });

  await t.test('missing capability blocks closed', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);
    const decision = service.evaluate({
      request: request({ capabilityId: 'unknown.capability' }),
      definition: undefined,
      providerAvailable: false,
    });

    assert.equal(decision.disposition, 'BLOCK');
    assert.ok(decision.reasonCodes.includes('CAPABILITY_NOT_FOUND'));
  });

  await t.test('missing tenant or principal blocks closed', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);

    const tenantDecision = service.evaluate({
      request: request({ tenantId: '' }),
      definition: definition(),
      providerAvailable: true,
    });
    assert.equal(tenantDecision.disposition, 'BLOCK');

    const principalDecision = service.evaluate({
      request: request({ principalId: '' }),
      definition: definition(),
      providerAvailable: true,
    });
    assert.equal(principalDecision.disposition, 'BLOCK');
  });

  await t.test('safety can escalate approval but can never downgrade registered REQUIRED approval', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);

    const escalated = service.evaluate({
      request: request({
        safetyDecision: {
          riskLevel: 'R1',
          executionAllowed: true,
          requiresActionApproval: true,
          tenantId: 'ten_r233t',
        } as any,
      }),
      definition: definition({ approval: 'NONE' }),
      providerAvailable: true,
    });
    assert.equal(escalated.disposition, 'REQUIRE_APPROVAL');

    const required = service.evaluate({
      request: request({ capabilityId: 'gmail.send_email' }),
      definition: definition({
        id: 'gmail.send_email',
        risk: 'CONSEQUENTIAL',
        approval: 'REQUIRED',
      }),
      providerAvailable: true,
    });
    assert.equal(required.disposition, 'REQUIRE_APPROVAL');
  });

  await t.test('blocked safety decision remains BLOCK', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);
    const decision = service.evaluate({
      request: request({
        safetyDecision: {
          riskLevel: 'R2',
          executionAllowed: false,
          requiresActionApproval: false,
          tenantId: 'ten_r233t',
          userFacingExplanation: 'blocked',
        } as any,
      }),
      definition: definition(),
      providerAvailable: true,
    });

    assert.equal(decision.disposition, 'BLOCK');
    assert.ok(decision.reasonCodes.includes('CAPABILITY_BLOCKED_BY_SAFETY'));
  });

  await t.test('permission audit contains metadata only, never request payload contents', () => {
    const audit = new AuditLogger();
    const service = new PermissionDecisionService(audit);
    service.evaluate({
      request: request({
        payload: {
          body: 'private email body',
          password: 'do-not-log',
          token: 'do-not-log',
        },
      }),
      definition: definition(),
      providerAvailable: true,
    });

    const logs = audit.getAuditLogs('ten_r233t');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'permission.decision');
    const serialized = JSON.stringify(logs[0]);
    assert.doesNotMatch(serialized, /private email body/);
    assert.doesNotMatch(serialized, /do-not-log/);
    assert.equal(logs[0].details?.disposition, 'ALLOW');
  });
});


test('R23.3T Approval binding — existing canonical store remains fail-closed', async (t) => {
  const tenantId = 'ten_r233t';
  const principalId = 'usr_r233t';
  const toolId = 'gmail.send_email';
  const payload = {
    from: 'user@example.com',
    to: ['alice@example.com'],
    subject: 'Approved subject',
    body: 'Approved body',
  };

  await t.test('reject is terminal and cannot be consumed as granted', () => {
    const store = new ActionApprovalStore();
    const approval = store.request({ toolId, tenantId, principalId, payload });
    store.reject(approval.approvalId, tenantId, principalId, 'req_reject');

    assert.equal(store.get(approval.approvalId, tenantId, principalId)?.status, 'REJECTED');
    assert.throws(
      () => store.consume(approval.approvalId, tenantId, principalId, toolId, payload, 'req_execute', 'exe_rejected'),
      (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_GRANTED',
    );
    const after = store.get(approval.approvalId, tenantId, principalId)!;
    assert.equal(after.status, 'REJECTED');
    assert.equal(after.executionId, null);
    assert.equal(after.usedAt, null);
  });

  await t.test('approved payload cannot drift after human review', () => {
    const store = new ActionApprovalStore();
    const approval = store.request({ toolId, tenantId, principalId, payload });
    store.approve(approval.approvalId, tenantId, principalId, 'req_approve');

    assert.throws(
      () => store.consume(
        approval.approvalId,
        tenantId,
        principalId,
        toolId,
        { ...payload, to: ['mallory@example.com'] },
        'req_execute',
        'exe_drift',
      ),
      (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_PAYLOAD_MISMATCH',
    );
    assert.equal(store.get(approval.approvalId, tenantId, principalId)?.status, 'APPROVED');
  });

  await t.test('approval cannot drift to a different tool', () => {
    const store = new ActionApprovalStore();
    const approval = store.request({ toolId, tenantId, principalId, payload });
    store.approve(approval.approvalId, tenantId, principalId, 'req_approve');

    assert.throws(
      () => store.consume(
        approval.approvalId,
        tenantId,
        principalId,
        'google_calendar.create_event',
        payload,
        'req_execute',
        'exe_tool_drift',
      ),
      (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_TOOL_MISMATCH',
    );
    assert.equal(store.get(approval.approvalId, tenantId, principalId)?.status, 'APPROVED');
  });

  await t.test('approval is consumed exactly once and replay stays blocked', () => {
    const store = new ActionApprovalStore();
    const approval = store.request({ toolId, tenantId, principalId, payload });
    store.approve(approval.approvalId, tenantId, principalId, 'req_approve');

    const consumed = store.consume(
      approval.approvalId,
      tenantId,
      principalId,
      toolId,
      payload,
      'req_execute_1',
      'exe_once',
    );
    assert.equal(consumed.status, 'CONSUMED');
    assert.equal(consumed.executionId, 'exe_once');

    assert.throws(
      () => store.consume(
        approval.approvalId,
        tenantId,
        principalId,
        toolId,
        payload,
        'req_execute_2',
        'exe_replay',
      ),
      (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED',
    );
  });

  await t.test('cross-tenant and cross-user approval reuse are hidden as not found', () => {
    const store = new ActionApprovalStore();
    const approval = store.request({ toolId, tenantId, principalId, payload });
    store.approve(approval.approvalId, tenantId, principalId, 'req_approve');

    for (const [attemptTenant, attemptPrincipal] of [
      ['ten_other', principalId],
      [tenantId, 'usr_other'],
    ] as const) {
      assert.throws(
        () => store.consume(
          approval.approvalId,
          attemptTenant,
          attemptPrincipal,
          toolId,
          payload,
          'req_cross_owner',
          'exe_cross_owner',
        ),
        (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_NOT_FOUND',
      );
    }

    assert.equal(store.get(approval.approvalId, tenantId, principalId)?.status, 'APPROVED');
  });
});


test('R23.3T Approval UX contract — edit invalidates approval and browser artifacts stay portable', () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  const r19BrowserSource = fs.readFileSync(path.join(process.cwd(), 'tests', 'r19_action_approval_real_browser.test.ts'), 'utf8');

  // Calendar and Gmail approval cards both expose Edit.
  assert.match(appSource, /id="btn-calendar-edit"/);
  assert.match(appSource, /id="btn-gmail-edit"/);

  // Edit does not mutate the approved payload in place. It first rejects
  // the old approval, then returns to the compose form; resubmission must
  // therefore mint a new approval id/hash through POST /api/v1/approvals.
  const calendarEditStart = appSource.indexOf("const btnEdit = document.getElementById('btn-calendar-edit')");
  const gmailEditStart = appSource.indexOf("const btnEdit = document.getElementById('btn-gmail-edit')");
  assert.ok(calendarEditStart >= 0);
  assert.ok(gmailEditStart >= 0);

  const calendarEditBlock = appSource.slice(calendarEditStart, calendarEditStart + 2600);
  const gmailEditBlock = appSource.slice(gmailEditStart, gmailEditStart + 2600);
  assert.match(calendarEditBlock, /\/api\/v1\/approvals\/\$\{approval\.approvalId\}\/reject/);
  assert.match(calendarEditBlock, /form\.style\.display = ''/);
  assert.match(gmailEditBlock, /\/api\/v1\/approvals\/\$\{approval\.approvalId\}\/reject/);
  assert.match(gmailEditBlock, /form\.style\.display = ''/);

  // Linux/test-server browser certification must never recreate a literal
  // Windows C:/Users/... path inside the repository.
  assert.doesNotMatch(r19BrowserSource, /C:\/Users\//);
  assert.match(r19BrowserSource, /artifacts\/screenshots/);
});
