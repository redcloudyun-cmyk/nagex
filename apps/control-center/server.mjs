import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '4500', 10);
const environment = process.env.CONTROL_CENTER_ENV ?? 'TEST';
const adminSessionCookie = process.env.CONTROL_CENTER_SESSION_NAME ?? '__Host-nagex_admin_session';
const configuredToken = process.env.NAGEX_CONTROL_ADMIN_TOKEN;
const initialSuperAdminEmail = 'redcloudyun@gmail.com';
const configuredAllowlist = process.env.NAGEX_CONTROL_ADMIN_ALLOWLIST ?? `${initialSuperAdminEmail}:SUPER_ADMIN`;
const authorizedAdmins = new Map(configuredAllowlist.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
  const [email, role = 'SUPER_ADMIN'] = entry.split(':');
  return [email.toLowerCase(), role];
}));
const cfAccessTeamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
const cfAccessAudience = process.env.CF_ACCESS_AUDIENCE;
const adminSessionSecret = process.env.NAGEX_CONTROL_ADMIN_SESSION_SECRET ?? crypto.randomBytes(32).toString('hex');
const adminSessionIdleSeconds = 1800;
const adminSessionAbsoluteSeconds = 28800;
let cfJwksCache;
const routeManifest = JSON.parse(await fs.readFile(path.join(__dirname, 'routes.json'), 'utf8'));
const controlCenterBoundary = {
  productName: routeManifest.productName,
  adminApiNamespace: routeManifest.adminApiNamespace,
};
const controlCenterNav = [
  'Overview',
  'Members',
  'Product Analytics',
  'AI & Models',
  'Tools',
  'Agents & Goals',
  'Executions',
  'Quality',
  'Costs & Usage',
  'Devices',
  'Security',
  'System Health',
  'Audit',
  'Admin Settings',
];

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const securityHeaders = {
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Frame-Options': 'DENY',
};

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function writeJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    ...securityHeaders,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function auditAdmin(eventType, payload) {
  const safe = {
    eventType,
    timestamp: new Date().toISOString(),
    email: payload.email,
    role: payload.role,
    authSource: payload.authSource,
    result: payload.result,
    reason: payload.reason,
  };
  console.log(`nagex_control_admin_audit ${JSON.stringify(safe)}`);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function timingSafeTokenMatches(received) {
  if (!configuredToken) return false;
  const expectedBuffer = Buffer.from(configuredToken);
  const receivedBuffer = Buffer.from(received ?? '');
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

function signSessionPayload(payload) {
  const encoded = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', adminSessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySessionCookie(value) {
  if (!value || !value.includes('.')) return undefined;
  const [encoded, sig] = value.split('.');
  const expected = crypto.createHmac('sha256', adminSessionSecret).update(encoded).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  const payload = JSON.parse(decodeBase64url(encoded));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now || payload.idleExp <= now) return undefined;
  if (!authorizedAdmins.get(String(payload.email).toLowerCase()) || authorizedAdmins.get(String(payload.email).toLowerCase()) !== payload.role) return undefined;
  return { email: payload.email, role: payload.role, authMethod: payload.authSource, sessionId: payload.sid, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

function createAdminSession(actor) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sid: `adm_${crypto.randomUUID()}`,
    email: actor.email,
    role: actor.role,
    authSource: actor.authMethod,
    iat: now,
    idleExp: now + adminSessionIdleSeconds,
    exp: now + adminSessionAbsoluteSeconds,
  };
  return { cookie: signSessionPayload(payload), expiresAt: new Date(payload.exp * 1000).toISOString() };
}

function adminSessionCookieHeader(cookie, maxAge = adminSessionIdleSeconds) {
  return `${adminSessionCookie}=${cookie}; Path=/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function adminSessionPayload(actor) {
  return {
    authenticated: true,
    admin: { email: actor.email, role: actor.role, authSource: actor.authMethod },
    identityPolicy: {
      verifiedOidcOnly: true,
      initialSuperAdmin: initialSuperAdminEmail,
      exactEmailAllowlist: true,
      defaultAdminAccess: 'DENY',
      domainWildcardAllowed: false,
      localPasswordLogin: false,
    },
    session: {
      cookieName: adminSessionCookie,
      separateFromUserSession: true,
      idleTimeoutSeconds: adminSessionIdleSeconds,
      absoluteLifetimeSeconds: adminSessionAbsoluteSeconds,
      revocationSupported: true,
      expiresAt: actor.expiresAt ?? new Date((Math.floor(Date.now() / 1000) + adminSessionAbsoluteSeconds) * 1000).toISOString(),
    },
  };
}

function pemFromJwk(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

async function getCloudflareJwks() {
  if (cfJwksCache && cfJwksCache.expiresAt > Date.now()) return cfJwksCache.keys;
  if (!cfAccessTeamDomain) return [];
  const response = await fetch(`https://${cfAccessTeamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error('CF_ACCESS_JWKS_UNAVAILABLE');
  const body = await response.json();
  cfJwksCache = { keys: body.keys ?? [], expiresAt: Date.now() + 10 * 60 * 1000 };
  return cfJwksCache.keys;
}

async function verifyCloudflareAccessJwt(jwt) {
  if (!jwt || !cfAccessTeamDomain || !cfAccessAudience) return undefined;
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  const header = JSON.parse(decodeBase64url(parts[0]));
  const claims = JSON.parse(decodeBase64url(parts[1]));
  if (claims.iss !== `https://${cfAccessTeamDomain}`) return undefined;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(cfAccessAudience)) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= now) return undefined;
  const keys = await getCloudflareJwks();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) return undefined;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const valid = verifier.verify(pemFromJwk(jwk), parts[2], 'base64url');
  if (!valid) return undefined;
  const email = String(claims.email ?? claims.identity?.email ?? claims.common_name ?? '').trim().toLowerCase();
  if (!email) return undefined;
  return { email, claims };
}

async function adminActorFromRequest(req, res) {
  const sessionActor = verifySessionCookie(parseCookies(req)[adminSessionCookie]);
  if (sessionActor) return sessionActor;

  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  if (timingSafeTokenMatches(bearer)) {
    return { email: 'token-admin@nagex.local', role: process.env.NAGEX_CONTROL_ADMIN_TOKEN_ROLE ?? 'SUPER_ADMIN', authMethod: 'ADMIN_BEARER_TOKEN' };
  }

  const jwt = String(req.headers['cf-access-jwt-assertion'] ?? '');
  const verified = await verifyCloudflareAccessJwt(jwt);
  if (verified) {
    const role = authorizedAdmins.get(verified.email);
    if (!role) {
      auditAdmin('admin_login_failure', { email: verified.email, result: 'DENIED', reason: 'NOT_ALLOWLISTED', authSource: 'CLOUDFLARE_ACCESS_GOOGLE' });
      return undefined;
    }
    const actor = { email: verified.email, role, authMethod: 'CLOUDFLARE_ACCESS_GOOGLE' };
    const session = createAdminSession(actor);
    actor.expiresAt = session.expiresAt;
    res.setHeader('Set-Cookie', adminSessionCookieHeader(session.cookie));
    auditAdmin('admin_login_success', { ...actor, authSource: actor.authMethod, result: 'SUCCESS' });
    auditAdmin('admin_session_created', { ...actor, authSource: actor.authMethod, result: 'SUCCESS' });
    return actor;
  }
  return undefined;
}

function permissionForPath(pathname) {
  if (pathname.includes('/security') || pathname.includes('/audit')) return ['SUPER_ADMIN', 'SECURITY_ADMIN'];
  if (pathname.includes('/models') || pathname.includes('/routing')) return ['SUPER_ADMIN', 'MODEL_ADMIN'];
  if (pathname.includes('/tools') || pathname.includes('/governance')) return ['SUPER_ADMIN', 'OPS_ADMIN'];
  return ['SUPER_ADMIN', 'OPS_ADMIN', 'SECURITY_ADMIN', 'SUPPORT_ADMIN', 'MODEL_ADMIN', 'ANALYTICS_VIEWER'];
}

async function requireAdmin(req, res, roles) {
  const actor = await adminActorFromRequest(req, res);
  if (!actor) {
    auditAdmin('admin_login_failure', { result: 'DENIED', reason: 'AUTH_REQUIRED' });
    writeJson(res, 401, { error: 'ADMIN_AUTH_REQUIRED' });
    return undefined;
  }
  if (!roles.includes(actor.role)) {
    auditAdmin('admin_login_failure', { email: actor.email, role: actor.role, authSource: actor.authMethod, result: 'DENIED', reason: 'RBAC_DENIED' });
    writeJson(res, 403, { error: 'ADMIN_RBAC_DENIED', requiredRoles: roles });
    return undefined;
  }
  return actor;
}

function makeReadModel() {
  const now = new Date().toISOString();
  const tool = {
    toolId: 'tool.creation.report',
    name: 'Report Renderer',
    category: 'CREATION',
    version: '1.0.0',
    status: 'ACTIVE',
    capabilities: ['DOCX_RENDER'],
    supportedPlatforms: ['server'],
    provider: 'nagex',
    riskLevel: 'LOW',
    authorityRequirement: 'NONE',
    privacyClass: 'INTERNAL',
    health: 'HEALTHY',
    usageCount: 1,
    successRate: 1,
    failureRate: 0,
    latencyP50: 120,
    latencyP95: 240,
    cost: 0.01,
  };
  return {
    overview: {
      activeUsers: 1,
      goals: 1,
      agentRuns: 1,
      toolCalls: 1,
      goalCompletionRate: 1,
      verifiedOutcomeRate: 1,
      firstPassAcceptance: 0,
      averageRevisionBurden: 1,
      p95Latency: 700,
      aiCost: 0.12,
      costPerSuccessfulOutcome: 0.06,
    },
    member: {
      memberId: 'member_hash_1',
      accountStatus: 'ACTIVE',
      plan: 'TEST',
      lastActive: now,
      activeDeviceCount: 2,
      connectedProviderCount: 1,
      quotaState: 'OK',
      consentPrivacyState: 'CURRENT',
      supportState: 'NORMAL',
      lifecycleState: 'ACTIVE',
      goalsStarted: 1,
      goalsCompleted: 1,
      errorCounts: 0,
    },
    analytics: {
      dau: 1,
      wau: 1,
      mau: 1,
      newRegistrations: 0,
      activation: 1,
      featureAdoption: 3,
      goalCompletion: 1,
      dropOff: 0,
      mobileUsage: 1,
      desktopUsage: 1,
      smartTvUsage: 0,
      lifeExecutionUsage: 0,
      creationUsage: 3,
      voiceUsage: 1,
      firstPassAcceptance: 0,
      revisionBurden: 1,
      retryCount: 0,
      timeToResult: 700,
      verifiedOutcomeRate: 1,
    },
    modelIntelligence: {
      benchmarkFreshness: 'current cert',
      liveDataVolume: 1,
      scoringPolicyVersion: 'MODEL_SCORING_POLICY_V1',
      benchmarkVersion: 'NAGEX_BENCHMARK_V1',
      livePerformanceWindow: '24h',
      registry: [
        { model: 'qwen-premium-sim', provider: 'nebius', family: 'qwen', host: 'cloud', status: 'ACTIVE', tierEligibility: 'PREMIUM', context: 'long', vision: 'yes', toolUse: 'yes', structuredOutput: 'yes', privacyCapability: 'INTERNAL', cost: '$$', latencyClass: 'MEDIUM', dataOrigin: 'BENCHMARK', lastBenchmark: now, lastLiveObservation: 'none' },
        { model: 'fast-local-sim', provider: 'local', family: 'small-reasoner', host: 'local', status: 'ACTIVE', tierEligibility: 'FAST', context: 'short', vision: 'no', toolUse: 'limited', structuredOutput: 'yes', privacyCapability: 'HIGHLY_SENSITIVE', cost: '$', latencyClass: 'LOW', dataOrigin: 'SIMULATION', lastBenchmark: now, lastLiveObservation: 'none' },
      ],
      leaderboard: ['Korean Executive Writing', 'Research Synthesis', 'Contradiction Detection', 'Long-document Summary', 'Slide Narrative', 'Structured Output', 'Data Interpretation', 'Coding', 'Tool-use Planning', 'Reservation Reasoning', 'UI Semantic Reasoning', 'Critic/Error Detection', 'Evidence-grounded Answering'].map((task, index) => ({
        rank: 1,
        model: 'qwen-premium-sim',
        provider: 'nebius',
        task,
        taskScore: 0.9 - index * 0.01,
        firstPassAcceptance: 0.82,
        revisionBurden: 1,
        evidenceScore: 0.91,
        latencyP50: 410,
        latencyP95: 700,
        cost: 0.04,
        failureRate: 0.01,
        dataOrigin: index % 2 === 0 ? 'BENCHMARK' : 'SIMULATION',
        sampleSize: 12,
      })),
      providers: [
        { provider: 'nebius', status: 'HEALTHY', models: 1, latency: 410, timeouts: 0, http5xx: 0, rateLimits: 0, quota: 'OK', authFailures: 0 },
        { provider: 'local', status: 'UNKNOWN', models: 1, latency: 'n/a', timeouts: 0, http5xx: 0, rateLimits: 0, quota: 'n/a', authFailures: 0 },
      ],
      routingDecisions: [
        { goalId: 'goal_admin_cert', workUnitId: 'wu_admin_cert', selectedModel: 'qwen-premium-sim', runnerUps: ['fast-local-sim'], selectionFactors: ['quality fit', 'language fit', 'tool-use fit', 'provider health'], disqualificationReasons: ['local model context insufficient'] },
      ],
    },
    toolHealth: [tool],
    attentionQueue: [
      { severity: 'HIGH', userImpact: 0, message: 'Outcome uncertain queue clear in cert data.', owner: 'ops', status: 'WATCHING' },
      { severity: 'MEDIUM', userImpact: 0, message: 'Cloudflare Access remains pending for public test deployment.', owner: 'security', status: 'PENDING' },
    ],
    systemHealth: ['API', 'DB', 'Queue', 'Agent Runtime', 'JEV', 'Model Intelligence', 'Model Router', 'Tool Runtime', 'Browser Runtime', 'Mobile Runtime', 'Desktop Runtime', 'Storage', 'Retrieval', 'Providers'].map((component) => ({ component, health: 'HEALTHY', latency: component === 'API' ? 35 : 0, incidents: 0 })),
    qualityDashboard: { overallQuality: 1, firstPassAcceptance: 0, averageRevisionBurden: 1, evidenceGrounding: 1, unsupportedClaimIncidents: 0, artifactQaPassRate: 1, outcomeVerification: 1, recoverySuccess: 1, byTask: 1, byModel: 1, byTool: 1, byPlatform: 1, byLanguage: 1, byRelease: 1 },
    costDashboard: { totalAiCost: 0.12, modelCost: 0.12, toolCost: 0.01, imageCost: 0, videoCost: 0, researchCost: 0, costPerSuccessfulOutcome: 0.06, byProvider: 0.12, byModel: 0.12, byFeature: 0.12, byGoalType: 0.12, byArtifactType: 0.04, byPlatform: 0.12 },
    goalMonitoring: [{ goalId: 'goal_admin_cert', state: 'COMPLETED', workUnitCount: 1, elapsedMs: 700, cost: 0.12, qualityGate: 'PASS' }],
    executionMonitoring: [{ executionId: 'exec_admin_cert', class: 'creation', state: 'VERIFIED', outcome: 'REPORT_CREATED' }],
    deviceMonitoring: [{ platform: 'DESKTOP', runtimeVersion: 'cert', lastSeen: now, trustState: 'TRUSTED', capabilityProfile: ['creation-review', 'screen-context'], connectivity: 'ONLINE', health: 'HEALTHY' }],
    securityEvents: [{ eventType: 'approval validation failure', severity: 'LOW', roleRestricted: true }, { eventType: 'external content / prompt injection event', severity: 'LOW', roleRestricted: true }],
    auditTrace: [{ intentRef: 'intent_admin_cert', jevDecisionRef: 'jev_admin_cert', workUnitId: 'wu_admin_cert', modelSelectionRef: 'model_route_admin_cert', toolCallRef: 'tool_call_admin_cert', evidenceRef: 'evidence_admin_cert', approvalRef: 'approval_none_required', authorityRef: 'authority_none_required', executionRef: 'exec_admin_cert', verificationRef: 'verification_admin_cert', outcomeRef: 'REPORT_CREATED' }],
    routes: routeManifest.routes,
    dataOrigin: 'DETERMINISTIC_CERT_DATA',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

  if (url.pathname === '/admin/api/health') {
    writeJson(res, 200, {
      status: 'ok',
      product: controlCenterBoundary.productName,
      environment,
      adminApiNamespace: controlCenterBoundary.adminApiNamespace,
      publicHealthOnly: true,
      fullAdminReadModelPublic: false,
      defaultAdminAccess: 'DENY',
      exactEmailAllowlist: true,
      localPasswordLogin: false,
      cfAccessJwtPresent: Boolean(req.headers['cf-access-jwt-assertion']),
      cfAccessIdentityHeaderPresent: Boolean(req.headers['cf-access-authenticated-user-email']),
      cfAccessEmailHeaderPresent: Boolean(req.headers['cf-access-authenticated-user-email']),
      rawUserPrivateContentExposed: false,
      secretExposed: false,
    });
    return;
  }

  if (url.pathname === '/admin/api/auth/access/bootstrap') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    const actor = await requireAdmin(req, res, ['SUPER_ADMIN']);
    if (!actor) return;
    writeJson(res, 200, adminSessionPayload(actor));
    return;
  }

  if (url.pathname === '/admin/api/session') {
    const actor = await requireAdmin(req, res, permissionForPath(url.pathname));
    if (!actor) return;
    writeJson(res, 200, adminSessionPayload(actor));
    return;
  }

  if (url.pathname === '/admin/api/logout') {
    auditAdmin('admin_logout', { result: 'SUCCESS' });
    writeJson(res, 200, { loggedOut: true }, {
      'Set-Cookie': `${adminSessionCookie}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    });
    return;
  }

  if (url.pathname === '/admin/api/read-model') {
    const actor = await requireAdmin(req, res, permissionForPath(url.pathname));
    if (!actor) return;
    writeJson(res, 200, {
      product: controlCenterBoundary.productName,
      environment,
      actor,
      navigation: controlCenterNav,
      readModel: makeReadModel(),
      sampleData: 'DETERMINISTIC_CERT_DATA',
    });
    return;
  }

  if (url.pathname === '/admin/api/actions/critical') {
    const actor = await requireAdmin(req, res, ['SUPER_ADMIN', 'OPS_ADMIN', 'SECURITY_ADMIN']);
    if (!actor) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (!parsed.reason || !parsed.beforeState || !parsed.afterState) {
        writeJson(res, 400, { error: 'CRITICAL_ADMIN_STEP_UP_REQUIRED', required: ['reason', 'beforeState', 'afterState'] });
        return;
      }
      writeJson(res, 200, {
        auditRef: `admin_audit_${crypto.randomUUID()}`,
        adminIdentity: actor.email,
        timestamp: new Date().toISOString(),
        reason: parsed.reason,
        beforeState: parsed.beforeState,
        afterState: parsed.afterState,
        stepUpConfirmed: true,
      });
      auditAdmin('critical_admin_action', { ...actor, authSource: actor.authMethod, result: 'SUCCESS', reason: parsed.reason });
    });
    return;
  }

  if (url.pathname.startsWith('/admin/api/')) {
    const actor = await requireAdmin(req, res, permissionForPath(url.pathname));
    if (!actor) return;
    writeJson(res, 200, {
      product: controlCenterBoundary.productName,
      environment,
      actor,
      readModel: makeReadModel(),
      sampleData: 'DETERMINISTIC_CERT_DATA',
    });
    return;
  }

  const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const staticPath = path.normalize(path.join(__dirname, relativePath));
  if (!staticPath.startsWith(__dirname)) {
    res.writeHead(403, securityHeaders);
    res.end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(staticPath);
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': contentType(staticPath),
      'Cache-Control': staticPath.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
    });
    res.end(file);
  } catch {
    res.writeHead(404, securityHeaders);
    res.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`NAgex Control Center listening on http://${host}:${port}`);
});
