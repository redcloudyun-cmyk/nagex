import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PermissionDecisionService, PERMISSION_POLICY_VERSION } from '../src/governance/permission/index.js';
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
