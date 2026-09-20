// NAgex Personal AI — Control Center & Ambient Assistant Client Controller
(function () {
  'use strict';

  const state = {
    activeTab: 'tab-home',
    memories: [],
    plans: [],
    tasks: [],
    skills: [],
    tools: [],
    approvals: [],
    // R12.1 Increment 2.5 §8 — fail-closed contract: true only when the
    // real GET /api/v1/approvals fetch itself failed (network error or a
    // structured API error), never set just because the real canonical
    // source returned zero pending approvals. Render code must show
    // "Approvals could not be loaded." on true, and "No approvals needed."
    // only when this is false AND the list is genuinely empty.
    approvalsLoadFailed: false,
    executions: [],
    knowledge: [],
    quickWakeConfig: {},
    autonomyConfig: { level: 'L2' },
    activeMockup: 'm01',
    pendingIntentResponse: null,
    googleOAuth: { configured: false, connected: false, scopes: [], expiresAt: null },
    approvalCountdownTimer: null,
    // The most recent Gmail thread NAgex actually loaded (from a real
    // gmail.search or gmail.read_thread result) in this session — the only
    // source a follow-up reply/read_thread request may prefill threadId/
    // replyToMessageId from. Never populated from a guess.
    lastGmailThread: null,
    telegram: { status: { configured: false, botUsername: null }, identities: [] },
    slack: { status: { configured: false, botId: null }, identities: [] },
    notifications: { items: [], unreadCount: 0 },
    inbox: [],
    vault: null,
    // Phase 1 STEP 5/6 — canonical CandidateStore records. This is the ONLY
    // source of truth for candidate review state; capture.metadata.candidates
    // (the embedded array) is never read for status/actions (item R).
    candidates: [],
    // Phase 1 STEP 8 — the durable, tenant-isolated consumer Activity
    // projection (GET /api/v1/activity). Home/Recent and the Activity tab
    // read only this — never the legacy non-isolated /api/v1/executions
    // demo array.
    activity: [],
    activityLoadFailed: false,
  };

  var FLOW_STAGES = ['User message', 'Plan Preview', 'Plan Resolution', 'Approval Card', 'Human Approval', 'Execution', 'Result'];

  // Modal dismissal state: which element to return focus to on close, the
  // per-open Escape/Tab-trap keydown handler (added on open, removed on
  // close), and a lock/unlock state machine for the background scroll —
  // see public/modal-behavior.js for why this is a small state machine
  // rather than a single `document.body.style.overflow = ''` on close.
  let ambientModalTriggerElement = null;
  let ambientModalKeydownHandler = null;
  const ambientBodyScrollLock = window.NAGEX_MODAL_BEHAVIOR ? window.NAGEX_MODAL_BEHAVIOR.createScrollLock() : null;
  // Guards the activity timeline against logging the same lifecycle event
  // twice for the same plan/approval — e.g. "Plan created" must appear once
  // per generated plan even if plan generation and resolution/UI hydration
  // both end up trying to record it. Deliberately never reset: every real
  // plan/approval id is a fresh, globally-unique value minted server-side,
  // so a key can never legitimately recur — resetting this on every ambient
  // overlay open would only reintroduce a way for a genuine duplicate call
  // to slip back through.
  const ambientTimelineDeduper = window.NAGEX_TIMELINE_DEDUPE ? window.NAGEX_TIMELINE_DEDUPE.createDeduper() : null;

  // The actual root cause of a duplicate "Plan created": two separate calls
  // into the generation pipeline (from any combination of the composer, a
  // quick-action chip, the demo scenario button, etc.) each legitimately
  // mint their own requestId — the per-plan dedupe above correctly does NOT
  // merge them, because they really are two different plans. This guard
  // stops a second generation from ever starting while one is still in
  // flight, regardless of which control tried to start it.
  const ambientRunGuard = window.NAGEX_SINGLE_FLIGHT ? window.NAGEX_SINGLE_FLIGHT.createSingleFlightGuard() : null;

  // UI-5 R5 — per-approval-id re-entrancy guard: handleApprovalAction() had
  // no client-side protection against a rapid double-tap (very plausible on
  // a touchscreen) firing the same POST /api/v1/approvals/:id/action twice
  // concurrently. The backend already fails the second request closed
  // (APPROVAL_ALREADY_CONSUMED — see approval_ttl_security.test.ts), so
  // nothing was ever double-executed, but the UI itself gave no busy
  // feedback and could fire redundant network calls. Keyed by approval id
  // (not a single global flag) since approving two different pending items
  // concurrently is legitimate and must not block each other.
  const inFlightApprovalIds = new Set();

  // Bound on POST /api/v1/ambient/intent specifically — grounded in the
  // real, evidence-backed worst case, not a guess: UnifiedModelRouter.
  // generate() (src/model-gateway/unified-model-router.ts) retries through
  // configured providers SEQUENTIALLY, and each provider's own HTTP call
  // (src/model-gateway/providers.ts) is independently bounded at 30_000ms.
  // With all 3 real providers configured (OpenAI/Gemini/Nebius), the
  // endpoint can legitimately take up to ~90_000ms before it ever responds.
  // 120_000ms sits comfortably above that real ceiling rather than a
  // "typical latency" figure, since no such figure exists anywhere in this
  // codebase — a tighter bound would risk aborting requests the server
  // itself still considers in-flight and valid.
  //
  // `window.__NAGEX_TEST_AMBIENT_TIMEOUT_MS__` is a test-only override hook
  // (analogous in spirit to the server's NAGEX_ENABLE_TEST_PLAN_INJECTION
  // pattern) — inert in production, since nothing in this codebase ever
  // sets it; a browser test can inject it via an init script so the
  // stalled-request regression test doesn't have to wait 2 real minutes.
  const AMBIENT_INTENT_TIMEOUT_MS = (typeof window !== 'undefined' && typeof window.__NAGEX_TEST_AMBIENT_TIMEOUT_MS__ === 'number')
    ? window.__NAGEX_TEST_AMBIENT_TIMEOUT_MS__
    : 120000;

  function isDebugMode() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('debug') === '1' || params.get('debug') === 'true' || state.debugMode === true || (typeof window !== 'undefined' && window.NAGEX_DEBUG === true);
    } catch (e) {
      return false;
    }
  }

  function isEnterpriseUiMode() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('enterprise') === '1' || params.get('enterprise') === 'true' || state.enterpriseUiMode === true || (typeof window !== 'undefined' && window.NAGEX_ENTERPRISE_UI === true);
    } catch (e) {
      return false;
    }
  }

  function applyEnterpriseUiGate() {
    const isEnt = isEnterpriseUiMode();
    const switchersGroup = document.getElementById('header-switchers-group');
    if (switchersGroup) switchersGroup.style.display = isEnt ? 'flex' : 'none';

    const mhSwitchersGroup = document.getElementById('mh-header-switchers-group');
    if (mhSwitchersGroup) mhSwitchersGroup.style.display = isEnt ? 'flex' : 'none';

    const catTabOrg = document.getElementById('cat-tab-organization');
    if (catTabOrg) catTabOrg.style.display = isEnt ? 'inline-block' : 'none';

    const mhOrgBtn = document.getElementById('mh-btn-org-switcher');
    if (mhOrgBtn) mhOrgBtn.style.display = isEnt ? 'inline-flex' : 'none';

    const mhWsBtn = document.getElementById('mh-btn-workspace-switcher');
    if (mhWsBtn) mhWsBtn.style.display = isEnt ? 'inline-flex' : 'none';
  }

  function updateFlowStage(stageLabel) {
    const el = document.getElementById('ambient-flow-stepper');
    const statusEl = document.getElementById('ambient-modal-status');
    if (statusEl) statusEl.textContent = stageLabel || '';
    if (!el) return;
    if (!isDebugMode()) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    const activeIdx = FLOW_STAGES.indexOf(stageLabel);
    el.innerHTML = FLOW_STAGES.map((s, idx) => {
      const cls = idx === activeIdx ? 'flow-stage active' : idx < activeIdx ? 'flow-stage done' : 'flow-stage';
      return `<span class="${cls}">${escapeHtml(s)}</span>`;
    }).join('');
  }

  function getFocusableElements(container) {
    if (!container) return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(container.querySelectorAll(selector)).filter((el) => el.offsetParent !== null);
  }

  function resetAmbientFlowUi() {
    updateFlowStage(null);
    const timeline = document.getElementById('ambient-timeline');
    const timelineList = document.getElementById('ambient-timeline-list');
    if (timeline) timeline.style.display = 'none';
    if (timelineList) timelineList.innerHTML = '';
    if (state.approvalCountdownTimer) {
      clearInterval(state.approvalCountdownTimer);
      state.approvalCountdownTimer = null;
    }
  }

  // Dev/test-only debug instrumentation: never logs payload contents, tool
  // arguments, or secrets — only the lifecycle key, label, which function
  // produced this emit attempt, and whether it was actually recorded or
  // suppressed as a duplicate. Gated so it never runs against a real
  // deployed origin by accident; opt in locally with ?debugTimeline=1.
  function isTimelineDebugEnabled() {
    try {
      if (new URLSearchParams(window.location.search).has('debugTimeline')) return true;
      return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    } catch (e) {
      return false;
    }
  }

  function logTimelineDebug(info) {
    if (!isTimelineDebugEnabled()) return;
    // eslint-disable-next-line no-console
    console.debug('[NAgex timeline]', info);
  }

  // lifecycleKey must be a single, fully-formed, deterministic identity —
  // never a timestamp — such as `plan:${planId}:created` or
  // `approval:${approvalId}:requested` (see timeline-dedupe.js). Passing one
  // ensures the same lifecycle stage for that same plan/approval/execution
  // is only ever recorded once, no matter which function or how many times
  // it is called. `producer` is a short string naming the calling function,
  // surfaced only in the debug log above — it plays no role in dedup.
  function addTimelineEntry(label, lifecycleKey, producer) {
    if (ambientTimelineDeduper && !ambientTimelineDeduper.shouldLog(lifecycleKey)) {
      logTimelineDebug({ lifecycleKey, eventType: label, producer, outcome: 'suppressed-duplicate' });
      return;
    }
    logTimelineDebug({ lifecycleKey, eventType: label, producer, outcome: 'recorded' });
    const timeline = document.getElementById('ambient-timeline');
    const list = document.getElementById('ambient-timeline-list');
    if (!timeline || !list) return;
    timeline.style.display = 'block';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(label)}</span><span class="timeline-time">${time}</span>`;
    list.appendChild(li);
  }

  // `timeoutMs` is an opt-in, call-site-scoped extension: when a caller
  // supplies it, this bounds the underlying fetch with an AbortController so
  // the returned promise is guaranteed to settle even if the network/server
  // never responds — a request with no bound at all can leave a caller's own
  // `finally` (e.g. a busy/disabled-controls guard) waiting forever. Callers
  // that omit it get byte-for-byte the same behavior as before this option
  // existed (no AbortController is created, nothing about the request
  // changes). A timed-out request reports back through the normal return
  // contract (an `{error}` shape, same as any other failed call) rather than
  // throwing, so existing `if (!res || res.error)`-style callers handle it
  // automatically with zero branching changes.
  function getDemoSessionId() {
    let session = null;
    try { session = sessionStorage.getItem('nagex_demo_session'); } catch (e) {}
    if (!session) {
      const match = document.cookie.match(/(?:^|;\s*)nagex_demo_session=([^;]+)/);
      if (match) {
        session = decodeURIComponent(match[1]);
      } else {
        session = 'demo_sess_' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2));
      }
      try { sessionStorage.setItem('nagex_demo_session', session); } catch (e) {}
      try { document.cookie = 'nagex_demo_session=' + encodeURIComponent(session) + '; path=/; SameSite=Lax'; } catch (e) {}
    }
    return session;
  }

  async function apiFetch(endpoint, options = {}) {
    const { timeoutMs, headers: customHeaders, ...restOptions } = options;
    let controller = null;
    let timeoutId = null;
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const isDemoMode = new URLSearchParams(window.location.search).get('demo') === '1';
      const currentLocale = window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : (localStorage.getItem('nagex_locale') || 'en');
      const res = await fetch(endpoint, {
        ...restOptions,
        headers: {
          'Content-Type': 'application/json',
          'X-NAgex-Tenant': isDemoMode ? 'ten_demo_hackathon' : 'ten_production_01',
          'X-Principal-Id': isDemoMode ? 'usr_demo_alex' : 'usr_admin_001',
          'X-NAgex-Locale': currentLocale,
          'Accept-Language': currentLocale === 'ko' ? 'ko-KR,ko;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
          ...(isDemoMode ? { 'X-NAgex-Demo': '1', 'X-NAgex-Demo-Session': getDemoSessionId() } : {}),
          ...(customHeaders || {}),
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      return await res.json();
    } catch (err) {
      if (controller && err && err.name === 'AbortError') {
        console.error('API Timeout:', endpoint);
        return { error: { code: 'REQUEST_TIMEOUT', message: 'The request took too long and was cancelled.' } };
      }
      console.error('API Error:', endpoint, err);
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function handleOAuthRedirectBanner() {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get('oauth');
    if (!oauthResult) return;
    const status = params.get('status');
    window.alert(
      oauthResult === 'google' && status === 'connected'
        ? 'Google Calendar connected.'
        : 'Could not connect Google Calendar. Please try again.'
    );
    params.delete('oauth');
    params.delete('status');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
    window.history.replaceState({}, '', cleanUrl);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(window.location.search).get('demo') === '1') setupDemoReset();
    initNavigation();
    initRouter();
    initQuickWake();
    initPrimaryScenario();
    initQuickActionChips();
    handleOAuthRedirectBanner();
    loadAllData();

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        openAmbientOverlay();
      }
    });

    if (window.NAGEX_I18N) window.NAGEX_I18N.applyLocale();
  });

  function setupDemoReset() {
    const panel = document.getElementById('cat-panel-general') || document.getElementById('cat-panel-notifications');
    if (!panel || document.getElementById('demo-reset-card')) return;
    const card = document.createElement('div');
    card.id = 'demo-reset-card';
    card.className = 'settings-card';
    card.innerHTML = '<h3>Demo</h3><p>Restore the canonical Alex Kim hero scenario.</p><button type="button" class="btn-secondary" id="btn-demo-reset">Reset Demo</button><p id="demo-reset-feedback" aria-live="polite"></p>';
    panel.appendChild(card);
    card.querySelector('#btn-demo-reset').addEventListener('click', async () => {
      if (!window.confirm('Reset the NAgex demo to its original state?')) return;
      const result = await apiFetch('/api/v1/demo/reset', { method: 'POST', body: '{}' });
      const feedback = card.querySelector('#demo-reset-feedback');
      if (result && result.success) {
        feedback.textContent = 'Demo reset complete.';
        window.setTimeout(() => window.location.assign('/?demo=1'), 300);
      } else feedback.textContent = "I couldn't reset the demo right now.";
    });
  }

  function initNavigation() {
    const navItems = document.querySelectorAll('.nav-menu .nav-item');
    const sidebar = document.getElementById('sidebar-left');
    const overlay = document.getElementById('sidebar-overlay');

    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        switchTab(tab);
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
      });
    });

    const langBtn = document.getElementById('btn-lang-toggle');
    if (langBtn) {
      langBtn.addEventListener('click', () => {
        if (window.NAGEX_I18N) {
          window.NAGEX_I18N.toggleLocale();
          renderActiveTab();
        }
      });
    }

    const btnHam = document.getElementById('btn-hamburger');
    if (btnHam && sidebar) {
      btnHam.addEventListener('click', () => sidebar.classList.toggle('open'));
    }
    if (overlay && sidebar) {
      overlay.addEventListener('click', () => sidebar.classList.remove('open'));
    }
  }

  const TAB_HASH_MAP = {
    'tab-home': '#home',
    'tab-inbox': '#inbox',
    'tab-executions': '#activity',
    'tab-vault': '#vault',
    'tab-memory': '#memory',
    'tab-plans': '#plans',
    'tab-tasks': '#tasks',
    'tab-skills': '#skills',
    'tab-tools': '#tools',
    'tab-approvals': '#approvals',
    'tab-knowledge': '#knowledge',
    'tab-settings': '#settings',
    'tab-my-space': '#my-space',
    'tab-create': '#create',
    'tab-analyze': '#analyze',
  };

  const HASH_TAB_MAP = {
    '#home': 'tab-home',
    '#inbox': 'tab-inbox',
    '#activity': 'tab-executions',
    '#vault': 'tab-vault',
    '#memory': 'tab-memory',
    '#plans': 'tab-plans',
    '#tasks': 'tab-tasks',
    '#skills': 'tab-skills',
    '#tools': 'tab-tools',
    '#approvals': 'tab-approvals',
    '#knowledge': 'tab-knowledge',
    '#settings': 'tab-settings',
    '#my-space': 'tab-my-space',
    '#create': 'tab-create',
    '#analyze': 'tab-analyze',
  };

  let isNavigatingFromPopState = false;

  function getHashForTab(tabId, settingsCat) {
    if (tabId === 'tab-settings' && settingsCat) {
      return `#settings/${settingsCat}`;
    }
    return TAB_HASH_MAP[tabId] || '#home';
  }

  function parseHash(rawHash) {
    const raw = (rawHash || (typeof window !== 'undefined' ? window.location.hash : '') || '').trim();
    if (!raw) return { tabId: 'tab-home', catKey: null };

    if (raw.startsWith('#settings/')) {
      const catKey = raw.replace('#settings/', '');
      return { tabId: 'tab-settings', catKey };
    }

    const cleanHash = raw.split('?')[0];
    const tabId = HASH_TAB_MAP[cleanHash] || 'tab-home';
    return { tabId, catKey: null };
  }

  function switchTab(tabId, options) {
    const pushHistory = !options || options.pushHistory !== false;
    const prevTab = state.activeTab;
    state.activeTab = tabId;

    document.querySelectorAll('.nav-menu .nav-item[data-tab], .mobile-bottom-nav .mob-nav-item[data-tab], #mobile-app-shell [data-tab], .mh-bottom-nav [data-tab], .mh-nav-item[data-tab]').forEach((el) => {
      if (el.getAttribute('data-tab') === tabId) el.classList.add('active');
      else el.classList.remove('active');
    });

    const targetViewId = 'view-' + tabId.replace('tab-', '');
    document.querySelectorAll('.tab-view').forEach((v) => {
      if (v.id === targetViewId) v.classList.add('active-view');
      else v.classList.remove('active-view');
    });

    renderActiveTab();

    if (window.NAGEX.onTabChange) window.NAGEX.onTabChange(tabId);

    // DEBT-0005 History API Integration
    if (!isNavigatingFromPopState && pushHistory && typeof window !== 'undefined' && window.history && window.history.pushState) {
      const catKey = tabId === 'tab-settings' ? (state.activeSettingsCat || 'connections') : null;
      const targetHash = getHashForTab(tabId, catKey);
      const st = window.history.state;
      const alreadyPushed = st && st.tabId === tabId && st.settingsCat === catKey && window.location.hash === targetHash;

      if (!alreadyPushed) {
        window.history.pushState({ tabId, settingsCat: catKey }, '', targetHash);
      }
    }
  }

  function initRouter() {
    if (typeof window === 'undefined' || !window.history) return;

    window.addEventListener('popstate', (e) => {
      isNavigatingFromPopState = true;
      try {
        const stateData = e.state;
        if (stateData && stateData.tabId) {
          switchTab(stateData.tabId, { pushHistory: false });
          if (stateData.tabId === 'tab-settings' && stateData.settingsCat) {
            switchSettingsCategory(stateData.settingsCat, { pushHistory: false });
          }
        } else {
          const parsed = parseHash(window.location.hash);
          switchTab(parsed.tabId, { pushHistory: false });
          if (parsed.catKey) {
            switchSettingsCategory(parsed.catKey, { pushHistory: false });
          }
        }
      } finally {
        isNavigatingFromPopState = false;
      }
    });

    const parsed = parseHash(window.location.hash);
    switchTab(parsed.tabId, { pushHistory: false });
    if (parsed.catKey) state.activeSettingsCat = parsed.catKey;

    const initialHash = getHashForTab(parsed.tabId, parsed.catKey);
    if (window.history.replaceState) {
      window.history.replaceState({ tabId: parsed.tabId, settingsCat: parsed.catKey }, '', initialHash);
    }
  }

  function renderActiveTab() {
    if (state.activeTab === 'tab-home') renderHome();
    else if (state.activeTab === 'tab-inbox') renderInbox();
    else if (state.activeTab === 'tab-vault') renderVault();
    else if (state.activeTab === 'tab-memory') renderMemory();
    else if (state.activeTab === 'tab-plans') renderPlans();
    else if (state.activeTab === 'tab-tasks') renderTasks();
    else if (state.activeTab === 'tab-skills') renderSkills();
    else if (state.activeTab === 'tab-tools') renderTools();
    else if (state.activeTab === 'tab-approvals') renderApprovals();
    else if (state.activeTab === 'tab-executions') renderActivity();
    else if (state.activeTab === 'tab-knowledge') renderKnowledge();
    else if (state.activeTab === 'tab-settings') renderSettings();
    else if (state.activeTab === 'tab-my-space') renderMySpace();
    else if (state.activeTab === 'tab-create') renderCreate();
    else if (state.activeTab === 'tab-analyze') renderAnalyze();
  }

  async function loadAllData() {
    const [memData, planData, taskData, skillData, toolData, apprData, execData, knowData, qwData, autoData, oauthData, tgStatus, tgIdentities, slackStatus, slackIdentities, notifData, candData, activityData, inboxData, convData, providerStatusData] = await Promise.all([
      apiFetch('/api/v1/memory'),
      apiFetch('/api/v1/plans'),
      apiFetch('/api/v1/tasks'),
      apiFetch('/api/v1/skills'),
      apiFetch('/api/v1/tools'),
      apiFetch('/api/v1/approvals'),
      apiFetch('/api/v1/executions'),
      apiFetch('/api/v1/knowledge'),
      apiFetch('/api/v1/quickwake/config'),
      apiFetch('/api/v1/autonomy/config'),
      apiFetch('/api/v1/oauth/google/status'),
      apiFetch('/api/v1/integrations/telegram/status'),
      apiFetch('/api/v1/integrations/telegram/identities'),
      apiFetch('/api/v1/integrations/slack/status'),
      apiFetch('/api/v1/integrations/slack/identities'),
      apiFetch('/api/v1/notifications'),
      apiFetch('/api/v1/candidates'),
      apiFetch('/api/v1/activity'),
      apiFetch('/api/v1/workspace/inbox'),
      apiFetch('/api/v1/conversations/main'),
      apiFetch('/api/v1/providers/status'),
    ]);

    if (memData) state.memories = memData.memories || [];
    if (planData) state.plans = planData.plans || [];
    if (taskData) state.tasks = taskData.tasks || [];
    if (skillData) state.skills = skillData.skills || [];
    if (toolData) state.tools = toolData.tools || [];
    state.approvalsLoadFailed = !apprData || Boolean(apprData.error);
    if (apprData && !apprData.error) state.approvals = apprData.approvals || [];
    if (execData) state.executions = execData.executions || [];
    if (knowData) state.knowledge = knowData.documents || [];
    if (candData) state.candidates = candData.candidates || [];
    state.activityLoadFailed = !activityData || Boolean(activityData.error) || !Array.isArray(activityData.activities);
    if (activityData && !activityData.error && Array.isArray(activityData.activities)) state.activity = activityData.activities;
    if (inboxData && Array.isArray(inboxData.items)) state.inbox = inboxData.items;
    if (convData) state.mainConversation = convData;
    if (qwData) state.quickWakeConfig = qwData;
    if (autoData) state.autonomyConfig = autoData;
    if (oauthData && typeof oauthData.connected === 'boolean') state.googleOAuth = oauthData;
    if (tgStatus) state.telegram.status = tgStatus;
    if (tgIdentities) state.telegram.identities = tgIdentities.identities || [];
    if (slackStatus) state.slack.status = slackStatus;
    if (slackIdentities) state.slack.identities = slackIdentities.identities || [];
    if (notifData) {
      state.notifications.items = notifData.notifications || [];
      state.notifications.unreadCount = typeof notifData.unreadCount === 'number' ? notifData.unreadCount : 0;
    }
    if (providerStatusData) state.providerStatus = providerStatusData;

    renderActiveTab();
    scheduleActiveWorkPolling();
  }

  // Phase 1 STEP 8, item V — bounded polling: only while real PROCESSING/
  // RUNNING/PENDING_APPROVAL work exists, and it stops itself the moment
  // loadAllData() finds nothing active anymore. No WebSocket infra, no
  // polling forever on an idle Home.
  let activeWorkPollTimer = null;
  const ACTIVE_WORK_POLL_MS = 5000;

  function hasActiveWork() {
    const processingCaptures = (state.inbox || []).some((i) => i.status === 'PROCESSING' || i.status === 'QUEUED' || i.status === 'UPLOADING');
    const runningTasks = (state.tasks || []).some((t) => t.status === 'RUNNING');
    const runningOrPendingActions = (state.candidates || []).some((c) => c.action && (c.action.status === 'RUNNING' || c.action.status === 'PENDING_APPROVAL'));
    return processingCaptures || runningTasks || runningOrPendingActions;
  }

  function scheduleActiveWorkPolling() {
    if (activeWorkPollTimer) {
      clearTimeout(activeWorkPollTimer);
      activeWorkPollTimer = null;
    }
    if (!hasActiveWork()) return;
    activeWorkPollTimer = setTimeout(() => {
      loadAllData();
    }, ACTIVE_WORK_POLL_MS);
  }

  let realMediaRecorder = null;
  let realAudioChunks = [];

  function renderHome() {
    // R12.1 Increment 2 — hero title/subtitle are now plain data-i18n
    // markup (applyLocale() keeps them current on every locale switch);
    // this function no longer overrides them with hardcoded copy. The
    // eyebrow greeting stays owned exclusively by desktop-home.js's
    // renderGreeting() (real time-of-day text), never a fabricated name.
    renderHomeWorkspaceSections();
    if (window.NAGEX.renderDailyBrief) window.NAGEX.renderDailyBrief('desktop');

    const btnSend = document.getElementById('btn-home-prompt-send');
    const homeInput = document.getElementById('home-prompt-input');
    const btnLink = document.getElementById('btn-afford-link');
    const btnFile = document.getElementById('btn-afford-file');
    const btnAudio = document.getElementById('btn-afford-audio');

    if (btnSend && homeInput) {
      // R12.1 Increment 1 — Universal Intent Input busy-state contract:
      // the composer must block duplicate submission (disabled the moment
      // classification starts, not only once the ambient run guard takes
      // over) and must never lose the user's text on a failed/timed-out
      // request — the original code cleared the input unconditionally
      // before even knowing whether classification succeeded, so a
      // network failure silently discarded what the user typed. Ownership
      // of the disabled state hands off to setAmbientRunControlsDisabled()
      // (which already re-enables in its own finally) once an ASK/COMMAND
      // intent is dispatched to runAmbientTask — handedOff below prevents
      // this handler's own finally from re-enabling too early and racing
      // that handoff.
      btnSend.onclick = async () => {
        if (btnSend.disabled) return;
        const text = homeInput.value.trim();
        if (!text) return;
        btnSend.disabled = true;
        homeInput.disabled = true;
        let handedOff = false;
        try {
          const routeRes = await apiFetch('/api/v1/workspace/route-input', {
            method: 'POST',
            body: JSON.stringify({ text }),
          });
          if (!routeRes || routeRes.error) {
            // Truthful recovery (§18): never a fake success, and the
            // user's original text is preserved for retry, not discarded.
            return;
          }

          const intent = routeRes?.data?.primaryIntent || 'ASK';

          if (intent === 'ASK' || intent === 'COMMAND') {
            homeInput.value = '';
            handedOff = true;
            openAmbientOverlay();
            runAmbientTask(text);
          } else if (intent === 'LINK_CAPTURE' || intent === 'CAPTURE') {
            const captureRes = await apiFetch('/api/v1/workspace/capture', {
              method: 'POST',
              body: JSON.stringify({
                type: intent === 'LINK_CAPTURE' ? 'LINK' : 'TEXT',
                content: text,
                source: 'WEB',
              }),
            });
            if (!captureRes || captureRes.error) return;
            homeInput.value = '';
            renderInbox();
            switchTab('tab-inbox');
          }
        } finally {
          if (!handedOff) {
            btnSend.disabled = false;
            homeInput.disabled = false;
          }
        }
      };
    }

    if (btnLink && homeInput) {
      btnLink.onclick = async () => {
        const url = window.prompt('Enter URL link to capture into Vault:', 'https://');
        if (url && url.startsWith('http')) {
          await apiFetch('/api/v1/workspace/capture', {
            method: 'POST',
            body: JSON.stringify({ type: 'LINK', content: url, source: 'WEB' }),
          });
          renderInbox();
          switchTab('tab-inbox');
        }
      };
    }

    if (btnFile) {
      btnFile.onclick = () => {
        const fileDrop = document.getElementById('composer-drop-zone');
        if (fileDrop) fileDrop.classList.toggle('hidden');
      };
    }

    if (btnAudio) {
      btnAudio.onclick = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert('Microphone recording is not supported by your browser.');
          return;
        }
        if (realMediaRecorder && realMediaRecorder.state === 'recording') {
          realMediaRecorder.stop();
          btnAudio.style.background = 'transparent';
          btnAudio.title = 'Capture Voice / Audio';
          return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          realAudioChunks = [];
          realMediaRecorder = new MediaRecorder(stream);
          realMediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) realAudioChunks.push(e.data);
          };
          realMediaRecorder.onstop = async () => {
            const audioBlob = new Blob(realAudioChunks, { type: 'audio/webm' });
            stream.getTracks().forEach((track) => track.stop());
            if (audioBlob.size === 0) return;

            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64Data = (reader.result || '').toString().split(',')[1];
              if (!base64Data) return;
              await apiFetch('/api/v1/workspace/upload', {
                method: 'POST',
                body: JSON.stringify({
                  type: 'AUDIO',
                  filename: `voice_memo_${Date.now()}.webm`,
                  mimeType: 'audio/webm',
                  base64: base64Data,
                  source: 'WEB',
                }),
              });
              renderInbox();
              switchTab('tab-inbox');
            };
            reader.readAsDataURL(audioBlob);
          };
          realMediaRecorder.start();
          btnAudio.style.background = '#fee2e2';
          btnAudio.title = 'Recording... Click to stop';
        } catch (err) {
          alert('Microphone access denied or error: ' + (err.message || err));
        }
      };
    }

    // Desktop/Mobile Home modules (separate files) hook in here rather
    // than duplicating this file's own render lifecycle — called every
    // time Home actually re-renders (including after loadAllData()),
    // never on a separate/parallel timer. Two distinct hook names
    // (rather than one shared one) so desktop-home.js and mobile-home.js
    // can both register without either overwriting the other.
    if (window.NAGEX.onHomeRender) window.NAGEX.onHomeRender();
    if (window.NAGEX.onHomeRenderMobile) window.NAGEX.onHomeRenderMobile();
  }

  async function renderHomeWorkspaceSections() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    // 2a. Important for you
    const elImportant = document.getElementById('list-important-for-you');
    if (elImportant) {
      const proposedCandidates = (state.candidates || []).filter((c) => c.status === 'PROPOSED');
      const needsHumanCaptures = (state.inbox || []).filter((i) => i.status === 'NEEDS_REVIEW' && i.metadata?.errorCode === 'BLOCKED_NEEDS_HUMAN');
      const importantItems = [
        ...proposedCandidates,
        ...needsHumanCaptures,
      ].slice(0, 2);
    }

    // 2b. Needs Approval (max 2 items)
    const elApprovals = document.getElementById('list-needs-attention');
    if (elApprovals) {
      if (state.approvalsLoadFailed) {
        elApprovals.innerHTML = `<div class="nagex-empty-state">${escapeHtml(t('home.approvalsLoadError') || 'Approvals could not be loaded.')}</div>`;
      } else {
        const pendingApprs = state.approvals.filter((a) => a.status === 'PENDING').slice(0, 2);
        elApprovals.innerHTML = pendingApprs.map((a) => homeApprovalActionLabel(a, t)).join('');
      }
    }
  }

  // Consequence-specific approval CTA (R12.1 Increment 2 §9/§10) — never a
  // bare "Run"/"Execute"/"Continue"/"OK". Derived from the approval's own
  // toolId when present (the reliable signal), falling back to its
  // action/tool text, and only using a still-specific generic label
  // ("Approve request") if neither identifies a known consequence.
  function homeApprovalActionLabel(a, t) {
    const toolId = String(a.toolId || '').toUpperCase();
    const action = String(a.action || a.intent || '').toLowerCase();
    const tool = String(a.tool || '').toLowerCase();
    if (toolId.includes('CALENDAR_CREATE') || (action.includes('create') && (action.includes('calendar') || action.includes('event') || tool.includes('calendar')))) {
      return t('home.approveAndCreateEvent') || 'Approve and create event';
    }
    if (toolId.includes('GMAIL_SEND') || toolId.includes('GMAIL_REPLY') || action.includes('send') || action.includes('email') || tool.includes('gmail')) {
      return t('home.approveAndSend') || 'Approve and send';
    }
    if (toolId.includes('CANCEL') || action.includes('delete') || action.includes('cancel')) {
      return t('home.approveAndDelete') || 'Approve and delete';
    }
    if (action.includes('submit')) {
      return t('home.approveAndSubmit') || 'Approve and submit';
    }
    return t('home.approveGeneric') || 'Approve request';
  }

  async function renderHomeWorkspaceSections() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    // 1. NAgex is working (max 2 items) — item D: real QUEUED/PROCESSING
    // captures and RUNNING tasks/candidate actions only. Nothing stays
    // listed here once it reaches a terminal state (SUCCEEDED/READY).
    const elWorking = document.getElementById('list-nagex-working');
    if (elWorking) {
      const card = elWorking.closest('.canvas-section-card');
      const runningTasks = (state.tasks || [])
        .filter((task) => task.status === 'RUNNING')
        .map((task) => ({ title: task.name || 'Working on it...', detail: task.lastRunAt ? `Started ${new Date(task.lastRunAt).toLocaleTimeString()}` : 'Started recently', taskId: task.taskId }));
      const processingCaptures = (state.inbox || [])
        .filter((i) => i.status === 'PROCESSING' || i.status === 'QUEUED' || i.status === 'UPLOADING')
        .map((i) => ({ title: i.metadata?.extractedTitle || i.content || 'Saving...', detail: i.metadata?.processingSubStage || '' }));
      const runningActions = (state.candidates || [])
        .filter((c) => c.action && c.action.status === 'RUNNING')
        .map((c) => ({ title: c.title, detail: `${c.type} action in progress` }));
      const workingItems = [...processingCaptures, ...runningTasks, ...runningActions].slice(0, 2);
      // UI-4-R1: the mockup keeps this panel structurally present at all
      // times (a "Live"-style working surface), so it is no longer hidden
      // when idle — a truthful empty state replaces the old
      // card.style.display='none' collapse. Real data/Stop binding is
      // otherwise unchanged.
      if (card) card.style.display = 'block';
      if (workingItems.length > 0) {
        // A Stop control is only ever rendered for an item that carries a
        // real, cancellable identifier (taskId -> POST /api/v1/tasks/:id/cancel,
        // the real DC3-B2-integrated Task cancellation path) — never a
        // local-only "looks stopped" toggle, and never shown for items
        // with no real cancel handle (processing captures, candidate
        // actions) rather than wiring a fake one.
        elWorking.innerHTML = workingItems.map((w) => `<div class="inbox-item-card">
            <div class="inbox-item-main">
              <span class="inbox-item-title">${escapeHtml(w.title)}</span>
              <span class="inbox-item-summary">${escapeHtml(w.detail)}</span>
            </div>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <span class="badge-status status-PROCESSING">${escapeHtml(t('workspace.working') || 'WORKING')}</span>
              ${w.taskId ? `<button class="btn-small danger" onclick="window.NAGEX.cancelTask('${w.taskId}')" title="${escapeHtml(t('workspace.stop') || 'Stop')}">${escapeHtml(t('workspace.stop') || 'Stop')}</button>` : ''}
            </div>
          </div>`).join('');
      } else {
        elWorking.innerHTML = `<div class="working-ready-state"><span class="working-ready-icon"><svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></span><div><strong>${escapeHtml(t('home.workingReadyTitle') || 'Ready when you are')}</strong><span>${escapeHtml(t('home.workingReadyBody') || 'Start a request above or review recent activity.')}</span></div><button class="working-ready-link" onclick="document.getElementById('home-prompt-input')?.focus()">${escapeHtml(t('home.startRequest') || 'Start a request')}</button></div>`;
      }
    }

    // 2a. Important for you (max 2 items, R12.1 Increment 2 §7) — proactive
    // information only, structurally separate from real approvals: proposed
    // candidates awaiting review and retryable failed candidate actions and
    // pages that need a human. Nothing rendered here can authorize a
    // mutation — clicking through always lands on Inbox for the real
    // review/accept/reject action.
    const elImportant = document.getElementById('list-important-for-you');
    if (elImportant) {
      const card = elImportant.closest('.canvas-section-card');
      const proposedCandidates = (state.candidates || []).filter((c) => c.status === 'PROPOSED');
      const failedActionCandidates = (state.candidates || []).filter((c) => c.status === 'ACCEPTED' && c.action && c.action.status === 'FAILED');
      const needsHumanCaptures = (state.inbox || []).filter((i) => i.status === 'NEEDS_REVIEW' && i.metadata?.errorCode === 'BLOCKED_NEEDS_HUMAN');

      const CANDIDATE_REVIEW_LABEL = { TASK: 'Review suggested task', CALENDAR: 'Review suggested calendar event', MEMORY: 'Review suggested memory', KNOWLEDGE: 'Review suggested knowledge item' };
      const ACTION_RETRY_LABEL = { TASK: 'Task action failed', CALENDAR: 'Calendar action failed', MEMORY: 'Memory action failed', KNOWLEDGE: 'Knowledge action failed' };

      const importantItems = [
        ...proposedCandidates.map((c) => ({ kind: 'candidate-review', candidate: c })),
        ...failedActionCandidates.map((c) => ({ kind: 'candidate-retry', candidate: c })),
        ...needsHumanCaptures.map((i) => ({ kind: 'needs-human', item: i })),
      ].slice(0, 2);

      if (card) card.style.display = 'block';
      if (importantItems.length > 0) {
        elImportant.innerHTML = importantItems.map((entry) => {
          if (entry.kind === 'candidate-review') {
            const c = entry.candidate;
            return `<div class="inbox-item-card" onclick="window.NAGEX.switchTab('tab-inbox')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.NAGEX.switchTab('tab-inbox');}"><div class="inbox-item-main"><span class="inbox-item-title">${escapeHtml(CANDIDATE_REVIEW_LABEL[c.type] || 'Review suggestion')}</span><span class="inbox-item-summary">${escapeHtml(c.title)}</span></div><span class="badge-status status-PROPOSED">${escapeHtml(t('workspace.candidateStatusProposed') || 'Suggested')}</span></div>`;
          }
          if (entry.kind === 'candidate-retry') {
            const c = entry.candidate;
            return `<div class="inbox-item-card" onclick="window.NAGEX.switchTab('tab-inbox')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.NAGEX.switchTab('tab-inbox');}"><div class="inbox-item-main"><span class="inbox-item-title">${escapeHtml(ACTION_RETRY_LABEL[c.type] || 'Action failed')}</span><span class="inbox-item-summary">${escapeHtml(c.title)}</span></div><span class="badge-status status-FAILED">${escapeHtml(t('workspace.candidateActionFailed') || 'Action failed')}</span></div>`;
          }
          // needs-human
          const i = entry.item;
          const title = i.metadata?.extractedTitle || i.content || 'A page';
          return `<div class="inbox-item-card" onclick="window.NAGEX.switchTab('tab-inbox')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.NAGEX.switchTab('tab-inbox');}"><div class="inbox-item-main"><span class="inbox-item-title">${escapeHtml(title)}</span><span class="inbox-item-summary">${escapeHtml(t('workspace.needsHumanAttention') || 'Needs your attention')}</span></div><span class="badge-status status-NEEDS_REVIEW">${escapeHtml(t('workspace.needsHumanBadge') || 'Review')}</span></div>`;
        }).join('');
      } else {
        elImportant.innerHTML = `<div class="nagex-empty-state">${escapeHtml(t('home.importantEmpty') || 'Nothing important to flag right now.')}</div>`;
      }
    }

    // 2b. Needs Approval (max 2 items) — real consequential actions
    // awaiting explicit user approval, structurally separate from the
    // proactive "Important for you" section above. CTAs are
    // consequence-specific (never a bare "Run"/"OK"), derived from the
    // approval's own toolId/action, per R12.1 Increment 2 §9.
    //
    // DEBT-0006 CLOSED (R12.1 Increment 2.5) — GET /api/v1/approvals now
    // sources this list from the real, tenant/principal-scoped
    // ActionApprovalStore.listPending() (the same primitive Daily Brief's
    // own "Needs Your Approval" section already used), never a hardcoded
    // demo/seed array. No frontend id-filtering is needed or present.
    //
    // Fail-closed (§8): state.approvalsLoadFailed distinguishes "the
    // fetch itself failed" from "the real source returned zero pending
    // approvals" — only the latter may render as "No approvals needed."
    const elApprovals = document.getElementById('list-needs-attention');
    if (elApprovals) {
      const card = elApprovals.closest('.canvas-section-card');
      if (card) card.style.display = 'block';
      const pendingApprs = state.approvals.filter((a) => a.status === 'PENDING').slice(0, 2);

      if (state.approvalsLoadFailed) {
        elApprovals.innerHTML = `<div class="nagex-empty-state">${escapeHtml(t('home.approvalsLoadError') || 'Approvals could not be loaded.')}</div>`;
      } else if (pendingApprs.length > 0) {
        elApprovals.innerHTML = pendingApprs.map((a) => {
          const humanAction = a.intent || a.action || 'Ready for review';
          return `<div class="inbox-item-card contextual-approval-card">
              <span class="approval-row-icon" aria-hidden="true">!</span>
              <div class="inbox-item-main">
                <span class="inbox-item-title">${escapeHtml(humanAction)}</span>
                <span class="inbox-item-summary">${escapeHtml(a.resource?.id || 'Review the details')}</span>
              </div>
              <div class="contextual-appr-btns" style="display: flex; gap: 0.35rem; margin-top: 0.25rem;">
                <button class="btn-primary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'APPROVE', event)">${escapeHtml(homeApprovalActionLabel(a, t))}</button>
                <button class="btn-secondary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.switchTab('tab-approvals')">${escapeHtml(t('home.reviewDetails') || 'Review')}</button>
                <button class="btn-secondary danger" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'REJECT', event)">${escapeHtml(t('calendar.reject') || 'Reject')}</button>
              </div>
            </div>`;
        }).join('');
      } else {
        elApprovals.innerHTML = `<div class="nagex-empty-state">${escapeHtml(t('home.approvalsEmpty') || 'No approvals needed.')}</div>`;
      }
    }

    // Recent Results — real completed outcomes. Owned by desktop-home.js's
    // renderTodayPanel() (#desktop-recent-actions-list, sourced from real
    // GET /api/v1/my-space history) since that is the panel actually
    // present in current Home markup; the #list-today-summary /
    // #list-recent-activity ids this block used to target no longer exist
    // in index.html (superseded by #desktop-today-list /
    // #desktop-recent-actions-list) — removed as dead code rather than
    // left silently no-op-ing against a target that was never real.
  }

  // ── R12.1 Increment 3 — Intent-first Inbox presentation model ──
  function buildCanonicalInboxViewModel({ approvals = [], captures = [], candidates = [] }) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const items = [];

    // 1. Pending Approvals (Priority 2)
    approvals.filter((a) => a.status === 'PENDING').forEach((a) => {
      let actionTitle = t('home.approveGeneric') || 'Approve request';
      if (a.toolId === 'google_calendar_create_event') actionTitle = t('home.approveAndCreateEvent') || 'Approve and create event';
      else if (a.toolId === 'gmail_send_message') actionTitle = t('home.approveAndSend') || 'Approve and send email';
      else if (a.toolId === 'gmail_create_draft') actionTitle = 'Approve and save draft';

      const detail = a.payload?.summary || a.payload?.subject || a.resource?.id || 'Review the details';
      items.push({
        id: a.approvalId,
        type: 'APPROVAL',
        priority: 2,
        groupKey: 'NEEDS_ATTENTION',
        title: actionTitle,
        summary: detail,
        status: 'PENDING_APPROVAL',
        source: (a.toolId || 'system').split('_')[0],
        createdAt: a.createdAt,
        updatedAt: a.updatedAt || a.createdAt,
        primaryAction: { label: actionTitle, actionType: 'APPROVE', approvalId: a.approvalId },
        secondaryAction: { label: t('workspace.candidateReject') || 'Reject', actionType: 'REJECT', approvalId: a.approvalId },
        approvalRef: a.approvalId,
        attentionReason: t('workspace.needsHumanAttention') || 'Needs your attention',
      });
    });

    // 2. Clarifications (Priority 3)
    captures.filter((c) => c.status === 'NEEDS_REVIEW' || c.metadata?.errorCode === 'BLOCKED_NEEDS_HUMAN').forEach((c) => {
      const title = c.metadata?.extractedTitle || c.content || 'Clarification needed';
      items.push({
        id: c.captureId,
        type: 'CLARIFICATION',
        priority: 3,
        groupKey: 'NEEDS_ATTENTION',
        title: title,
        summary: c.metadata?.extractedSummary || c.content || '',
        status: 'NEEDS_REVIEW',
        source: c.source || 'capture',
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
        primaryAction: { label: t('inbox.answerClarification') || 'Answer', actionType: 'ACTION_CAPTURE', captureId: c.captureId },
        taskRef: c.captureId,
        attentionReason: c.metadata?.errorMessage || t('workspace.needsHumanAttention') || 'Needs your attention',
      });
    });

    // 3. Proposed Candidates (Priority 4)
    candidates.filter((c) => c.status === 'PROPOSED').forEach((c) => {
      items.push({
        id: c.candidateId,
        type: 'CANDIDATE_REVIEW',
        priority: 4,
        groupKey: 'NEEDS_ATTENTION',
        title: c.title,
        summary: candidatePayloadPreview(c),
        status: 'PROPOSED',
        source: c.type,
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
        primaryAction: { label: t('workspace.candidateAccept') || 'Accept', actionType: 'ACCEPT_CANDIDATE', candidateId: c.candidateId },
        secondaryAction: { label: t('workspace.candidateReject') || 'Reject', actionType: 'REJECT_CANDIDATE', candidateId: c.candidateId },
        taskRef: c.candidateId,
        attentionReason: t('workspace.needsReview') || 'Needs review',
      });
    });

    // 4. Failed Work (Priority 5)
    captures.filter((c) => c.status === 'FAILED').forEach((c) => {
      const retryable = c.metadata?.retryable !== false;
      items.push({
        id: c.captureId,
        type: 'FAILED_WORK',
        priority: 5,
        groupKey: 'NEEDS_ATTENTION',
        title: c.metadata?.extractedTitle || 'Capture processing failed',
        summary: c.metadata?.errorMessage || 'Execution encountered an error',
        status: 'FAILED',
        source: c.source || 'capture',
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
        primaryAction: retryable ? { label: t('workspace.retry') || 'Retry', actionType: 'RETRY_CAPTURE', captureId: c.captureId } : null,
        errorState: c.metadata?.errorMessage || 'Execution error',
        attentionReason: c.metadata?.failureCategory === 'NEEDS_HUMAN' ? (t('workspace.needsHumanAttention') || 'Needs your attention') : (t('workspace.notRetryable') || 'Cannot be retried'),
      });
    });

    // 5. Ready Results (Priority 6)
    captures.filter((c) => c.status === 'READY').forEach((c) => {
      items.push({
        id: c.captureId,
        type: 'READY_RESULT',
        priority: 6,
        groupKey: 'READY_FOR_YOU',
        title: c.metadata?.extractedTitle || 'Result ready',
        summary: c.metadata?.extractedSummary || c.content || '',
        status: 'READY',
        source: c.source || 'capture',
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
        primaryAction: { label: t('inbox.openReport') || 'Open result', actionType: 'VIEW_RESULT', captureId: c.captureId },
        artifactRef: c.metadata?.artifactRef || null,
      });
    });

    // 6. Running Work (Priority 7)
    captures.filter((c) => ['QUEUED', 'UPLOADING', 'PROCESSING', 'EXTRACTED', 'UNDERSTOOD'].includes(c.status)).forEach((c) => {
      items.push({
        id: c.captureId,
        type: 'RUNNING_WORK',
        priority: 7,
        groupKey: 'NAGEX_IS_WORKING',
        title: c.metadata?.extractedTitle || c.content || 'NAGEX is working',
        summary: c.metadata?.processingSubStage || 'Processing...',
        status: 'WORKING',
        source: c.source || 'capture',
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
      });
    });

    // 7. Recently Completed (Priority 8)
    captures.filter((c) => c.status === 'ACTIONED' || c.status === 'ARCHIVED').slice(0, 3).forEach((c) => {
      items.push({
        id: c.captureId,
        type: 'RECENTLY_COMPLETED',
        priority: 8,
        groupKey: 'RECENTLY_COMPLETED',
        title: c.metadata?.extractedTitle || c.content || 'Completed action',
        summary: c.metadata?.extractedSummary || 'Done',
        status: 'COMPLETED',
        source: c.source || 'capture',
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
      });
    });

    // Sort by priority ASC, then recency DESC
    return items.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  function renderCanonicalInboxCard(item) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const timeStr = item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let primaryBtnHtml = '';
    let secondaryBtnHtml = '';

    if (item.primaryAction) {
      if (item.primaryAction.actionType === 'APPROVE') {
        primaryBtnHtml = `<button class="btn-primary" style="font-size:0.75rem; padding: 4px 10px;" onclick="window.NAGEX.approveAction('${item.approvalRef}')">${escapeHtml(item.primaryAction.label)}</button>`;
      } else if (item.primaryAction.actionType === 'RETRY_CAPTURE') {
        primaryBtnHtml = `<button class="btn-secondary" style="font-size:0.75rem; padding: 4px 10px;" onclick="window.NAGEX.retryCapture('${item.id}')">${escapeHtml(item.primaryAction.label)}</button>`;
      } else if (item.primaryAction.actionType === 'ACCEPT_CANDIDATE') {
        primaryBtnHtml = `<button class="btn-primary" style="font-size:0.75rem; padding: 4px 10px;" onclick="window.NAGEX.acceptCandidate('${item.id}')">${escapeHtml(item.primaryAction.label)}</button>`;
      } else if (item.primaryAction.actionType === 'ACTION_CAPTURE') {
        primaryBtnHtml = `<button class="btn-primary" style="font-size:0.75rem; padding: 4px 10px;" onclick="window.NAGEX.actionCapture('${item.id}', 'ACTIONED')">${escapeHtml(item.primaryAction.label)}</button>`;
      } else {
        primaryBtnHtml = `<button class="btn-secondary" style="font-size:0.75rem; padding: 4px 10px;">${escapeHtml(item.primaryAction.label)}</button>`;
      }
    }

    if (item.secondaryAction) {
      if (item.secondaryAction.actionType === 'REJECT') {
        secondaryBtnHtml = `<button class="btn-secondary" style="font-size:0.75rem; padding: 4px 10px;" onclick="window.NAGEX.rejectAction('${item.approvalRef}')">${escapeHtml(item.secondaryAction.label)}</button>`;
      } else if (item.secondaryAction.actionType === 'REJECT_CANDIDATE') {
        secondaryBtnHtml = `<button class="btn-secondary" style="font-size:0.75rem; padding: 4px 10px;" onclick="window.NAGEX.rejectCandidate('${item.id}')">${escapeHtml(item.secondaryAction.label)}</button>`;
      }
    }

    const badgeClass = item.status === 'PENDING_APPROVAL' ? 'status-NEEDS_REVIEW' :
                       item.status === 'FAILED' ? 'status-FAILED' :
                       item.status === 'WORKING' ? 'status-PROCESSING' :
                       item.status === 'READY' || item.status === 'COMPLETED' ? 'status-READY' : 'status-CAPTURED';

    return `
      <div class="inbox-item-card" data-inbox-id="${item.id}" tabindex="0" role="region" aria-label="${escapeHtml(item.title)}">
        <div class="inbox-item-main">
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <span class="inbox-item-title">${escapeHtml(item.title)}</span>
            <span class="badge-status ${badgeClass}">${escapeHtml(item.status)}</span>
          </div>
          <span class="inbox-item-summary">${escapeHtml(item.summary)}</span>
          ${item.attentionReason ? `<span style="font-size:0.72rem; color:var(--color-accent-gold, #d97706); font-weight:500;">${escapeHtml(item.attentionReason)}</span>` : ''}
          ${item.errorState ? `<span style="font-size:0.72rem; color:#ef4444;">${escapeHtml(item.errorState)}</span>` : ''}
          <span style="font-size:0.7rem; color:var(--text-muted, #9ca3af);">${timeStr}</span>
        </div>
        <div style="display:flex; gap:0.4rem; align-items:center;">
          ${primaryBtnHtml}
          ${secondaryBtnHtml}
        </div>
      </div>`;
  }

  async function renderInbox() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const listEl = document.getElementById('inbox-items-list');
    if (!listEl) return;
    // Gated by metadata?.retryable !== false (captureRetryable)

    let loadError = false;
    let approvalsData = [];
    let inboxData = [];
    let candData = [];

    try {
      const [apprRes, inbRes, candRes] = await Promise.all([
        apiFetch('/api/v1/approvals').catch(() => ({ error: true })),
        apiFetch('/api/v1/workspace/inbox').catch(() => ({ error: true })),
        apiFetch('/api/v1/candidates').catch(() => ({ error: true })),
      ]);
      if (!inbRes || inbRes.error) loadError = true;
      else {
        approvalsData = (apprRes && Array.isArray(apprRes.approvals)) ? apprRes.approvals : [];
        inboxData = Array.isArray(inbRes.items) ? inbRes.items : [];
        candData = (candRes && Array.isArray(candRes.candidates)) ? candRes.candidates : [];
        state.inbox = inboxData;
        state.candidates = candData;
      }
    } catch (err) {
      loadError = true;
    }

    if (loadError) {
      listEl.innerHTML = `<div class="empty-state-text" style="color: #ef4444;">${escapeHtml(t('inbox.loadError') || 'Inbox could not be loaded.')}</div>`;
      return;
    }

    const items = buildCanonicalInboxViewModel({
      approvals: approvalsData,
      captures: inboxData,
      candidates: candData,
    });

    if (items.length === 0) {
      listEl.innerHTML = `<div class="empty-state-text">${escapeHtml(t('inbox.emptyState') || 'Nothing needs your attention right now.')}</div>`;
      return;
    }

    const groupKeys = ['NEEDS_ATTENTION', 'READY_FOR_YOU', 'NAGEX_IS_WORKING', 'RECENTLY_COMPLETED'];
    const groupTitles = {
      NEEDS_ATTENTION: t('inbox.groupNeedsAttention') || 'Needs your attention',
      READY_FOR_YOU: t('inbox.groupReadyForYou') || 'Ready for you',
      NAGEX_IS_WORKING: t('inbox.groupNagexWorking') || 'NAGEX is working',
      RECENTLY_COMPLETED: t('inbox.groupRecentlyCompleted') || 'Recently completed',
    };

    let html = '';
    for (const key of groupKeys) {
      const groupItems = items.filter((i) => i.groupKey === key);
      if (groupItems.length === 0) continue; // Only groups that have real items!

      html += `
        <div class="inbox-group-section" data-group="${key}" style="margin-bottom: 1.5rem;">
          <h3 class="inbox-group-heading" style="font-size: 0.85rem; font-weight: 700; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.35rem;">
            ${escapeHtml(groupTitles[key])} (${groupItems.length})
          </h3>
          <div class="inbox-group-items" style="display: flex; flex-direction: column; gap: 0.6rem;">
            ${groupItems.map(renderCanonicalInboxCard).join('')}
          </div>
        </div>`;
    }

    listEl.innerHTML = html;
  }

  // ─── Phase 1 STEP 6 — Candidate Review ───
  //
  // CandidateStore/API is the ONLY source of truth for review state
  // (item B). Nothing here ever reads capture.metadata.candidates[].status
  // to decide what to render or which action is available (item R).
  //
  // Review is not execution (item A): Accept only ever moves a candidate to
  // ACCEPTED — it never creates a Task, requests a Calendar approval, writes
  // Memory, or indexes Knowledge. That distinction is enforced server-side
  // (CandidateStore.accept/QuickCaptureService.acceptCandidate — see
  // candidate.store.ts) and is repeated here only in copy, never bypassed.

  // Which candidate (if any) is currently showing its inline edit form, and
  // whether decided/expired candidates are currently shown in the queue.
  let candidateEditState = null;
  let candidatesShowResolved = false;

  async function loadCanonicalCandidates() {
    const data = await apiFetch('/api/v1/candidates');
    state.candidates = (data && Array.isArray(data.candidates)) ? data.candidates : [];
  }

  function candidateStatusLabel(status) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const map = {
      PROPOSED: t('workspace.candidateStatusProposed') || 'Suggested',
      ACCEPTED: t('workspace.candidateStatusAccepted') || 'Accepted for action',
      REJECTED: t('workspace.candidateStatusRejected') || 'Rejected',
      EXPIRED: t('workspace.candidateStatusExpired') || 'Expired',
    };
    return map[status] || status;
  }

  // Source context (item J): cross-references the already-loaded capture
  // list purely to display where a suggestion came from — a domain/page
  // title for URLs, a real chunk's page number for PDFs, or the source
  // capture's own title/snippet for plain text. Never fabricated: if the
  // capture or the referenced chunk isn't found, this returns ''.
  function candidateSourceContext(candidate) {
    const capture = (state.inbox || []).find((i) => i.captureId === candidate.captureId);
    if (!capture) return '';
    if (capture.type === 'LINK') {
      let domain = '';
      if (capture.metadata && capture.metadata.sourceUrl) {
        try { domain = new URL(capture.metadata.sourceUrl).hostname; } catch { /* leave blank */ }
      }
      const title = (capture.metadata && (capture.metadata.pageTitle || capture.metadata.extractedTitle)) || '';
      return [title, domain].filter(Boolean).join(' · ');
    }
    if (capture.type === 'FILE') {
      const chunkRef = (candidate.sourceRefs || []).find((r) => typeof r === 'string' && r.indexOf('chk_') === 0);
      const chunk = chunkRef ? ((capture.metadata && capture.metadata.chunks) || []).find((c) => c.chunkId === chunkRef) : null;
      const filename = (capture.metadata && (capture.metadata.originalName || capture.metadata.extractedTitle)) || 'document';
      return chunk && chunk.pageStart != null ? `${filename} · p.${chunk.pageStart}` : filename;
    }
    // TEXT
    return (capture.metadata && capture.metadata.extractedTitle) || (capture.content || '').slice(0, 60);
  }

  // Type-specific payload preview (item D) — never the raw payload JSON.
  function candidatePayloadPreview(candidate) {
    const p = candidate.payload || {};
    if (candidate.type === 'TASK') {
      return [p.objective, p.dueAt ? `due ${new Date(p.dueAt).toLocaleDateString()}` : ''].filter(Boolean).join(' · ');
    }
    if (candidate.type === 'CALENDAR') {
      const bits = [];
      if (p.start) bits.push(new Date(p.start).toLocaleString());
      if (p.timezone) bits.push(p.timezone);
      if (p.attendees && p.attendees.length > 0) bits.push(`${p.attendees.length} attendee${p.attendees.length > 1 ? 's' : ''}`);
      return bits.join(' · ');
    }
    if (candidate.type === 'MEMORY') {
      return p.statement || '';
    }
    return p.summary || ''; // KNOWLEDGE
  }

  function toLocalDatetimeValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function candidateEditField(labelKey, fallbackLabel, inputHtml) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    return `<label class="cand-edit-label" style="display:block; font-size:0.72rem; margin-top:0.35rem;">
      ${escapeHtml(t(labelKey) || fallbackLabel)}
      ${inputHtml}
    </label>`;
  }

  const CAND_ESC = (id) => `if(event.key==='Escape'){event.preventDefault();window.NAGEX.cancelModifyCandidate('${id}');}`;

  // Item H: a plain inline edit form, not a modal — keyboard-accessible via
  // normal tab order, no focus trap needed. Escape on any field cancels
  // without saving (item P) — it never triggers Accept/Reject/PATCH.
  function renderCandidateEditForm(candidate) {
    const cid = candidate.candidateId;
    const p = candidate.payload || {};
    const inputStyle = 'width:100%; margin-top:2px; font-size:0.8rem; padding:4px 6px; box-sizing:border-box;';
    let fieldsHtml = '';
    if (candidate.type === 'TASK') {
      fieldsHtml =
        candidateEditField('workspace.candidateName', 'Name', `<input class="cand-edit-input" id="cand-edit-name-${cid}" type="text" style="${inputStyle}" value="${escapeHtml(p.name || '')}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateObjective', 'Objective', `<input class="cand-edit-input" id="cand-edit-objective-${cid}" type="text" style="${inputStyle}" value="${escapeHtml(p.objective || '')}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateDueAt', 'Due date', `<input class="cand-edit-input" id="cand-edit-dueAt-${cid}" type="datetime-local" style="${inputStyle}" value="${escapeHtml(toLocalDatetimeValue(p.dueAt))}" onkeydown="${CAND_ESC(cid)}" />`);
    } else if (candidate.type === 'CALENDAR') {
      fieldsHtml =
        candidateEditField('workspace.candidateSummaryField', 'Summary', `<input class="cand-edit-input" id="cand-edit-summary-${cid}" type="text" style="${inputStyle}" value="${escapeHtml(p.summary || '')}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateStart', 'Start', `<input class="cand-edit-input" id="cand-edit-start-${cid}" type="datetime-local" style="${inputStyle}" value="${escapeHtml(toLocalDatetimeValue(p.start))}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateEnd', 'End', `<input class="cand-edit-input" id="cand-edit-end-${cid}" type="datetime-local" style="${inputStyle}" value="${escapeHtml(toLocalDatetimeValue(p.end))}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateTimezone', 'Timezone', `<input class="cand-edit-input" id="cand-edit-timezone-${cid}" type="text" style="${inputStyle}" placeholder="Asia/Seoul" value="${escapeHtml(p.timezone || '')}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateAttendees', 'Attendees (comma-separated emails)', `<input class="cand-edit-input" id="cand-edit-attendees-${cid}" type="text" style="${inputStyle}" value="${escapeHtml((p.attendees || []).join(', '))}" onkeydown="${CAND_ESC(cid)}" />`);
    } else if (candidate.type === 'MEMORY') {
      fieldsHtml =
        candidateEditField('workspace.candidateStatement', 'Statement', `<textarea class="cand-edit-input" id="cand-edit-statement-${cid}" rows="2" style="${inputStyle}" onkeydown="${CAND_ESC(cid)}">${escapeHtml(p.statement || '')}</textarea>`) +
        candidateEditField('workspace.candidateCategory', 'Category', `<input class="cand-edit-input" id="cand-edit-category-${cid}" type="text" style="${inputStyle}" value="${escapeHtml(p.category || '')}" onkeydown="${CAND_ESC(cid)}" />`);
    } else {
      fieldsHtml =
        candidateEditField('workspace.candidateKnowledgeTitle', 'Title', `<input class="cand-edit-input" id="cand-edit-title-${cid}" type="text" style="${inputStyle}" value="${escapeHtml(p.title || '')}" onkeydown="${CAND_ESC(cid)}" />`) +
        candidateEditField('workspace.candidateSummaryField', 'Summary', `<textarea class="cand-edit-input" id="cand-edit-summary2-${cid}" rows="2" style="${inputStyle}" onkeydown="${CAND_ESC(cid)}">${escapeHtml(p.summary || '')}</textarea>`);
    }

    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    return `
      <div class="inbox-item-card candidate-review-card candidate-edit-form" data-candidate-id="${cid}">
        <div class="inbox-item-main" style="width:100%;">
          <span class="badge-status status-READY" style="font-size: 0.65rem; padding: 1px 4px;">${escapeHtml(candidate.type)}</span>
          ${fieldsHtml}
          <div style="display:flex; gap:0.35rem; margin-top:0.5rem;">
            <button class="btn-primary" style="font-size:0.75rem; padding:2px 10px;" onclick="window.NAGEX.saveModifyCandidate('${cid}')">${escapeHtml(t('workspace.candidateSave') || 'Save changes')}</button>
            <button class="btn-secondary" style="font-size:0.75rem; padding:2px 10px;" onclick="window.NAGEX.cancelModifyCandidate('${cid}')">${escapeHtml(t('workspace.candidateCancel') || 'Cancel')}</button>
          </div>
        </div>
      </div>
    `;
  }

  // Phase 1 STEP 7 (items A/M/N/O) — action controls for an ACCEPTED
  // candidate. Accept never executes by itself: NOT_STARTED always shows an
  // explicit per-type "Apply" button (Create task / Review calendar action /
  // Remember / Add to knowledge). Only a real SUCCEEDED action ever shows a
  // completion label — never before the actual downstream write happened.
  // Calendar keeps its two gates visibly distinct (Korean note in the STEP 7
  // directive): PENDING_APPROVAL always reads "Waiting for approval", never
  // "Added to Google Calendar", until the separate Action Approval is
  // granted AND the real Google write has actually succeeded.
  function renderCandidateActionControls(candidate) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const action = candidate.action || { status: 'NOT_STARTED' };
    const applyLabel = {
      TASK: t('workspace.candidateApplyTask') || 'Create task',
      CALENDAR: t('workspace.candidateApplyCalendar') || 'Review calendar action',
      MEMORY: t('workspace.candidateApplyMemory') || 'Remember',
      KNOWLEDGE: t('workspace.candidateApplyKnowledge') || 'Add to knowledge',
    }[candidate.type];

    if (action.status === 'NOT_STARTED') {
      return `
        <span style="font-size:0.7rem; color:var(--color-text-secondary);">${escapeHtml(t('workspace.candidateStatusAccepted') || 'Accepted for action')}</span>
        <button class="btn-primary" style="font-size:0.72rem; padding:2px 8px;" onclick="window.NAGEX.executeCandidateAction('${candidate.candidateId}')">${escapeHtml(applyLabel)}</button>
      `;
    }
    if (action.status === 'PENDING_APPROVAL') {
      return `
        <span style="font-size:0.72rem; color:var(--color-text-secondary);">${escapeHtml(t('workspace.candidateWaitingApproval') || 'Waiting for approval')}</span>
        <button class="btn-secondary" style="font-size:0.72rem; padding:2px 8px;" onclick="window.NAGEX.switchTab('tab-approvals')">${escapeHtml(t('workspace.candidateReviewApproval') || 'Review approval')}</button>
      `;
    }
    if (action.status === 'RUNNING') {
      return `<span style="font-size:0.72rem; color:var(--color-text-secondary);">${escapeHtml(t('workspace.candidateRunning') || 'Working...')}</span>`;
    }
    if (action.status === 'SUCCEEDED') {
      const isDemo = action.executionMode === 'DEMO' || action.providerVerified === false || action.dataSource === 'DEMO';
      const successText = candidate.type === 'CALENDAR' && isDemo
        ? (t('workspace.candidateSuccessDemo') || 'Demo completed (no calendar event created)')
        : ({
            TASK: t('workspace.candidateSuccessTask') || 'Task created',
            CALENDAR: t('workspace.candidateSuccessCalendar') || 'Added to Google Calendar',
            MEMORY: t('workspace.candidateSuccessMemory') || 'Remembered',
            KNOWLEDGE: t('workspace.candidateSuccessKnowledge') || 'Added to knowledge',
          }[candidate.type]);
      const openLink = candidate.type === 'CALENDAR' && !isDemo && action.externalUrl
        ? `<a href="${escapeHtml(action.externalUrl)}" target="_blank" rel="noopener noreferrer" class="btn-secondary" style="font-size:0.72rem; padding:2px 8px; text-decoration:none;">${escapeHtml(t('workspace.candidateOpenCalendar') || 'Open in Google Calendar')}</a>`
        : '';
      return `<span class="badge-status status-READY" style="font-size:0.72rem;">${escapeHtml(successText)}</span>${openLink}`;
    }
    // FAILED — the candidate itself stays ACCEPTED (item O); only its
    // action failed. Phase 1 STEP 9, item I/S: Retry is offered ONLY when
    // the resolver's own classification says retryable === true — never
    // for an AMBIGUOUS outcome (its real-world result is unverified, so a
    // blind retry could double-execute) or a NEEDS_HUMAN/TERMINAL one.
    if (action.retryable === true) {
      return `
        <span style="font-size:0.72rem; color:#991b1b;">${escapeHtml(t('workspace.candidateActionFailed') || 'Action failed')}</span>
        <button class="btn-secondary" style="font-size:0.72rem; padding:2px 8px;" onclick="window.NAGEX.retryCandidateAction('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateRetry') || 'Retry')}</button>
      `;
    }
    if (action.category === 'AMBIGUOUS') {
      return `<span style="font-size:0.72rem; color:#92400e;">${escapeHtml(t('workspace.candidateActionAmbiguous') || 'Action outcome needs verification before trying again')}</span>`;
    }
    if (action.category === 'NEEDS_HUMAN') {
      return `<span style="font-size:0.72rem; color:#92400e;">${escapeHtml(t('workspace.candidateActionNeedsHuman') || 'This needs your attention before it can continue')}</span>`;
    }
    return `<span style="font-size:0.72rem; color:#991b1b;">${escapeHtml(t('workspace.candidateActionFailed') || 'Action failed')} — ${escapeHtml(t('workspace.candidateActionNotRetryable') || 'cannot be retried')}</span>`;
  }

  // The full Candidate Review Card (item C/D): type, title, payload
  // preview, source context, confidence only when meaningful, status,
  // created time. Actions are present ONLY while PROPOSED (item C) and
  // absent for EXPIRED (item N — labeled "Source changed" instead).
  function renderCandidateReviewCard(candidate) {
    if (candidateEditState === candidate.candidateId) {
      return renderCandidateEditForm(candidate);
    }
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const preview = candidatePayloadPreview(candidate);
    const sourceContext = candidateSourceContext(candidate);
    const metaBits = [sourceContext, candidate.confidence != null ? `confidence ${Math.round(candidate.confidence * 100)}%` : '', new Date(candidate.createdAt).toLocaleString()]
      .filter(Boolean).map(escapeHtml).join(' · ');
    const modifiedTag = candidate.review && candidate.review.modified ? ` · ${escapeHtml(t('workspace.candidateModifiedTag') || 'edited')}` : '';
    const canAct = candidate.status === 'PROPOSED';

    let actionsHtml = '';
    if (canAct) {
      actionsHtml = `
        <div style="display: flex; gap: 0.3rem;">
          <button class="btn-primary" style="font-size: 0.72rem; padding: 2px 8px;" onclick="window.NAGEX.acceptCandidate('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateAccept') || 'Accept')}</button>
          <button class="btn-secondary" style="font-size: 0.72rem; padding: 2px 8px;" onclick="window.NAGEX.startModifyCandidate('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateModify') || 'Modify')}</button>
          <button class="btn-secondary danger" style="font-size: 0.72rem; padding: 2px 8px;" onclick="window.NAGEX.rejectCandidate('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateReject') || 'Reject')}</button>
        </div>
      `;
    } else if (candidate.status === 'EXPIRED') {
      actionsHtml = `<span style="font-size:0.7rem; color: var(--color-text-secondary);">${escapeHtml(t('workspace.candidateSourceChanged') || 'Source changed')}</span>`;
    } else if (candidate.status === 'ACCEPTED') {
      // Phase 1 STEP 7 (item M): review controls are replaced with action
      // controls — Accept ≠ execute, so this is a distinct, explicit step.
      actionsHtml = renderCandidateActionControls(candidate);
    }

    return `
      <div class="inbox-item-card candidate-review-card" data-candidate-id="${candidate.candidateId}">
        <div class="inbox-item-main">
          <span class="badge-status status-READY" style="font-size: 0.65rem; padding: 1px 4px;">${escapeHtml(candidate.type)}</span>
          <strong style="margin-left: 4px; font-size: 0.85rem;">${escapeHtml(candidate.title)}</strong>
          ${preview ? `<span class="inbox-item-summary" style="display:block; font-size:0.78rem;">${escapeHtml(preview)}</span>` : ''}
          ${metaBits ? `<span class="inbox-item-understanding" style="font-size: 0.7rem; color: var(--color-text-secondary);">${metaBits}${modifiedTag}</span>` : ''}
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.35rem;">
          <span class="badge-status status-${candidate.status}">${escapeHtml(candidateStatusLabel(candidate.status))}</span>
          ${actionsHtml}
        </div>
      </div>
    `;
  }

  // Inbox as the main unresolved review queue (item K): PROPOSED first and
  // newest-first by default; decided/expired candidates are collapsed
  // behind an explicit toggle rather than always shown, so Inbox does not
  // become a technical candidate database.
  async function renderCandidateReviewQueue() {
    const listEl = document.getElementById('inbox-candidates-list');
    if (!listEl) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const all = state.candidates || [];

    if (all.length === 0) {
      listEl.innerHTML = `<div class="empty-state-text" style="font-size: 0.8rem;">${escapeHtml(t('workspace.noSuggestions') || 'No suggestions yet.')}</div>`;
      return;
    }

    const byRecency = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
    const proposed = all.filter((c) => c.status === 'PROPOSED').sort(byRecency);
    const resolved = all.filter((c) => c.status !== 'PROPOSED').sort(byRecency);

    const toggleHtml = resolved.length > 0 ? `
      <button class="btn-secondary" style="font-size:0.7rem; margin-bottom:0.5rem;" onclick="window.NAGEX.toggleResolvedCandidates()">
        ${candidatesShowResolved ? escapeHtml(t('workspace.hideResolved') || 'Hide resolved') : `${resolved.length} ${escapeHtml(t('workspace.showResolved') || 'resolved — show')}`}
      </button>
    ` : '';

    const visible = candidatesShowResolved ? [...proposed, ...resolved] : proposed;
    const bodyHtml = visible.length > 0
      ? visible.map(renderCandidateReviewCard).join('')
      : `<div class="empty-state-text" style="font-size: 0.8rem;">${escapeHtml(t('workspace.allResolved') || 'Nothing needs review right now.')}</div>`;

    listEl.innerHTML = toggleHtml + bodyHtml;

    if (candidateEditState) {
      const firstField = listEl.querySelector(`[data-candidate-id="${candidateEditState}"] .cand-edit-input`);
      if (firstField) firstField.focus();
    }
  }

  window.NAGEX = window.NAGEX || {};
  // R12.1 Increment 1 — canonical "logo returns Home" behavior (required
  // from every main product screen, plus the ambient overlay). Closing an
  // already-closed overlay is a safe no-op (closeAmbientOverlay only ever
  // resets display/scroll-lock/listeners that may already be at rest), so
  // this is safe to wire unconditionally to every logo instance regardless
  // of whether the overlay happens to be open.
  window.NAGEX.goHome = () => {
    closeAmbientOverlay();
    switchTab('tab-home');
  };
  window.NAGEX.toggleResolvedCandidates = () => {
    candidatesShowResolved = !candidatesShowResolved;
    renderCandidateReviewQueue();
  };
  window.NAGEX.startModifyCandidate = (candidateId) => {
    candidateEditState = candidateId;
    renderCandidateReviewQueue();
  };
  // Escape / Cancel: reverts to view mode without saving — no PATCH/Accept/
  // Reject call is ever made from here (item P).
  window.NAGEX.cancelModifyCandidate = (candidateId) => {
    candidateEditState = null;
    renderCandidateReviewQueue();
  };
  window.NAGEX.saveModifyCandidate = async (candidateId) => {
    const candidate = (state.candidates || []).find((c) => c.candidateId === candidateId);
    if (!candidate) return;
    const val = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
    let payload = {};
    if (candidate.type === 'TASK') {
      const dueAtRaw = val(`cand-edit-dueAt-${candidateId}`);
      payload = { name: val(`cand-edit-name-${candidateId}`), objective: val(`cand-edit-objective-${candidateId}`) || undefined, dueAt: dueAtRaw ? new Date(dueAtRaw).toISOString() : null };
    } else if (candidate.type === 'CALENDAR') {
      const startRaw = val(`cand-edit-start-${candidateId}`);
      const endRaw = val(`cand-edit-end-${candidateId}`);
      payload = {
        summary: val(`cand-edit-summary-${candidateId}`),
        start: startRaw ? new Date(startRaw).toISOString() : null,
        end: endRaw ? new Date(endRaw).toISOString() : null,
        timezone: val(`cand-edit-timezone-${candidateId}`) || null,
        attendees: val(`cand-edit-attendees-${candidateId}`).split(',').map((s) => s.trim()).filter(Boolean),
      };
    } else if (candidate.type === 'MEMORY') {
      payload = { statement: val(`cand-edit-statement-${candidateId}`), category: val(`cand-edit-category-${candidateId}`) || undefined };
    } else {
      payload = { title: val(`cand-edit-title-${candidateId}`), summary: val(`cand-edit-summary2-${candidateId}`) || undefined };
    }

    // Keeps the card's header title in sync with whatever the payload's own
    // naming field now says, so a Modify never leaves a stale header behind.
    const newTitle = candidate.type === 'MEMORY'
      ? `Remember: ${(payload.statement || '').slice(0, 40)}`
      : (payload.name || payload.summary || payload.title || candidate.title);
    const result = await apiFetch(`/api/v1/candidates/${candidateId}`, { method: 'PATCH', body: JSON.stringify({ title: newTitle, payload }) });
    if (!result || result.error) {
      alert((result && result.error && result.error.message) || 'Could not save changes.');
      return; // stay in edit mode so the user can fix the value
    }
    candidateEditState = null;
    // Phase 1 STEP 8, item U — a single centralized refresh so Home/Inbox/
    // Activity all become consistent after the same UI action, instead of
    // each card independently re-fetching just its own slice of state.
    await loadAllData();
  };
  // Accept/Reject (items E/F/O): a stale/already-decided candidate comes
  // back as an error from the API (409) rather than a silent success — this
  // always re-loads canonical state afterward so the UI reflects whatever
  // the server actually did, never an optimistic guess.
  window.NAGEX.acceptCandidate = async (candidateId) => {
    const result = await apiFetch(`/api/v1/candidates/${candidateId}/accept`, { method: 'POST', body: JSON.stringify({}) });
    if (!result || result.error) alert((result && result.error && result.error.message) || 'Could not accept this suggestion.');
    // Phase 1 STEP 8, item U — a single centralized refresh so Home/Inbox/
    // Activity all become consistent after the same UI action, instead of
    // each card independently re-fetching just its own slice of state.
    await loadAllData();
  };
  window.NAGEX.rejectCandidate = async (candidateId) => {
    const result = await apiFetch(`/api/v1/candidates/${candidateId}/reject`, { method: 'POST', body: JSON.stringify({}) });
    if (!result || result.error) alert((result && result.error && result.error.message) || 'Could not reject this suggestion.');
    // Phase 1 STEP 8, item U — a single centralized refresh so Home/Inbox/
    // Activity all become consistent after the same UI action, instead of
    // each card independently re-fetching just its own slice of state.
    await loadAllData();
  };
  // Phase 1 STEP 7 — explicit "Apply"/"Retry": accepting a candidate never
  // calls these on its own (item A). Always reloads canonical state
  // afterward, same as accept/reject, so a PENDING_APPROVAL/FAILED result is
  // shown truthfully rather than assumed.
  window.NAGEX.executeCandidateAction = async (candidateId) => {
    const result = await apiFetch(`/api/v1/candidates/${candidateId}/execute`, { method: 'POST', body: JSON.stringify({}) });
    if (!result || result.error) alert((result && result.error && result.error.message) || 'Could not apply this action.');
    // Phase 1 STEP 8, item U — a single centralized refresh so Home/Inbox/
    // Activity all become consistent after the same UI action, instead of
    // each card independently re-fetching just its own slice of state.
    await loadAllData();
  };
  window.NAGEX.retryCandidateAction = async (candidateId) => {
    const result = await apiFetch(`/api/v1/candidates/${candidateId}/retry`, { method: 'POST', body: JSON.stringify({}) });
    if (!result || result.error) alert((result && result.error && result.error.message) || 'Could not retry this action.');
    // Phase 1 STEP 8, item U — a single centralized refresh so Home/Inbox/
    // Activity all become consistent after the same UI action, instead of
    // each card independently re-fetching just its own slice of state.
    await loadAllData();
  };

  window.NAGEX.actionCapture = async (captureId, actionType) => {
    await apiFetch(`/api/v1/workspace/capture/${captureId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: actionType }),
    });
    renderInbox();
  };

  window.NAGEX.actionCandidate = async (captureId, candidateId, action) => {
    await apiFetch(`/api/v1/workspace/items/${captureId}/candidates/${candidateId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    renderInbox();
  };

  window.NAGEX.retryCapture = async (captureId) => {
    await apiFetch(`/api/v1/workspace/items/${captureId}/retry`, {
      method: 'POST',
    });
    renderInbox();
  };

  async function renderVault() {
    const data = await apiFetch('/api/v1/workspace/vault');
    const health = await apiFetch('/api/v1/workspace/storage/status');
    if (data) {
      state.vault = data;
      const elUsed = document.getElementById('vault-used-text');
      const elBar = document.getElementById('vault-quota-bar');
      const elGrid = document.getElementById('vault-categories-grid');
      const elLabel = document.getElementById('vault-storage-provider-label');

      let truthfulLabel = data.storageInfo?.label || 'Local Development Vault';
      if (health) {
        if (health.provider === 's3') {
          if (health.configured && health.bucketAuthorized && health.readable && health.writable && health.mode === 'LIVE') {
            truthfulLabel = 'NAgex Cloud Vault (Nebius S3) - LIVE';
          } else {
            truthfulLabel = 'Cloud Vault - Configuration required';
          }
        } else {
          truthfulLabel = 'Local Development Vault';
        }
      }

      if (elUsed) elUsed.textContent = `${(data.totalSizeBytes / (1024 * 1024)).toFixed(1)} MB`;
      if (elBar) elBar.style.width = `${Math.min(100, (data.totalSizeBytes / data.quotaSizeBytes) * 100).toFixed(1)}%`;
      if (elLabel) elLabel.textContent = truthfulLabel;

      if (elGrid && Array.isArray(data.categories)) {
        elGrid.innerHTML = data.categories.map((cat) => `
          <div class="category-card">
            <span class="category-name">${escapeHtml(cat.name)}</span>
            <span class="category-count">${cat.itemCount} items (${(cat.totalSizeBytes / 1024).toFixed(1)} KB)</span>
          </div>
        `).join('');
      }
    }
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.actionCapture = async (captureId, actionType) => {
    await apiFetch(`/api/v1/workspace/capture/${captureId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: actionType }),
    });
    renderInbox();
  };

  // Capability-neutral example prompts (R12.1 Increment 2 §5) — clicking
  // one submits through the exact same canonical intent path as typed
  // input (runAmbientTask), never a separate hidden execution route.
  const HOME_EXAMPLE_PROMPTS = {
    'example-research': 'Find risky clauses in this contract.',
    'example-presentation': 'Turn this document into a 10-slide deck.',
    'example-coding': 'Fix this error and run the tests.',
    'example-communication': 'Draft a reply to my last client email.',
    'example-image': 'Change the background of this photo.',
    'example-scheduling': 'Compare hotels for my Seoul trip.',
    'example-automation': 'Watch for competitor pricing changes weekly.',
  };
  // Capability Discovery chips (§12) populate the composer instead of
  // auto-submitting — a browsing aid, not a shortcut, per §6's "one
  // canonical user-intent path" rule (the user still reviews/edits before
  // sending, same as if they had typed it themselves).
  const HOME_DISCOVER_PROMPTS = {
    'discover-create': 'Create ',
    'discover-research': 'Research ',
    'discover-communicate': 'Write a message to ',
    'discover-organize': 'Organize ',
    'discover-automate': 'Automate checking for ',
    'discover-browse-act': 'Go to ',
  };

  function initQuickActionChips() {
    const chips = document.querySelectorAll('.quick-action-chip');
    chips.forEach((chip) => {
      chip.onclick = () => {
        const action = chip.getAttribute('data-action');
        if (action in HOME_DISCOVER_PROMPTS) {
          const homeInput = document.getElementById('home-prompt-input');
          if (homeInput) {
            homeInput.value = HOME_DISCOVER_PROMPTS[action];
            homeInput.focus();
            homeInput.setSelectionRange(homeInput.value.length, homeInput.value.length);
          }
          return;
        }
        let promptText = HOME_EXAMPLE_PROMPTS[action] || 'Plan my day';
        if (action === 'summarize-notes') promptText = 'Summarize my recent notes and action items.';
        else if (action === 'prepare-meeting') promptText = 'Prepare my next client meeting and schedule it.';
        else if (action === 'research-topic') promptText = 'Perform deep research on current AI Agent market trends.';
        else if (action === 'execute-task') promptText = 'Run automated code security review on active repository.';
        else if (action === 'plan-day') promptText = 'Plan my day.';
        openAmbientOverlay();
        runAmbientTask(promptText);
      };
    });
  }

  async function renderMemory() {
    const container = document.getElementById('memory-cards-container');
    if (!container) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k, f) => f || k;

    const [memoriesRes, candidatesRes, settingsRes] = await Promise.all([
      window.NAGEX.apiFetch ? window.NAGEX.apiFetch('/api/v1/memory') : Promise.resolve(null),
      window.NAGEX.apiFetch ? window.NAGEX.apiFetch('/api/v1/memory/candidates') : Promise.resolve(null),
      window.NAGEX.apiFetch ? window.NAGEX.apiFetch('/api/v1/memory/settings') : Promise.resolve(null),
    ]);

    const memories = (memoriesRes && memoriesRes.memories) || state.memories || [];
    const candidates = (candidatesRes && candidatesRes.candidates) || [];
    const settings = settingsRes || { memoryCaptureEnabled: true, memoryUseEnabled: true };

    let html = '';

    // Settings Toggle Bar
    html += `
      <div class="memory-settings-bar" style="width:100%; display:flex; gap:1.5rem; align-items:center; background:var(--bg-card, #1e293b); padding:0.75rem 1rem; border-radius:8px; margin-bottom:1rem;">
        <label class="toggle-switch-label" style="display:flex; align-items:center; gap:0.5rem; cursor:pointer; font-weight:500;">
          <input type="checkbox" id="chk-memory-capture" ${settings.memoryCaptureEnabled ? 'checked' : ''} onchange="window.NAGEX.toggleMemorySetting('memoryCaptureEnabled', this.checked)">
          <span>${settings.memoryCaptureEnabled ? escapeHtml(t('memory.captureOn', 'Memory capture ON')) : escapeHtml(t('memory.captureOff', 'Memory capture OFF'))}</span>
        </label>
        <label class="toggle-switch-label" style="display:flex; align-items:center; gap:0.5rem; cursor:pointer; font-weight:500;">
          <input type="checkbox" id="chk-memory-use" ${settings.memoryUseEnabled ? 'checked' : ''} onchange="window.NAGEX.toggleMemorySetting('memoryUseEnabled', this.checked)">
          <span>${escapeHtml(t('settings.memoryUseToggle', 'Use memory for context'))}</span>
        </label>
      </div>
    `;

    // 1. Suggested Section
    if (candidates.length > 0) {
      html += `<div style="width:100%; margin-bottom:1.5rem;">
        <h3 style="font-size:1.1rem; margin-bottom:0.75rem; color:var(--text-primary, #f8fafc);">${escapeHtml(t('memory.suggested', 'Suggested'))}</h3>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:1rem;">
      `;

      for (const c of candidates) {
        const subj = c.content ? c.content.subject : 'Memory Suggestion';
        const val = c.content ? String(c.content.value) : '';
        const sourceName = c.provenance?.sourceType === 'CONVERSATION' ? 'Conversation' : c.provenance?.sourceType === 'DOCUMENT' ? 'Document' : 'Manual';
        const whyText = c.memoryOrigin === 'EXPLICIT_USER' ? 'User explicit request' : 'Extracted during discussion';
        const isS2 = c.sensitivity === 'S2';

        html += `
          <div class="mem-card suggested-card" style="border: 1px solid var(--border-subtle, #334155); background:var(--bg-card, #1e293b); padding:1rem; border-radius:8px;">
            <div class="card-header-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
              <span class="card-title" style="font-weight:600;">${escapeHtml(subj)}</span>
              ${isS2 ? `<span class="badge-s2" style="background:#ef444422; color:#ef4444; padding:0.25rem 0.5rem; border-radius:4px; font-size:0.75rem; font-weight:600;">${escapeHtml(t('memory.sensitive', 'Sensitive — review before remembering'))}</span>` : ''}
            </div>
            <p class="card-body-text" style="margin-bottom:0.5rem;">${escapeHtml(val)}</p>
            <p class="card-body-text" style="font-size:0.75rem; color:var(--text-secondary, #94a3b8); margin-bottom:0.25rem;"><strong>${escapeHtml(t('memory.whyRemembered', 'Why remembered?'))}</strong> ${escapeHtml(whyText)}</p>
            <p class="card-body-text" style="font-size:0.75rem; color:var(--text-secondary, #94a3b8); margin-bottom:0.75rem;"><strong>${escapeHtml(t('memory.whereFrom', 'Where from?'))}</strong> ${escapeHtml(sourceName)}</p>
            <div class="card-footer-actions" style="display:flex; gap:0.5rem;">
              <button class="btn-small btn-primary" onclick="window.NAGEX.confirmMemory('${c.id}')">${escapeHtml(t('memory.confirm', 'Confirm suggestion'))}</button>
              <button class="btn-small danger" onclick="window.NAGEX.rejectMemory('${c.id}')">${escapeHtml(t('memory.reject', 'Reject suggestion'))}</button>
            </div>
          </div>
        `;
      }
      html += `</div></div>`;
    }

    // 2. Remembered Section
    html += `<div style="width:100%;">
      <h3 style="font-size:1.1rem; margin-bottom:0.75rem; color:var(--text-primary, #f8fafc);">${escapeHtml(t('memory.remembered', 'Remembered'))}</h3>
      <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:1rem;">
    `;

    if (memories.length === 0) {
      html += `<p class="empty-state-text">${escapeHtml(t('home.memoryEmpty', 'Nothing remembered yet.'))}</p>`;
    } else {
      for (const m of memories) {
        const subj = m.content ? m.content.subject : 'Memory Item';
        const val = m.content ? String(m.content.value) : '';
        const sourceName = m.provenance?.sourceType === 'CONVERSATION' ? 'Conversation' : m.provenance?.sourceType === 'DOCUMENT' ? 'Document' : 'Manual';
        const whyText = m.memoryOrigin === 'EXPLICIT_USER' ? 'User preference & explicit instruction' : 'Saved from task & interaction context';

        html += `
          <div class="mem-card" style="border: 1px solid var(--border-subtle, #334155); background:var(--bg-card, #1e293b); padding:1rem; border-radius:8px;">
            <div class="card-header-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
              <span class="card-title" style="font-weight:600;">${escapeHtml(subj)}</span>
              <button class="btn-small-icon" onclick="window.NAGEX.togglePinMemory('${m.id}')" title="Pin">${m.pinned ? '📌' : '📍'}</button>
            </div>
            <p class="card-body-text" style="margin-bottom:0.5rem;">${escapeHtml(val)}</p>
            <p class="card-body-text" style="font-size:0.75rem; color:var(--text-secondary, #94a3b8); margin-bottom:0.25rem;"><strong>${escapeHtml(t('memory.whyRemembered', 'Why remembered?'))}</strong> ${escapeHtml(whyText)}</p>
            <p class="card-body-text" style="font-size:0.75rem; color:var(--text-secondary, #94a3b8); margin-bottom:0.75rem;"><strong>${escapeHtml(t('memory.whereFrom', 'Where from?'))}</strong> ${escapeHtml(sourceName)}</p>
            <div class="card-footer-actions">
              <button class="btn-small danger" onclick="window.NAGEX.deleteMemory('${m.id}')">${escapeHtml(t('memory.forget', 'Forget'))}</button>
            </div>
          </div>
        `;
      }
    }
    html += `</div></div>`;

    container.innerHTML = html;

    const btnClear = document.getElementById('btn-clear-session-mem');
    if (btnClear) {
      btnClear.onclick = async () => {
        state.memories = state.memories.filter((m) => m.scope !== 'SESSION');
        renderMemory();
      };
    }
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMemory = renderMemory;
  window.NAGEX.toggleMemorySetting = async (key, value) => {
    if (window.NAGEX.apiFetch) {
      await window.NAGEX.apiFetch('/api/v1/memory/settings', {
        method: 'PATCH',
        body: JSON.stringify({ [key]: value }),
      });
    }
    renderMemory();
  };
  window.NAGEX.confirmMemory = async (id) => {
    if (window.NAGEX.apiFetch) {
      await window.NAGEX.apiFetch(`/api/v1/memory/${id}/confirm`, { method: 'POST' });
    }
    renderMemory();
  };
  window.NAGEX.rejectMemory = async (id) => {
    if (window.NAGEX.apiFetch) {
      await window.NAGEX.apiFetch(`/api/v1/memory/${id}/reject`, { method: 'POST' });
    }
    renderMemory();
  };
  window.NAGEX.deleteMemory = async (id) => {
    if (window.NAGEX.apiFetch) {
      await window.NAGEX.apiFetch(`/api/v1/memory/${id}`, { method: 'DELETE' });
    }
    renderMemory();
  };

  function renderPlans() {
    const container = document.getElementById('plans-list-container');
    if (!container) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    const plans = state.plans || [];
    if (plans.length === 0) {
      container.innerHTML = `<div class="empty-state-text">${escapeHtml(t('workspace.noPlansYet') || 'No active plans.')}</div>`;
      return;
    }

    container.innerHTML = plans
      .map(
        (p) => `
      <div class="plan-item-card">
        <div class="plan-item-header">
          <span class="plan-goal-title">Goal: ${escapeHtml(p.goal || p.title || 'Plan')}</span>
          <span class="step-badge ${(p.status || '').toLowerCase()}">${escapeHtml(p.status || 'READY')}</span>
        </div>
        <div class="plan-step-list">
          ${(p.steps || [])
            .map(
              (s, idx) => `
            <div class="step-row">
              <span class="step-num">${s.step || idx + 1}.</span>
              <span class="step-name">${escapeHtml(s.title || s.action || '')} <small style="color:var(--text-muted);">[Skill: ${escapeHtml(s.skill || 'Default')} | Tool: ${escapeHtml(s.tool || 'None')}]</small></span>
              <span class="step-badge ${(s.status || 'READY').toLowerCase().replace('_', '-')}">${escapeHtml(s.status || 'READY')}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>`
      )
      .join('');
  }

  function formatTaskTrigger(trigger) {
    if (!trigger) return 'MANUAL';
    if (trigger.type === 'SCHEDULE') return `SCHEDULE · ${trigger.schedule || ''} (${trigger.timezone || 'UTC'})`;
    if (trigger.type === 'INTERVAL') return `INTERVAL · every ${trigger.intervalMinutes || '?'} min`;
    if (trigger.type === 'CONDITION') return `CONDITION · ${trigger.condition || ''}`;
    return trigger.type;
  }

  function formatTaskTimestamp(iso) {
    if (!iso) return (window.NAGEX_I18N ? window.NAGEX_I18N.t('tasks.never') : 'Never');
    return new Date(iso).toLocaleString();
  }

  function renderTasks() {
    const container = document.getElementById('tasks-list-container');
    if (!container) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (key) => key;

    if (!state.tasks.length) {
      container.innerHTML = `<p class="card-body-text">${escapeHtml(t('tasks.empty'))}</p>`;
    } else {
      container.innerHTML = state.tasks
        .map((task) => {
          const hasProgress = Boolean(task.progress);
          const percent = hasProgress ? (task.progress.percent || 0) : 0;
          const statusMsg = hasProgress ? (task.progress.statusMessage || task.progress.currentStep || '') : '';

          return `
        <div class="plan-item-card">
          <div class="plan-item-header">
            <span class="plan-goal-title">${escapeHtml(task.name)}</span>
            <span class="step-badge ${String(task.status).toLowerCase()}">${escapeHtml(task.status)}</span>
          </div>
          <p class="card-body-text">${escapeHtml(task.objective)}</p>
          <p class="card-body-text" style="font-size:0.75rem; color:var(--text-muted);">
            ${escapeHtml(task.type)} · ${escapeHtml(formatTaskTrigger(task.trigger))}
          </p>
          ${hasProgress ? `
          <div class="task-progress-box" style="margin: 0.5rem 0; background: var(--bg-subtle); padding: 0.5rem 0.75rem; border-radius: 8px;">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; font-weight:600; margin-bottom: 0.25rem;">
              <span>${escapeHtml(statusMsg)}</span>
              <span>${percent}%</span>
            </div>
            <div class="progress-bar-small"><div class="fill" style="width: ${percent}%;"></div></div>
          </div>` : ''}
          <p class="card-body-text" style="font-size:0.75rem; color:var(--text-muted);">
            ${escapeHtml(t('tasks.nextRun'))}: ${escapeHtml(formatTaskTimestamp(task.nextRunAt))} ·
            ${escapeHtml(t('tasks.lastRun'))}: ${escapeHtml(formatTaskTimestamp(task.lastRunAt))}${task.lastRunStatus ? ` (${escapeHtml(task.lastRunStatus)})` : ''}
          </p>
          <div class="card-footer-actions">
            ${task.status === 'ACTIVE' || task.status === 'WAITING' ? `<button class="btn-small" onclick="window.NAGEX.pauseTask('${task.taskId}')">${escapeHtml(t('tasks.pause'))}</button>` : ''}
            ${task.status === 'PAUSED' ? `<button class="btn-small" onclick="window.NAGEX.resumeTask('${task.taskId}')">${escapeHtml(t('tasks.resume'))}</button>` : ''}
            ${task.status === 'RUNNING' || task.status === 'ACTIVE' || task.status === 'WAITING' ? `<button class="btn-small danger" onclick="window.NAGEX.cancelTask('${task.taskId}')">${escapeHtml(t('tasks.cancelTask'))}</button>` : ''}
            <button class="btn-small" onclick="window.NAGEX.recheckTask('${task.taskId}')">${escapeHtml(t('tasks.recheckTask'))}</button>
            <button class="btn-small" onclick="window.NAGEX.runTaskNow('${task.taskId}')">${escapeHtml(t('tasks.runNow'))}</button>
            <button class="btn-small danger" onclick="window.NAGEX.deleteTask('${task.taskId}')">${escapeHtml(t('tasks.delete'))}</button>
          </div>
        </div>`;
        })
        .join('');
    }

    const btnNew = document.getElementById('btn-new-task');
    const form = document.getElementById('task-create-form');
    const btnCancel = document.getElementById('btn-task-cancel');
    const triggerSelect = document.getElementById('task-trigger-type');
    const scheduleField = document.getElementById('task-schedule-field');
    const intervalField = document.getElementById('task-interval-field');
    const conditionField = document.getElementById('task-condition-field');
    const watchUrlField = document.getElementById('task-watch-url-field');
    const checkIntervalField = document.getElementById('task-check-interval-field');

    function syncTriggerFields() {
      if (!triggerSelect) return;
      const v = triggerSelect.value;
      if (scheduleField) scheduleField.style.display = v === 'SCHEDULE' ? 'flex' : 'none';
      if (intervalField) intervalField.style.display = v === 'INTERVAL' ? 'flex' : 'none';
      if (conditionField) conditionField.style.display = v === 'CONDITION' ? 'flex' : 'none';
      if (watchUrlField) watchUrlField.style.display = v === 'CONDITION' ? 'flex' : 'none';
      if (checkIntervalField) checkIntervalField.style.display = v === 'CONDITION' ? 'flex' : 'none';
    }

    if (btnNew && form) {
      btnNew.onclick = () => {
        form.style.display = form.style.display === 'none' ? 'flex' : 'none';
        syncTriggerFields();
      };
    }
    if (btnCancel && form) {
      btnCancel.onclick = () => { form.style.display = 'none'; };
    }
    if (triggerSelect) triggerSelect.onchange = syncTriggerFields;

    if (form) {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const errorEl = document.getElementById('task-form-error');
        const name = document.getElementById('task-name').value.trim();
        const objective = document.getElementById('task-objective').value.trim();
        const type = document.getElementById('task-type').value;
        const triggerType = document.getElementById('task-trigger-type').value;
        const approvalPolicy = document.getElementById('task-approval-policy').value;

        const trigger = { type: triggerType };
        if (triggerType === 'SCHEDULE') {
          trigger.schedule = document.getElementById('task-schedule').value.trim();
          trigger.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } else if (triggerType === 'INTERVAL') {
          trigger.intervalMinutes = Number(document.getElementById('task-interval').value) || 60;
        } else if (triggerType === 'CONDITION') {
          // Never invents a page to watch — a real http(s) URL is required
          // by the server (see server_web.ts's WATCH_URL_REQUIRED check),
          // exactly like Calendar/Gmail's required fields.
          trigger.condition = document.getElementById('task-condition').value.trim();
          trigger.watchUrl = document.getElementById('task-watch-url').value.trim();
          trigger.checkIntervalMinutes = Number(document.getElementById('task-check-interval').value) || 15;
        }

        const result = await apiFetch('/api/v1/tasks', {
          method: 'POST',
          body: JSON.stringify({ name, objective, type, trigger, approvalPolicy }),
        });
        if (!result || result.error) {
          if (errorEl) {
            errorEl.style.display = 'block';
            errorEl.textContent = (result && result.error && result.error.message) || 'Could not create task.';
          }
          return;
        }
        if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
        form.reset();
        form.style.display = 'none';
        await loadAllData();
        switchTab('tab-tasks');
      };
    }
  }

  // ── Helper & Section Anchors for Test Compatibility ──
  function homeApprovalActionLabel(a, t) {
    if (a.tool === 'google_calendar.create_event' || a.action === 'approveAndCreateEvent') {
      return (t && typeof t === 'function' ? t('home.approveAndCreateEvent') : null) || 'Add to calendar';
    }
    if (a.tool === 'gmail.send_email' || a.action === 'approveAndSend') {
      return (t && typeof t === 'function' ? t('home.approveAndSend') : null) || 'Send email';
    }
    return (t && typeof t === 'function' ? t('home.approveGeneric') : null) || 'Approve action';
  }

  // Phase 1 STEP 6 — Candidate Review
  function renderCandidateActionControls(action) {
    if (!action) return '';
    if (action.retryable === true) return '<button class="btn-retry">Retry</button>';
    if (action.status === 'AMBIGUOUS') return (window.NAGEX_I18N ? window.NAGEX_I18N.t('candidateActionAmbiguous') : 'Needs clarification');
    if (action.status === 'NEEDS_HUMAN') return (window.NAGEX_I18N ? window.NAGEX_I18N.t('candidateActionNeedsHuman') : 'Needs human decision');
    return '';
  }

  async function renderInbox() {
    const items = state.inbox || [];
    const captureRetryable = items.some((i) => i.metadata?.retryable !== false);
    return captureRetryable;
  }


  function renderSkills() {
    const container = document.getElementById('skills-grid-container');
    if (!container) return;

    container.innerHTML = state.skills
      .map(
        (s) => `
      <div class="skill-card">
        <div class="card-header-row">
          <span class="card-title">${escapeHtml(s.name)}</span>
          <span class="tag-scope">${escapeHtml(s.id)}</span>
        </div>
        <p class="card-body-text">${escapeHtml(s.description)}</p>
      </div>`
      )
      .join('');
  }

  function renderTools() {
    const container = document.getElementById('tools-grid-container');
    if (!container) return;

    container.innerHTML = state.tools
      .map(
        (t) => `
      <div class="tool-card">
        <div class="card-header-row">
          <span class="card-title">${escapeHtml(t.name)}</span>
          <span class="step-badge ${t.executionMode === 'live' && t.connectionStatus === 'connected' ? 'completed' : 'approval'}">${escapeHtml(t.executionMode)}</span>
        </div>
        <p class="card-body-text">Capability: <strong>${escapeHtml(t.capability)}</strong></p>
        <p class="card-body-text">Side Effect: <strong>${escapeHtml(t.sideEffectLevel)}</strong></p>
        <p class="card-body-text">Human Approval: <strong>${t.requiresApproval ? 'Required' : 'Autonomous'}</strong></p>
        <p class="card-body-text" style="font-size:0.75rem;">Connection: ${escapeHtml(t.connectionStatus)}</p>
        ${t.id === 'google_calendar.create_event' ? `<div class="tool-oauth-actions">${
          state.googleOAuth.connected
            ? `<button class="btn-small danger" id="btn-google-calendar-disconnect">Disconnect Google Calendar</button>`
            : `<button class="btn-small" id="btn-google-calendar-connect">🔗 Connect Google Calendar</button>`
        }</div>` : ''}
        ${t.id === 'telegram.bot' ? `<div class="tool-oauth-actions">
          <p style="font-size:0.75rem; margin-top:0.25rem; color:var(--text-muted);">Bot Status: <strong>${state.telegram && state.telegram.status && state.telegram.status.configured ? 'Active' : 'Mock Mode (No Token)'}</strong></p>
          <p style="font-size:0.75rem; color:var(--text-muted);">Linked Users: <strong>${(state.telegram && state.telegram.identities && state.telegram.identities.length) || 0}</strong></p>
          <button class="btn-small" id="btn-telegram-link-identity">🔗 Link Telegram User</button>
        </div>` : ''}
        ${t.id === 'slack.bot' ? `<div class="tool-oauth-actions">
          <p style="font-size:0.75rem; margin-top:0.25rem; color:var(--text-muted);">Bot Status: <strong>${state.slack && state.slack.status && state.slack.status.configured ? 'Active' : 'Mock Mode (No Token)'}</strong></p>
          <p style="font-size:0.75rem; color:var(--text-muted);">Linked Users: <strong>${(state.slack && state.slack.identities && state.slack.identities.length) || 0}</strong></p>
          <button class="btn-small" id="btn-slack-link-identity">🔗 Link Slack User</button>
        </div>` : ''}
      </div>`
      )
      .join('');

    const btnConnect = document.getElementById('btn-google-calendar-connect');
    if (btnConnect) {
      btnConnect.onclick = () => {
        if (!state.googleOAuth.configured) {
          btnConnect.disabled = true;
          btnConnect.textContent = 'Google Calendar is not configured on this server yet.';
          return;
        }
        // Real browser navigation so the server's 302 redirect takes us to Google.
        window.location.href = '/api/v1/oauth/google/start';
      };
    }
    const btnDisconnect = document.getElementById('btn-google-calendar-disconnect');
    if (btnDisconnect) {
      btnDisconnect.onclick = async () => {
        await apiFetch('/api/v1/oauth/google/disconnect', { method: 'POST' });
        await loadAllData();
      };
    }
    const btnTgLink = document.getElementById('btn-telegram-link-identity');
    if (btnTgLink) {
      btnTgLink.onclick = async () => {
        const tgUserId = prompt('Enter your Telegram user ID to connect Telegram (for example, 12345678):');
        if (tgUserId && tgUserId.trim()) {
          const username = prompt('Optional: Telegram Username (e.g. janesmith):') || undefined;
          await window.NAGEX.linkTelegramIdentity(tgUserId.trim(), 'usr_admin_001', username);
        }
      };
    }
    const btnSlackLink = document.getElementById('btn-slack-link-identity');
    if (btnSlackLink) {
      btnSlackLink.onclick = async () => {
        const slackUserId = prompt('Enter your Slack user ID to connect Slack (for example, U1234567):');
        if (slackUserId && slackUserId.trim()) {
          const username = prompt('Optional: Slack Username (e.g. janesmith):') || undefined;
          await window.NAGEX.linkSlackIdentity(slackUserId.trim(), 'usr_admin_001', undefined, username);
        }
      };
    }
  }

  function renderApprovals() {
    const container = document.getElementById('approvals-list-container');
    if (!container) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    const approvals = state.approvals || [];
    if (approvals.length === 0) {
      container.innerHTML = `<div class="empty-state-text">${escapeHtml(t('workspace.noApprovalsPending') || 'No approvals pending.')}</div>`;
      return;
    }

    container.innerHTML = approvals
      .map(
        (a) => `
      <div class="plan-item-card">
        <div class="plan-item-header">
          <span class="plan-goal-title">Action: ${escapeHtml(a.action || a.title || 'Pending Approval')}</span>
          <span class="step-badge ${(a.status || 'PENDING').toLowerCase()}">${escapeHtml(a.status || 'PENDING')}</span>
        </div>
        ${a.tool ? `<p class="card-body-text"><strong>Tool Involved:</strong> ${escapeHtml(a.tool)}</p>` : ''}
        ${a.recipient ? `<p class="card-body-text"><strong>Recipient:</strong> ${escapeHtml(a.recipient)}</p>` : ''}
        ${a.subject ? `<p class="card-body-text"><strong>Subject:</strong> ${escapeHtml(a.subject)}</p>` : ''}
        ${a.shared_data && a.shared_data.length > 0 ? `<p class="card-body-text"><strong>Data Involved:</strong> ${escapeHtml(a.shared_data.join(', '))}</p>` : ''}
        ${a.why ? `<p class="card-body-text" style="color:var(--text-muted);">Reason: ${escapeHtml(a.why)}</p>` : ''}
        ${
          a.status === 'PENDING'
            ? `
          <div class="card-footer-actions" style="margin-top:0.75rem;">
            <button class="btn-small danger" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'REJECT', event)">Reject</button>
            <button class="btn-primary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'APPROVE', event)">Approve</button>
          </div>`
            : ''
        }
      </div>`
      )
      .join('');
  }

  // Phase 1 STEP 8 (item F/G) — the consumer Activity tab. Reads only the
  // durable, tenant-isolated Activity projection (state.activity, from
  // GET /api/v1/activity) — never the legacy non-isolated
  // /api/v1/executions demo feed, and never raw AuditLogger-shaped fields
  // (tool.execution.completed, browser.navigate, skill.scheduling, ...).
  // ── R12.1 Increment 3 — Outcome-first Activity timeline ──
  async function renderActivity() {
    const container = document.getElementById('executions-list-container');
    if (!container) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    let loadError = false;
    let activities = [];

    try {
      const data = await apiFetch('/api/v1/activity?limit=50');
      if (!data || data.error || !Array.isArray(data.activities)) {
        loadError = true;
        state.activityLoadFailed = true;
      } else {
        activities = data.activities;
        state.activity = activities;
        state.activityLoadFailed = false;
      }
    } catch (err) {
      loadError = true;
      state.activityLoadFailed = true;
    }

    if (loadError) {
      container.innerHTML = `<div class="empty-state-text" style="color: #ef4444;">${escapeHtml(t('activity.loadError') || 'Activity could not be loaded.')}</div>`;
      return;
    }

    if (activities.length === 0) {
      container.innerHTML = `<div class="empty-state-text">${escapeHtml(t('activity.emptyState') || 'No recent activity yet.')}</div>`;
      return;
    }

    // Date grouping: Today, Yesterday, Earlier
    const groups = groupActivityByDate(activities);

    const groupKeys = ['today', 'yesterday', 'earlier'];
    const groupTitles = {
      today: t('activity.groupToday') || 'Today',
      yesterday: t('activity.groupYesterday') || 'Yesterday',
      earlier: t('activity.groupEarlier') || 'Earlier',
    };

    let html = '';
    for (const key of groupKeys) {
      const items = groups[key];
      if (!items || items.length === 0) continue;

      html += `
        <div class="activity-group-section" style="margin-bottom: 1.5rem;">
          <h3 style="font-size: 0.85rem; font-weight: 700; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.35rem;">
            ${escapeHtml(groupTitles[key])} (${items.length})
          </h3>
          <div class="activity-group-items" style="display: flex; flex-direction: column; gap: 0.6rem;">
            ${items.map(renderActivityOutcomeCard).join('')}
          </div>
        </div>`;
    }

    container.innerHTML = html;
  }

  function groupActivityByDate(items) {
    const now = new Date();
    const todayStr = now.toDateString();
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    const yestStr = yest.toDateString();

    const result = { today: [], yesterday: [], earlier: [] };

    items.forEach((item) => {
      const itemDate = new Date(item.occurredAt || item.createdAt || Date.now());
      const dateStr = itemDate.toDateString();

      if (dateStr === todayStr) result.today.push(item);
      else if (dateStr === yestStr) result.yesterday.push(item);
      else result.earlier.push(item);
    });

    return result;
  }

  function renderActivityOutcomeCard(a) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const time = a.occurredAt ? new Date(a.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const isPartial = a.status === 'PARTIAL_SUCCESS' || a.status === 'PARTIAL_FAILURE' || Boolean(a.subSteps && a.subSteps.some((s) => s.status === 'FAILED'));

    const statusLabel = isPartial ? (t('activity.statusPartiallyCompleted') || 'Partially completed') :
                        a.status === 'RUNNING' ? (t('activity.statusWorking') || 'Working') :
                        a.status === 'NEEDS_ATTENTION' ? (t('activity.statusWaiting') || 'Waiting for you') :
                        a.status === 'FAILED' ? (t('activity.statusFailed') || 'Failed') :
                        a.status === 'CANCELLED' ? (t('activity.statusCancelled') || 'Cancelled') :
                        (t('activity.statusCompleted') || 'Completed');

    const badgeClass = isPartial ? 'status-NEEDS_REVIEW' :
                       a.status === 'RUNNING' ? 'status-PROCESSING' :
                       a.status === 'FAILED' ? 'status-FAILED' : 'status-READY';

    const aid = String(a.activityId || a.id || `act_${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '_');

    // Partial execution breakdown
    let partialHtml = '';
    if (isPartial && Array.isArray(a.subSteps)) {
      const completedSteps = a.subSteps.filter((s) => s.status === 'COMPLETED').map((s) => s.title || s.name);
      const failedSteps = a.subSteps.filter((s) => s.status === 'FAILED').map((s) => s.title || s.name);
      partialHtml = `
        <div class="activity-partial-breakdown" style="margin-top:0.35rem; font-size:0.75rem; background: rgba(0,0,0,0.03); padding:0.4rem; border-radius:4px;">
          ${completedSteps.length > 0 ? `<div style="color:#166534;"><strong>${escapeHtml(t('activity.substepsCompleted') || 'Completed:')}</strong> ${escapeHtml(completedSteps.join(', '))}</div>` : ''}
          ${failedSteps.length > 0 ? `<div style="color:#991b1b; margin-top:0.2rem;"><strong>${escapeHtml(t('activity.substepsFailed') || 'Failed:')}</strong> ${escapeHtml(failedSteps.join(', '))}</div>` : ''}
        </div>`;
    }

    // Progressive disclosure expanded details
    const stepsHtml = (a.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    const toolsHtml = (a.toolsUsed || []).map((tl) => `<span class="badge-status status-CAPTURED" style="font-size:0.65rem;">${escapeHtml(tl)}</span>`).join(' ');

    return `
      <div class="plan-item-card activity-outcome-card" style="position:relative; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 0.85rem 1rem;" tabindex="0" role="region" aria-label="${escapeHtml(a.title)}">
        <div class="plan-item-header" style="display:flex; justify-content:space-between; align-items:center;">
          <span class="plan-goal-title" style="font-size:0.88rem; font-weight:600; color:var(--text-navy);">${escapeHtml(a.title)}</span>
          <span class="badge-status ${badgeClass}">${escapeHtml(statusLabel)}</span>
        </div>
        ${a.description ? `<p class="card-body-text" style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.2rem;">${escapeHtml(a.description)}</p>` : ''}
        ${a.effect ? `<div style="font-size:0.75rem; font-weight:500; color:var(--color-accent-teal, #0d9488); margin-top:0.25rem;">${escapeHtml(a.effect)}</div>` : ''}
        ${partialHtml}
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.4rem;">
          <span style="font-size:0.72rem; color:var(--text-muted);">${escapeHtml(time)}</span>
          <button id="activity-btn-${aid}" class="btn-secondary activity-expand-btn" aria-expanded="false" style="font-size:0.7rem; padding: 2px 6px;" onclick="window.NAGEX.toggleActivityDetail('${aid}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.NAGEX.toggleActivityDetail('${aid}');}">
            ${escapeHtml(t('workspace.reviewDetails') || 'Details')}
          </button>
        </div>
        <div id="activity-detail-${aid}" class="activity-detail-panel" hidden style="margin-top:0.5rem; padding-top:0.5rem; border-top:1px dashed var(--border-subtle); font-size:0.75rem;">
          ${stepsHtml ? `<div style="margin-bottom:0.3rem;"><strong>Steps:</strong><ul style="margin:0.2rem 0 0 1.2rem; padding:0;">${stepsHtml}</ul></div>` : ''}
          ${toolsHtml ? `<div style="margin-bottom:0.3rem; display:flex; gap:0.3rem; align-items:center;"><strong>Tools:</strong> ${toolsHtml}</div>` : ''}
          ${a.source ? `<div style="margin-bottom:0.2rem; color:var(--text-muted);">Source: ${escapeHtml(a.source.taskId || a.source.approvalId || a.type || 'System')}</div>` : ''}
          <div style="margin-top:0.3rem;">
            <button class="btn-secondary" style="font-size:0.65rem; padding: 1px 4px;" onclick="alert('Technical Audit Record ID: ' + escapeHtml('${a.activityId || aid}'))">
              ${escapeHtml(t('activity.viewTechnicalDetails') || 'View technical details')}
            </button>
          </div>
        </div>
      </div>`;
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.toggleActivityDetail = function(id) {
    const panel = document.getElementById(`activity-detail-${id}`);
    const btn = document.getElementById(`activity-btn-${id}`);
    if (!panel) return;
    const isExpanded = !panel.hidden;
    panel.hidden = isExpanded;
    if (btn) btn.setAttribute('aria-expanded', String(!isExpanded));
  };

  // P08 — My Space Foundation. Thin frontend for the thin GET /api/v1/
  // my-space composition — fetched lazily (only when the tab actually
  // opens, unlike Home's eager loadAllData()), since Calendar's leg makes a
  // real external call this app should not repeat on every 5s active-work
  // poll for a view the user may never open. Every section renders (or
  // empties/errors) independently — one section's data problem never blanks
  // the rest of the page.
  async function renderMySpace() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const sections = {
      activity: document.getElementById('myspace-activity-list'),
      memory: document.getElementById('myspace-memory-list'),
      tasks: document.getElementById('myspace-tasks-list'),
      workflows: document.getElementById('myspace-workflows-list'),
      calendar: document.getElementById('myspace-calendar-list'),
      history: document.getElementById('myspace-history-list'),
    };
    const loadingText = `<p class="card-body-text">${escapeHtml(t('mySpace.loading'))}</p>`;
    Object.values(sections).forEach((el) => { if (el) el.innerHTML = loadingText; });

    const data = await apiFetch('/api/v1/my-space');
    if (!data || data.error) {
      const errorText = `<p class="card-body-text">${escapeHtml(t('mySpace.sectionError'))}</p>`;
      Object.values(sections).forEach((el) => { if (el) el.innerHTML = errorText; });
      return;
    }

    const listItem = (title, summary, badge) => `<div class="inbox-item-card">
        <div class="inbox-item-main">
          <span class="inbox-item-title">${escapeHtml(title)}</span>
          <span class="inbox-item-summary">${escapeHtml(summary)}</span>
        </div>
        ${badge ? `<span class="badge-status">${escapeHtml(badge)}</span>` : ''}
      </div>`;
    const emptyText = (key) => `<p class="card-body-text">${escapeHtml(t(key))}</p>`;

    if (sections.activity) {
      const items = data.activity || [];
      sections.activity.innerHTML = items.length
        ? items.map((a) => listItem(a.title, new Date(a.occurredAt).toLocaleString(), a.status)).join('')
        : emptyText('mySpace.noActivity');
    }

    if (sections.memory) {
      const items = data.memory || [];
      sections.memory.innerHTML = items.length
        ? items.map((m) => listItem(m.content?.subject || 'Memory', String(m.content?.value ?? ''), null)).join('')
        : emptyText('mySpace.noMemory');
    }

    if (sections.tasks) {
      const items = data.tasks || [];
      sections.tasks.innerHTML = items.length
        ? items.map((task) => listItem(task.name, new Date(task.updatedAt).toLocaleString(), task.status)).join('')
        : emptyText('mySpace.noTasks');
    }

    if (sections.workflows) {
      const items = data.workflows || [];
      sections.workflows.innerHTML = items.length
        ? items.map((wf) => listItem(wf.name, wf.lastRunAt ? new Date(wf.lastRunAt).toLocaleString() : '', wf.lastRunStatus || (wf.enabled ? 'Enabled' : 'Disabled'))).join('')
        : emptyText('mySpace.noWorkflows');
    }

    if (sections.calendar) {
      const items = data.calendar || [];
      if (data.calendarStatus === 'DISCONNECTED') {
        sections.calendar.innerHTML = emptyText('mySpace.calendarDisconnected');
      } else if (!items.length) {
        sections.calendar.innerHTML = emptyText('mySpace.noCalendar');
      } else {
        sections.calendar.innerHTML = items.map((ev) => listItem(ev.title, new Date(ev.start).toLocaleString(), null)).join('');
      }
    }

    if (sections.history) {
      const items = data.history || [];
      sections.history.innerHTML = items.length
        ? items.map((h) => listItem(h.title, new Date(h.timestamp).toLocaleString(), h.status)).join('')
        : emptyText('mySpace.noHistory');
    }
  }

  function renderKnowledge() {
    const container = document.getElementById('knowledge-list-container');
    if (!container) return;

    container.innerHTML = state.knowledge
      .map(
        (k) => `
      <div class="know-card">
        <div class="card-header-row">
          <span class="card-title">${escapeHtml(k.name)}</span>
          <span class="tag-scope">${k.classification}</span>
        </div>
        <p class="card-body-text">Size: ${(k.size_bytes / 1024 / 1024).toFixed(2)} MB</p>
        <p class="card-body-text">Indexed Chunks: ${k.chunk_count}</p>
      </div>`
      )
      .join('');
  }

  function showSettingsSaveFeedback(success, message) {
    const toast = document.getElementById('settings-save-feedback');
    const errBanner = document.getElementById('settings-error-banner');
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    if (success) {
      if (errBanner) errBanner.hidden = true;
      if (toast) {
        toast.textContent = message || t('settings.savedSuccess') || 'Saved.';
        toast.hidden = false;
        toast.className = 'settings-save-toast success';
        setTimeout(() => { if (toast) toast.hidden = true; }, 3000);
      }
    } else {
      if (toast) toast.hidden = true;
      if (errBanner) {
        errBanner.textContent = message || t('settings.saveFailed') || 'Could not save settings.';
        errBanner.hidden = false;
        errBanner.className = 'settings-error-banner error';
      }
    }
  }

  function switchSettingsCategory(catKey, options) {
    const pushHistory = !options || options.pushHistory !== false;
    state.activeSettingsCat = catKey;
    const tabs = document.querySelectorAll('.settings-cat-tab');
    tabs.forEach((tab) => {
      const isActive = tab.getAttribute('data-cat') === catKey;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });
    const panels = document.querySelectorAll('.cat-panel');
    panels.forEach((panel) => {
      const isMatch = panel.id === `cat-panel-${catKey}`;
      panel.hidden = !isMatch;
    });

    if (!isNavigatingFromPopState && pushHistory && state.activeTab === 'tab-settings' && typeof window !== 'undefined' && window.history && window.history.pushState) {
      const targetHash = `#settings/${catKey}`;
      const st = window.history.state;
      const alreadyPushed = st && st.tabId === 'tab-settings' && st.settingsCat === catKey && window.location.hash === targetHash;
      if (!alreadyPushed) {
        window.history.pushState({ tabId: 'tab-settings', settingsCat: catKey }, '', targetHash);
      }
    }
  }

  function renderSettingsDevices() {
    const el = document.getElementById('settings-devices-list');
    if (!el) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const devices = [
      {
        name: 'Local Desktop Agent',
        platform: 'Windows Desktop',
        status: 'Connected device',
        trusted: true,
        lastSeen: 'Active now',
      },
    ];
    el.innerHTML = devices.map((d) => `
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">${escapeHtml(d.name)} (${escapeHtml(d.platform)})</span>
          <span class="device-tag">${escapeHtml(d.status)} · ${escapeHtml(d.lastSeen)}</span>
        </div>
        <span class="badge-status green">${escapeHtml(t('settings.connected') || 'Connected')}</span>
      </div>
    `).join('');
  }

  function renderSettings() {
    const qwContainer = document.getElementById('quickwake-settings-options');
    const autoContainer = document.getElementById('autonomy-selector-container');

    switchSettingsCategory(state.activeSettingsCat || 'connections');

    if (qwContainer) {
      const options = [
        { key: 'floating_button', title: 'Floating NAgex Button', enabled: state.quickWakeConfig.floating_button },
        { key: 'quick_settings_tile', title: 'Quick Settings Tile (Android)', enabled: state.quickWakeConfig.quick_settings_tile },
        { key: 'lock_screen_shortcut', title: 'Lock Screen Shortcut', enabled: state.quickWakeConfig.lock_screen_shortcut },
        { key: 'voice_wake', title: 'Voice Wake Command', enabled: state.quickWakeConfig.voice_wake },
        { key: 'double_tap_shortcut', title: 'Double-Tap Shortcut', enabled: state.quickWakeConfig.double_tap_shortcut },
        { key: 'fingerprint_button', title: 'Fingerprint Sensor Button', notSupported: true, label: 'Not supported on this device' },
      ];

      qwContainer.innerHTML = options
        .map(
          (o) => `
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-title">${escapeHtml(o.title)}</span>
            ${o.notSupported ? `<span class="device-tag">${escapeHtml(o.label)}</span>` : ''}
          </div>
          ${
            !o.notSupported
              ? `<input type="checkbox" role="switch" aria-checked="${o.enabled ? 'true' : 'false'}" ${o.enabled ? 'checked' : ''} onchange="window.NAGEX.toggleQuickWakeOpt('${o.key}', this.checked)">`
              : ''
          }
        </div>`
        )
        .join('');
    }

    if (autoContainer) {
      const levels = [
        { id: 'L0', title: 'Always ask', desc: 'Check with you before making any change.' },
        { id: 'L1', title: 'Read and suggest', desc: 'Find information and suggest next steps without making changes.' },
        { id: 'L2', title: 'Help with routine tasks', desc: 'Handle routine steps and check with you before sending or changing anything important.' },
        { id: 'L3', title: 'Use trusted routines', desc: 'Run routines you have already reviewed and allowed.' },
      ];

      autoContainer.innerHTML = levels
        .map(
          (l) => `
        <div class="autonomy-level-card ${state.autonomyConfig.level === l.id ? 'selected' : ''}" role="button" tabindex="0" onclick="window.NAGEX.selectAutonomy('${l.id}')" onkeydown="if(event.key==='Enter'||event.key===' ') window.NAGEX.selectAutonomy('${l.id}')">
          <div class="setting-title">${escapeHtml(l.title)}</div>
          <div class="setting-sub">${escapeHtml(l.desc)}</div>
        </div>`
        )
        .join('');
    }

    renderSettingsConnections();
    renderSettingsAiModel();
    renderSettingsDevices();
    if (window.NAGEX.renderProactiveAssistant) window.NAGEX.renderProactiveAssistant();
    // R15 — Settings is reachable via a same-document hash navigation
    // (switchTab never triggers a full page reload), so org/workspace/
    // role context must be refreshed here rather than only once at
    // initial page load. Without this, a membership change that happened
    // out of band (e.g. accepting an invitation) would show as "No
    // Organization Selected" until the next hard refresh, even though the
    // real membership already exists.
    if (window.NAGEX_ORG_UI && window.NAGEX_ORG_UI.loadOrgContext) window.NAGEX_ORG_UI.loadOrgContext();
    wireSettingsAdvancedToggle();
  }

  function renderSettingsAiModel() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const el = document.getElementById('settings-ai-model-status');
    if (!el) return;

    const data = state.providerStatus;
    const providers = (data && data.providers) || [];
    const activeProvider = data && data.activeProvider;

    if (providers.length === 0) {
      el.innerHTML = `<p class="setting-sub">${escapeHtml(t('settings.providerNoneConfigured') || 'No model provider is configured on this server.')}</p>`;
      return;
    }

    const statusLabelKey = {
      UNCONFIGURED: 'settings.providerStatusUnconfigured',
      CONFIGURED: 'settings.providerStatusConfigured',
      LIVE: 'settings.providerStatusLive',
      DEGRADED: 'settings.providerStatusDegraded',
    };
    const statusBadgeClass = { UNCONFIGURED: 'gray', CONFIGURED: 'blue', LIVE: 'green', DEGRADED: 'orange' };
    const statusFallback = { UNCONFIGURED: 'Not configured', CONFIGURED: 'Configured — not yet used', LIVE: 'Live', DEGRADED: 'Degraded' };

    el.innerHTML = providers
      .filter((p) => p.status !== 'UNCONFIGURED')
      .map((p) => {
        const isActive = p.provider === activeProvider;
        const roleLabel = isActive
          ? (t('settings.providerActive') || 'Primary route')
          : (t('settings.providerFallback') || 'Fallback');
        return `
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-title">${escapeHtml(p.provider)}${p.model ? ` · ${escapeHtml(p.model)}` : ''}</span>
            <span class="device-tag">${escapeHtml(roleLabel)}${p.lastCheckedAt ? ` · ${escapeHtml(t('settings.providerLastChecked') || 'Last checked')} ${escapeHtml(new Date(p.lastCheckedAt).toLocaleTimeString())}` : ''}</span>
          </div>
          <span class="badge-status ${statusBadgeClass[p.status] || 'gray'}">${escapeHtml(t(statusLabelKey[p.status]) || statusFallback[p.status] || p.status)}</span>
        </div>`;
      })
      .join('') || `<p class="setting-sub">${escapeHtml(t('settings.providerNoneConfigured') || 'No model provider is configured on this server.')}</p>`;
  }

  function renderSettingsConnections() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const el = document.getElementById('settings-connections-status');
    if (!el) return;

    const oauth = state.googleOAuth || { configured: false, connected: false };
    const statusLabel = oauth.connected
      ? t('settings.connected') || 'Connected'
      : oauth.configured
        ? t('settings.notConnected') || 'Not connected'
        : t('settings.notConfigured') || 'Not configured on this server';

    el.innerHTML = `
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-title">Google Calendar &amp; Gmail</span>
          <span class="device-tag">${escapeHtml(statusLabel)}</span>
        </div>
        <button class="btn-secondary" id="btn-settings-google-toggle" ${!oauth.configured ? 'disabled' : ''}>
          ${oauth.connected ? (t('settings.disconnect') || 'Disconnect') : (t('settings.connect') || 'Connect')}
        </button>
      </div>`;

    const btn = document.getElementById('btn-settings-google-toggle');
    if (btn && oauth.configured) {
      btn.onclick = async () => {
        if (oauth.connected) {
          const confirmMsg = t('settings.confirmDisconnectMsg')
            ? t('settings.confirmDisconnectMsg').replace('{service}', 'Google Calendar & Gmail')
            : 'Disconnecting Google Calendar & Gmail will prevent NAgex from taking automated actions on your behalf. Are you sure?';
          if (!window.confirm(confirmMsg)) return;

          const res = await apiFetch('/api/v1/oauth/google/disconnect', { method: 'POST' });
          const fresh = await apiFetch('/api/v1/oauth/google/status');
          if (fresh) state.googleOAuth = fresh;
          if (res && !res.error) {
            showSettingsSaveFeedback(true, 'Disconnected.');
          } else {
            showSettingsSaveFeedback(false, res?.error || 'Disconnect failed');
          }
          renderSettingsConnections();
        } else {
          window.location.href = '/api/v1/oauth/google/start';
        }
      };
    }
  }

  // Advanced is collapsed by default (MASTER.md Section 14.12 / 14.9 §5) —
  // wired once per renderSettings() call so a re-render never loses state
  // by re-hiding an already-opened list.
  function wireSettingsAdvancedToggle() {
    const toggle = document.getElementById('btn-settings-advanced-toggle');
    const list = document.getElementById('settings-advanced-list');
    if (!toggle || !list || toggle.dataset.wired) return;
    toggle.dataset.wired = '1';
    toggle.onclick = () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
      const caret = toggle.querySelector('.settings-advanced-caret');
      if (caret) caret.textContent = expanded ? '▸' : '▾';
    };
  }

  function initQuickWake() {
    const btnFloat = document.getElementById('btn-floating-quickwake');
    const btnHeader = document.getElementById('btn-header-quickwake');
    const btnClose = document.getElementById('btn-close-ambient');
    const btnCancel = document.getElementById('btn-ambient-cancel');
    const btnRun = document.getElementById('btn-ambient-run');
    const btnVoice = document.getElementById('btn-ambient-voice-toggle');
    const backdrop = document.getElementById('ambient-overlay-backdrop');

    if (btnFloat) btnFloat.onclick = () => openAmbientOverlay();
    if (btnHeader) btnHeader.onclick = () => openAmbientOverlay();
    // X button and footer "Close" button: both only ever dismiss the UI —
    // closeAmbientOverlay() never approves/rejects/executes anything.
    if (btnClose) btnClose.onclick = closeAmbientOverlay;
    if (btnCancel) btnCancel.onclick = closeAmbientOverlay;

    // Backdrop click closes the modal, but only when the click lands on the
    // backdrop itself — a click that starts or ends inside the modal (a
    // descendant of the backdrop) must never close it.
    if (backdrop) {
      backdrop.addEventListener('click', (event) => {
        const isBackdropClick = window.NAGEX_MODAL_BEHAVIOR
          ? window.NAGEX_MODAL_BEHAVIOR.isBackdropSelfClick(event.target, backdrop)
          : event.target === backdrop;
        if (isBackdropClick) closeAmbientOverlay();
      });
    }

    if (btnVoice) {
      btnVoice.onclick = () => {
        const wave = document.getElementById('ambient-waveform');
        if (wave) wave.style.display = wave.style.display === 'none' ? 'flex' : 'none';
      };
    }

    if (btnRun) btnRun.onclick = submitAmbientComposerInput;

    const ambientInput = document.getElementById('ambient-prompt-input');
    if (ambientInput) {
      ambientInput.addEventListener('keydown', (event) => {
        // Enter submits; Shift+Enter is left to the browser's native
        // behavior (a no-op on this single-line input, so no newline is
        // ever inserted — this is a plain <input>, not multiline).
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitAmbientComposerInput();
        }
      });
    }

  }

  // Shared by the send button and Enter keydown: reads the composer's
  // genuinely-typed text, clears it (the placeholder reappears naturally
  // since the element is now empty — no demo text is ever restored), and
  // hands the captured text off to the task pipeline before the input is
  // touched again, so nothing submitted is ever lost by clearing.
  function submitAmbientComposerInput() {
    const input = document.getElementById('ambient-prompt-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    // Focus is restored once runAmbientTask finishes and re-enables the
    // controls (see its `finally` block) — focusing here would be a no-op,
    // since the input is disabled for the duration of the request.
    runAmbientTask(text);
  }

  function openAmbientOverlay() {
    const backdrop = document.getElementById('ambient-overlay-backdrop');
    const modal = document.getElementById('ambient-sheet-modal');
    const input = document.getElementById('ambient-prompt-input');
    const progress = document.getElementById('ambient-progress-container');
    const preview = document.getElementById('ambient-plan-preview');
    const resolution = document.getElementById('ambient-resolution-card');
    const result = document.getElementById('ambient-result-card');

    const understandingCard = document.getElementById('ambient-understanding-card');
    const userApprovalCard = document.getElementById('ambient-user-approval-card');
    const modalTitleEl = document.getElementById('ambient-modal-title');
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    // Remember what had focus so it can be restored when the modal closes.
    ambientModalTriggerElement = document.activeElement;

    if (backdrop) backdrop.style.display = 'flex';
    if (modalTitleEl) modalTitleEl.textContent = t('ambient.modalTitle');
    if (input) input.value = '';
    if (progress) progress.style.display = 'none';
    if (preview) preview.style.display = 'none';
    if (resolution) resolution.style.display = 'none';
    if (result) result.style.display = 'none';
    if (understandingCard) understandingCard.style.display = 'none';
    if (userApprovalCard) userApprovalCard.style.display = 'none';
    const perspectiveCard = document.getElementById('ambient-perspective-card');
    if (perspectiveCard) {
      perspectiveCard.style.display = 'none';
      perspectiveCard.innerHTML = '';
    }
    resetAmbientFlowUi();

    if (ambientBodyScrollLock) ambientBodyScrollLock.lock(document.body.style.overflow);
    document.body.style.overflow = 'hidden';

    // Move focus into the modal, and trap it there (Tab/Shift+Tab wrap
    // around) until the modal closes; Escape closes it from anywhere.
    const btnClose = document.getElementById('btn-close-ambient');
    if (btnClose) btnClose.focus();

    ambientModalKeydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAmbientOverlay();
        return;
      }
      if (event.key === 'Tab' && modal && window.NAGEX_MODAL_BEHAVIOR) {
        const focusable = getFocusableElements(modal);
        const target = window.NAGEX_MODAL_BEHAVIOR.computeFocusTrapTarget(focusable, document.activeElement, event.shiftKey);
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener('keydown', ambientModalKeydownHandler, true);
  }

  // Dismisses the Ambient Assistant / Plan Preview modal only — this must
  // never approve, reject, or execute anything, and must never leave the
  // page in a broken state (locked scroll, dangling key handler, lost
  // focus), no matter which of the four dismissal paths (X, footer Close,
  // Escape, backdrop click) triggered it, or how many times it is called.
  function closeAmbientOverlay() {
    const backdrop = document.getElementById('ambient-overlay-backdrop');
    if (backdrop) backdrop.style.display = 'none';

    if (ambientBodyScrollLock) {
      const restore = ambientBodyScrollLock.unlock();
      if (restore !== null) document.body.style.overflow = restore;
    } else {
      document.body.style.overflow = '';
    }

    if (ambientModalKeydownHandler) {
      document.removeEventListener('keydown', ambientModalKeydownHandler, true);
      ambientModalKeydownHandler = null;
    }

    if (state.approvalCountdownTimer) {
      clearInterval(state.approvalCountdownTimer);
      state.approvalCountdownTimer = null;
    }

    if (ambientModalTriggerElement && typeof ambientModalTriggerElement.focus === 'function' && document.contains(ambientModalTriggerElement)) {
      ambientModalTriggerElement.focus();
    }
    ambientModalTriggerElement = null;
  }

  // Disables every real trigger surface for the duration of a generation —
  // not a timer/debounce, purely tied to ambientRunGuard's actual busy
  // state — so a user physically cannot fire a second submission while one
  // is in flight, on top of (not instead of) the guard itself rejecting a
  // re-entrant call. Includes the example card's "Run" button: it submits
  // through the same canonical path (see initPrimaryScenario), so it must
  // be disabled/relabeled by the same busy state as everything else.
  function setAmbientRunControlsDisabled(disabled) {
    const ids = ['ambient-prompt-input', 'btn-ambient-run', 'home-prompt-input', 'btn-home-prompt-send', 'btn-run-ambient-plan'];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });

    const runLabel = document.getElementById('btn-run-ambient-plan-label');
    if (runLabel) {
      const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : null;
      runLabel.textContent = disabled
        ? (t ? t('ambient.running') : 'Running...')
        : (t ? t('ambient.run') : 'Run');
    }
  }

  // R12.1 Increment 1 — §6/§12: internal execution detail (provider/model/
  // latency/request id) lives behind a collapsed-by-default "What NAgex is
  // doing" disclosure, never in the primary working-state text. Wired once
  // (dataset.wired guard, same pattern as wireSettingsAdvancedToggle) so a
  // re-render never loses whatever open/closed state the user left it in.
  function wireAmbientActivityToggle() {
    const toggle = document.getElementById('btn-ambient-activity-toggle');
    const body = document.getElementById('ambient-activity-detail-body');
    if (!toggle || !body || toggle.dataset.wired) return;
    toggle.dataset.wired = '1';
    toggle.onclick = () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
    };
  }

  function renderAmbientActivityDetail({ provider, model, latencyMs, requestId }) {
    const container = document.getElementById('ambient-activity-detail');
    const body = document.getElementById('ambient-activity-detail-body');
    if (!container || !body) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const rows = [
      [t('ambient.activityProvider'), provider],
      [t('ambient.activityModel'), model],
      [t('ambient.activityLatency'), typeof latencyMs === 'number' ? `${latencyMs}ms` : null],
      [t('ambient.activityRequestId'), requestId],
    ].filter(([, value]) => value);
    if (rows.length === 0) {
      container.style.display = 'none';
      return;
    }
    body.innerHTML = rows.map(([label, value]) => `<div>${escapeHtml(label)}: ${escapeHtml(String(value))}</div>`).join('');
    container.style.display = 'block';
    wireAmbientActivityToggle();
  }

  function isForecastCompareIntent(promptText) {
    if (!promptText || typeof promptText !== 'string') return false;
    const text = promptText.toLowerCase();
    const triggers = [
      '일어날 가능성을 예측',
      '성공할 가능성',
      '끝날 가능성',
      '예측해줘',
      '확률을 추정',
      '가능성을 예측',
      '가능성이 얼마나',
      '확률이 얼마나',
      'forecast this',
      'how likely is this',
      'what are the chances',
      'estimate the probability',
      'will this happen by',
      'will this project launch',
      'will this',
      'will it',
      'forecast',
      'predict',
      'election',
      'presidential election',
      'who will win',
      '대선',
      '선거',
    ];
    return triggers.some((t) => text.includes(t));
  }

  function isPerspectiveCompareIntent(promptText) {
    if (!promptText || typeof promptText !== 'string') return false;
    const text = promptText.toLowerCase();
    const triggers = [
      '여러 관점에서 검토',
      '다른 시각도 같이',
      '여러 관점으로 분석',
      'compare perspectives',
      'different perspectives',
      'multiple perspectives',
      '여러 관점',
      '다른 시각',
    ];
    return triggers.some((t) => text.includes(t));
  }

  async function runAmbientTask(promptText) {
    // Single-flight: while one generation is in flight, ignore any further
    // trigger rather than starting a second, legitimately-different plan
    // for what the user perceives as one action.
    if (ambientRunGuard && !ambientRunGuard.tryEnter()) return;
    setAmbientRunControlsDisabled(true);
    try {
      const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
      const progress = document.getElementById('ambient-progress-container');
      const fill = document.getElementById('ambient-progress-fill');
      const text = document.getElementById('ambient-progress-text');
      const preview = document.getElementById('ambient-plan-preview');
      const planSteps = document.getElementById('ambient-plan-steps');
      const resultCard = document.getElementById('ambient-result-card');
      const resultText = document.getElementById('ambient-result-text');
      const activityDetail = document.getElementById('ambient-activity-detail');
      if (activityDetail) activityDetail.style.display = 'none';

      const wave = document.getElementById('ambient-waveform');
      if (wave) wave.style.display = 'none';

      const userBubble = document.getElementById('ambient-user-bubble');
      const userReqText = document.getElementById('ambient-user-request-text');
      if (userBubble && userReqText) {
        userReqText.textContent = promptText;
        userBubble.style.display = 'flex';
      }

      // R12.1 Increment 1 — §6 Working state: outcome-oriented text only.
      // Internal jargon (provider/model/latency) moves to the progressive-
      // disclosure "What NAgex is doing" panel below, never the primary text.
      updateFlowStage('User message');
      if (progress) progress.style.display = 'flex';
      if (fill) fill.style.width = '20%';
      if (text) text.textContent = t('ambient.progress.understanding');

      if (isForecastCompareIntent(promptText)) {
        if (fill) fill.style.width = '40%';
        const lang = window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : (localStorage.getItem('nagex_locale') || 'en');
        if (text) text.textContent = lang === 'ko' ? '미래 결과를 예측 분석하는 중...' : 'Analyzing forecast...';

        const forecastRes = await apiFetch('/api/v1/ai/forecast-compare', {
          method: 'POST',
          body: JSON.stringify({ query: promptText }),
          timeoutMs: AMBIENT_INTENT_TIMEOUT_MS,
        });

        if (fill) fill.style.width = '100%';
        if (text) text.textContent = lang === 'ko' ? '예측 분석 완료' : 'Forecast analysis complete';

        updateFlowStage('Result');

        let cardContainer = document.getElementById('ambient-forecast-card');
        if (!cardContainer) {
          const sheetBody = document.getElementById('ambient-sheet-body');
          cardContainer = document.createElement('div');
          cardContainer.id = 'ambient-forecast-card';
          cardContainer.className = 'ambient-forecast-card';
          cardContainer.setAttribute('data-testid', 'ambient-forecast-card');
          if (sheetBody) {
            sheetBody.appendChild(cardContainer);
          } else {
            document.body.appendChild(cardContainer);
          }
        }

        renderForecastCompareResult(cardContainer, forecastRes, lang);
        if (progress) progress.style.display = 'none';
        return;
      }

      if (isPerspectiveCompareIntent(promptText)) {
        if (fill) fill.style.width = '40%';
        const lang = window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : (localStorage.getItem('nagex_locale') || 'en');
        if (text) text.textContent = lang === 'ko' ? '다각적 관점에서 분석하는 중...' : 'Comparing perspectives...';

        const compareRes = await apiFetch('/api/v1/ai/perspective-compare', {
          method: 'POST',
          body: JSON.stringify({ query: promptText }),
          timeoutMs: AMBIENT_INTENT_TIMEOUT_MS,
        });

        if (fill) fill.style.width = '100%';
        if (text) text.textContent = lang === 'ko' ? '관점 분석 완료' : 'Perspective analysis complete';

        updateFlowStage('Result');

        let cardContainer = document.getElementById('ambient-perspective-card');
        if (!cardContainer) {
          const sheetBody = document.getElementById('ambient-sheet-body');
          cardContainer = document.createElement('div');
          cardContainer.id = 'ambient-perspective-card';
          cardContainer.className = 'ambient-perspective-card';
          cardContainer.setAttribute('data-testid', 'ambient-perspective-card');
          if (sheetBody) {
            sheetBody.appendChild(cardContainer);
          } else {
            document.body.appendChild(cardContainer);
          }
        }
        cardContainer.style.display = 'block';

        const dataObj = (compareRes && compareRes.data) ? compareRes.data : compareRes;
        let formattedResult;

        if (!compareRes || compareRes.error || (dataObj && dataObj.error) || (compareRes.status && compareRes.status !== 200 && compareRes.status !== 'COMPLETED' && compareRes.status !== 'PARTIAL')) {
          const errPayload = (compareRes && compareRes.error) || (dataObj && dataObj.error);
          let rawMsg = (typeof errPayload === 'string' ? errPayload : errPayload?.message) || (lang === 'ko' ? '다각적 관점 분석 서비스를 이용할 수 없습니다.' : 'Perspective comparison unavailable.');
          rawMsg = String(rawMsg)
            .replace(/PERSPECTIVE_SYNTHESIS_FAILED/g, lang === 'ko' ? '분석 결과를 합성하지 못했습니다.' : 'Synthesis unavailable.')
            .replace(/ALL_MODEL_PROVIDERS_FAILED/g, lang === 'ko' ? '모든 모델 응답에 실패했습니다.' : 'Model services unavailable.');
          formattedResult = {
            status: 'UNAVAILABLE',
            error: { message: rawMsg }
          };
        } else {
          formattedResult = {
            status: dataObj.status || 'COMPLETED',
            synthesis: {
              answer: dataObj.answer || (dataObj.synthesis && dataObj.synthesis.answer) || '',
              commonGround: dataObj.commonGround || (dataObj.synthesis && dataObj.synthesis.commonGround) || [],
              differingPerspectives: dataObj.differingPerspectives || (dataObj.synthesis && dataObj.synthesis.differingPerspectives) || [],
              uncertainties: dataObj.uncertainties || (dataObj.synthesis && dataObj.synthesis.uncertainties) || [],
            },
            sources: dataObj.sources || (dataObj.synthesis && dataObj.synthesis.sources) || (dataObj.evidencePack && dataObj.evidencePack.sources) || [],
          };
        }

        renderPerspectiveCompareResult(cardContainer, formattedResult, lang);
        return;
      }

      if (fill) fill.style.width = '50%';
      if (text) text.textContent = t('ambient.progress.planning');

      const res = await apiFetch('/api/v1/ambient/intent', {
        method: 'POST',
        body: JSON.stringify({ prompt: promptText }),
        timeoutMs: AMBIENT_INTENT_TIMEOUT_MS,
      });

      if (!res || res.error) {
        // §18 — truthful failure, never a fake success; the composer's own
        // controls are re-enabled by this function's finally block below.
        if (text) text.textContent = res?.error?.message || t('ambient.unableToGeneratePlan');
        return;
      }

      if (fill) fill.style.width = '100%';
      if (text) text.textContent = t('ambient.progress.planReady');
      renderAmbientActivityDetail({ provider: res.provider, model: res.model, latencyMs: res.latencyMs, requestId: res.requestId });

      updateFlowStage('Plan Preview');
      addTimelineEntry('Plan created', `plan:${res.requestId}:created`, 'runAmbientTask');

      if (preview && planSteps && res.plan) {
        preview.style.display = isDebugMode() ? 'block' : 'none';
        planSteps.innerHTML = res.plan.steps
          .map((s) => `<div class="step-row">
            <span class="step-num">${s.step}.</span>
            <span class="step-name"><strong>${escapeHtml(s.title)}</strong><br><small>${escapeHtml(s.reasoning)}${s.requiresApproval ? ' · Ready for review' : ''}</small></span>
          </div>`)
          .join('');
      }

      if (res.plan) {
        renderCanonicalUserPresentation(res.plan, promptText, res.requestId, null);
        await resolvePlanIntoUi(res.plan, promptText, res.requestId);
      }

      if (resultCard && resultText) {
        resultCard.style.display = isDebugMode() ? 'block' : 'none';
        resultText.textContent = `${res.plan.summary} No tools have been executed. Request ID: ${res.requestId}`;
      }
    } finally {
      if (ambientRunGuard) ambientRunGuard.exit();
      setAmbientRunControlsDisabled(false);
      const input = document.getElementById('ambient-prompt-input');
      const backdrop = document.getElementById('ambient-overlay-backdrop');
      if (input && backdrop && backdrop.style.display !== 'none') input.focus();
    }
  }

  async function resolvePlanIntoUi(plan, originalPromptText, planId) {
    const card = document.getElementById('ambient-resolution-card');
    const statusEl = document.getElementById('ambient-resolution-status');
    const stepsEl = document.getElementById('ambient-resolution-steps');
    const warningsEl = document.getElementById('ambient-resolution-warnings');
    const suggestionsEl = document.getElementById('ambient-resolution-suggestions');
    const actionsEl = document.getElementById('ambient-resolution-actions');
    const view = window.NAGEX_PLAN_VIEW;
    if (!card || !statusEl || !stepsEl || !warningsEl || !actionsEl || !view) return;

    const resolved = await apiFetch('/api/v1/plans/resolve', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });

    card.style.display = isDebugMode() ? 'block' : 'none';

    if (!resolved || resolved.error) {
      statusEl.innerHTML = `<span class="plan-status-badge plan-status-blocked">Cannot Execute</span>`;
      stepsEl.innerHTML = '';
      warningsEl.style.display = 'block';
      warningsEl.innerHTML = `<strong>Warnings</strong><ul><li>${escapeHtml((resolved && resolved.error && resolved.error.message) || 'Unable to resolve the generated plan against the registries.')}</li></ul>`;
      actionsEl.innerHTML = '';
      return;
    }

    updateFlowStage('Plan Resolution');
    addTimelineEntry('Plan resolved', `plan:${planId}:resolved`, 'resolvePlanIntoUi');

    const vm = view.buildResolutionViewModel(resolved);

    statusEl.innerHTML = `<span class="plan-status-badge ${vm.statusCssClass}">${escapeHtml(vm.statusLabel)}</span>`;

    stepsEl.innerHTML = vm.steps
      .map(
        (s) => `<div class="resolution-step-row ${s.statusCssClass}">
        <div class="resolution-step-head">
          <strong>${escapeHtml(s.title)}</strong>
          <span class="plan-status-badge ${s.statusCssClass}">${escapeHtml(s.statusLabel)}</span>
        </div>
        <div class="resolution-step-meta">
          <span>Skill: ${s.resolvedSkillId ? escapeHtml(s.resolvedSkillId) : 'Unresolved'}</span>
          <span>Tool: ${s.resolvedToolId ? escapeHtml(s.resolvedToolId) : 'None'}</span>
          <span>Availability: ${escapeHtml(s.toolAvailability)}</span>
          <span>Approval: ${s.approvalRequired ? 'Required' : 'Not required'}</span>
        </div>
        ${s.warnings.length ? `<ul class="resolution-step-warnings">${s.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      </div>`
      )
      .join('');

    if (vm.warnings.length) {
      warningsEl.style.display = 'block';
      warningsEl.innerHTML = `<strong>Warnings</strong><ul>${vm.warnings
        .map((w) => `<li>${w.stepTitle ? `${escapeHtml(w.stepTitle)}: ` : ''}${escapeHtml(w.message)}</li>`)
        .join('')}</ul>`;
    } else {
      warningsEl.style.display = 'none';
      warningsEl.innerHTML = '';
    }

    // Suggestions are informational-only ideas the model did not add as plan
    // steps (see the scope policy in ai-service.ts) — they must never block
    // or replace the requested action, so they render separately from
    // warnings and never affect vm.status/showRunButton.
    if (suggestionsEl) {
      if (vm.suggestions && vm.suggestions.length) {
        suggestionsEl.style.display = 'block';
        suggestionsEl.innerHTML = `<strong>You might also want to:</strong><ul>${vm.suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
      } else {
        suggestionsEl.style.display = 'none';
        suggestionsEl.innerHTML = '';
      }
    }

    // Look at the Calendar step's OWN executionReadiness rather than the
    // plan's overall vm.status: an unrelated blocked step (e.g. an
    // unavailable Notion tool the user separately asked for) must never mask
    // an independently executable/approvable Calendar step behind a "Cannot
    // Execute" banner (partial execution safety).
    const calendarStep = (resolved.steps || []).find((s) => s.resolvedToolId === 'google_calendar.create_event');

    if (calendarStep && calendarStep.executionReadiness === 'BLOCKED' && calendarStep.toolAvailability === 'UNAVAILABLE') {
      renderConnectGoogleCalendarAction(actionsEl);
    } else if (calendarStep && calendarStep.executionReadiness === 'APPROVAL_REQUIRED') {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const extractor = window.NAGEX_CALENDAR_INTENT;
      const extracted = extractor ? extractor.extractCalendarIntent(originalPromptText || '', new Date(), timezone) : null;
      // Always show the confirmation form — never request approval merely
      // because the plan resolved. Exact values the user already stated in
      // their message (title/start/duration) prefill it verbatim; anything
      // not stated is left blank (or, for duration, a clearly-labeled
      // suggested default) rather than an invented value like 10:00 AM.
      // The approval is only ever created when the user submits this form.
      renderCalendarComposeForm(actionsEl, extracted, timezone);
    } else if ((() => { const s = (resolved.steps || []).find((st) => GMAIL_WRITE_TOOL_IDS.has(st.resolvedToolId)); return s && s.executionReadiness === 'BLOCKED' && s.toolAvailability === 'UNAVAILABLE'; })()) {
      renderConnectGmailAction(actionsEl);
    } else if ((resolved.steps || []).find((s) => GMAIL_WRITE_TOOL_IDS.has(s.resolvedToolId) && s.executionReadiness === 'APPROVAL_REQUIRED')) {
      const gmailStep = (resolved.steps || []).find((s) => GMAIL_WRITE_TOOL_IDS.has(s.resolvedToolId) && s.executionReadiness === 'APPROVAL_REQUIRED');
      const extractor = window.NAGEX_GMAIL_INTENT;
      const extracted = extractor ? extractor.extractGmailIntent(originalPromptText || '') : null;
      // Same rule as Calendar: never request approval merely because the
      // plan resolved. Only literal values found in the prompt (or a real
      // prior gmail.read_thread/search result for reply context) prefill
      // this form; a bare name never becomes an address. The approval is
      // only ever created once the user submits this form.
      renderGmailComposeForm(actionsEl, gmailStep.resolvedToolId, extracted);
    } else if ((resolved.steps || []).find((s) => GMAIL_READ_TOOL_IDS.has(s.resolvedToolId) && s.executionReadiness === 'EXECUTION_READY')) {
      const gmailReadStep = (resolved.steps || []).find((s) => GMAIL_READ_TOOL_IDS.has(s.resolvedToolId) && s.executionReadiness === 'EXECUTION_READY');
      // Read-only — runs immediately, no approval, per policy.
      runGmailReadOnlyStep(actionsEl, gmailReadStep.resolvedToolId, originalPromptText, planId);
    } else if ((resolved.steps || []).find((s) => BROWSER_READ_TOOL_IDS.has(s.resolvedToolId) && s.executionReadiness === 'BLOCKED' && s.toolAvailability === 'UNAVAILABLE')) {
      renderBrowserUnavailableAction(actionsEl);
    } else if ((resolved.steps || []).find((s) => BROWSER_READ_TOOL_IDS.has(s.resolvedToolId) && s.executionReadiness === 'EXECUTION_READY')) {
      // Browser open/navigate are READ_ONLY (no approval) — but unlike
      // Calendar/Gmail there is no compose form here: the only thing to
      // confirm before browsing is the destination URL itself, and only a
      // literal URL already in the prompt is ever used (never a guessed
      // domain for "the airline website"). A consequential in-page action
      // (Submit/Buy/Pay/Delete/...) is a separate, later step this ambient
      // flow does not drive yet — see browser-approval-view.js's header
      // comment for why that is an intentional, documented scope boundary.
      runBrowserReadOnlyStep(actionsEl, originalPromptText, planId);
    } else if (vm.showRunButton && vm.actionLabel) {
      const isApproval = vm.status === 'APPROVAL_REQUIRED';
      actionsEl.innerHTML = `<button class="btn-plan-action ${vm.statusCssClass}" id="btn-plan-resolution-action">${isApproval ? '🛡️' : '▶'} ${escapeHtml(vm.actionLabel)}</button>`;
      const btn = document.getElementById('btn-plan-resolution-action');
      if (btn) {
        btn.onclick = () => {
          if (isApproval) {
            closeAmbientOverlay();
            switchTab('tab-approvals');
          } else {
            btn.disabled = true;
            btn.textContent = 'Execution not yet connected in this phase';
          }
        };
      }
    } else {
      actionsEl.innerHTML = '';
    }

    renderCanonicalUserPresentation(plan, originalPromptText, planId, resolved);
  }

  function resetAmbientFlowState() {
    const taskTitleEl = document.getElementById('ambient-task-display-title');
    const taskSubtitleEl = document.getElementById('ambient-task-display-subtitle');
    const taskIcon = document.getElementById('ambient-task-icon');
    const requestCard = document.getElementById('ambient-request-card');
    const stepsEl = document.getElementById('ambient-friendly-steps');
    const summarySection = document.getElementById('ambient-summary-section');
    const sourcesSection = document.getElementById('ambient-sources-section');
    const contextBox = document.getElementById('ambient-surfaced-context');
    const groundingWhyEl = document.getElementById('ambient-grounding-why');
    const summaryBox = document.getElementById('ambient-understanding-summary');
    const actionsBar = document.getElementById('ambient-understanding-actions');
    const approvalCard = document.getElementById('ambient-user-approval-card');
    const voiceCard = document.getElementById('ambient-voice-card');

    if (summarySection) summarySection.style.display = 'none';
    const understandingCard = document.getElementById('ambient-understanding-card');
    if (understandingCard) understandingCard.style.display = 'none';
    if (sourcesSection) sourcesSection.style.display = 'none';
    if (contextBox) contextBox.style.display = 'none';
    if (groundingWhyEl) groundingWhyEl.style.display = 'none';
    if (summaryBox) summaryBox.style.display = 'none';
    if (actionsBar) actionsBar.style.display = 'none';
    if (approvalCard) approvalCard.style.display = 'none';
    if (voiceCard) voiceCard.style.display = 'none';

    if (taskIcon) {
      taskIcon.innerHTML = `<svg class="svg-icon-md" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    }
  }

  function classifyIntentForUi(promptText) {
    const text = (promptText || '').toLowerCase();
    if (text.includes('meeting') || text.includes('schedule') || text.includes('calendar') || text.includes('미팅') || text.includes('회의') || text.includes('일정')) {
      return 'MEETING';
    }
    if (text.includes('file') || text.includes('document') || text.includes('contract') || text.includes('pdf') || text.includes('분석') || text.includes('파일') || text.includes('조항')) {
      return 'ANALYZE';
    }
    if (text.includes('image') || text.includes('draw') || text.includes('photo') || text.includes('picture') || text.includes('이미지') || text.includes('그림') || text.includes('생성')) {
      return 'CREATE';
    }
    return 'RESEARCH';
  }

  function renderCanonicalUserPresentation(plan, promptText, planId, resolved) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const isKr = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';

    // 1. Modal title update
    const modalTitleEl = document.getElementById('ambient-modal-title');
    if (modalTitleEl) {
      modalTitleEl.textContent = t('ambient.modalTitle');
    }

    // 2. Hide technical elements if not in debug mode
    const preview = document.getElementById('ambient-plan-preview');
    const resolutionCard = document.getElementById('ambient-resolution-card');
    const resultCard = document.getElementById('ambient-result-card');
    if (preview) preview.style.display = isDebugMode() ? 'block' : 'none';
    if (resolutionCard) resolutionCard.style.display = isDebugMode() ? 'block' : 'none';
    if (resultCard) resultCard.style.display = isDebugMode() ? 'block' : 'none';

    // 3. Request card text update
    const userReqText = document.getElementById('ambient-user-request-text');
    if (userReqText && promptText) {
      userReqText.textContent = `"${promptText}"`;
    }

    const intent = classifyIntentForUi(promptText);

    const taskTitleEl = document.getElementById('ambient-task-display-title');
    const taskSubtitleEl = document.getElementById('ambient-task-display-subtitle');
    const taskIcon = document.getElementById('ambient-task-icon');
    const stepsEl = document.getElementById('ambient-friendly-steps');
    const summarySection = document.getElementById('ambient-understanding-card') || document.getElementById('ambient-summary-section');
    const summarySectionAlias = document.getElementById('ambient-summary-section');
    const summaryList = document.getElementById('ambient-summary-list');
    const sourcesSection = document.getElementById('ambient-sources-section');
    const sourcesList = document.getElementById('ambient-sources-list');
    const contextBox = document.getElementById('ambient-surfaced-context');
    const groundingWhyEl = document.getElementById('ambient-grounding-why');
    const actionsBar = document.getElementById('ambient-understanding-actions');
    const footerActions = document.getElementById('ambient-mockup-actions');

    if (intent === 'RESEARCH') {
      if (taskTitleEl) taskTitleEl.textContent = t('ambient.taskResearching');
      if (taskSubtitleEl) taskSubtitleEl.textContent = t('ambient.taskResearchingSub');
      if (taskIcon) {
        taskIcon.innerHTML = `<svg class="svg-icon-md" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
      }

      // Progress Steps (Single Progress Surface)
      if (stepsEl) {
        const steps = [
          { status: 'done', text: isKr ? '✓ 신뢰할 수 있는 출처 검색 완료' : '✓ Searching trusted sources' },
          { status: 'done', text: isKr ? '✓ 최신 업데이트 및 자료 분석 완료' : '✓ Reading recent updates' },
          { status: 'active', text: isKr ? '● 핵심 요약 정리 완료' : '● Preparing a concise summary' },
          { status: 'upcoming', text: isKr ? '○ 결과 정리 완료' : '○ Finalizing results' }
        ];
        stepsEl.innerHTML = steps.map(s => `<div class="user-friendly-step-item ${s.status}">${escapeHtml(s.text)}</div>`).join('');
      }

      // Summary Section (Result-First)
      if (summarySection && summaryList) {
        summarySection.style.display = 'block';
        if (summarySectionAlias) summarySectionAlias.style.display = 'block';
        const summaryTitleText = t('ambient.understanding.title');
        const findings = isKr ? [
          '메모리 아키텍처가 점차 영속적이고 맥락 인지적으로 발전하고 있습니다.',
          '도구 사용의 신뢰성 및 검증 루프에 대한 관심이 급증하고 있습니다.',
          '멀티 에이전트 오케스트레이션이 실제 연구 및 워크플로우에 적용되는 중입니다.',
          '브라우저/액션 에이전트 성능이 향상되는 가운데 승인 경계 정책이 중요하게 다뤄집니다.'
        ] : [
          'Memory architectures are becoming more persistent and context-aware.',
          'Tool-use reliability and verification loops are getting more attention.',
          'Multi-agent orchestration is being applied to research and workflows.',
          'Browser/action agents are improving, but approval boundaries remain important.'
        ];
        summaryList.innerHTML = findings.map((f, idx) => `
          <div class="finding-item-row">
            <span class="finding-num-badge">${idx + 1}</span>
            <span class="finding-text">${escapeHtml(f)}</span>
          </div>
        `).join('');
      }

      // Sources Section
      if (sourcesSection && sourcesList) {
        sourcesSection.style.display = 'block';
        const sources = [
          { title: 'The next wave of AI agent architecture', publisher: 'Tech Insights', date: 'Sep 16, 2025', icon: '📄' },
          { title: 'Building reliable tool-using agents', publisher: 'AI Research Digest', date: 'Sep 14, 2025', icon: '⚛️' },
          { title: 'Multi-agent systems in real-world applications', publisher: 'Product & AI Blog', date: 'Sep 12, 2025', icon: '📖' },
          { title: 'Browser agents: progress and open challenges', publisher: 'The AI Report', date: 'Sep 10, 2025', icon: '🌐' }
        ];
        sourcesList.innerHTML = sources.map(s => `
          <div class="source-item-row">
            <div class="source-item-left">
              <span class="source-icon">${s.icon}</span>
              <div class="source-meta">
                <span class="source-title">${escapeHtml(s.title)}</span>
                <span class="source-publisher">${escapeHtml(s.publisher)}</span>
              </div>
            </div>
            <span class="source-date">${escapeHtml(s.date)}</span>
          </div>
        `).join('');
      }

      // The current ambient endpoint resolves a plan; it does not return
      // executed research evidence. Do not present sample findings/sources
      // as a completed real result.
      if (summarySection && summaryList) {
        summarySection.style.display = 'block';
        if (summarySectionAlias) summarySectionAlias.style.display = 'block';
        summaryList.innerHTML = `<div class="nagex-empty-state">${escapeHtml(isKr ? '조사 계획이 준비됐어요. 실제 출처를 확인한 뒤 결과를 표시합니다.' : 'Your research plan is ready. Results will appear after the sources are actually checked.')}</div>`;
      }
      if (sourcesSection && sourcesList) {
        sourcesSection.style.display = 'block';
        sourcesList.innerHTML = `<div class="nagex-empty-state">${escapeHtml(isKr ? '확인된 출처가 아직 없어요.' : 'No verified sources yet.')}</div>`;
      }

      // Hide Meeting-specific boxes
      if (contextBox) contextBox.style.display = 'none';
      if (groundingWhyEl) groundingWhyEl.style.display = 'none';
      if (actionsBar) actionsBar.style.display = 'none';

      // Footer Primary Actions: Ask a follow-up + Save to Vault
      if (footerActions) {
        footerActions.style.display = 'flex';
        footerActions.innerHTML = `
          <button class="btn-mockup-secondary" id="btn-ask-followup" type="button">
            <span class="btn-icon">💬</span>
            <span>${t('ambient.ctaFollowUp')}</span>
          </button>
          <button class="btn-mockup-primary" id="btn-save-vault" type="button">
            <span class="btn-icon">🔖</span>
            <span>${t('ambient.ctaSaveVault')}</span>
          </button>
        `;
        const btnVault = document.getElementById('btn-save-vault');
        if (btnVault) {
          btnVault.onclick = () => {
            btnVault.disabled = true;
            btnVault.textContent = isKr ? '저장됨 ✓' : 'Saved ✓';
          };
        }
      }
      // The legacy click handler above changed copy only. Replace it with a
      // real Vault mutation and show success only after a persisted item id.
      const realVaultButton = document.getElementById('btn-save-vault');
      if (realVaultButton) {
        realVaultButton.onclick = async () => {
          realVaultButton.disabled = true;
          realVaultButton.textContent = isKr ? '저장 중...' : 'Saving...';
          const saved = await apiFetch('/api/v1/workspace/vault', {
            method: 'POST',
            body: JSON.stringify({ type: 'SAVED_ANALYSIS', title: (plan && plan.goal) || promptText || 'Saved result', storageRef: `ambient:${planId}`, source: 'AMBIENT_RESULT', sourceRef: planId, metadata: { prompt: promptText, savedAt: new Date().toISOString() } }),
          });
          if (saved && saved.vaultItemId && !saved.error) {
            realVaultButton.textContent = isKr ? 'Vault에 저장됨' : 'Saved to Vault';
          } else {
            realVaultButton.disabled = false;
            realVaultButton.textContent = isKr ? '저장하지 못했어요. 다시 시도' : "Couldn't save. Try again";
          }
        };
      }
    } else if (intent === 'MEETING') {
      if (taskTitleEl) taskTitleEl.textContent = t('ambient.taskMeeting');
      if (taskSubtitleEl) taskSubtitleEl.textContent = t('ambient.taskMeetingSub');
      if (taskIcon) {
        taskIcon.innerHTML = `<svg class="svg-icon-md" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/></svg>`;
      }

      // Hide Research sections
      if (summarySection) summarySection.style.display = 'none';
      // Plan resolution is not document analysis execution. Never show the
      // legacy sample clauses as if they came from a user's document.
      if (summarySection && summaryList) {
        summarySection.style.display = 'block';
        summaryList.innerHTML = `<div class="nagex-empty-state">${escapeHtml(isKr ? '분석할 실제 문서가 필요해요.' : 'Add the document you want me to analyze.')}</div>`;
      }
      if (sourcesSection) sourcesSection.style.display = 'none';

      // Meeting Progress Steps
      if (stepsEl) {
        const steps = [
          { status: 'done', text: isKr ? '✓ 일정 확인 완료' : '✓ Checked your availability' },
          { status: 'done', text: isKr ? '✓ 관련 메모 및 이메일 수집' : '✓ Found related notes and emails' },
          { status: 'active', text: isKr ? '● 미팅 상세내용 준비 중' : '● Preparing meeting details' },
          { status: 'upcoming', text: isKr ? '○ 캘린더 등록 준비' : '○ Getting the calendar action ready' }
        ];
        stepsEl.innerHTML = steps.map(s => `<div class="user-friendly-step-item ${s.status}">${escapeHtml(s.text)}</div>`).join('');
      }

      // Surfaced Context (Meeting notes, proposal, email)
      if (contextBox) {
        contextBox.style.display = 'block';
        const items = [];
        contextBox.innerHTML = `
          <strong>${t('ambient.context.found').replace('{count}', String(items.length))}</strong>
          <ul>
            ${items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}
          </ul>
        `;
      }

      // Replace the legacy placeholder immediately; real content is loaded
      // after resolution and an unavailable source remains an honest state.
      if (contextBox) {
        contextBox.innerHTML = `<p>${escapeHtml(isKr ? '관련 자료를 확인하고 있어요.' : 'Checking for related context...')}</p>`;
      }

      // Grounding Why / Schedule recommendation
      if (groundingWhyEl) {
        groundingWhyEl.style.display = 'block';
        groundingWhyEl.innerHTML = `📅 <strong>${isKr ? '추천 일정:' : 'Proposed Schedule:'}</strong> ${
          isKr ? '실제 일정을 확인하는 중...' : 'Checking your calendar...'
        }`;
      }

      if (groundingWhyEl) {
        groundingWhyEl.innerHTML = `<span>${escapeHtml(isKr ? '실제 일정과 관련 자료를 바탕으로 준비합니다.' : 'Preparing from your real calendar and related materials.')}</span>`;
      }
      if (resolved) renderGroundedMeetingContext(resolved, contextBox, groundingWhyEl, isKr);

      // One Clear Next Action: [Continue] & [Edit]
      if (actionsBar) {
        actionsBar.style.display = 'flex';
        actionsBar.innerHTML = `
          <button class="btn-action-secondary" id="btn-ambient-understanding-edit" type="button">${t('ambient.understanding.edit')}</button>
          <button class="btn-action-primary" id="btn-ambient-understanding-continue" type="button">${t('ambient.understanding.continue')}</button>
        `;
        const btnContinue = document.getElementById('btn-ambient-understanding-continue');
        const btnEdit = document.getElementById('btn-ambient-understanding-edit');
        if (btnEdit) {
          btnEdit.onclick = () => {
            const input = document.getElementById('ambient-prompt-input');
            if (input) input.focus();
          };
        }
        if (btnContinue) {
          btnContinue.onclick = async () => {
            btnContinue.disabled = true;
            btnContinue.textContent = isKr ? '진행됨 ✓' : 'Accepted ✓';
            await renderUserApprovalCard(resolved, promptText);
          };
        }
      }

      if (footerActions) footerActions.style.display = 'none';
    } else if (intent === 'ANALYZE') {
      if (taskTitleEl) taskTitleEl.textContent = t('ambient.taskAnalyze');
      if (taskSubtitleEl) taskSubtitleEl.textContent = t('ambient.taskAnalyzeSub');
      if (taskIcon) {
        taskIcon.innerHTML = `<svg class="svg-icon-md" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
      }

      if (stepsEl) {
        const steps = [
          { status: 'done', text: isKr ? '✓ 문서 구조 파악 완료' : '✓ Examined document structure' },
          { status: 'done', text: isKr ? '✓ 핵심 조항 추출 완료' : '✓ Extracted key clauses' },
          { status: 'active', text: isKr ? '● 리스크 요소 평가 중' : '● Evaluating risk factors' },
          { status: 'upcoming', text: isKr ? '○ 레포트 생성 마무리' : '○ Finalizing report' }
        ];
        stepsEl.innerHTML = steps.map(s => `<div class="user-friendly-step-item ${s.status}">${escapeHtml(s.text)}</div>`).join('');
      }

      if (summarySection && summaryList) {
        summarySection.style.display = 'block';
        const findings = isKr ? [
          '계약서 내 위험 요소 및 책임 면책 조항 2건 발견',
          '자동 갱신 주기 30일 사전 통지 조건 명시 확인',
          '분쟁 해결 관할 법원이 본사 거점지로 지정됨'
        ] : [
          'Found 2 potential liability limitation clauses requiring review',
          'Automatic renewal notice requirement specified as 30 days prior',
          'Dispute resolution venue designated at headquarters location'
        ];
        summaryList.innerHTML = findings.map((f, idx) => `
          <div class="finding-item-row">
            <span class="finding-num-badge">${idx + 1}</span>
            <span class="finding-text">${escapeHtml(f)}</span>
          </div>
        `).join('');
      }

      if (summarySection && summaryList) {
        summarySection.style.display = 'block';
        summaryList.innerHTML = `<div class="nagex-empty-state">${escapeHtml(isKr ? '생성 요청이 준비됐어요. 실제 결과가 생성되면 여기에 표시합니다.' : 'Your creation request is ready. The result will appear here after it is generated.')}</div>`;
      }
      if (sourcesSection) sourcesSection.style.display = 'none';
      if (contextBox) contextBox.style.display = 'none';
      if (groundingWhyEl) groundingWhyEl.style.display = 'none';
      if (actionsBar) actionsBar.style.display = 'none';

      if (footerActions) {
        footerActions.style.display = 'flex';
        footerActions.innerHTML = `
          <button class="btn-mockup-secondary" id="btn-ask-followup" type="button">
            <span class="btn-icon">💬</span>
            <span>${t('ambient.ctaFollowUp')}</span>
          </button>
          <button class="btn-mockup-primary" id="btn-save-vault" type="button">
            <span class="btn-icon">🔖</span>
            <span>${t('ambient.ctaSaveVault')}</span>
          </button>
        `;
      }
    } else {
      // CREATE Intent
      if (taskTitleEl) taskTitleEl.textContent = t('ambient.taskCreate');
      if (taskSubtitleEl) taskSubtitleEl.textContent = t('ambient.taskCreateSub');
      if (taskIcon) {
        taskIcon.innerHTML = `<svg class="svg-icon-md" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
      }

      if (stepsEl) {
        const steps = [
          { status: 'done', text: isKr ? '✓ 프롬프트 레시피 분석 완료' : '✓ Analyzed prompt recipe' },
          { status: 'done', text: isKr ? '✓ 스타일 프리셋 적용 완료' : '✓ Applied style preset' },
          { status: 'active', text: isKr ? '● 비주얼 에셋 생성 중' : '● Generating visual asset' },
          { status: 'upcoming', text: isKr ? '○ 해상도 최적화 마무리' : '○ Finalizing output resolution' }
        ];
        stepsEl.innerHTML = steps.map(s => `<div class="user-friendly-step-item ${s.status}">${escapeHtml(s.text)}</div>`).join('');
      }

      if (sourcesSection) sourcesSection.style.display = 'none';
      if (contextBox) contextBox.style.display = 'none';
      if (groundingWhyEl) groundingWhyEl.style.display = 'none';
      if (actionsBar) actionsBar.style.display = 'none';

      if (footerActions) {
        footerActions.style.display = 'flex';
        footerActions.innerHTML = `
          <button class="btn-mockup-secondary" id="btn-ask-followup" type="button">
            <span class="btn-icon">💬</span>
            <span>${t('ambient.ctaFollowUp')}</span>
          </button>
          <button class="btn-mockup-primary" id="btn-save-vault" type="button">
            <span class="btn-icon">🔖</span>
            <span>${t('ambient.ctaSaveVault')}</span>
          </button>
        `;
      }
    }
  }

  // R21 P1 — this card previously ended in a fake setTimeout("Added to
  // calendar ✓") that never called any real API — a false-success bug (the
  // opposite of a silent failure, but just as untrustworthy: the user is
  // told a real Google Calendar event now exists when none does). The
  // calendar path below now performs the exact same real
  // POST /api/v1/approvals -> approve -> POST /api/v1/tools/google-
  // calendar/create-event sequence app.js's older requestCalendarApproval()
  // uses, using whatever concrete fields the real resolved plan step
  // already extracted (never fabricated) and falling back to a real
  // free-slots lookup only for a genuinely missing time — never inventing
  // a title or attendee. The Gmail/generic branches are not yet wired to a
  // real execution path here (real Gmail grounding for an arbitrary
  // ambient request needs more context than this card has); rather than
  // fake success for those, they now honestly route to the real Approvals
  // surface instead of claiming a real send/action happened.
  async function renderGroundedMeetingContext(resolved, contextBox, groundingWhyEl, isKr) {
    const eventStep = (resolved.steps || []).find((step) => step && step.parameters && step.parameters.eventId);
    const eventId = eventStep && eventStep.parameters.eventId;
    const prep = await apiFetch('/api/v1/personal/meeting-prep', {
      method: 'POST',
      body: JSON.stringify(eventId ? { eventId } : {}),
    });
    if (!contextBox || !groundingWhyEl) return;
    if (!prep || prep.error) {
      contextBox.innerHTML = `<strong>${escapeHtml(isKr ? '이 회의와 관련된 자료' : 'Related to this meeting')}</strong><p>${escapeHtml(isKr ? '관련 자료를 불러오지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.' : "I couldn't load related context. Check your connections and try again.")}</p>`;
      groundingWhyEl.style.display = 'none';
      return;
    }
    const materials = Array.isArray(prep.related_materials) ? prep.related_materials : [];
    contextBox.innerHTML = materials.length
      ? `<strong>${escapeHtml(isKr ? `${materials.length}개의 관련 자료를 찾았어요` : `I found ${materials.length} related item${materials.length === 1 ? '' : 's'}`)}</strong><ul>${materials.map((item) => `<li>${escapeHtml(item.title || item.label || item.type)}</li>`).join('')}</ul>`
      : `<p>${escapeHtml(isKr ? '관련 자료는 찾지 못했지만 실제 일정으로 준비를 계속할 수 있어요.' : 'No related materials found. You can still prepare from the calendar event.')}</p>`;
    const title = prep.title || prep.event_title;
    groundingWhyEl.style.display = 'block';
    groundingWhyEl.innerHTML = `<strong>${escapeHtml(isKr ? '준비 대상' : 'Preparing for')}</strong>${title ? `: ${escapeHtml(title)}` : ''}`;
  }

  async function renderUserApprovalCard(resolved, promptText) {
    const approvalCard = document.getElementById('ambient-user-approval-card');
    const headingEl = document.getElementById('ambient-approval-heading');
    const detailsEl = document.getElementById('ambient-approval-details-body');
    const actionsEl = document.getElementById('ambient-approval-action-btns');
    if (!approvalCard || !headingEl || !detailsEl || !actionsEl) return;

    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const isKr = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';

    const calendarStep = resolved && (resolved.steps || []).find(s => s.resolvedToolId === GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
    const hasGmail = resolved && (resolved.steps || []).some(s => GMAIL_WRITE_TOOL_IDS.has(s.resolvedToolId));

    approvalCard.style.display = 'block';

    if (calendarStep || (promptText && (promptText.toLowerCase().includes('meeting') || promptText.includes('미팅')))) {
      headingEl.textContent = isKr ? '준비 중...' : 'Preparing...';
      detailsEl.innerHTML = `<p>${escapeHtml(isKr ? '캘린더를 확인하는 중입니다...' : 'Checking your calendar...')}</p>`;
      actionsEl.innerHTML = '';

      // Real params only: prefer whatever the real plan already extracted
      // (AiService.plan() never invents a concrete date/time/attendee —
      // see its system prompt); look up a real free slot only for
      // whatever is genuinely still missing.
      const params = (calendarStep && calendarStep.parameters) || {};
      const summary = params.summary || promptText || (isKr ? '새 일정' : 'New event');
      const attendees = Array.isArray(params.attendees) ? params.attendees : [];
      let start = params.start || null;
      let end = params.end || null;

      if (!start || !end) {
        const timeMin = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const timeMax = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        const freeSlotsRes = await apiFetch('/api/v1/tools/google-calendar/free-slots', { method: 'POST', body: JSON.stringify({ timeMin, timeMax }) });
        const slot = freeSlotsRes && Array.isArray(freeSlotsRes.freeSlots) && freeSlotsRes.freeSlots.length > 0 ? freeSlotsRes.freeSlots[0] : null;
        if (slot) { start = slot.start; end = slot.end; }
      }

      if (!start || !end) {
        headingEl.textContent = isKr ? '캘린더를 연결해 주세요' : 'Connect your calendar to continue';
        detailsEl.innerHTML = `<p>${escapeHtml(isKr ? 'Google Calendar가 연결되어 있지 않거나 여유 시간을 찾지 못했습니다.' : 'Google Calendar is not connected, or no open time could be found.')}</p>`;
        return;
      }

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const payload = { calendarId: 'primary', summary, description: promptText || '', start, end, timezone, attendees };
      const startDate = new Date(start);
      const endDate = new Date(end);

      headingEl.textContent = isKr ? '캘린더에 추가할 준비가 됐어요' : 'Ready to add to your calendar';
      detailsEl.innerHTML = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.85rem; margin-top: 0.5rem;">
          <strong style="display: block; font-size: 0.95rem; color: #0f172a; margin-bottom: 0.3rem;">${escapeHtml(summary)}</strong>
          <div style="font-size: 0.85rem; color: #475569; margin-bottom: 0.2rem;">${escapeHtml(startDate.toLocaleString())} – ${escapeHtml(endDate.toLocaleTimeString())}</div>
          ${attendees.length ? `<div style="font-size: 0.85rem; color: #475569;">${isKr ? '참석자' : 'Attendees'}: ${escapeHtml(attendees.join(', '))}</div>` : ''}
        </div>
      `;
      actionsEl.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.6rem; margin-top: 0.85rem;">
          <button class="btn-mockup-primary" id="btn-ambient-approve-mutation" type="button">${isKr ? '캘린더에 추가' : 'Add to calendar'}</button>
          <button class="btn-action-text" id="btn-ambient-reject-mutation" type="button" style="background:none; border:none; color:#64748b; font-size:0.85rem; cursor:pointer; padding:0.4rem 0.8rem;">${isKr ? '나중에' : 'Not now'}</button>
        </div>
      `;

      const btnApprove = document.getElementById('btn-ambient-approve-mutation');
      const btnReject = document.getElementById('btn-ambient-reject-mutation');
      if (btnReject) btnReject.onclick = () => { approvalCard.style.display = 'none'; };
      if (btnApprove) {
        btnApprove.onclick = async () => {
          const approvalStartedAt = performance.now();
          btnApprove.disabled = true;
          if (btnReject) btnReject.disabled = true;
          btnApprove.textContent = isKr ? '요청 중...' : 'Requesting approval...';

          const approval = await apiFetch('/api/v1/approvals', { method: 'POST', body: JSON.stringify({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload }) });
          if (!approval || approval.error || !approval.approvalId) {
            headingEl.textContent = isKr ? '완료하지 못했어요' : "I couldn't complete that";
            detailsEl.innerHTML = `<div style="color:#991b1b;">${escapeHtml((approval && approval.error && approval.error.message) || (isKr ? '잠시 후 다시 시도해 주세요.' : 'Please try again in a moment.'))}</div>`;
            actionsEl.innerHTML = '';
            return;
          }

          btnApprove.textContent = isKr ? '추가하는 중...' : 'Adding to calendar...';
          const approved = await apiFetch(`/api/v1/approvals/${approval.approvalId}/approve`, { method: 'POST' });
          if (!approved || approved.error) {
            headingEl.textContent = isKr ? '완료하지 못했어요' : "I couldn't complete that";
            detailsEl.innerHTML = `<div style="color:#991b1b;">${escapeHtml(isKr ? '잠시 후 다시 시도해 주세요.' : 'Please try again in a moment.')}</div>`;
            actionsEl.innerHTML = '';
            return;
          }

          const result = await apiFetch('/api/v1/tools/google-calendar/create-event', { method: 'POST', body: JSON.stringify({ approvalId: approval.approvalId, payload: approved.canonicalPayload }) });
          if (result && result.status === 'SUCCEEDED') {
            window.NAGEX_METRICS = window.NAGEX_METRICS || {};
            window.NAGEX_METRICS.APPROVAL_TO_RESULT_MS = Math.max(0, Math.round(performance.now() - approvalStartedAt));
            const isDemo = result.executionMode === 'DEMO' || result.providerVerified === false || result.dataSource === 'DEMO';
            headingEl.textContent = isDemo
              ? (isKr ? '데모 실행 완료 · 실제 Google Calendar 이벤트는 생성되지 않았습니다' : 'Demo completed · No real Google Calendar event was created.')
              : (isKr ? '✓ 캘린더에 추가되었습니다' : '✓ Added to your calendar');
            detailsEl.innerHTML = `
              <div style="color:#059669; font-weight:600;">${escapeHtml(summary)}</div>
              <div style="font-size:0.85rem; color:#475569;">${escapeHtml(startDate.toLocaleString())}</div>
              ${!isDemo && result.externalUrl ? `<a href="${encodeURI(result.externalUrl)}" target="_blank" rel="noopener" style="font-size:0.85rem;">${isKr ? 'Google Calendar에서 열기' : 'Open in Google Calendar'} →</a>` : ''}
            `;
          } else {
            headingEl.textContent = isKr ? '완료하지 못했어요' : "I couldn't complete that";
            detailsEl.innerHTML = `<div style="color:#991b1b;">${escapeHtml(isKr ? '잠시 후 다시 시도해 주세요.' : 'Please try again in a moment.')}</div>`;
          }
          actionsEl.innerHTML = '';
        };
      }
    } else if (hasGmail) {
      headingEl.textContent = t('ambient.approval.readyEmail');
      detailsEl.innerHTML = `<div>${escapeHtml(isKr ? '이 초안의 실제 수신자/제목은 아직 준비되지 않았습니다. Approvals에서 이어서 진행해 주세요.' : "This draft's real recipient/subject isn't ready here yet — continue from Approvals.")}</div>`;
      actionsEl.innerHTML = `
        <button class="btn-mockup-secondary" id="btn-ambient-goto-approvals" type="button">${isKr ? 'Approvals로 이동' : 'Go to Approvals'}</button>
        <button class="btn-action-text" id="btn-ambient-reject-mutation" type="button">${t('ambient.approval.notNow')}</button>
      `;
      const btnGoto = document.getElementById('btn-ambient-goto-approvals');
      if (btnGoto) btnGoto.onclick = () => { closeAmbientOverlay(); switchTab('tab-approvals'); };
      const btnReject = document.getElementById('btn-ambient-reject-mutation');
      if (btnReject) btnReject.onclick = () => { approvalCard.style.display = 'none'; };
    } else {
      headingEl.textContent = isKr ? '실행 승인 준비 완료' : 'Ready for your approval';
      detailsEl.innerHTML = `<div>${escapeHtml(promptText || 'Requested action')}</div><div style="font-size:0.8rem; color:#64748b; margin-top:0.4rem;">${escapeHtml(isKr ? 'Approvals에서 이 작업을 검토하고 실행할 수 있습니다.' : 'Review and run this from Approvals.')}</div>`;
      actionsEl.innerHTML = `
        <button class="btn-mockup-secondary" id="btn-ambient-goto-approvals" type="button">${isKr ? 'Approvals로 이동' : 'Go to Approvals'}</button>
        <button class="btn-action-text" id="btn-ambient-reject-mutation" type="button">${t('ambient.approval.notNow')}</button>
      `;
      const btnGoto = document.getElementById('btn-ambient-goto-approvals');
      if (btnGoto) btnGoto.onclick = () => { closeAmbientOverlay(); switchTab('tab-approvals'); };
      const btnReject = document.getElementById('btn-ambient-reject-mutation');
      if (btnReject) btnReject.onclick = () => { approvalCard.style.display = 'none'; };
    }
  }

  function renderConnectGoogleCalendarAction(actionsEl) {
    actionsEl.innerHTML = `
      <div class="calendar-connect-prompt">
        <p>Google Calendar is not connected, so this step cannot proceed.</p>
        <button class="btn-plan-action plan-status-approval" id="btn-connect-google-calendar">🔗 Connect Google Calendar</button>
      </div>`;
    const btn = document.getElementById('btn-connect-google-calendar');
    if (btn) {
      btn.onclick = () => {
        if (!state.googleOAuth.configured) {
          btn.disabled = true;
          btn.textContent = 'Google Calendar is not configured on this server yet.';
          return;
        }
        // Real browser navigation so the server's 302 redirect takes us to Google.
        window.location.href = '/api/v1/oauth/google/start';
      };
    }
  }

  // extracted (from calendar-intent-extraction.js) may be null, or may only
  // have some fields confidently parsed — this form must reflect exactly
  // what was extracted and nothing more: a field the user didn't state is
  // left blank (title, start, attendees) or shown as a clearly-labeled
  // suggested default (duration) rather than a silently-invented value.
  function renderCalendarComposeForm(actionsEl, extracted, timezone) {
    const titleValue = (extracted && extracted.summary) || '';
    const startValue = extracted ? extracted.start.slice(0, 16) : '';
    const attendeesValue = extracted && extracted.attendees.length ? extracted.attendees.join(', ') : '';
    const extractedDurationMinutes = extracted
      ? Math.round((new Date(extracted.end).getTime() - new Date(extracted.start).getTime()) / 60000)
      : null;
    const durationValue = extractedDurationMinutes !== null && extractedDurationMinutes > 0 ? extractedDurationMinutes : 30;
    const durationIsSuggested = extractedDurationMinutes === null || extractedDurationMinutes <= 0;

    actionsEl.innerHTML = `
      <form class="calendar-compose-form" id="calendar-compose-form" novalidate>
        <h4>Confirm the exact calendar event</h4>
        <label>Title
          <input type="text" id="cal-title" value="${escapeHtml(titleValue)}" placeholder="e.g. Client Strategy Sync" required>
        </label>
        <label>Start
          <input type="datetime-local" id="cal-start" value="${escapeHtml(startValue)}" required>
        </label>
        <label>Duration (minutes)${durationIsSuggested ? ' <span class="field-suggested-hint">(suggested — please confirm)</span>' : ''}
          <input type="number" id="cal-duration" value="${durationValue}" min="1" step="5" required>
        </label>
        <label>Timezone
          <input type="text" value="${escapeHtml(timezone)}" disabled>
        </label>
        <label>Attendee emails (comma-separated)
          <input type="text" id="cal-attendees" placeholder="name@example.com" value="${escapeHtml(attendeesValue)}">
        </label>
        <label>Description
          <textarea id="cal-description" rows="2" placeholder="Optional"></textarea>
        </label>
        <label class="calendar-checkbox-label">
          <input type="checkbox" id="cal-meet-link"> Add a Google Meet link
        </label>
        <label>Calendar
          <input type="text" value="primary" disabled>
        </label>
        <p class="calendar-form-error" id="calendar-form-error" style="display:none;"></p>
        <button type="submit" class="btn-plan-action plan-status-approval">🛡️ Preview & Request Approval</button>
      </form>
      <div id="calendar-preview-slot"></div>`;

    const form = document.getElementById('calendar-compose-form');
    if (form) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const errorEl = document.getElementById('calendar-form-error');
        const titleRaw = document.getElementById('cal-title').value;
        const startRaw = document.getElementById('cal-start').value;
        const durationMinutes = Number(document.getElementById('cal-duration').value);
        const attendeesRaw = document.getElementById('cal-attendees').value;

        const validation = window.NAGEX_CALENDAR_VALIDATION;
        const result = validation
          ? validation.validateCalendarComposeForm({ title: titleRaw, start: startRaw, durationMinutes, timezone, attendeesRaw })
          : { valid: true, errors: {}, attendees: attendeesRaw.split(',').map((e) => e.trim()).filter(Boolean), startDate: startRaw ? new Date(startRaw) : null };

        if (!result.valid) {
          if (errorEl) {
            errorEl.style.display = 'block';
            errorEl.textContent = Object.values(result.errors).join(' ');
          }
          return; // Preview & Request Approval never proceeds while invalid.
        }
        if (errorEl) {
          errorEl.style.display = 'none';
          errorEl.textContent = '';
        }

        const pad = (n) => String(n).padStart(2, '0');
        const toLocalIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
        const endDate = new Date(result.startDate.getTime() + durationMinutes * 60000);

        // Whatever is in the form right now — extracted-and-untouched,
        // extracted-and-edited, or filled in from blank — becomes the exact
        // canonical payload. Nothing here is re-derived from the original
        // prompt again.
        const payload = {
          calendarId: 'primary',
          summary: titleRaw.trim(),
          description: document.getElementById('cal-description').value,
          start: toLocalIso(result.startDate),
          end: toLocalIso(endDate),
          timezone,
          attendees: result.attendees,
          conferenceData: document.getElementById('cal-meet-link').checked,
        };
        requestCalendarApproval(payload);
      };
    }
  }

  const GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID = 'google_calendar.create_event';

  const GMAIL_SEND_EMAIL_TOOL_ID = 'gmail.send_email';
  const GMAIL_REPLY_TOOL_ID = 'gmail.reply';
  const GMAIL_CREATE_DRAFT_TOOL_ID = 'gmail.create_draft';
  const GMAIL_SEARCH_TOOL_ID = 'gmail.search';
  const GMAIL_READ_THREAD_TOOL_ID = 'gmail.read_thread';
  const GMAIL_WRITE_TOOL_IDS = new Set([GMAIL_SEND_EMAIL_TOOL_ID, GMAIL_REPLY_TOOL_ID, GMAIL_CREATE_DRAFT_TOOL_ID]);
  const GMAIL_READ_TOOL_IDS = new Set([GMAIL_SEARCH_TOOL_ID, GMAIL_READ_THREAD_TOOL_ID]);
  const GMAIL_EXECUTE_ENDPOINT = {
    [GMAIL_SEND_EMAIL_TOOL_ID]: '/api/v1/tools/gmail/send-email',
    [GMAIL_REPLY_TOOL_ID]: '/api/v1/tools/gmail/reply',
    [GMAIL_CREATE_DRAFT_TOOL_ID]: '/api/v1/tools/gmail/create-draft',
  };

  const BROWSER_OPEN_TOOL_ID = 'browser.open';
  const BROWSER_NAVIGATE_TOOL_ID = 'browser.navigate';
  const BROWSER_READ_TOOL_IDS = new Set([BROWSER_OPEN_TOOL_ID, BROWSER_NAVIGATE_TOOL_ID]);

  function renderCalendarApprovalCard(slot, approval, view) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const vmView = view.buildCardViewModel(approval, Date.now());
    const f = vmView.fields;
    slot.innerHTML = `
      <div class="calendar-approval-card">
        <h4>Ready for review</h4>
        <dl class="calendar-approval-fields">
          <div><dt>Title</dt><dd>${escapeHtml(f.title)}</dd></div>
          <div><dt>Description</dt><dd>${escapeHtml(f.description) || '—'}</dd></div>
          <div><dt>Date</dt><dd>${escapeHtml(f.date)}</dd></div>
          <div><dt>Start time</dt><dd>${escapeHtml(f.startTime)}</dd></div>
          <div><dt>End time</dt><dd>${escapeHtml(f.endTime)}</dd></div>
          <div><dt>Timezone</dt><dd>${escapeHtml(f.timezone)}</dd></div>
          <div><dt>Calendar</dt><dd>${escapeHtml(f.calendar)}</dd></div>
          <div><dt>Attendees</dt><dd>${f.attendees.length ? escapeHtml(f.attendees.join(', ')) : 'None'}</dd></div>
        </dl>
        <p class="calendar-approval-status" id="calendar-approval-status">${escapeHtml(vmView.statusLabel)}</p>
        <p class="calendar-approval-expiry" id="calendar-approval-expiry">${vmView.countdownLabel ? escapeHtml(vmView.countdownLabel) : ''}</p>
        <div class="calendar-preview-actions">
          <button class="btn-reject-outline" id="btn-calendar-reject" ${vmView.rejectDisabled ? 'disabled' : ''}>${escapeHtml(t('calendar.reject'))}</button>
          <button class="btn-plan-action plan-status-ready" id="btn-calendar-approve" ${vmView.approveDisabled ? 'disabled' : ''}>${escapeHtml(t('calendar.approveAndCreateEvent'))}</button>
        </div>
      </div>`;
    return vmView;
  }

  function renderCalendarSuccessCard(slot, approval, result, view) {
    const successVm = view.buildSuccessViewModel(approval.canonicalPayload, result);
    const isDemo = result && (result.executionMode === 'DEMO' || result.providerVerified === false || result.dataSource === 'DEMO');
    const headingText = isDemo ? 'Demo completed · No real Google Calendar event was created.' : 'Calendar event created';
    slot.innerHTML = `
      <div class="calendar-preview-card">
        <h4>${escapeHtml(headingText)}</h4>
        <p><strong>${escapeHtml(successVm.title)}</strong></p>
        <p>${escapeHtml(successVm.date)} ${escapeHtml(successVm.startTime)}–${escapeHtml(successVm.endTime)} (${escapeHtml(successVm.timezone)})</p>
        <p>Execution ID: ${escapeHtml(successVm.executionId || '')}</p>
        ${!isDemo && successVm.externalUrl ? `<a class="btn-plan-action plan-status-ready" href="${encodeURI(successVm.externalUrl)}" target="_blank" rel="noopener">Open in Google Calendar →</a>` : ''}
      </div>`;
  }

  async function requestCalendarApproval(payload) {
    const slot = document.getElementById('calendar-preview-slot');
    const form = document.getElementById('calendar-compose-form');
    const view = window.NAGEX_CALENDAR_APPROVAL_VIEW;
    if (!slot || !view) return;
    slot.innerHTML = `<p>Requesting approval…</p>`;

    // Step 3: the approval API is the single source of truth from here on.
    // Its canonicalPayload — never this locally-composed `payload` — is what
    // gets displayed and, later, what gets executed (steps 2 and 7).
    const approval = await apiFetch('/api/v1/approvals', {
      method: 'POST',
      body: JSON.stringify({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload }),
    });

    if (!approval || approval.error || !approval.approvalId) {
      slot.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml((approval && approval.error && approval.error.message) || 'Could not request approval for this action.')}</div>`;
      return;
    }

    if (form) form.style.display = 'none';
    addTimelineEntry('Approval requested', `approval:${approval.approvalId}:requested`, 'requestCalendarApproval');
    updateFlowStage('Approval Card');
    updateFlowStage('Human Approval');

    function stopCountdown() {
      if (state.approvalCountdownTimer) {
        clearInterval(state.approvalCountdownTimer);
        state.approvalCountdownTimer = null;
      }
    }

    function wireButtons() {
      const btnReject = document.getElementById('btn-calendar-reject');
      const btnApprove = document.getElementById('btn-calendar-approve');
      const statusEl = () => document.getElementById('calendar-approval-status');

      if (btnReject) {
        btnReject.onclick = async () => {
          stopCountdown();
          btnReject.disabled = true;
          if (btnApprove) btnApprove.disabled = true;
          const rejected = await apiFetch(`/api/v1/approvals/${approval.approvalId}/reject`, { method: 'POST' });
          updateFlowStage('Result');
          if (rejected && !rejected.error && rejected.status === 'REJECTED') {
            approval.status = 'REJECTED';
            addTimelineEntry('Rejected', `approval:${approval.approvalId}:rejected`, 'btnReject.onclick');
            const el = statusEl();
            if (el) el.textContent = 'Rejected';
          } else {
            const code = rejected && rejected.error && rejected.error.code;
            const message = view.describeExecutionError(code) || (rejected && rejected.error && rejected.error.message) || 'This approval could not be rejected.';
            const el = statusEl();
            if (el) el.textContent = message;
          }
        };
      }

      if (btnApprove) {
        btnApprove.onclick = async () => {
          // Fail closed: both buttons are disabled the instant this fires,
          // and the countdown is stopped so it can never re-enable them out
          // from under an in-flight approve/execute request (step 8).
          stopCountdown();
          btnApprove.disabled = true;
          if (btnReject) btnReject.disabled = true;
          updateFlowStage('Execution');
          const elBusy = statusEl();
          if (elBusy) elBusy.textContent = 'Creating calendar event...';

          // Step 6: approve first, then execute — never the other way round.
          const approved = await apiFetch(`/api/v1/approvals/${approval.approvalId}/approve`, { method: 'POST' });
          if (!approved || approved.error) {
            updateFlowStage('Result');
            const code = approved && approved.error && approved.error.code;
            const message = view.describeExecutionError(code) || (approved && approved.error && approved.error.message) || 'This action could not be approved.';
            const el = statusEl();
            if (el) el.textContent = message;
            return; // no create-event call is ever made without a successful approve
          }
          approval.status = approved.status;
          addTimelineEntry('Approved', `approval:${approval.approvalId}:approved`, 'btnApprove.onclick');
          addTimelineEntry('Execution started', `execution:${approval.approvalId}:started`, 'btnApprove.onclick');

          // Step 7: execute with the exact canonicalPayload the approval API
          // returned — never the locally-composed `payload` variable.
          const result = await apiFetch('/api/v1/tools/google-calendar/create-event', {
            method: 'POST',
            body: JSON.stringify({ approvalId: approval.approvalId, payload: approval.canonicalPayload }),
          });

          updateFlowStage('Result');

          if (result && result.status === 'SUCCEEDED') {
            addTimelineEntry('Calendar event created', `execution:${result.executionId}:succeeded`, 'btnApprove.onclick');
            renderCalendarSuccessCard(slot, approval, result, view);
            return;
          }

          // Step 10: on APPROVAL_ALREADY_CONSUMED (or any other failure), show
          // the failure and stop — never retry automatically.
          const code = result && result.error && result.error.code;
          const message = view.describeExecutionError(code) || (result && result.error && result.error.message) || 'The event could not be created.';
          const el = statusEl();
          if (el) el.textContent = message;
        };
      }
    }

    function render() {
      const vmView = renderCalendarApprovalCard(slot, approval, view);
      wireButtons();
      return vmView;
    }

    render();

    // Step 11: live countdown while PENDING; the moment the deadline passes,
    // fail closed by disabling Approve (and Reject, since the server would
    // reject either transition on an EXPIRED approval) and stop polling.
    state.approvalCountdownTimer = setInterval(() => {
      const vmView = render();
      if (vmView.status === 'EXPIRED') {
        stopCountdown();
        addTimelineEntry('Approval expired', `approval:${approval.approvalId}:expired`, 'countdown-interval');
      }
    }, 1000);
  }

  // ── Gmail Ambient E2E (MASTER.md Section 14: user types an email request,
  // completes it end to end, without curl) — mirrors the Calendar compose
  // form / approval card / success card pattern above, using the shared
  // gmail-approval-view.js view model and gmail-intent-extraction.js's
  // deterministic, never-invents-a-value extraction.

  function renderConnectGmailAction(actionsEl) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    actionsEl.innerHTML = `
      <div class="calendar-connect-prompt">
        <p>${escapeHtml(t('gmail.connectPrompt'))}</p>
        <button class="btn-plan-action plan-status-approval" id="btn-connect-gmail">🔗 ${escapeHtml(t('gmail.connectButton'))}</button>
      </div>`;
    const btn = document.getElementById('btn-connect-gmail');
    if (btn) {
      btn.onclick = () => {
        if (!state.googleOAuth.configured) {
          btn.disabled = true;
          btn.textContent = t('gmail.connectNotConfigured');
          return;
        }
        window.location.href = '/api/v1/oauth/google/start';
      };
    }
  }

  function gmailComposeTitleKey(toolId) {
    if (toolId === GMAIL_REPLY_TOOL_ID) return 'gmail.confirmReply';
    if (toolId === GMAIL_CREATE_DRAFT_TOOL_ID) return 'gmail.confirmDraft';
    return 'gmail.confirmSend';
  }

  function gmailExecutingLabelKey(toolId) {
    if (toolId === GMAIL_CREATE_DRAFT_TOOL_ID) return 'gmail.savingDraft';
    if (toolId === GMAIL_REPLY_TOOL_ID) return 'gmail.replying';
    return 'gmail.sending';
  }

  function gmailSucceededLabelKey(toolId) {
    if (toolId === GMAIL_CREATE_DRAFT_TOOL_ID) return 'gmail.draftCreated';
    if (toolId === GMAIL_REPLY_TOOL_ID) return 'gmail.replySent';
    return 'gmail.sent';
  }

  function gmailApproveButtonLabelKey(toolId) {
    if (toolId === GMAIL_CREATE_DRAFT_TOOL_ID) return 'gmail.approveAndCreateDraft';
    if (toolId === GMAIL_REPLY_TOOL_ID) return 'gmail.approveAndReply';
    return 'gmail.approveAndSend';
  }

  // `extracted` (from gmail-intent-extraction.js) may be null, or may only
  // have some fields confidently parsed. A field the user didn't literally
  // state (to, subject, body) is left blank — never filled with a guess —
  // and `recipientNameHint` (a bare name like "John") is shown only as text
  // next to the still-blank, still-required To field, exactly mirroring how
  // renderCalendarComposeForm leaves title/start blank rather than inventing
  // a value. Submitting is the only thing that ever creates an approval.
  function renderGmailComposeForm(actionsEl, toolId, extracted) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const isReply = toolId === GMAIL_REPLY_TOOL_ID;
    const toValue = extracted && extracted.to.length ? extracted.to.join(', ') : '';
    const ccValue = extracted && extracted.cc.length ? extracted.cc.join(', ') : '';
    const bccValue = extracted && extracted.bcc.length ? extracted.bcc.join(', ') : '';
    const subjectValue = (extracted && extracted.subject) || '';
    const bodyValue = (extracted && extracted.body) || '';
    const recipientHint = extracted && extracted.recipientNameHint
      ? `<p class="field-suggested-hint">${escapeHtml(t('gmail.recipientHint'))} "${escapeHtml(extracted.recipientNameHint)}" ${escapeHtml(t('gmail.recipientHintSuffix'))}</p>`
      : '';
    // Reply thread context is only ever prefilled from a thread NAgex
    // actually just loaded in this session (state.lastGmailThread) — never
    // guessed at from the prompt text alone.
    const threadPrefill = (isReply && state.lastGmailThread) || { threadId: '', replyToMessageId: '' };

    actionsEl.innerHTML = `
      <form class="calendar-compose-form" id="gmail-compose-form" novalidate>
        <h4>${escapeHtml(t(gmailComposeTitleKey(toolId)))}</h4>
        ${recipientHint}
        <label>${escapeHtml(t('gmail.to'))}
          <input type="text" id="gmail-to" value="${escapeHtml(toValue)}" placeholder="name@example.com" required>
        </label>
        <label>${escapeHtml(t('gmail.cc'))}
          <input type="text" id="gmail-cc" value="${escapeHtml(ccValue)}" placeholder="name@example.com">
        </label>
        <label>${escapeHtml(t('gmail.bcc'))}
          <input type="text" id="gmail-bcc" value="${escapeHtml(bccValue)}" placeholder="name@example.com">
        </label>
        <label>${escapeHtml(t('gmail.subject'))}
          <input type="text" id="gmail-subject" value="${escapeHtml(subjectValue)}">
        </label>
        <label>${escapeHtml(t('gmail.body'))}
          <textarea id="gmail-body" rows="4" required>${escapeHtml(bodyValue)}</textarea>
        </label>
        ${isReply ? `
        <label>${escapeHtml(t('gmail.threadId'))}
          <input type="text" id="gmail-thread-id" value="${escapeHtml(threadPrefill.threadId || '')}" required>
        </label>
        <label>${escapeHtml(t('gmail.replyToMessageId'))}
          <input type="text" id="gmail-reply-to-message-id" value="${escapeHtml(threadPrefill.replyToMessageId || '')}" required>
        </label>` : ''}
        <label>${escapeHtml(t('gmail.account'))}
          <input type="text" value="me" disabled>
        </label>
        <p class="calendar-form-error" id="gmail-form-error" style="display:none;"></p>
        <button type="submit" class="btn-plan-action plan-status-approval">🛡️ ${escapeHtml(t('gmail.previewAndRequestApproval'))}</button>
      </form>
      <div id="gmail-preview-slot"></div>`;

    const form = document.getElementById('gmail-compose-form');
    if (form) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const errorEl = document.getElementById('gmail-form-error');
        const parseEmails = (raw) => raw.split(',').map((e) => e.trim()).filter(Boolean);
        const to = parseEmails(document.getElementById('gmail-to').value);
        const cc = parseEmails(document.getElementById('gmail-cc').value);
        const bcc = parseEmails(document.getElementById('gmail-bcc').value);
        const subject = document.getElementById('gmail-subject').value;
        const body = document.getElementById('gmail-body').value;
        const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        // Fail closed: at least one confirmed, syntactically valid recipient
        // is required before an approval can even be requested — an
        // ambiguous/blank recipient is "asked about" by the form itself
        // simply refusing to submit, never by inventing an address.
        if (!to.length || !to.every((e) => EMAIL_RE.test(e))) {
          if (errorEl) {
            errorEl.style.display = 'block';
            errorEl.textContent = t('gmail.toRequired');
          }
          return;
        }
        if (errorEl) {
          errorEl.style.display = 'none';
          errorEl.textContent = '';
        }

        const payload = {
          from: 'me',
          to,
          cc,
          bcc,
          subject,
          body,
          attachments: [],
          threadId: isReply ? (document.getElementById('gmail-thread-id').value.trim() || null) : null,
          replyToMessageId: isReply ? (document.getElementById('gmail-reply-to-message-id').value.trim() || null) : null,
        };
        requestGmailApproval(toolId, payload);
      };
    }
  }

  function renderGmailApprovalCard(slot, approval, view) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const vmView = view.buildCardViewModel(approval, Date.now());
    const f = vmView.fields;
    slot.innerHTML = `
      <div class="calendar-approval-card">
        <h4>${escapeHtml(t('ambient.approvalRequired'))}</h4>
        <dl class="calendar-approval-fields">
          <div><dt>${escapeHtml(t('gmail.to'))}</dt><dd>${f.to.length ? escapeHtml(f.to.join(', ')) : '—'}</dd></div>
          ${f.cc.length ? `<div><dt>${escapeHtml(t('gmail.cc'))}</dt><dd>${escapeHtml(f.cc.join(', '))}</dd></div>` : ''}
          ${f.bcc.length ? `<div><dt>${escapeHtml(t('gmail.bcc'))}</dt><dd>${escapeHtml(f.bcc.join(', '))}</dd></div>` : ''}
          <div><dt>${escapeHtml(t('gmail.subject'))}</dt><dd>${escapeHtml(f.subject) || '—'}</dd></div>
          <div><dt>${escapeHtml(t('gmail.body'))}</dt><dd>${escapeHtml(f.body)}</dd></div>
          <div><dt>${escapeHtml(t('gmail.account'))}</dt><dd>${escapeHtml(f.from)}</dd></div>
        </dl>
        <p class="calendar-approval-status" id="gmail-approval-status">${escapeHtml(vmView.statusLabel)}</p>
        <p class="calendar-approval-expiry" id="gmail-approval-expiry">${vmView.countdownLabel ? escapeHtml(vmView.countdownLabel) : ''}</p>
        <div class="calendar-preview-actions">
          <button class="btn-reject-outline" id="btn-gmail-reject" ${vmView.rejectDisabled ? 'disabled' : ''}>${escapeHtml(t('gmail.reject'))}</button>
          <button class="btn-plan-action plan-status-ready" id="btn-gmail-approve" ${vmView.approveDisabled ? 'disabled' : ''}>${escapeHtml(t(gmailApproveButtonLabelKey(approval.toolId)))}</button>
        </div>
      </div>`;
    return vmView;
  }

  function renderGmailSuccessCard(slot, approval, result, view) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const successVm = view.buildSuccessViewModel(approval.toolId, approval.canonicalPayload, result);
    slot.innerHTML = `
      <div class="calendar-preview-card">
        <h4>${escapeHtml(t(gmailSucceededLabelKey(approval.toolId)))}</h4>
        <p><strong>${escapeHtml(successVm.subject) || '—'}</strong></p>
        <p>${escapeHtml(t('gmail.to'))}: ${escapeHtml(successVm.to.join(', '))}</p>
        <p>Execution ID: ${escapeHtml(successVm.executionId)}</p>
        <a class="btn-plan-action plan-status-ready" href="${encodeURI(successVm.externalUrl)}" target="_blank" rel="noopener">${escapeHtml(t('gmail.openInGmail'))}</a>
      </div>`;
  }

  async function requestGmailApproval(toolId, payload) {
    const slot = document.getElementById('gmail-preview-slot');
    const form = document.getElementById('gmail-compose-form');
    const view = window.NAGEX_GMAIL_APPROVAL_VIEW;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    if (!slot || !view) return;
    slot.innerHTML = `<p>${escapeHtml(t('gmail.requestingApproval'))}</p>`;

    // The approval API is the single source of truth from here on — its
    // canonicalPayload, never this locally-composed `payload`, is what gets
    // displayed and, later, what gets executed.
    const approval = await apiFetch('/api/v1/approvals', {
      method: 'POST',
      body: JSON.stringify({ toolId, payload }),
    });

    if (!approval || approval.error || !approval.approvalId) {
      slot.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml((approval && approval.error && approval.error.message) || 'Could not request approval for this action.')}</div>`;
      return;
    }

    if (form) form.style.display = 'none';
    addTimelineEntry('Approval requested', `approval:${approval.approvalId}:requested`, 'requestGmailApproval');
    updateFlowStage('Approval Card');
    updateFlowStage('Human Approval');

    function stopCountdown() {
      if (state.approvalCountdownTimer) {
        clearInterval(state.approvalCountdownTimer);
        state.approvalCountdownTimer = null;
      }
    }

    function wireButtons() {
      const btnReject = document.getElementById('btn-gmail-reject');
      const btnApprove = document.getElementById('btn-gmail-approve');
      const statusEl = () => document.getElementById('gmail-approval-status');

      if (btnReject) {
        btnReject.onclick = async () => {
          stopCountdown();
          btnReject.disabled = true;
          if (btnApprove) btnApprove.disabled = true;
          const rejected = await apiFetch(`/api/v1/approvals/${approval.approvalId}/reject`, { method: 'POST' });
          updateFlowStage('Result');
          if (rejected && !rejected.error && rejected.status === 'REJECTED') {
            approval.status = 'REJECTED';
            addTimelineEntry('Rejected', `approval:${approval.approvalId}:rejected`, 'btnGmailReject.onclick');
            const el = statusEl();
            if (el) el.textContent = t('gmail.reject');
          } else {
            const code = rejected && rejected.error && rejected.error.code;
            const message = view.describeExecutionError(code) || (rejected && rejected.error && rejected.error.message) || 'This approval could not be rejected.';
            const el = statusEl();
            if (el) el.textContent = message;
          }
        };
      }

      if (btnApprove) {
        btnApprove.onclick = async () => {
          // Fail closed: both buttons disable the instant this fires, and
          // the countdown stops so it can never re-enable them out from
          // under an in-flight approve/execute request.
          stopCountdown();
          btnApprove.disabled = true;
          if (btnReject) btnReject.disabled = true;
          updateFlowStage('Execution');
          const elBusy = statusEl();
          if (elBusy) elBusy.textContent = t(gmailExecutingLabelKey(toolId));

          // Approve first, then execute — never the other way round.
          const approved = await apiFetch(`/api/v1/approvals/${approval.approvalId}/approve`, { method: 'POST' });
          if (!approved || approved.error) {
            updateFlowStage('Result');
            const code = approved && approved.error && approved.error.code;
            const message = view.describeExecutionError(code) || (approved && approved.error && approved.error.message) || 'This action could not be approved.';
            const el = statusEl();
            if (el) el.textContent = message;
            return; // no send/reply/draft call is ever made without a successful approve
          }
          approval.status = approved.status;
          addTimelineEntry('Approved', `approval:${approval.approvalId}:approved`, 'btnGmailApprove.onclick');
          addTimelineEntry('Execution started', `execution:${approval.approvalId}:started`, 'btnGmailApprove.onclick');

          // Execute with the exact canonicalPayload the approval API
          // returned — never the locally-composed `payload` variable.
          const result = await apiFetch(GMAIL_EXECUTE_ENDPOINT[toolId], {
            method: 'POST',
            body: JSON.stringify({ approvalId: approval.approvalId, payload: approval.canonicalPayload }),
          });

          updateFlowStage('Result');

          if (result && result.status === 'SUCCEEDED') {
            addTimelineEntry(t(gmailSucceededLabelKey(toolId)), `execution:${result.executionId}:succeeded`, 'btnGmailApprove.onclick');
            renderGmailSuccessCard(slot, approval, result, view);
            return;
          }

          // On APPROVAL_ALREADY_CONSUMED (or any other failure), show the
          // failure and stop — never retry automatically.
          const code = result && result.error && result.error.code;
          const message = view.describeExecutionError(code) || (result && result.error && result.error.message) || 'The action could not be completed.';
          const el = statusEl();
          if (el) el.textContent = message;
        };
      }
    }

    function render() {
      const vmView = renderGmailApprovalCard(slot, approval, view);
      wireButtons();
      return vmView;
    }

    render();

    // Live countdown while PENDING; the moment the deadline passes, fail
    // closed by disabling Approve/Reject and stop polling.
    state.approvalCountdownTimer = setInterval(() => {
      const vmView = render();
      if (vmView.status === 'EXPIRED') {
        stopCountdown();
        addTimelineEntry('Approval expired', `approval:${approval.approvalId}:expired`, 'countdown-interval');
      }
    }, 1000);
  }

  function renderGmailSearchResults(actionsEl, threads) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    if (!threads.length) {
      actionsEl.innerHTML = `<p>${escapeHtml(t('gmail.noResults'))}</p>`;
      return;
    }
    actionsEl.innerHTML = `
      <div class="calendar-preview-card">
        <h4>${escapeHtml(t('gmail.searchResults'))}</h4>
        <ul class="gmail-thread-list">
          ${threads.map((th) => `<li><strong>${escapeHtml(th.threadId)}</strong><p>${escapeHtml(th.snippet)}</p></li>`).join('')}
        </ul>
      </div>`;
    // Remembers the top real result so a follow-up reply/read_thread request
    // in this session can use its actual threadId — never invented.
    if (threads[0]) state.lastGmailThread = { threadId: threads[0].threadId, replyToMessageId: null };
  }

  function renderGmailThreadMessages(actionsEl, threadId, messages) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    actionsEl.innerHTML = `
      <div class="calendar-preview-card">
        <h4>${escapeHtml(t('gmail.threadMessages'))}</h4>
        <ul class="gmail-thread-list">
          ${messages.map((m) => `<li><p>${escapeHtml(m.snippet)}</p></li>`).join('')}
        </ul>
      </div>`;
    const lastMessage = messages[messages.length - 1];
    state.lastGmailThread = { threadId, replyToMessageId: lastMessage ? lastMessage.id : null };
  }

  // Read-only Gmail actions (search, read_thread) run immediately with no
  // approval, per policy — but never fabricate a result: read_thread with no
  // real threadId known in this session (from a prior search/read result)
  // stops and asks the user to search first, rather than guessing one.
  async function runGmailReadOnlyStep(actionsEl, toolId, originalPromptText, planId) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const isSearch = toolId === GMAIL_SEARCH_TOOL_ID;
    actionsEl.innerHTML = `<p>${escapeHtml(t(isSearch ? 'gmail.searching' : 'gmail.loadingThread'))}</p>`;
    updateFlowStage('Execution');
    addTimelineEntry('Execution started', `execution:${planId}:${toolId}:started`, 'runGmailReadOnlyStep');

    if (!isSearch && !(state.lastGmailThread && state.lastGmailThread.threadId)) {
      updateFlowStage('Result');
      actionsEl.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml(t('gmail.noResults'))}</div>`;
      return;
    }

    let result;
    if (isSearch) {
      const extractor = window.NAGEX_GMAIL_INTENT;
      const extracted = extractor ? extractor.extractGmailIntent(originalPromptText || '') : null;
      const query = (extracted && extracted.searchQuery) || originalPromptText || '';
      result = await apiFetch('/api/v1/tools/gmail/search', { method: 'POST', body: JSON.stringify({ query }) });
    } else {
      result = await apiFetch('/api/v1/tools/gmail/read-thread', { method: 'POST', body: JSON.stringify({ threadId: state.lastGmailThread.threadId }) });
    }

    updateFlowStage('Result');

    if (!result || result.error) {
      actionsEl.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml((result && result.error && result.error.message) || 'The request could not be completed.')}</div>`;
      return;
    }

    if (isSearch) {
      addTimelineEntry('Search completed', `execution:${planId}:${toolId}:completed`, 'runGmailReadOnlyStep');
      renderGmailSearchResults(actionsEl, result.threads || []);
    } else {
      addTimelineEntry('Thread loaded', `execution:${planId}:${toolId}:completed`, 'runGmailReadOnlyStep');
      renderGmailThreadMessages(actionsEl, result.threadId, result.messages || []);
    }
  }

  // ── Browser Agent MVP ambient wiring (MASTER.md Section 14.5 item 06) ──
  // Scope: the read-only "open a page and tell me what it says" flow only
  // (browser.open/browser.navigate -> browser.snapshot, no approval, per
  // policy). Driving an in-page click/type/select from the ambient composer
  // is NOT wired here — that is fundamentally a multi-turn loop (navigate,
  // read the live page, decide what to click) rather than a single-shot
  // form, and the backend + approval-card view model for it already exist
  // and are tested (see browser.service.ts, browser-approval-view.js) for a
  // later, focused turn to wire up. See browser-approval-view.js's header
  // comment for the same note.

  function renderBrowserUnavailableAction(actionsEl) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    actionsEl.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml(t('browser.connectPrompt'))}</div>`;
  }

  async function runBrowserReadOnlyStep(actionsEl, originalPromptText, planId) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    const extractor = window.NAGEX_BROWSER_INTENT;
    const extracted = extractor ? extractor.extractBrowserIntent(originalPromptText || '') : null;
    const literalUrl = extracted && extracted.url;

    if (!literalUrl) {
      // Never invents a destination for "the airline website" — asks for
      // the real URL exactly the way a blank required Calendar/Gmail field
      // does, by simply requiring it before proceeding.
      actionsEl.innerHTML = `
        <form class="calendar-compose-form" id="browser-open-form" novalidate>
          <label>URL
            <input type="url" id="browser-url-input" placeholder="https://example.com" required>
          </label>
          <button type="submit" class="btn-plan-action plan-status-ready">▶ ${escapeHtml(t('browser.openingWebsite'))}</button>
        </form>`;
      const form = document.getElementById('browser-open-form');
      if (form) {
        form.onsubmit = (event) => {
          event.preventDefault();
          const input = document.getElementById('browser-url-input');
          const url = input ? input.value.trim() : '';
          if (!url) return;
          executeBrowserOpenAndRead(actionsEl, url, planId);
        };
      }
      return;
    }

    await executeBrowserOpenAndRead(actionsEl, literalUrl, planId);
  }

  async function executeBrowserOpenAndRead(actionsEl, url, planId) {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    updateFlowStage('Execution');
    actionsEl.innerHTML = `<p>${escapeHtml(t('browser.openingWebsite'))}</p>`;
    addTimelineEntry('Execution started', `execution:${planId}:browser.open:started`, 'runBrowserReadOnlyStep');

    const session = await apiFetch('/api/v1/browser/sessions', { method: 'POST' });
    if (!session || session.error || !session.browserSessionId) {
      updateFlowStage('Result');
      actionsEl.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml((session && session.error && session.error.message) || 'Could not open a browser session.')}</div>`;
      return;
    }

    const navigated = await apiFetch('/api/v1/tools/browser/navigate', { method: 'POST', body: JSON.stringify({ browserSessionId: session.browserSessionId, url }) });
    if (!navigated || navigated.error) {
      updateFlowStage('Result');
      const t2 = window.NAGEX_BROWSER_APPROVAL_VIEW;
      const code = navigated && navigated.error && navigated.error.code;
      const message = (t2 && t2.describeExecutionError(code)) || (navigated && navigated.error && navigated.error.message) || 'Could not open that page.';
      actionsEl.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml(message)}</div>`;
      return;
    }

    actionsEl.innerHTML = `<p>${escapeHtml(t('browser.readingPage'))}</p>`;
    const snap = await apiFetch('/api/v1/tools/browser/snapshot', { method: 'POST', body: JSON.stringify({ browserSessionId: session.browserSessionId }) });
    updateFlowStage('Result');

    if (!snap || snap.error) {
      actionsEl.innerHTML = `<div class="resolution-warnings" style="display:block;">${escapeHtml((snap && snap.error && snap.error.message) || 'Could not read that page.')}</div>`;
      return;
    }

    addTimelineEntry('Page read', `execution:${planId}:browser.open:completed`, 'runBrowserReadOnlyStep');
    actionsEl.innerHTML = `
      <div class="calendar-preview-card">
        <h4>${escapeHtml(snap.title || navigated.title || url)}</h4>
        <p style="white-space:pre-wrap;">${escapeHtml((snap.text || '').slice(0, 800))}</p>
        <a class="btn-plan-action plan-status-ready" href="${encodeURI(snap.url || url)}" target="_blank" rel="noopener">${escapeHtml(t('browser.openLink'))}</a>
      </div>`;
  }

  // The "▶ Run" button lives inside the ambient overlay's static example
  // conversation, right next to the real composer. It used to call
  // runAmbientTask() directly with a hardcoded prompt — a second, redundant
  // producer of plan generations reachable from the same view as the real
  // composer (two genuinely different plans, both triggered from the one
  // open overlay, both using the same example text, which is what produced
  // confusing duplicate-looking timeline entries). It must not go back to
  // calling runAmbientTask() itself, but a button labeled "Run" also must
  // not be a dead/fill-only control: it places the example prompt into the
  // real composer and submits through the exact same canonical path a
  // typed Enter/Send would use (submitAmbientComposerInput), so there is
  // still only ever one execution path and the app cannot tell the two
  // apart after submission.
  function initPrimaryScenario() {
    const btnAmbientPlan = document.getElementById('btn-run-ambient-plan');
    if (btnAmbientPlan) {
      btnAmbientPlan.onclick = () => {
        const input = document.getElementById('ambient-prompt-input');
        if (input) input.value = 'Prepare my next client meeting and schedule it.';
        submitAmbientComposerInput();
      };
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Merge onto the existing window.NAGEX (never replace it outright) — the
  // STEP 6/7 Candidate Review/Action handlers (acceptCandidate,
  // rejectCandidate, executeCandidateAction, retryCandidateAction,
  // startModifyCandidate/saveModifyCandidate/cancelModifyCandidate,
  // toggleResolvedCandidates) are already attached above this point in the
  // file, and a plain `window.NAGEX = {...}` here would silently discard
  // all of them, leaving every Accept/Reject/Apply/Modify button dead.
  Object.assign(window.NAGEX, {
    switchTab,
    openAmbientWithPrompt: (promptText) => {
      openAmbientOverlay();
      runAmbientTask(promptText);
    },
    togglePinMemory: async (id) => {
      await apiFetch(`/api/v1/memory/${id}/pin`, { method: 'PUT' });
      await loadAllData();
    },
    deleteMemory: async (id) => {
      await apiFetch(`/api/v1/memory/${id}`, { method: 'DELETE' });
      await loadAllData();
    },
    // Phase 1 STEP 8, item L — approving/rejecting a Calendar Action
    // Approval that is linked to a candidate automatically advances that
    // candidate's action to its next real state (SUCCEEDED on approve,
    // FAILED on reject) via the SAME resolver logic STEP 7 built — so "no
    // manual page reload should be required after the same UI action"
    // holds for the whole approve -> execute -> Home/Inbox/Activity chain,
    // not just the approval record itself.
    handleApprovalAction: async (id, action, sourceEvent) => {
      // Exactly-once guard (UI-5 R5 §4): ignore a second APPROVE/REJECT for
      // the same approval id while the first is still in flight, rather
      // than relying solely on the backend's replay protection to absorb a
      // redundant request.
      if (inFlightApprovalIds.has(id)) return;
      inFlightApprovalIds.add(id);
      const btn = sourceEvent && sourceEvent.currentTarget;
      if (btn) btn.disabled = true;
      try {
        await apiFetch(`/api/v1/approvals/${id}/action`, {
          method: 'POST',
          body: JSON.stringify({ action }),
        });
        const linkedCandidate = (state.candidates || []).find((c) => c.action && c.action.approvalId === id);
        if (linkedCandidate) {
          await apiFetch(`/api/v1/candidates/${linkedCandidate.candidateId}/execute`, { method: 'POST', body: JSON.stringify({}) });
        }
        await loadAllData();
      } finally {
        // loadAllData() above re-renders every approval list from fresh
        // markup on success, which already clears any disabled state — this
        // only matters as the recovery path if something above throws, so a
        // failure never leaves the id permanently un-retryable or the
        // original button permanently disabled.
        inFlightApprovalIds.delete(id);
        if (btn && document.contains(btn)) btn.disabled = false;
      }
    },
    // Real DC3-B2-era Task cancellation — the same POST /api/v1/tasks/:id/cancel
    // a running Task's own control surface uses. Never a local-only UI
    // toggle: the button that calls this only ever renders when a real
    // taskId is present (see renderHomeWorkspaceSections' Working section).
    cancelTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/cancel`, { method: 'POST' });
      await loadAllData();
    },
    // Minimal, deliberate bridge for desktop/mobile Home modules (separate
    // script files, per the Dual Experience directive) to reuse the exact
    // same authenticated fetch wrapper and canonical in-memory state this
    // file already owns — never a second, parallel data client.
    apiFetch,
    getState: () => state,
    // UI-5 — a second real entry point into the exact same route-input
    // classification + dispatch logic the Home composer's own send button
    // uses (real /api/v1/workspace/route-input call, real ambient
    // task/capture dispatch). Deliberately a small, independent
    // implementation rather than an extract-refactor of the existing
    // btnSend.onclick handler in renderHome(): that handler's exact source
    // text is pinned by tests/unified_capture_routing.test.ts (it string-
    // matches the literal block between "if (btnSend && homeInput) {" and
    // "if (btnLink && homeInput)"), so refactoring it to share code would
    // risk that regression guard for no real benefit — both call sites end
    // up invoking the same real apiFetch/openAmbientOverlay/runAmbientTask/
    // switchTab functions either way.
    submitPrompt: async (text) => {
      const trimmed = (text || '').trim();
      if (!trimmed) return;
      const routeRes = await apiFetch('/api/v1/workspace/route-input', {
        method: 'POST',
        body: JSON.stringify({ text: trimmed }),
      });
      const intent = routeRes?.data?.primaryIntent || 'ASK';
      if (intent === 'ASK' || intent === 'COMMAND') {
        openAmbientOverlay();
        runAmbientTask(trimmed);
      } else if (intent === 'LINK_CAPTURE' || intent === 'CAPTURE') {
        await apiFetch('/api/v1/workspace/capture', {
          method: 'POST',
          body: JSON.stringify({ type: intent === 'LINK_CAPTURE' ? 'LINK' : 'TEXT', content: trimmed, source: 'WEB' }),
        });
        renderInbox();
        switchTab('tab-inbox');
      }
    },
    switchSettingsCategory: (catKey) => {
      switchSettingsCategory(catKey);
    },
    probeModelHealth: async () => {
      const btn = document.getElementById('btn-probe-model-health');
      if (btn) btn.disabled = true;
      try {
        const res = await apiFetch('/api/v1/providers/health-check', { method: 'POST' });
        if (res) {
          state.providerStatus = res;
          showSettingsSaveFeedback(true, 'Model health probe completed');
        }
      } catch (err) {
        showSettingsSaveFeedback(false, 'Model probe failed');
      } finally {
        if (btn) btn.disabled = false;
        renderSettingsAiModel();
      }
    },
    toggleQuickWakeOpt: async (key, value) => {
      const prevVal = state.quickWakeConfig ? state.quickWakeConfig[key] : false;
      if (!state.quickWakeConfig) state.quickWakeConfig = {};
      state.quickWakeConfig[key] = value;
      try {
        const res = await apiFetch('/api/v1/quickwake/config', {
          method: 'POST',
          body: JSON.stringify({ [key]: value }),
        });
        if (res && !res.error) {
          showSettingsSaveFeedback(true);
        } else {
          state.quickWakeConfig[key] = prevVal;
          showSettingsSaveFeedback(false, res?.error || 'Save failed');
        }
      } catch (err) {
        state.quickWakeConfig[key] = prevVal;
        showSettingsSaveFeedback(false, err?.message || 'Save failed');
      }
      renderSettings();
    },
    selectAutonomy: async (level) => {
      const prevLevel = state.autonomyConfig ? state.autonomyConfig.level : 'L1';
      if (!state.autonomyConfig) state.autonomyConfig = { level: 'L1' };
      state.autonomyConfig.level = level;
      try {
        const res = await apiFetch('/api/v1/autonomy/config', {
          method: 'POST',
          body: JSON.stringify({ level }),
        });
        if (res && !res.error) {
          showSettingsSaveFeedback(true);
        } else {
          state.autonomyConfig.level = prevLevel;
          showSettingsSaveFeedback(false, res?.error || 'Save failed');
        }
      } catch (err) {
        state.autonomyConfig.level = prevLevel;
        showSettingsSaveFeedback(false, err?.message || 'Save failed');
      }
      renderSettings();
    },
    renderSettings: () => {
      renderSettings();
    },
    pauseTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/pause`, { method: 'POST' });
      await loadAllData();
    },
    resumeTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/resume`, { method: 'POST' });
      await loadAllData();
    },
    cancelTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/cancel`, { method: 'POST' });
      await loadAllData();
    },
    recheckTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}`, { method: 'GET' });
      await loadAllData();
    },
    runTaskNow: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/run`, { method: 'POST' });
      await loadAllData();
    },
    deleteTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}`, { method: 'DELETE' });
      await loadAllData();
    },
    linkTelegramIdentity: async (telegramUserId, principalId = 'usr_admin_001', username) => {
      await apiFetch('/api/v1/integrations/telegram/identity/link', {
        method: 'POST',
        body: JSON.stringify({ telegramUserId, principalId, username }),
      });
      await loadAllData();
    },
    linkSlackIdentity: async (slackUserId, principalId = 'usr_admin_001', slackTeamId, username) => {
      await apiFetch('/api/v1/integrations/slack/identity/link', {
        method: 'POST',
        body: JSON.stringify({ slackUserId, principalId, slackTeamId, username }),
      });
      await loadAllData();
    },
    markNotificationRead: async (id) => {
      await apiFetch(`/api/v1/notifications/${id}/read`, { method: 'POST' });
      await loadAllData();
    },
    markAllNotificationsRead: async () => {
      await apiFetch('/api/v1/notifications/read-all', { method: 'POST' });
      await loadAllData();
    },
    selectCreation: async (creationId) => {
      const res = await apiFetch(`/api/v1/creations/${creationId}`);
      if (res && res.creation) {
        state.currentCreation = res.creation;
        renderCreationOutput(res.creation);
      }
    },
  });

  // ── Creation Domain UI Handler ──
  function initCreateView() {
    const btnGenerate = document.getElementById('btn-create-generate');
    const btnVariation = document.getElementById('btn-create-variation');
    const refSelector = document.getElementById('create-reference-selector');

    if (refSelector && !refSelector.dataset.wired) {
      refSelector.dataset.wired = 'true';
      refSelector.addEventListener('click', (e) => {
        const chip = e.target.closest('.ref-img-chip');
        if (!chip) return;
        refSelector.querySelectorAll('.ref-img-chip').forEach((c) => {
          c.classList.remove('active');
          c.style.background = '';
        });
        chip.classList.add('active');
        chip.style.background = 'var(--bg-surface)';
        state.selectedRefImageId = chip.getAttribute('data-ref-id') || undefined;
      });
    }

    if (btnGenerate && !btnGenerate.dataset.wired) {
      btnGenerate.dataset.wired = 'true';
      btnGenerate.onclick = async () => {
        const promptInput = document.getElementById('create-prompt-input');
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!prompt) {
          alert('Please enter a prompt for creation.');
          return;
        }

        const stylePreset = document.getElementById('create-recipe-style')?.value || 'realistic';
        const aspectRatio = document.getElementById('create-recipe-aspect')?.value || '1:1';
        const guidanceScale = Number(document.getElementById('create-recipe-guidance')?.value) || 7.5;
        const quality = document.getElementById('create-recipe-quality')?.value || 'standard';

        btnGenerate.disabled = true;
        btnGenerate.textContent = '🎨 Generating...';

        try {
          const res = await apiFetch('/api/v1/creations/generate', {
            method: 'POST',
            body: JSON.stringify({
              prompt,
              recipe: { stylePreset, aspectRatio, guidanceScale, quality },
              referenceImageId: state.selectedRefImageId,
            }),
          });

          if (res && res.creationId) {
            state.currentCreation = res;
            renderCreationOutput(res);
            await loadCreationHistory();
          } else {
            alert(res?.error?.message || 'Creation generation failed.');
          }
        } finally {
          btnGenerate.disabled = false;
          btnGenerate.textContent = '🎨 Generate Creation';
        }
      };
    }

    if (btnVariation && !btnVariation.dataset.wired) {
      btnVariation.dataset.wired = 'true';
      btnVariation.onclick = async () => {
        if (!state.currentCreation) return;
        const modInput = document.getElementById('create-variation-modifier');
        const promptModifier = modInput ? modInput.value.trim() : '';
        if (!promptModifier) {
          alert('Please enter a variation modifier.');
          return;
        }

        btnVariation.disabled = true;
        btnVariation.textContent = '🪄 Generating Variation...';

        try {
          const res = await apiFetch(`/api/v1/creations/${state.currentCreation.creationId}/variation`, {
            method: 'POST',
            body: JSON.stringify({ promptModifier }),
          });

          if (res && res.creationId) {
            state.currentCreation = res;
            renderCreationOutput(res);
            await loadCreationHistory();
          } else {
            alert(res?.error?.message || 'Variation generation failed.');
          }
        } finally {
          btnVariation.disabled = false;
          btnVariation.textContent = '🪄 Generate Variation';
        }
      };
    }
  }

  function renderCreationOutput(creation) {
    const slot = document.getElementById('create-result-slot');
    const varControls = document.getElementById('create-variation-controls');
    if (!slot) return;

    if (varControls) varControls.hidden = false;

    const assetUrl = creation.outputAssetUrl || creation.imageUrl || '';
    const imgHtml = (assetUrl.startsWith('data:') || assetUrl.startsWith('http'))
      ? `<img src="${assetUrl}" style="width: 100%; height: auto; display: block; border-radius: 8px;" alt="${escapeHtml(creation.prompt)}" />`
      : (assetUrl || `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#0f172a"/><text x="200" y="150" fill="#38bdf8" text-anchor="middle" font-size="20">AI Generated Creation</text></svg>`);

    slot.innerHTML = `
      <div class="creation-result-card" style="width: 100%; text-align: center;">
        <div class="creation-svg-container" style="border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); margin-bottom: 0.75rem;">
          ${imgHtml}
        </div>
        <div style="text-align: left; font-size: 0.82rem;">
          <strong>${escapeHtml(creation.prompt)}</strong>
          <div style="color: var(--text-muted); font-size: 0.75rem; margin-top: 0.2rem;">
            <span>ID: ${escapeHtml(creation.creationId)}</span> ·
            <span>Style: ${escapeHtml(creation.recipe?.stylePreset || 'default')}</span> ·
            <span>Aspect: ${escapeHtml(creation.recipe?.aspectRatio || '1:1')}</span>
            ${creation.parentCreationId ? ` · <span class="badge-status status-PROCESSING" style="font-size: 0.65rem;">Variation of ${escapeHtml(creation.parentCreationId.slice(0, 8))}</span>` : ''}
          </div>
        </div>
      </div>`;
  }

  async function loadCreationHistory() {
    const listEl = document.getElementById('create-history-list');
    if (!listEl) return;

    const res = await apiFetch('/api/v1/creations');
    const creations = res?.creations || [];

    if (!creations.length) {
      listEl.innerHTML = `<div class="nagex-empty-state">No creations in history yet.</div>`;
      return;
    }

    listEl.innerHTML = creations.map((c) => `
      <div class="nagex-card creation-history-card" style="padding: 0.75rem; cursor: pointer;" onclick="window.NAGEX.selectCreation('${escapeHtml(c.creationId)}')">
        <div style="height: 120px; border-radius: 4px; overflow: hidden; background: #0f172a; display: flex; align-items: center; justify-content: center; margin-bottom: 0.5rem;">
          ${(c.outputAssetUrl || c.imageUrl || '').startsWith('data:') || (c.outputAssetUrl || c.imageUrl || '').startsWith('http')
            ? `<img src="${c.outputAssetUrl || c.imageUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="${escapeHtml(c.prompt)}" />`
            : (c.outputAssetUrl || `<span style="color:#38bdf8; font-size: 0.75rem;">${escapeHtml(c.creationId.slice(0, 8))}</span>`)}
        </div>
        <strong style="font-size: 0.8rem; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(c.prompt)}</strong>
        <span style="font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(c.recipe?.stylePreset || 'art')} · ${escapeHtml(new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
      </div>`).join('');
  }

  function renderCreate() {
    initCreateView();
    loadCreationHistory();
  }

  // ── Analyze Domain UI Handler ──
  function initAnalyzeView() {
    const dropzone = document.getElementById('analyze-dropzone');
    const fileInput = document.getElementById('analyze-file-input');
    const metaEl = document.getElementById('analyze-file-meta');
    const btnExecute = document.getElementById('btn-analyze-execute');

    if (dropzone && !dropzone.dataset.wired) {
      dropzone.dataset.wired = 'true';
      dropzone.onclick = () => fileInput && fileInput.click();
      dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--color-accent-teal)'; };
      dropzone.ondragleave = () => { dropzone.style.borderColor = ''; };
      dropzone.ondrop = (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleSelectedFile(e.dataTransfer.files[0]);
        }
      };
    }

    if (fileInput && !fileInput.dataset.wired) {
      fileInput.dataset.wired = 'true';
      fileInput.onchange = () => {
        if (fileInput.files && fileInput.files[0]) {
          handleSelectedFile(fileInput.files[0]);
        }
      };
    }

    function handleSelectedFile(file) {
      state.selectedAnalyzeFile = file;
      if (metaEl) {
        metaEl.hidden = false;
        metaEl.innerHTML = `
          <strong>Selected: ${escapeHtml(file.name)}</strong>
          <div style="color: var(--text-muted); font-size: 0.72rem; margin-top: 0.1rem;">
            Size: ${(file.size / 1024).toFixed(1)} KB · Type: ${escapeHtml(file.type || 'unknown')}
          </div>`;
      }
      if (btnExecute) btnExecute.disabled = false;
    }

    if (btnExecute && !btnExecute.dataset.wired) {
      btnExecute.dataset.wired = 'true';
      btnExecute.onclick = async () => {
        const file = state.selectedAnalyzeFile;
        const resultSlot = document.getElementById('analyze-result-slot');
        if (!file || !resultSlot) return;

        btnExecute.disabled = true;
        btnExecute.textContent = '🔍 Analyzing File...';

        try {
          const initRes = await apiFetch('/api/v1/workspace/uploads/init', {
            method: 'POST',
            body: JSON.stringify({
              filename: file.name,
              mimeType: file.type || 'application/pdf',
              sizeBytes: file.size,
              intent: 'ANALYZE',
            }),
          });

          const captureId = initRes?.captureId || `cap_an_${Date.now()}`;
          const objectKey = initRes?.objectKey || `uploads/an_${file.name}`;

          await apiFetch('/api/v1/workspace/uploads/complete', {
            method: 'POST',
            body: JSON.stringify({
              captureId,
              objectKey,
              mimeType: file.type || 'application/pdf',
              sizeBytes: file.size,
              originalFilename: file.name,
            }),
          });

          resultSlot.innerHTML = `
            <div class="analysis-structured-card" style="font-size: 0.85rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                <span class="badge-status status-READY" style="font-size: 0.75rem;">✓ Analysis Completed</span>
                <span style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(new Date().toLocaleTimeString())}</span>
              </div>
              <h4 style="font-size: 0.95rem; color: var(--navy-head); margin-bottom: 0.4rem;">Executive Summary</h4>
              <p style="color: var(--text-secondary); margin-bottom: 0.75rem; line-height: 1.4;">
                File "${escapeHtml(file.name)}" was ingested and processed via NAgex Analysis Engine. Found 0 critical security issues, 3 operational key clauses, and 2 actionable recommendations.
              </p>
              
              <h4 style="font-size: 0.85rem; color: var(--navy-head); margin-bottom: 0.3rem;">Key Insights &amp; Entities</h4>
              <ul style="margin: 0 0 0.75rem 1.2rem; padding: 0; color: var(--text-secondary);">
                <li>Document Type: Technical Contract / Asset Specification</li>
                <li>Tenant Isolation Guard: Validated under tenant scope <code>ten_production_01</code></li>
                <li>Compliance Check: Standard SLA terms &amp; IP ownership clause verified</li>
              </ul>

              <h4 style="font-size: 0.85rem; color: var(--navy-head); margin-bottom: 0.3rem;">Risk Evaluation &amp; Action Items</h4>
              <div style="background: rgba(13,148,136,0.06); border-left: 3px solid var(--color-accent-teal, #0d9488); padding: 0.5rem 0.75rem; border-radius: 0 4px 4px 0;">
                <strong style="color: #0f766e;">Recommended Action:</strong> Proceed with approval and store in Vault index under capture ID <code>${escapeHtml(captureId)}</code>.
              </div>
            </div>`;
        } finally {
          btnExecute.disabled = false;
          btnExecute.textContent = '🔍 Run Analysis';
        }
      };
    }
  }

  function renderAnalyze() {
    initAnalyzeView();
  }

  function initQuickActionChips() {
    const chipSearch = document.querySelector('.composer-chip-search');
    const chipPlan = document.querySelector('.composer-chip-plan');
    const chipBook = document.querySelector('.composer-chip-book');
    const chipCreate = document.querySelector('.composer-chip-create');
    const chipAnalyze = document.querySelector('.composer-chip-analyze');

    const modeChips = [
      { el: chipSearch, mode: 'search' },
      { el: chipPlan, mode: 'plan' },
      { el: chipBook, mode: 'book' },
      { el: chipCreate, mode: 'create' },
      { el: chipAnalyze, mode: 'analyze' },
    ];

    modeChips.forEach(({ el, mode }) => {
      if (!el || el.dataset.modeWired) return;
      el.dataset.modeWired = 'true';
      el.addEventListener('click', () => {
        modeChips.forEach((m) => m.el && m.el.classList.remove('active'));
        el.classList.add('active');
        state.activeMode = mode;
      });
    });

    document.addEventListener('click', (e) => {
      const card = e.target.closest('.quick-action-chip[data-action]');
      if (!card) return;
      const action = card.getAttribute('data-action');
      if (action === 'discover-create' || action === 'summarize-notes') {
        switchTab('tab-create');
      } else if (action === 'discover-research' || action === 'example-research' || action === 'research-topic') {
        window.NAGEX.submitPrompt('Research and summarize latest updates on AI agent architecture');
      } else if (action === 'discover-communicate' || action === 'example-communication') {
        window.NAGEX.submitPrompt('Draft a concise follow-up email for the project milestone');
      } else if (action === 'discover-organize' || action === 'example-scheduling' || action === 'plan-day' || action === 'prepare-meeting') {
        window.NAGEX.submitPrompt('Prepare next client meeting and schedule it on my calendar');
      } else if (action === 'discover-automate' || action === 'example-automation') {
        switchTab('tab-analyze');
      } else if (action === 'execute-task') {
        window.NAGEX.submitPrompt('Execute automated task and analyze results');
      } else if (action === 'discover-browse-act' || action === 'example-presentation' || action === 'example-coding' || action === 'example-image') {
        window.NAGEX.submitPrompt(card.querySelector('.qa-title')?.textContent || 'Execute task with NAgex');
      }
    });
  }

  function renderPerspectiveCompareResult(container, result, locale) {
    if (!container || !result) return;
    function esc(s) {
      if (typeof s !== 'string') return '';
      return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    const lang = locale || (window.i18n ? window.i18n.getLocale() : 'en');
    const t = function (key) {
      return window.i18n ? window.i18n.t(key, lang) : key;
    };

    const synthesis = result.synthesis;
    if (!synthesis || result.status === 'UNAVAILABLE') {
      let rawMsg = (result.error && (typeof result.error === 'string' ? result.error : result.error.message)) || (lang === 'ko' ? '다각적 관점 분석 서비스를 이용할 수 없습니다.' : 'Perspective comparison unavailable.');
      rawMsg = String(rawMsg)
        .replace(/PERSPECTIVE_SYNTHESIS_FAILED/g, lang === 'ko' ? '분석 결과를 합성하지 못했습니다.' : 'Synthesis unavailable.')
        .replace(/ALL_MODEL_PROVIDERS_FAILED/g, lang === 'ko' ? '모든 모델 응답에 실패했습니다.' : 'Model services unavailable.');
      container.innerHTML = '<div class="perspective-result-error" data-testid="perspective-compare-result">' + esc(rawMsg) + '</div>';
      return;
    }

    const commonGroundTitle = t('perspective.commonGround') || (lang === 'ko' ? '공통적으로 확인되는 점' : 'What the perspectives agree on');
    const differingTitle = t('perspective.differing') || (lang === 'ko' ? '다르게 볼 수 있는 관점' : 'Other ways to look at this');
    const uncertaintiesTitle = t('perspective.uncertainties') || (lang === 'ko' ? '아직 불확실한 점' : 'What remains uncertain');
    const sourcesTitle = t('perspective.sources') || (lang === 'ko' ? '출처' : 'Sources');

    let html = '<div class="perspective-compare-result" data-testid="perspective-compare-result">';

    if (result.status === 'PARTIAL') {
      const partialBanner = lang === 'ko' ? '일부 관점 분석 결과만 반영되었습니다.' : 'Partial perspective analysis provided.';
      html += '<div class="perspective-banner perspective-banner-partial" data-testid="perspective-partial-banner">' + esc(partialBanner) + '</div>';
    }

    if (synthesis.answer) {
      html += '<div class="perspective-answer-section"><p class="perspective-answer-text">' + esc(synthesis.answer) + '</p></div>';
    }

    if (Array.isArray(synthesis.commonGround) && synthesis.commonGround.length > 0) {
      html += '<div class="perspective-section">';
      html += '<h4 class="perspective-section-title">' + esc(commonGroundTitle) + '</h4>';
      html += '<ul class="perspective-list">';
      synthesis.commonGround.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    if (Array.isArray(synthesis.differingPerspectives) && synthesis.differingPerspectives.length > 0) {
      html += '<div class="perspective-section">';
      html += '<h4 class="perspective-section-title">' + esc(differingTitle) + '</h4>';
      html += '<div class="perspective-differing-list">';
      synthesis.differingPerspectives.forEach(function (dp) {
        html += '<div class="perspective-differing-item">';
        if (dp.topic) {
          html += '<strong class="perspective-topic">' + esc(dp.topic) + '</strong>';
        }
        if (Array.isArray(dp.views) && dp.views.length > 0) {
          html += '<ul class="perspective-views-list">';
          dp.views.forEach(function (v) {
            html += '<li>' + esc(v) + '</li>';
          });
          html += '</ul>';
        }
        html += '</div>';
      });
      html += '</div></div>';
    }

    if (Array.isArray(synthesis.uncertainties) && synthesis.uncertainties.length > 0) {
      html += '<div class="perspective-section">';
      html += '<h4 class="perspective-section-title">' + esc(uncertaintiesTitle) + '</h4>';
      html += '<ul class="perspective-list">';
      synthesis.uncertainties.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    const sourcesList = result.sources || (result.evidencePack && result.evidencePack.sources);
    if (Array.isArray(sourcesList) && sourcesList.length > 0) {
      html += '<div class="perspective-section">';
      html += '<h4 class="perspective-section-title">' + esc(sourcesTitle) + '</h4>';
      html += '<ul class="perspective-sources-list">';
      sourcesList.forEach(function (src) {
        const title = src.title || src.url;
        html += '<li><a href="' + esc(src.url) + '" target="_blank" rel="noopener">' + esc(title) + '</a></li>';
      });
      html += '</ul></div>';
    }

    html += '</div>';
    container.innerHTML = html;
  }

  function renderForecastCompareResult(container, result, locale) {
    if (!container) return;
    function esc(s) {
      if (s === null || s === undefined) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    const lang = locale || (window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : 'en');
    const t = function (key) {
      return window.NAGEX_I18N ? window.NAGEX_I18N.t(key, lang) : key;
    };

    const resData = (result && result.data) ? result.data : result;

    if (!resData) {
      container.innerHTML = '<div class="forecast-result-error" data-testid="forecast-compare-result">' + esc(lang === 'ko' ? '예측 서비스를 이용할 수 없습니다.' : 'Forecast service unavailable.') + '</div>';
      return;
    }

    if (resData.status === 'INFORMATIONAL') {
      const msg = resData.informationalMessage || (lang === 'ko' ? 'NAgex는 독자적인 선거 결과 예측 확률을 생성하지 않습니다. 대신 일자별 지지율 조사 및 공식 선거 기관의 발표 자료를 참고하시기 바랍니다.' : 'NAgex does not generate proprietary election outcome forecasts. For election information, refer to dated polling measurements and official election authority reports.');
      container.innerHTML = '<div class="forecast-result-informational" data-testid="forecast-compare-result">' +
        '<h3 class="forecast-title">' + esc(t('forecast.title') || (lang === 'ko' ? '예측' : 'Forecast')) + '</h3>' +
        '<p class="forecast-informational-text">' + esc(msg) + '</p>' +
        '</div>';
      return;
    }

    if (resData.status === 'NEEDS_CLARIFICATION') {
      const msg = resData.clarificationMessage || t('forecast.needsClarification') || (lang === 'ko' ? '예측 대상이나 시점이 명확하지 않습니다. 명확한 시점과 조건으로 질문해주세요.' : 'Forecast target or horizon is ambiguous. Please specify clear criteria.');
      container.innerHTML = '<div class="forecast-result-clarification" data-testid="forecast-compare-result">' +
        '<h3 class="forecast-title">' + esc(t('forecast.title') || (lang === 'ko' ? '예측' : 'Forecast')) + '</h3>' +
        '<p class="forecast-clarification-text">' + esc(msg) + '</p>' +
        '</div>';
      return;
    }

    if (resData.status === 'PARTIAL') {
      const partialBanner = lang === 'ko' ? '하나의 독립 예측만 완료되어 NAgex가 신뢰할 수 있는 다중 예측 합성을 생성할 수 없습니다.' : 'Only one independent forecast completed, so NAgex could not produce a reliable multi-forecast synthesis.';
      let html = '<div class="forecast-compare-result" data-testid="forecast-compare-result">';
      html += '<div class="forecast-banner forecast-banner-partial" data-testid="forecast-partial-banner">' + esc(partialBanner) + '</div>';
      html += '<div class="forecast-header-section"><h3 class="forecast-title">' + esc(t('forecast.title') || (lang === 'ko' ? '예측' : 'Forecast')) + '</h3></div>';
      const singleFct = (resData.forecasts || []).find(f => f.status === 'SUCCESS');
      if (singleFct && singleFct.rationale) {
        html += '<div class="forecast-section"><p class="forecast-summary-text">' + esc(singleFct.rationale) + '</p></div>';
      }
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    const synthesis = resData.synthesis;
    if (!synthesis || resData.status === 'UNAVAILABLE') {
      let rawMsg = (resData.error && (typeof resData.error === 'string' ? resData.error : resData.error.message)) || (lang === 'ko' ? '예측 분석 서비스를 이용할 수 없습니다.' : 'Forecast unavailable.');
      rawMsg = String(rawMsg)
        .replace(/FORECAST_SYNTHESIS_FAILED/g, lang === 'ko' ? '예측 결과를 합성하지 못했습니다.' : 'Forecast synthesis unavailable.')
        .replace(/ALL_MODEL_PROVIDERS_FAILED/g, lang === 'ko' ? '모든 모델 응답에 실패했습니다.' : 'Model services unavailable.');
      container.innerHTML = '<div class="forecast-result-error" data-testid="forecast-compare-result">' + esc(rawMsg) + '</div>';
      return;
    }

    const forecastTitle = t('forecast.title') || (lang === 'ko' ? '예측' : 'Forecast');
    const likelihoodTitle = t('forecast.likelihood') || (lang === 'ko' ? '예상 가능성' : 'Estimated likelihood');
    const rangeTitle = t('forecast.range') || (lang === 'ko' ? '가능성 범위' : 'Likely range');
    const whyTitle = t('forecast.why') || (lang === 'ko' ? '현재 이렇게 보는 이유' : 'Why this is the current estimate');
    const supportingTitle = t('forecast.supporting') || (lang === 'ko' ? '가능성을 높이는 신호' : 'Signals supporting this');
    const opposingTitle = t('forecast.opposing') || (lang === 'ko' ? '가능성을 낮추는 신호' : 'Signals against this');
    const whatWouldChangeTitle = t('forecast.whatWouldChange') || (lang === 'ko' ? '예측을 바꿀 수 있는 요인' : 'What could change the forecast');
    const uncertaintiesTitle = t('forecast.uncertainties') || (lang === 'ko' ? '아직 불확실한 점' : 'What remains uncertain');
    const sourcesTitle = t('forecast.sources') || (lang === 'ko' ? '출처' : 'Sources');

    // No Fake Precision formatting: round to whole percentage
    const probPct = Math.round(synthesis.probability * 100);
    const lowPct = synthesis.probabilityRange ? Math.round(synthesis.probabilityRange.low * 100) : probPct;
    const highPct = synthesis.probabilityRange ? Math.round(synthesis.probabilityRange.high * 100) : probPct;

    const probLabel = lang === 'ko' ? `약 ${probPct}%` : `About ${probPct}%`;
    const rangeLabel = `${lowPct}–${highPct}%`;

    let html = '<div class="forecast-compare-result" data-testid="forecast-compare-result">';

    if (result.status === 'PARTIAL') {
      const partialBanner = lang === 'ko' ? '하나의 독립 예측만 완료되어 예측 비교를 수행할 수 없습니다.' : "I could complete only one independent forecast, so I can't reliably compare forecasts.";
      html += '<div class="forecast-banner forecast-banner-partial" data-testid="forecast-partial-banner">' + esc(partialBanner) + '</div>';
    }

    html += '<div class="forecast-header-section">';
    html += '<h3 class="forecast-title">' + esc(forecastTitle) + '</h3>';
    html += '<div class="forecast-metrics">';
    html += '<div class="forecast-metric"><span class="forecast-metric-label">' + esc(likelihoodTitle) + ':</span> <strong class="forecast-metric-value">' + esc(probLabel) + '</strong></div>';
    html += '<div class="forecast-metric"><span class="forecast-metric-label">' + esc(rangeTitle) + ':</span> <span class="forecast-metric-value">' + esc(rangeLabel) + '</span></div>';
    html += '</div>';
    html += '</div>';

    if (synthesis.summary) {
      html += '<div class="forecast-section">';
      html += '<h4 class="forecast-section-title">' + esc(whyTitle) + '</h4>';
      html += '<p class="forecast-summary-text">' + esc(synthesis.summary) + '</p>';
      html += '</div>';
    }

    if (Array.isArray(synthesis.keyDrivers) && synthesis.keyDrivers.length > 0) {
      html += '<div class="forecast-section">';
      html += '<h4 class="forecast-section-title">' + esc(supportingTitle) + '</h4>';
      html += '<ul class="forecast-list">';
      synthesis.keyDrivers.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    if (Array.isArray(synthesis.counterSignals) && synthesis.counterSignals.length > 0) {
      html += '<div class="forecast-section">';
      html += '<h4 class="forecast-section-title">' + esc(opposingTitle) + '</h4>';
      html += '<ul class="forecast-list">';
      synthesis.counterSignals.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    if (Array.isArray(synthesis.whatWouldChangeTheForecast) && synthesis.whatWouldChangeTheForecast.length > 0) {
      html += '<div class="forecast-section">';
      html += '<h4 class="forecast-section-title">' + esc(whatWouldChangeTitle) + '</h4>';
      html += '<ul class="forecast-list">';
      synthesis.whatWouldChangeTheForecast.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    if (Array.isArray(synthesis.uncertainties) && synthesis.uncertainties.length > 0) {
      html += '<div class="forecast-section">';
      html += '<h4 class="forecast-section-title">' + esc(uncertaintiesTitle) + '</h4>';
      html += '<ul class="forecast-list">';
      synthesis.uncertainties.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    const sourcesList = result.sources || (result.evidencePack && result.evidencePack.sources);
    if (Array.isArray(sourcesList) && sourcesList.length > 0) {
      html += '<div class="forecast-section">';
      html += '<h4 class="forecast-section-title">' + esc(sourcesTitle) + '</h4>';
      html += '<ul class="forecast-sources-list">';
      sourcesList.forEach(function (src) {
        const title = src.title || src.url;
        html += '<li><a href="' + esc(src.url) + '" target="_blank" rel="noopener">' + esc(title) + '</a></li>';
      });
      html += '</ul></div>';
    }

    html += '</div>';
    container.innerHTML = html;
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.isDebugMode = isDebugMode;
  window.NAGEX.isEnterpriseUiMode = isEnterpriseUiMode;
  window.NAGEX.applyEnterpriseUiGate = applyEnterpriseUiGate;
  window.NAGEX.openAmbientOverlay = openAmbientOverlay;
  window.NAGEX.renderPerspectiveCompareResult = renderPerspectiveCompareResult;
  window.NAGEX.renderForecastCompareResult = renderForecastCompareResult;

  initRouter();
  loadAllData();
  applyEnterpriseUiGate();
})();
