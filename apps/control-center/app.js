const roles = ['SUPER_ADMIN', 'OPS_ADMIN', 'SECURITY_ADMIN', 'SUPPORT_ADMIN', 'MODEL_ADMIN', 'ANALYTICS_VIEWER'];
const state = {
  role: new URLSearchParams(location.search).get('role') || 'SUPER_ADMIN',
  active: location.hash.replace('#', '') || 'overview',
  timeRange: '24h',
  data: null,
};

const nav = [
  ['overview', 'Overview', ['SUPER_ADMIN', 'OPS_ADMIN', 'MODEL_ADMIN', 'ANALYTICS_VIEWER']],
  ['members', 'Members', ['SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN', 'ANALYTICS_VIEWER']],
  ['analytics', 'Product Analytics', ['SUPER_ADMIN', 'OPS_ADMIN', 'ANALYTICS_VIEWER']],
  ['models', 'AI & Models', ['SUPER_ADMIN', 'MODEL_ADMIN', 'ANALYTICS_VIEWER']],
  ['leaderboard', 'Model Leaderboard', ['SUPER_ADMIN', 'MODEL_ADMIN', 'ANALYTICS_VIEWER']],
  ['tools', 'Tools', ['SUPER_ADMIN', 'OPS_ADMIN', 'MODEL_ADMIN']],
  ['goals', 'Agents & Goals', ['SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN']],
  ['executions', 'Executions', ['SUPER_ADMIN', 'OPS_ADMIN', 'SUPPORT_ADMIN', 'SECURITY_ADMIN']],
  ['quality', 'Quality', ['SUPER_ADMIN', 'OPS_ADMIN', 'MODEL_ADMIN', 'ANALYTICS_VIEWER']],
  ['costs', 'Costs & Usage', ['SUPER_ADMIN', 'OPS_ADMIN', 'ANALYTICS_VIEWER']],
  ['devices', 'Devices', ['SUPER_ADMIN', 'OPS_ADMIN', 'SECURITY_ADMIN']],
  ['security', 'Security', ['SUPER_ADMIN', 'SECURITY_ADMIN']],
  ['health', 'System Health', ['SUPER_ADMIN', 'OPS_ADMIN', 'SECURITY_ADMIN']],
  ['audit', 'Audit', ['SUPER_ADMIN', 'SECURITY_ADMIN']],
  ['settings', 'Admin Settings', ['SUPER_ADMIN']],
];

const canSee = (item) => item[2].includes(state.role);
const fmt = (value) => typeof value === 'number' ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) : value;
const originBadge = (origin, note = '') => `<span class="origin origin-${origin.toLowerCase()}">${origin}${note ? `<small>${note}</small>` : ''}</span>`;
const status = (value) => `<span class="status-pill ${String(value).toLowerCase()}">${value}</span>`;

async function loadData() {
  const healthResponse = await fetch('/admin/api/health');
  const health = await healthResponse.json();
  let sessionResponse = await fetch('/admin/api/session', { headers: { Accept: 'application/json' } });
  if (sessionResponse.status === 401 && health.cfAccessJwtPresent) {
    sessionResponse = await fetch('/admin/api/auth/access/bootstrap', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  }
  if (!sessionResponse.ok) {
    state.data = {
      locked: true,
      health,
      attentionQueue: [],
    };
    return;
  }
  const session = await sessionResponse.json();
  state.role = session.admin.role;
  const response = await fetch('/admin/api/read-model', { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    state.data = {
      locked: true,
      health,
      attentionQueue: [],
    };
    return;
  }
  const payload = await response.json();
  state.data = payload.readModel;
  state.data.health = { ...health, adminBoundary: `${session.admin.role} authenticated`, adminEmail: session.admin.email, authSource: session.admin.authSource };
}

function renderNav() {
  document.querySelector('#nav').innerHTML = nav.filter(canSee).map(([id, label]) => {
    const active = state.active === id ? ' active' : '';
    return `<a class="nav-link${active}" href="#${id}" data-route="${id}">${label}</a>`;
  }).join('');
}

function renderTopbar() {
  document.querySelector('#environment').textContent = state.data.health.environment;
  document.querySelector('#auth-state').textContent = `${state.data.health.adminBoundary} | ${state.data.health.authSource}`;
  document.querySelector('#attention-count').textContent = state.data.attentionQueue.length;
  document.querySelector('#role-select').innerHTML = `<option>${state.role}</option>`;
  document.querySelector('#role-select').disabled = true;
  document.querySelector('#time-range').value = state.timeRange;
}

function cards(items) {
  return `<div class="overview-grid">${items.map(([label, value, meta]) => `<article><span>${label}</span><strong>${fmt(value)}</strong>${meta ? `<em>${meta}</em>` : ''}</article>`).join('')}</div>`;
}

function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function chartGrid(items) {
  return `<div class="chart-grid">${items.map(([label, value, percent]) => `<div class="chart"><span>${label}</span><strong>${value}</strong><div class="bar" style="--value:${percent}%"></div></div>`).join('')}</div>`;
}

function operationalStates() {
  return `<section class="panel"><div class="panel-heading"><h2>Operational States</h2><span>complete non-developer states</span></div><div class="state-grid">${[
    ['Loading', 'Readable skeleton state while admin data loads.'],
    ['Empty', 'Truthful empty state when telemetry is absent.'],
    ['No access', 'Role-restricted sections stay hidden or explain access.'],
    ['Degraded data', 'Partial telemetry is labeled, never silently blended.'],
    ['Provider unavailable', 'Provider outage appears in attention queue.'],
    ['Error', 'User-safe recovery message, no raw stack dumps.'],
    ['Offline', 'Local cache disabled for privileged admin data.'],
    ['Partial telemetry', 'Metrics show origin and coverage window.'],
  ].map(([title, copy]) => `<div class="state-card"><strong>${title}</strong><p class="state-copy">${copy}</p></div>`).join('')}</div></section>`;
}

function attentionQueue() {
  return `<section class="panel attention"><div class="panel-heading"><h2>Attention Queue</h2><span>operational priority</span></div>${table(['Severity', 'Item', 'Affected', 'Owner', 'Status'], state.data.attentionQueue.map((item) => [status(item.severity), item.message, item.userImpact, item.owner, item.status]))}</section>`;
}

function systemStrip() {
  const wanted = ['API', 'Agent Runtime', 'JEV', 'Model Intelligence', 'Model Router', 'Tool Runtime', 'Mobile Runtime', 'Desktop Runtime', 'Storage'];
  return `<section class="system-strip">${wanted.map((name) => {
    const item = state.data.systemHealth.find((health) => health.component === name) || { component: name, health: 'UNKNOWN' };
    return `<div><span>${item.component}</span>${status(item.health)}</div>`;
  }).join('')}</section>`;
}

const pages = {
  overview() {
    const o = state.data.overview;
    return `${systemStrip()}${cards([
      ['Active Users', o.activeUsers, originBadge('LIVE')],
      ['Goals Today', o.goals, originBadge('LIVE')],
      ['Agent Runs', o.agentRuns, originBadge('LIVE')],
      ['Tool Calls', o.toolCalls, originBadge('LIVE')],
      ['Goal Completion Rate', o.goalCompletionRate, originBadge('SIMULATION', 'certification data only')],
      ['Verified Outcome Rate', o.verifiedOutcomeRate, originBadge('SIMULATION', 'certification data only')],
      ['First-pass Acceptance', o.firstPassAcceptance, originBadge('SIMULATION', 'certification data only')],
      ['Revision Burden', o.averageRevisionBurden, originBadge('SIMULATION', 'certification data only')],
      ['P95 Latency', `${o.p95Latency} ms`, originBadge('BENCHMARK', 'controlled evaluation')],
      ['AI Cost Today', `$${o.aiCost}`, originBadge('SIMULATION')],
      ['Cost per Successful Outcome', `$${o.costPerSuccessfulOutcome}`, originBadge('SIMULATION')],
    ])}${chartGrid([
      ['User success', `${Math.round(o.verifiedOutcomeRate * 100)}% verified`, 100],
      ['Revision burden', `${o.averageRevisionBurden} avg revisions`, 42],
      ['Cost pressure', `$${o.costPerSuccessfulOutcome} / outcome`, 30],
    ])}${attentionQueue()}${operationalStates()}`;
  },
  members() {
    const member = state.data.member;
    return `<section class="panel"><div class="panel-heading"><h2>Members</h2><span>No raw private content</span></div>${table(['Member', 'Status', 'Plan', 'Last Active', 'Devices', 'Providers', 'Quota', 'Consent'], [[member.memberId, status(member.accountStatus), member.plan, member.lastActive, member.activeDeviceCount, member.connectedProviderCount, member.quotaState, member.consentPrivacyState]])}</section>
    <section class="panel"><p class="empty">Private user content is not available in the standard admin view. Support access to scoped content would require explicit purpose, elevated permission, audit event, and time-bounded access.</p></section>
    <section class="panel detail-grid">${['Operational Summary', 'Usage', 'Devices', 'Errors', 'Support', 'Consent / Privacy', 'Account Lifecycle'].map((title) => `<div class="detail"><h3>${title}</h3><p>${member.lifecycleState} | goals ${member.goalsStarted}/${member.goalsCompleted} | errors ${member.errorCounts}</p></div>`).join('')}</section>`;
  },
  analytics() {
    const a = state.data.analytics;
    return `${cards([
      ['DAU', a.dau, originBadge('SIMULATION')],
      ['WAU', a.wau, originBadge('SIMULATION')],
      ['MAU', a.mau, originBadge('SIMULATION')],
      ['Registrations', a.newRegistrations, originBadge('SIMULATION')],
      ['Activation', a.activation, originBadge('SIMULATION')],
      ['Feature Adoption', a.featureAdoption, originBadge('SIMULATION')],
      ['Goal Completion', a.goalCompletion, originBadge('SIMULATION')],
      ['Drop-off', a.dropOff, originBadge('SIMULATION')],
      ['Retry Rate', a.retryCount, originBadge('SIMULATION')],
      ['Time to Result', `${a.timeToResult} ms`, originBadge('SIMULATION')],
      ['Verified Outcome Rate', a.verifiedOutcomeRate, originBadge('SIMULATION')],
    ])}<section class="panel">${table(['Platform', 'Usage'], [['Mobile', a.mobileUsage], ['Desktop', a.desktopUsage], ['Browser', 0], ['Smart TV', a.smartTvUsage], ['Life Execution', a.lifeExecutionUsage], ['Creation', a.creationUsage], ['Voice', a.voiceUsage], ['Research', 0], ['Image', 0], ['Video', 0]])}</section>`;
  },
  models() {
    const m = state.data.modelIntelligence;
    return `${cards([
      ['Registered Models', m.registry.length, originBadge('BENCHMARK')],
      ['Active Providers', m.providers.length, originBadge('BENCHMARK')],
      ['Healthy Providers', m.providers.filter((p) => p.status === 'HEALTHY').length, originBadge('LIVE')],
      ['Benchmark Freshness', m.benchmarkFreshness, originBadge('BENCHMARK')],
      ['Live Data Volume', m.liveDataVolume, originBadge('LIVE')],
      ['Routing Decisions', m.routingDecisions.length, originBadge('LIVE')],
    ])}<section class="panel"><div class="panel-heading"><h2>Model Registry</h2><span>filters: provider, family, status, capability, local/cloud, data origin</span></div>${table(['Model', 'Provider', 'Family', 'Host', 'Status', 'Tier', 'Context', 'Vision', 'Tool Use', 'Structured', 'Privacy', 'Cost', 'Latency', 'Data Origin', 'Last Benchmark', 'Last Live'], m.registry.map((r) => [r.model, r.provider, r.family, r.host, status(r.status), r.tierEligibility, r.context, r.vision, r.toolUse, r.structuredOutput, r.privacyCapability, r.cost, r.latencyClass, originBadge(r.dataOrigin), r.lastBenchmark, r.lastLiveObservation]))}</section>
    <section class="panel"><div class="panel-heading"><h2>Provider Health</h2><span>timeouts, 5xx, rate limits, auth failures</span></div>${table(['Provider', 'Status', 'Models', 'Latency', 'Timeouts', '5xx', 'Rate Limits', 'Quota', 'Auth Failures'], m.providers.map((p) => [p.provider, status(p.status), p.models, p.latency, p.timeouts, p.http5xx, p.rateLimits, p.quota, p.authFailures]))}</section>`;
  },
  leaderboard() {
    const m = state.data.modelIntelligence;
    return `<section class="panel"><div class="panel-heading"><h2>Task Leaderboard</h2><span>BEST FIT FOR THIS TASK</span></div>${table(['Rank', 'Model', 'Provider', 'Task', 'Task Score', 'First-pass', 'Revision', 'Evidence', 'P50', 'P95', 'Cost', 'Failure', 'Data Origin', 'Sample'], m.leaderboard.map((r) => [r.rank, r.model, r.provider, r.task, r.taskScore, r.firstPassAcceptance, r.revisionBurden, r.evidenceScore, r.latencyP50, r.latencyP95, r.cost, r.failureRate, originBadge(r.dataOrigin), r.sampleSize]))}</section>
    <section class="panel"><div class="panel-heading"><h2>Routing Explainer</h2><span>${m.scoringPolicyVersion} | ${m.benchmarkVersion} | ${m.livePerformanceWindow}</span></div>${table(['Goal', 'WorkUnit', 'Selected', 'Runner-up', 'Factors', 'Disqualified'], m.routingDecisions.map((r) => [r.goalId, r.workUnitId, r.selectedModel, r.runnerUps.join(', '), r.selectionFactors.join(', '), r.disqualificationReasons.join(', ')]))}</section>
    <section class="panel"><div class="panel-heading"><h2>Model Detail / Compare</h2><span>task-aware comparison, no universal best label</span></div>${chartGrid([['Quality trend', '0.91', 91], ['Latency P95', '700ms', 62], ['Cost trend', '$0.04', 36]])}${table(['Area', 'Model A', 'Model B'], [['Quality', '0.91', '0.86'], ['Evidence grounding', '0.93', '0.88'], ['Latency', '410ms', '620ms'], ['Cost', '$0.04', '$0.03'], ['Capabilities', 'tool, structured, vision', 'structured']])}</section>`;
  },
  tools() {
    return `<section class="panel"><div class="panel-heading"><h2>Tool Registry</h2><span>governance actions require role and reason</span></div>${table(['Tool', 'Category', 'Status', 'Provider', 'Platforms', 'Calls', 'Success', 'Failure', 'P50', 'P95', 'Cost', 'Risk', 'Authority', 'Health'], state.data.toolHealth.map((t) => [t.name, t.category, status(t.status), t.provider, t.supportedPlatforms.join(', '), t.usageCount, t.successRate, t.failureRate, t.latencyP50, t.latencyP95, t.cost, t.riskLevel, t.authorityRequirement, status(t.health)]))}</section>
    <section class="panel"><div class="panel-heading"><h2>Tool Detail & Governance</h2><span>${state.role === 'OPS_ADMIN' || state.role === 'SUPER_ADMIN' ? 'authorized with audited reason' : 'read only'}</span></div>${table(['Action', 'Permission', 'Guardrail'], [['Enable', 'OPS_ADMIN', 'audit event'], ['Disable', 'OPS_ADMIN', 'critical reason required'], ['Maintenance', 'OPS_ADMIN', 'audit event'], ['Retire', 'SUPER_ADMIN', 'critical reason required'], ['Rate Limit', 'OPS_ADMIN', 'bounded policy change']])}</section>`;
  },
  goals() {
    return `<section class="panel"><div class="panel-heading"><h2>Agents & Goals</h2><span>Running | Waiting | Recovering | Partial | Completed | Failed | Cancelled</span></div>${table(['Goal ID', 'Type', 'User Ref', 'Stage', 'WorkUnits', 'Duration', 'Cost', 'Quality', 'Status'], state.data.goalMonitoring.map((g) => [g.goalId, 'creation', 'usr_hash_1', g.state, g.workUnitCount, `${g.elapsedMs} ms`, `$${g.cost}`, g.qualityGate, status(g.state)]))}</section>`;
  },
  executions() {
    return `<section class="panel"><div class="panel-heading"><h2>Executions</h2><span>OUTCOME_UNCERTAIN prioritized</span></div>${table(['Execution', 'Category', 'State', 'Outcome'], state.data.executionMonitoring.map((e) => [e.executionId, e.class, status(e.state), e.outcome]).concat([['exec_attention', 'Reservation', status('OUTCOME_UNCERTAIN'), 'needs verification']]))}</section>`;
  },
  quality() {
    const q = state.data.qualityDashboard;
    return `${chartGrid([['First-pass acceptance', q.firstPassAcceptance, 10], ['Evidence quality', q.evidenceGrounding, 100], ['Outcome verification', q.outcomeVerification, 100]])}${cards(Object.entries(q).map(([k, v]) => [k, v, originBadge('SIMULATION')]))}`;
  },
  costs() {
    const c = state.data.costDashboard;
    return `${chartGrid([['Total AI cost', `$${c.totalAiCost}`, 36], ['Model cost', `$${c.modelCost}`, 36], ['Cost per successful outcome', `$${c.costPerSuccessfulOutcome}`, 24]])}${cards(Object.entries(c).map(([k, v]) => [k === 'costPerSuccessfulOutcome' ? 'COST_PER_SUCCESSFUL_OUTCOME' : k, typeof v === 'number' ? `$${v}` : v, originBadge('SIMULATION')]))}`;
  },
  devices() {
    return `<section class="panel"><div class="panel-heading"><h2>Devices</h2><span>Mobile | Desktop | Browser | Smart TV</span></div>${table(['Device', 'Platform', 'Runtime', 'Last Seen', 'Trust', 'Connectivity', 'Capabilities', 'Health'], state.data.deviceMonitoring.map((d) => [d.platform, d.platform, d.runtimeVersion, d.lastSeen, d.trustState, d.connectivity, d.capabilityProfile.join(', '), status(d.health)]))}</section>`;
  },
  security() {
    return `<section class="panel"><div class="panel-heading"><h2>Security</h2><span>role restricted</span></div>${table(['Severity', 'Time', 'Event', 'Affected Scope', 'Status', 'Required Action'], state.data.securityEvents.map((e) => [status(e.severity), 'current cert', e.eventType, 'admin telemetry', e.roleRestricted ? 'restricted' : 'open', 'review policy']))}</section>`;
  },
  health() {
    return `<section class="panel"><div class="panel-heading"><h2>System Health</h2><span>last health check: current cert run</span></div>${table(['Service', 'Status', 'Latency', 'Incidents'], state.data.systemHealth.map((h) => [h.component, status(h.health), h.latency ?? 'n/a', h.incidents ?? 0]))}</section>`;
  },
  audit() {
    const trace = state.data.auditTrace[0];
    const steps = [['Intent', trace.intentRef], ['JEV', trace.jevDecisionRef], ['WorkUnit', trace.workUnitId], ['Model', trace.modelSelectionRef], ['Tool', trace.toolCallRef], ['Evidence', trace.evidenceRef], ['Approval', trace.approvalRef], ['Authority', trace.authorityRef], ['Execution', trace.executionRef], ['Verification', trace.verificationRef], ['Outcome', trace.outcomeRef]];
    return `<section class="panel"><div class="panel-heading"><h2>Audit Explorer</h2><span>structured decision summaries, no hidden chain-of-thought</span></div><div class="trace">${steps.map(([label, value]) => `<div class="trace-step"><strong>${label}</strong>${value}</div>`).join('')}</div></section>${table(['Intent', 'JEV', 'WorkUnit', 'Model', 'Tool', 'Evidence', 'Approval', 'Authority', 'Execution', 'Verification', 'Outcome'], state.data.auditTrace.map((a) => [a.intentRef, a.jevDecisionRef, a.workUnitId, a.modelSelectionRef, a.toolCallRef, a.evidenceRef, a.approvalRef, a.authorityRef, a.executionRef, a.verificationRef, a.outcomeRef]))}`;
  },
  settings() {
    return `<section class="panel"><div class="panel-heading"><h2>Admin Settings</h2><span>empty state</span></div><p class="empty">No mutable production settings are exposed in this cert build.</p></section>`;
  },
};

function render() {
  if (state.data?.locked) {
    document.querySelector('#nav').innerHTML = '';
    document.querySelector('#environment').textContent = state.data.health.environment;
    document.querySelector('#auth-state').textContent = 'Admin authentication required';
    document.querySelector('#attention-count').textContent = '0';
    document.querySelector('#role-select').innerHTML = '<option>LOCKED</option>';
    document.querySelector('#page-title').textContent = 'Admin Access Required';
    document.querySelector('#content').innerHTML = `<section class="panel"><div class="panel-heading"><h2>NAgex Control Center</h2><span>protected admin boundary</span></div><p class="empty">Administrator authentication is required. Cloudflare Access or NAgex Admin Auth must verify an authorized admin identity before operational data is available.</p></section>`;
    return;
  }
  renderNav();
  renderTopbar();
  const allowed = nav.find((item) => item[0] === state.active && canSee(item));
  if (!allowed) state.active = 'overview';
  document.querySelector('#content').innerHTML = pages[state.active]();
  document.querySelector('#page-title').textContent = nav.find((item) => item[0] === state.active)?.[1] || 'Overview';
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-route]');
  if (!link) return;
  state.active = link.dataset.route;
  render();
});

document.querySelector('#role-select').addEventListener('change', (event) => {
  state.role = event.target.value;
  render();
});
document.querySelector('#time-range').addEventListener('change', (event) => {
  state.timeRange = event.target.value;
  render();
});

loadData().then(render);
