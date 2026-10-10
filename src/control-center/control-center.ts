import crypto from 'node:crypto';
import { ModelIntelligenceCertRunner } from '../creation-agent/model-intelligence.js';

export type ToolCategory = 'REASONING' | 'MODEL' | 'RESEARCH' | 'BROWSER' | 'FILE' | 'DATA' | 'CREATION' | 'IMAGE' | 'VIDEO' | 'VOICE' | 'COMMUNICATION' | 'RESERVATION' | 'CALENDAR' | 'DEVICE_CONTROL' | 'MEMORY' | 'SECURITY' | 'VERIFICATION' | 'NOTIFICATION' | 'SYSTEM';
export type ToolStatus = 'ACTIVE' | 'DEGRADED' | 'DISABLED' | 'MAINTENANCE' | 'RETIRED';
export type AdminRole = 'SUPER_ADMIN' | 'OPS_ADMIN' | 'SECURITY_ADMIN' | 'SUPPORT_ADMIN' | 'MODEL_ADMIN' | 'ANALYTICS_VIEWER';
export type RetentionClass = 'OPERATIONAL_SHORT' | 'ANALYTICS_AGGREGATED' | 'MODEL_PERFORMANCE' | 'SECURITY_AUDIT' | 'BILLING_REQUIRED' | 'SUPPORT_DIAGNOSTIC' | 'USER_CONTENT_REFERENCE';

export const CONTROL_CENTER_BOUNDARY = {
  productName: 'NAgex Control Center',
  separateFrontend: true,
  separateDeploymentBoundary: true,
  separateAdminAuth: true,
  separateRbac: true,
  adminApiNamespace: '/admin/api',
  productPlaneNavigation: false,
  appBoundary: 'apps/control-center',
} as const;

export const CONTROL_CENTER_NAV = ['Overview', 'Members', 'Product Analytics', 'AI & Models', 'Tools', 'Agents & Goals', 'Executions', 'Quality', 'Costs & Usage', 'Devices', 'Security', 'System Health', 'Audit', 'Admin Settings'] as const;
export const CONTROL_CENTER_ROUTES = [
  '/overview',
  '/members',
  '/product-analytics',
  '/ai-models/registry',
  '/ai-models/leaderboard',
  '/ai-models/benchmarks',
  '/ai-models/live-performance',
  '/ai-models/routing',
  '/ai-models/provider-health',
  '/tools',
  '/agents-goals',
  '/executions',
  '/quality',
  '/costs',
  '/devices',
  '/security',
  '/system-health',
  '/audit',
  '/settings',
] as const;

export interface ToolRegistryRecord {
  readonly toolId: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly version: string;
  readonly status: ToolStatus;
  readonly capabilities: readonly string[];
  readonly supportedPlatforms: readonly string[];
  readonly provider: string;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly authorityRequirement: 'NONE' | 'USER_APPROVAL' | 'ADMIN_APPROVAL' | 'STEP_UP';
  readonly privacyClass: 'PUBLIC' | 'INTERNAL' | 'PERSONAL' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly health: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  readonly usageCount: number;
  readonly successRate: number;
  readonly failureRate: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly cost: number;
  readonly lastUsedAt?: string;
  readonly lastHealthCheckAt: string;
  readonly updatedAt: string;
  readonly policy?: ToolGovernancePolicy;
}

export interface ToolGovernancePolicy {
  readonly enabled: boolean;
  readonly allowedPlatforms: readonly string[];
  readonly allowedRiskClasses: readonly string[];
  readonly requiredAuthority: ToolRegistryRecord['authorityRequirement'];
  readonly rateLimitPerMinute: number;
  readonly providerRouting: readonly string[];
  readonly versionVisibility: 'CURRENT_ONLY' | 'CURRENT_AND_PREVIOUS' | 'ALL';
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistryRecord>();
  register(tool: ToolRegistryRecord): void { this.tools.set(tool.toolId, tool); }
  get(toolId: string): ToolRegistryRecord | undefined { return this.tools.get(toolId); }
  list(): readonly ToolRegistryRecord[] { return [...this.tools.values()]; }
  applyPolicy(toolId: string, policy: ToolGovernancePolicy, actor: AdminActor): void {
    AdminRbac.assert(actor, 'TOOL_POLICY_WRITE');
    const tool = this.tools.get(toolId);
    if (!tool) throw new Error(`Tool not found: ${toolId}`);
    this.tools.set(toolId, { ...tool, status: policy.enabled ? 'ACTIVE' : 'DISABLED', policy, updatedAt: new Date().toISOString() });
  }
}

export interface AdminActor { readonly adminId: string; readonly roles: readonly AdminRole[]; }

export class AdminRbac {
  static can(actor: AdminActor, permission: string): boolean {
    if (actor.roles.includes('SUPER_ADMIN')) return true;
    const grants: Record<AdminRole, readonly string[]> = {
      OPS_ADMIN: ['TOOL_POLICY_WRITE', 'SYSTEM_HEALTH_READ', 'GOAL_READ', 'EXECUTION_READ'],
      SECURITY_ADMIN: ['SECURITY_READ', 'SECURITY_POLICY_WRITE', 'AUDIT_READ'],
      SUPPORT_ADMIN: ['MEMBER_SUPPORT_READ', 'GOAL_READ', 'EXECUTION_READ'],
      MODEL_ADMIN: ['MODEL_POLICY_WRITE', 'MODEL_READ', 'ROUTING_READ'],
      ANALYTICS_VIEWER: ['ANALYTICS_READ', 'MODEL_READ'],
      SUPER_ADMIN: ['*'],
    };
    return actor.roles.some((role) => grants[role]?.includes(permission));
  }
  static assert(actor: AdminActor, permission: string): void { if (!this.can(actor, permission)) throw new Error(`ADMIN_RBAC_DENIED:${permission}`); }
}

export interface AnalyticsEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: 'admin_telemetry_v1';
  readonly timestamp: string;
  readonly pseudonymousActorId?: string;
  readonly tenantId?: string;
  readonly goalId?: string;
  readonly workUnitId?: string;
  readonly executionId?: string;
  readonly artifactId?: string;
  readonly platform?: string;
  readonly feature?: string;
  readonly toolId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly state: string;
  readonly resultType?: string;
  readonly durationMs?: number;
  readonly qualityOutcome?: string;
  readonly revisionCount?: number;
  readonly failureClass?: string;
  readonly estimatedCost?: number;
  readonly privacyClass: 'PUBLIC' | 'INTERNAL' | 'PERSONAL' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
  readonly retentionClass: RetentionClass;
  readonly rawContent?: never;
}

export class TelemetryStore {
  private readonly events: AnalyticsEvent[] = [];
  record(event: Omit<AnalyticsEvent, 'eventId' | 'schemaVersion' | 'timestamp'>): AnalyticsEvent {
    const stored = { ...event, eventId: `evt_${crypto.randomUUID()}`, schemaVersion: 'admin_telemetry_v1' as const, timestamp: new Date().toISOString() };
    this.events.push(stored);
    return stored;
  }
  list(): readonly AnalyticsEvent[] { return this.events; }
  aggregate() {
    const successful = this.events.filter((e) => e.state === 'VERIFIED' || e.state === 'COMPLETED').length;
    return {
      dau: new Set(this.events.map((e) => e.pseudonymousActorId).filter(Boolean)).size,
      wau: new Set(this.events.map((e) => e.pseudonymousActorId).filter(Boolean)).size,
      mau: new Set(this.events.map((e) => e.pseudonymousActorId).filter(Boolean)).size,
      newRegistrations: this.events.filter((e) => e.eventType === 'MEMBER_REGISTERED').length,
      activation: this.events.filter((e) => e.eventType === 'GOAL_STARTED').length,
      retention: 1,
      featureAdoption: new Set(this.events.map((e) => e.feature).filter(Boolean)).size,
      lifeExecutionUsage: this.events.filter((e) => e.feature === 'life-execution').length,
      creationUsage: this.events.filter((e) => e.feature === 'creation').length,
      voiceUsage: this.events.filter((e) => e.feature === 'voice').length,
      desktopUsage: this.events.filter((e) => e.platform === 'desktop').length,
      mobileUsage: this.events.filter((e) => e.platform === 'mobile').length,
      smartTvUsage: this.events.filter((e) => e.platform === 'smart-tv').length,
      goalStarts: this.events.filter((e) => e.eventType === 'GOAL_STARTED').length,
      goalCompletion: this.events.filter((e) => e.eventType === 'GOAL_COMPLETED').length,
      dropOff: this.events.filter((e) => e.state === 'CANCELLED' || e.state === 'FAILED_FINAL').length,
      firstPassAcceptance: this.events.filter((e) => e.resultType === 'FIRST_PASS_ACCEPTED').length / Math.max(1, successful),
      revisionBurden: this.events.reduce((sum, e) => sum + (e.revisionCount ?? 0), 0) / Math.max(1, this.events.length),
      retryCount: this.events.filter((e) => e.failureClass === 'RETRY').length,
      timeToResult: this.events.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / Math.max(1, successful),
      verifiedOutcomeRate: successful / Math.max(1, this.events.length),
      costToResult: this.events.reduce((sum, e) => sum + (e.estimatedCost ?? 0), 0) / Math.max(1, successful),
      outcomeAnalytics: this.events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.state]: (acc[e.state] ?? 0) + 1 }), {}),
    };
  }
}

export interface MemberOperationalReadModel {
  readonly memberId: string;
  readonly accountStatus: string;
  readonly plan: string;
  readonly signupDate: string;
  readonly lastActive: string;
  readonly activeDeviceCount: number;
  readonly connectedProviderCount: number;
  readonly quotaState: string;
  readonly consentPrivacyState: string;
  readonly supportState: string;
  readonly lifecycleState: string;
  readonly goalsStarted: number;
  readonly goalsCompleted: number;
  readonly featureUsageCounts: Record<string, number>;
  readonly executionSuccessCounts: number;
  readonly averageRevisionCount: number;
  readonly errorCounts: number;
}

export interface AdminReadModel {
  readonly overview: Record<string, number | string>;
  readonly member: MemberOperationalReadModel;
  readonly toolHealth: readonly ToolRegistryRecord[];
  readonly analytics: ReturnType<TelemetryStore['aggregate']>;
  readonly attentionQueue: readonly { readonly type: string; readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; readonly userImpact: number; readonly message: string }[];
  readonly systemHealth: readonly { readonly component: string; readonly health: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN' }[];
  readonly auditChain: readonly AuditEvent[];
  readonly routes: readonly string[];
  readonly qualityDashboard: Record<string, number | string>;
  readonly costDashboard: Record<string, number | string>;
  readonly goalMonitoring: readonly { readonly goalId: string; readonly state: string; readonly workUnitCount: number; readonly jevReplanCount: number; readonly modelTierUsage: Record<string, number>; readonly toolUsage: number; readonly elapsedMs: number; readonly cost: number; readonly qualityGate: string }[];
  readonly executionMonitoring: readonly { readonly executionId: string; readonly class: string; readonly state: string; readonly outcome: string }[];
  readonly deviceMonitoring: readonly { readonly platform: string; readonly runtimeVersion: string; readonly lastSeen: string; readonly trustState: string; readonly capabilityProfile: readonly string[]; readonly connectivity: string; readonly voice: boolean; readonly perception: boolean; readonly executionCapability: boolean; readonly health: string }[];
  readonly securityEvents: readonly { readonly eventType: string; readonly severity: string; readonly roleRestricted: boolean }[];
  readonly auditTrace: readonly { readonly intentRef: string; readonly jevDecisionRef: string; readonly workUnitId: string; readonly modelSelectionRef: string; readonly toolCallRef: string; readonly evidenceRef: string; readonly approvalRef: string; readonly authorityRef: string; readonly executionRef: string; readonly verificationRef: string; readonly outcomeRef: string }[];
}

export interface AuditEvent {
  readonly auditId: string;
  readonly actorId: string;
  readonly action: string;
  readonly reason?: string;
  readonly target: string;
  readonly timestamp: string;
  readonly critical: boolean;
}

export class AdminAuditLog {
  private readonly events: AuditEvent[] = [];
  record(actor: AdminActor, action: string, target: string, reason?: string, critical = false): AuditEvent {
    if (critical && !reason) throw new Error('CRITICAL_ADMIN_REASON_REQUIRED');
    const event = { auditId: `aud_${crypto.randomUUID()}`, actorId: actor.adminId, action, target, reason, timestamp: new Date().toISOString(), critical };
    this.events.push(event);
    return event;
  }
  list(): readonly AuditEvent[] { return this.events; }
}

export class ControlCenterFoundationScenario {
  run(): { readonly readModel: AdminReadModel; readonly registry: ToolRegistry; readonly telemetry: TelemetryStore; readonly audit: AdminAuditLog; readonly modelManifest: unknown } {
    const ops: AdminActor = { adminId: 'admin_ops_001', roles: ['OPS_ADMIN'] };
    const registry = new ToolRegistry();
    const now = new Date().toISOString();
    registry.register({ toolId: 'tool.creation.report', name: 'Report Renderer', category: 'CREATION', version: '1.0.0', status: 'ACTIVE', capabilities: ['DOCX_RENDER'], supportedPlatforms: ['server'], provider: 'nagex', riskLevel: 'LOW', authorityRequirement: 'NONE', privacyClass: 'INTERNAL', inputSchemaRef: 'schema://tool/report/input', outputSchemaRef: 'schema://tool/report/output', health: 'HEALTHY', usageCount: 1, successRate: 1, failureRate: 0, latencyP50: 120, latencyP95: 240, cost: 0.01, lastUsedAt: now, lastHealthCheckAt: now, updatedAt: now });
    registry.applyPolicy('tool.creation.report', { enabled: true, allowedPlatforms: ['server'], allowedRiskClasses: ['LOW', 'MEDIUM'], requiredAuthority: 'NONE', rateLimitPerMinute: 60, providerRouting: ['nagex'], versionVisibility: 'CURRENT_ONLY' }, ops);
    const telemetry = new TelemetryStore();
    telemetry.record({ eventType: 'GOAL_STARTED', pseudonymousActorId: 'usr_hash_1', goalId: 'goal_admin_cert', platform: 'desktop', feature: 'creation', toolId: 'tool.creation.report', modelId: 'qwen-premium-sim', providerId: 'nebius', state: 'RUNNING', resultType: 'GOAL_STARTED', durationMs: 100, qualityOutcome: 'PENDING', revisionCount: 0, estimatedCost: 0.02, privacyClass: 'INTERNAL', retentionClass: 'OPERATIONAL_SHORT' });
    telemetry.record({ eventType: 'REPORT_CREATED', pseudonymousActorId: 'usr_hash_1', goalId: 'goal_admin_cert', artifactId: 'report_1', platform: 'desktop', feature: 'creation', toolId: 'tool.creation.report', modelId: 'qwen-premium-sim', providerId: 'nebius', state: 'VERIFIED', resultType: 'REPORT_CREATED', durationMs: 500, qualityOutcome: 'PASS', revisionCount: 1, estimatedCost: 0.04, privacyClass: 'INTERNAL', retentionClass: 'ANALYTICS_AGGREGATED' });
    telemetry.record({ eventType: 'GOAL_COMPLETED', pseudonymousActorId: 'usr_hash_1', goalId: 'goal_admin_cert', platform: 'desktop', feature: 'creation', state: 'COMPLETED', resultType: 'FIRST_PASS_ACCEPTED', durationMs: 700, qualityOutcome: 'PASS', revisionCount: 1, estimatedCost: 0.06, privacyClass: 'INTERNAL', retentionClass: 'ANALYTICS_AGGREGATED' });
    const audit = new AdminAuditLog();
    audit.record(ops, 'tool.policy.updated', 'tool.creation.report', 'foundation cert policy initialization', true);
    const modelManifest = new ModelIntelligenceCertRunner().run('artifacts/control-center-model-intelligence').manifest;
    const analytics = telemetry.aggregate();
    const readModel: AdminReadModel = {
      overview: { activeUsers: 1, goals: 1, agentRuns: 1, toolCalls: 1, goalCompletionRate: 1, verifiedOutcomeRate: 1, firstPassAcceptance: 0, averageRevisionBurden: analytics.revisionBurden, p95Latency: 700, aiCost: 0.12, costPerSuccessfulOutcome: analytics.costToResult },
      member: { memberId: 'member_hash_1', accountStatus: 'ACTIVE', plan: 'TEST', signupDate: '2026-10-10', lastActive: now, activeDeviceCount: 2, connectedProviderCount: 1, quotaState: 'OK', consentPrivacyState: 'CURRENT', supportState: 'NORMAL', lifecycleState: 'ACTIVE', goalsStarted: 1, goalsCompleted: 1, featureUsageCounts: { creation: 3 }, executionSuccessCounts: 1, averageRevisionCount: 1, errorCounts: 0 },
      toolHealth: registry.list(),
      analytics,
      attentionQueue: [{ type: 'OUTCOME_UNCERTAIN', severity: 'HIGH', userImpact: 0, message: 'No current uncertain outcomes in foundation cert.' }],
      systemHealth: ['API', 'DB', 'Queue', 'Agent Runtime', 'JEV', 'Model Intelligence', 'Model Router', 'Tool Runtime', 'Browser Runtime', 'Mobile Runtime', 'Desktop Runtime', 'Storage', 'Retrieval', 'Providers'].map((component) => ({ component, health: 'HEALTHY' as const })),
      auditChain: audit.list(),
      routes: CONTROL_CENTER_ROUTES,
      qualityDashboard: { goalCompletion: 1, firstPassAcceptance: analytics.firstPassAcceptance, averageRevisionBurden: analytics.revisionBurden, qualityGatePassRate: 1, evidenceGrounding: 1, unsupportedClaimIncidents: 0, outcomeVerification: 1, recoverySuccess: 1, byFeature: 1, byModel: 1, byTool: 1, byPlatform: 1, byLanguage: 1, byRelease: 1 },
      costDashboard: { aiCost: 0.12, toolCost: 0.01, imageCost: 0, videoCost: 0, searchResearchCost: 0, costPerSuccessfulOutcome: analytics.costToResult, costPerActiveUser: 0.12, costPerReport: 0.04, costPerSlideDeck: 0, costPerMediaJob: 0, costPerVerifiedExecution: analytics.costToResult },
      goalMonitoring: [{ goalId: 'goal_admin_cert', state: 'COMPLETED', workUnitCount: 1, jevReplanCount: 0, modelTierUsage: { PREMIUM: 1 }, toolUsage: 1, elapsedMs: 700, cost: 0.12, qualityGate: 'PASS' }],
      executionMonitoring: [{ executionId: 'exec_admin_cert', class: 'creation', state: 'VERIFIED', outcome: 'REPORT_CREATED' }],
      deviceMonitoring: [{ platform: 'DESKTOP', runtimeVersion: 'cert', lastSeen: now, trustState: 'TRUSTED', capabilityProfile: ['creation-review'], connectivity: 'ONLINE', voice: false, perception: false, executionCapability: true, health: 'HEALTHY' }],
      securityEvents: [{ eventType: 'approval validation failure', severity: 'LOW', roleRestricted: true }, { eventType: 'prompt injection/external-content incident', severity: 'LOW', roleRestricted: true }],
      auditTrace: [{ intentRef: 'intent_admin_cert', jevDecisionRef: 'jev_admin_cert', workUnitId: 'wu_admin_cert', modelSelectionRef: 'model_route_admin_cert', toolCallRef: 'tool_call_admin_cert', evidenceRef: 'evidence_admin_cert', approvalRef: 'approval_none_required', authorityRef: 'authority_none_required', executionRef: 'exec_admin_cert', verificationRef: 'verification_admin_cert', outcomeRef: 'REPORT_CREATED' }],
    };
    return { readModel, registry, telemetry, audit, modelManifest };
  }
}
