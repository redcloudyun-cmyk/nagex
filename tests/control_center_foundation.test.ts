import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminAuditLog,
  AdminRbac,
  CONTROL_CENTER_BOUNDARY,
  CONTROL_CENTER_NAV,
  CONTROL_CENTER_ROUTES,
  ControlCenterFoundationScenario,
  TelemetryStore,
  ToolRegistry,
  type AdminActor,
  type ToolRegistryRecord,
} from '../src/control-center/index.js';

function sampleTool(): ToolRegistryRecord {
  const now = new Date().toISOString();
  return { toolId: 'tool.test', name: 'Test Tool', category: 'VERIFICATION', version: '1.0.0', status: 'ACTIVE', capabilities: ['VERIFY'], supportedPlatforms: ['server'], provider: 'nagex', riskLevel: 'LOW', authorityRequirement: 'NONE', privacyClass: 'INTERNAL', inputSchemaRef: 'schema://in', outputSchemaRef: 'schema://out', health: 'HEALTHY', usageCount: 0, successRate: 1, failureRate: 0, latencyP50: 10, latencyP95: 20, cost: 0, lastHealthCheckAt: now, updatedAt: now };
}

test('Control Plane is separate from Product Plane', () => {
  assert.equal(CONTROL_CENTER_BOUNDARY.productName, 'NAgex Control Center');
  assert.equal(CONTROL_CENTER_BOUNDARY.separateFrontend, true);
  assert.equal(CONTROL_CENTER_BOUNDARY.separateDeploymentBoundary, true);
  assert.equal(CONTROL_CENTER_BOUNDARY.separateAdminAuth, true);
  assert.equal(CONTROL_CENTER_BOUNDARY.productPlaneNavigation, false);
  assert.equal(CONTROL_CENTER_BOUNDARY.appBoundary, 'apps/control-center');
  assert.ok(CONTROL_CENTER_NAV.includes('AI & Models'));
  assert.ok(CONTROL_CENTER_ROUTES.includes('/ai-models/provider-health'));
});

test('Tool Registry records canonical fields and health metrics', () => {
  const registry = new ToolRegistry();
  registry.register(sampleTool());
  const tool = registry.get('tool.test')!;
  assert.equal(tool.category, 'VERIFICATION');
  assert.equal(tool.health, 'HEALTHY');
  assert.equal(tool.inputSchemaRef, 'schema://in');
});

test('tool governance requires authorized admin role', () => {
  const registry = new ToolRegistry();
  registry.register(sampleTool());
  const denied: AdminActor = { adminId: 'support', roles: ['SUPPORT_ADMIN'] };
  assert.throws(() => registry.applyPolicy('tool.test', { enabled: false, allowedPlatforms: ['server'], allowedRiskClasses: ['LOW'], requiredAuthority: 'NONE', rateLimitPerMinute: 1, providerRouting: ['nagex'], versionVisibility: 'CURRENT_ONLY' }, denied));
  registry.applyPolicy('tool.test', { enabled: false, allowedPlatforms: ['server'], allowedRiskClasses: ['LOW'], requiredAuthority: 'NONE', rateLimitPerMinute: 1, providerRouting: ['nagex'], versionVisibility: 'CURRENT_ONLY' }, { adminId: 'ops', roles: ['OPS_ADMIN'] });
  assert.equal(registry.get('tool.test')?.status, 'DISABLED');
});

test('admin RBAC is deny-by-default and role-scoped', () => {
  assert.equal(AdminRbac.can({ adminId: 'model', roles: ['MODEL_ADMIN'] }, 'MODEL_POLICY_WRITE'), true);
  assert.equal(AdminRbac.can({ adminId: 'model', roles: ['MODEL_ADMIN'] }, 'MEMBER_DELETE'), false);
  assert.equal(AdminRbac.can({ adminId: 'support', roles: ['SUPPORT_ADMIN'] }, 'MODEL_POLICY_WRITE'), false);
});

test('telemetry schema excludes raw user content and supports retention classes', () => {
  const telemetry = new TelemetryStore();
  const event = telemetry.record({ eventType: 'REPORT_CREATED', state: 'VERIFIED', resultType: 'REPORT_CREATED', privacyClass: 'INTERNAL', retentionClass: 'ANALYTICS_AGGREGATED', feature: 'creation', revisionCount: 1, estimatedCost: 0.1 });
  assert.equal(event.schemaVersion, 'admin_telemetry_v1');
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'rawContent'), false);
  assert.equal(event.retentionClass, 'ANALYTICS_AGGREGATED');
});

test('product analytics track outcomes, revision burden and cost per successful outcome', () => {
  const telemetry = new TelemetryStore();
  telemetry.record({ eventType: 'GOAL_COMPLETED', state: 'COMPLETED', resultType: 'FIRST_PASS_ACCEPTED', privacyClass: 'INTERNAL', retentionClass: 'ANALYTICS_AGGREGATED', feature: 'creation', revisionCount: 2, estimatedCost: 0.2 });
  const aggregate = telemetry.aggregate();
  assert.equal(aggregate.goalCompletion, 1);
  assert.equal(aggregate.revisionBurden, 2);
  assert.equal(aggregate.costToResult, 0.2);
  assert.equal(aggregate.firstPassAcceptance, 1);
});

test('critical admin actions require reason and create audit chain', () => {
  const audit = new AdminAuditLog();
  const actor = { adminId: 'ops', roles: ['OPS_ADMIN'] as const };
  assert.throws(() => audit.record(actor, 'tool.disable', 'tool.test', undefined, true));
  audit.record(actor, 'tool.disable', 'tool.test', 'provider incident', true);
  assert.equal(audit.list().length, 1);
});

test('foundation scenario builds privacy-safe admin read model', () => {
  const scenario = new ControlCenterFoundationScenario().run();
  assert.equal(scenario.readModel.member.memberId, 'member_hash_1');
  assert.equal(scenario.readModel.member.goalsCompleted, 1);
  assert.equal(scenario.readModel.analytics.goalCompletion, 1);
  assert.equal(scenario.readModel.toolHealth.length, 1);
  assert.equal(scenario.readModel.routes.includes('/executions'), true);
  assert.equal(scenario.readModel.costDashboard.costPerSuccessfulOutcome, 0.06);
  assert.equal(JSON.stringify(scenario.readModel).includes('message contents'), false);
});

test('overview, system health and attention queue answer operator questions', () => {
  const read = new ControlCenterFoundationScenario().run().readModel;
  assert.equal(read.overview.verifiedOutcomeRate, 1);
  assert.ok(read.systemHealth.some((component) => component.component === 'Model Intelligence' && component.health === 'HEALTHY'));
  assert.ok(read.attentionQueue.some((item) => item.type === 'OUTCOME_UNCERTAIN'));
  assert.equal(read.goalMonitoring[0].state, 'COMPLETED');
  assert.equal(read.executionMonitoring[0].state, 'VERIFIED');
  assert.equal(read.securityEvents.every((event) => event.roleRestricted), true);
  assert.equal(read.auditTrace[0].outcomeRef, 'REPORT_CREATED');
});

test('model intelligence integration is available through Control Center foundation', () => {
  const scenario = new ControlCenterFoundationScenario().run();
  const manifest = scenario.modelManifest as { modelCount: number; rankings: unknown; feedbackPersisted: boolean; dataOrigin: string; records: Array<{ dataOrigin?: string }> };
  assert.equal(manifest.modelCount > 0, true);
  assert.equal(manifest.feedbackPersisted, true);
  assert.equal(manifest.dataOrigin, 'SIMULATION');
  assert.ok(manifest.records.every((record) => record.dataOrigin === 'SIMULATION'));
  assert.ok(manifest.rankings);
});
