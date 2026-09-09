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

  function updateFlowStage(stageLabel) {
    const el = document.getElementById('ambient-flow-stepper');
    const statusEl = document.getElementById('ambient-modal-status');
    if (statusEl) statusEl.textContent = stageLabel || '';
    if (!el) return;
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

  async function apiFetch(endpoint, options = {}) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'X-NAgex-Tenant': 'ten_production_01',
          'X-Principal-Id': 'usr_admin_001',
          ...(options.headers || {}),
        },
        ...options,
      });
      return await res.json();
    } catch (err) {
      console.error('API Error:', endpoint, err);
      return null;
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
    initNavigation();
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

  function switchTab(tabId) {
    state.activeTab = tabId;
    document.querySelectorAll('.nav-menu .nav-item').forEach((el) => {
      if (el.getAttribute('data-tab') === tabId) el.classList.add('active');
      else el.classList.remove('active');
    });

    const targetViewId = 'view-' + tabId.replace('tab-', '');
    document.querySelectorAll('.tab-view').forEach((v) => {
      if (v.id === targetViewId) v.classList.add('active-view');
      else v.classList.remove('active-view');
    });

    renderActiveTab();
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
  }

  async function loadAllData() {
    const [memData, planData, taskData, skillData, toolData, apprData, execData, knowData, qwData, autoData, oauthData, tgStatus, tgIdentities, slackStatus, slackIdentities, notifData, candData, activityData, inboxData, convData] = await Promise.all([
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
    ]);

    if (memData) state.memories = memData.memories || [];
    if (planData) state.plans = planData.plans || [];
    if (taskData) state.tasks = taskData.tasks || [];
    if (skillData) state.skills = skillData.skills || [];
    if (toolData) state.tools = toolData.tools || [];
    if (apprData) state.approvals = apprData.approvals || [];
    if (execData) state.executions = execData.executions || [];
    if (knowData) state.knowledge = knowData.documents || [];
    if (candData) state.candidates = candData.candidates || [];
    if (activityData) state.activity = activityData.activities || [];
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
    const isKr = window.NAGEX_I18N && window.NAGEX_I18N.currentLocale === 'kr';
    const heroEyebrow = document.querySelector('.eyebrow-text');
    const heroTitle = document.querySelector('.personal-hero-title');
    const heroSub = document.querySelector('.personal-hero-subtitle');

    if (heroEyebrow) heroEyebrow.textContent = 'NAGEX';
    if (heroTitle) {
      heroTitle.innerHTML = isKr
        ? '<span class="brand-blue">NAgex</span> — 다음 시대를 위한 Personal AI'
        : '<span class="brand-blue">NAgex</span> — Personal AI for the Next Age';
    }
    if (heroSub) {
      heroSub.textContent = isKr
        ? '당신과 함께 기억하고, 이해하며, 실행하는 지능.'
        : 'Intelligence that remembers, understands, and acts with you.';
    }

    renderHomeWorkspaceSections();

    const btnSend = document.getElementById('btn-home-prompt-send');
    const homeInput = document.getElementById('home-prompt-input');
    const btnLink = document.getElementById('btn-afford-link');
    const btnFile = document.getElementById('btn-afford-file');
    const btnAudio = document.getElementById('btn-afford-audio');

    if (btnSend && homeInput) {
      btnSend.onclick = async () => {
        const text = homeInput.value.trim();
        if (!text) return;
        homeInput.value = '';

        // 1. Run InputRouter classification
        const routeRes = await apiFetch('/api/v1/workspace/route-input', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });

        const intent = routeRes?.data?.primaryIntent || 'ASK';

        // 2. Dispatch to single primary path
        if (intent === 'ASK' || intent === 'COMMAND') {
          openAmbientOverlay();
          runAmbientTask(text);
        } else if (intent === 'LINK_CAPTURE' || intent === 'CAPTURE') {
          await apiFetch('/api/v1/workspace/capture', {
            method: 'POST',
            body: JSON.stringify({
              type: intent === 'LINK_CAPTURE' ? 'LINK' : 'TEXT',
              content: text,
              source: 'WEB',
            }),
          });
          renderInbox();
          switchTab('tab-inbox');
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
        .map((task) => ({ title: task.name || 'Task in progress...', detail: task.lastRunAt ? `Started ${new Date(task.lastRunAt).toLocaleTimeString()}` : 'Started recently' }));
      const processingCaptures = (state.inbox || [])
        .filter((i) => i.status === 'PROCESSING' || i.status === 'QUEUED' || i.status === 'UPLOADING')
        .map((i) => ({ title: i.metadata?.extractedTitle || i.content || 'Processing capture...', detail: i.metadata?.processingSubStage || i.status }));
      const runningActions = (state.candidates || [])
        .filter((c) => c.action && c.action.status === 'RUNNING')
        .map((c) => ({ title: c.title, detail: `${c.type} action in progress` }));
      const workingItems = [...processingCaptures, ...runningTasks, ...runningActions].slice(0, 2);
      if (workingItems.length > 0) {
        if (card) card.style.display = 'block';
        elWorking.innerHTML = workingItems.map((w) => `<div class="inbox-item-card">
            <div class="inbox-item-main">
              <span class="inbox-item-title">${escapeHtml(w.title)}</span>
              <span class="inbox-item-summary">${escapeHtml(w.detail)}</span>
            </div>
            <span class="badge-status status-PROCESSING">${escapeHtml(t('workspace.working') || 'WORKING')}</span>
          </div>`).join('');
      } else {
        if (card) card.style.display = 'none';
      }
    }

    // 2. Needs your attention (max 2 items total, item C). Four distinct,
    // real, canonical-state-derived sources — never fake demo cards, never
    // a stale ACCEPTED/SUCCEEDED candidate shown as needing attention.
    // Candidate Review ("Review suggested ...") and Action Approval
    // ("Approve ...") use visibly different copy (item C/M) — they are not
    // the same control.
    const elAttention = document.getElementById('list-needs-attention');
    if (elAttention) {
      const card = elAttention.closest('.canvas-section-card');
      const pendingApprs = state.approvals.filter((a) => a.status === 'PENDING');
      const proposedCandidates = (state.candidates || []).filter((c) => c.status === 'PROPOSED');
      const failedActionCandidates = (state.candidates || []).filter((c) => c.status === 'ACCEPTED' && c.action && c.action.status === 'FAILED');
      const needsHumanCaptures = (state.inbox || []).filter((i) => i.status === 'NEEDS_REVIEW' && i.metadata?.errorCode === 'BLOCKED_NEEDS_HUMAN');

      const CANDIDATE_REVIEW_LABEL = { TASK: 'Review suggested task', CALENDAR: 'Review suggested calendar event', MEMORY: 'Review suggested memory', KNOWLEDGE: 'Review suggested knowledge item' };
      const ACTION_RETRY_LABEL = { TASK: 'Task action failed', CALENDAR: 'Calendar action failed', MEMORY: 'Memory action failed', KNOWLEDGE: 'Knowledge action failed' };

      const attentionItems = [
        ...pendingApprs.map((a) => ({ kind: 'approval', approval: a })),
        ...proposedCandidates.map((c) => ({ kind: 'candidate-review', candidate: c })),
        ...failedActionCandidates.map((c) => ({ kind: 'candidate-retry', candidate: c })),
        ...needsHumanCaptures.map((i) => ({ kind: 'needs-human', item: i })),
      ].slice(0, 2);

      if (attentionItems.length > 0) {
        if (card) card.style.display = 'block';
        elAttention.innerHTML = attentionItems.map((entry) => {
          if (entry.kind === 'approval') {
            const a = entry.approval;
            const humanAction = a.intent || a.action || 'Approval Required';
            return `<div class="inbox-item-card contextual-approval-card">
              <div class="inbox-item-main">
                <span class="inbox-item-title">${escapeHtml(t('workspace.actionApprovalLabel') || 'Approve')}: ${escapeHtml(humanAction)}</span>
                <span class="inbox-item-summary">${escapeHtml(a.resource?.id || 'Action Approval')}</span>
              </div>
              <div class="contextual-appr-btns" style="display: flex; gap: 0.35rem; margin-top: 0.25rem;">
                <button class="btn-primary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.approvalId}', 'APPROVE')">Approve</button>
                <button class="btn-secondary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.switchTab('tab-approvals')">Review</button>
                <button class="btn-secondary danger" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.approvalId}', 'REJECT')">Reject</button>
              </div>
            </div>`;
          }
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
          return `<div class="inbox-item-card" onclick="window.NAGEX.switchTab('tab-inbox')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.NAGEX.switchTab('tab-inbox');}"><div class="inbox-item-main"><span class="inbox-item-title">${escapeHtml(title)}</span><span class="inbox-item-summary">${escapeHtml(t('workspace.needsHumanAttention') || 'Needs your attention')}</span></div><span class="badge-status status-NEEDS_REVIEW">${escapeHtml(t('workspace.needsHumanBadge') || 'HUMAN NEEDED')}</span></div>`;
        }).join('');
      } else {
        if (card) card.style.display = 'none';
      }
    }

    // 3. Today summary (max 2 items)
    const elToday = document.getElementById('list-today-summary');
    if (elToday) {
      const card = elToday.closest('.canvas-section-card');
      if (card) {
        const hasAgenda = elToday.children && elToday.children.length > 0 && !elToday.querySelector('.empty-state-text');
        card.style.display = hasAgenda ? 'block' : 'none';
      }
    }

    // 4. Recent (max 2 items, item E) — real completed outcomes from the
    // canonical Activity projection (state.activity), never the legacy
    // non-tenant-isolated /api/v1/executions demo feed and never a generic
    // completion placeholder. Hidden entirely when there is no real
    // completed event yet — never filled for visual balance (item W).
    const elRecent = document.getElementById('list-recent-activity');
    if (elRecent) {
      const card = elRecent.closest('.canvas-section-card');
      const recentCompleted = (state.activity || []).filter((a) => a.status === 'COMPLETED').slice(0, 2);
      if (recentCompleted.length > 0) {
        if (card) card.style.display = 'block';
        elRecent.innerHTML = recentCompleted.map((a) => {
          const time = new Date(a.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return `<div class="inbox-item-card"><div class="inbox-item-main"><span class="inbox-item-title">${escapeHtml(a.title)}</span><span class="inbox-item-summary">${time}</span></div><span class="badge-status status-READY">${escapeHtml(t('workspace.activityDone') || 'Done')}</span></div>`;
        }).join('');
      } else {
        if (card) card.style.display = 'none';
      }
    }
  }

  async function renderInbox() {
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;
    // Canonical candidates are loaded FIRST so both the per-capture
    // contextual pointer and the review queue below use fresh state — never
    // the embedded metadata.candidates array (Phase 1 STEP 6, item R).
    await loadCanonicalCandidates();

    const data = await apiFetch('/api/v1/workspace/inbox');
    if (data && Array.isArray(data.items)) {
      state.inbox = data.items;
      const listEl = document.getElementById('inbox-items-list');
      if (listEl) {
        if (data.items.length === 0) {
          listEl.innerHTML = '<div class="empty-state-text">No captured items in Inbox yet. Use the composer on Home or Quick Wake (Alt+N) to capture anything!</div>';
        } else {
          listEl.innerHTML = data.items.map((item) => {
            const subStage = item.metadata?.processingSubStage || (item.status === 'PROCESSING' ? 'Processing...' : '');
            // Contextual pointer only (item A #1) — the canonical review
            // queue below is the single place Accept/Modify/Reject live, so
            // this capture card never duplicates candidate controls.
            const proposedForCapture = (state.candidates || []).filter((c) => c.captureId === item.captureId && c.status === 'PROPOSED');

            const candidatesHtml = proposedForCapture.length > 0 ? `
              <div class="candidate-pointer" style="margin-top: 0.375rem; font-size: 0.75rem; color: var(--color-accent-teal);">
                ${proposedForCapture.length} suggestion${proposedForCapture.length > 1 ? 's' : ''} — see “${escapeHtml(t('workspace.candidatesTitle') || 'Suggested (Candidates)')}” below
              </div>
            ` : '';

            // Phase 1 STEP 9, item S — the Retry button is gated by the
            // real failure classification, never shown for a capture the
            // server would refuse to retry (retryable === false: TERMINAL/
            // NEEDS_HUMAN). retryable === undefined (pre-STEP-9 data, or no
            // errorCode recorded) is treated as retryable, matching the
            // server-side check in quick-capture.service.ts#retryCapture.
            const captureRetryable = item.metadata?.retryable !== false;
            const captureCategory = item.metadata?.failureCategory;
            const retryControl = captureRetryable
              ? `<button class="btn-secondary" style="font-size: 0.7rem; margin-left: 0.5rem; padding: 2px 6px;" onclick="window.NAGEX.retryCapture('${item.captureId}')">${escapeHtml(t('workspace.retry') || 'Retry')}</button>`
              : `<span style="font-size: 0.7rem; margin-left: 0.5rem; opacity: 0.8;">${escapeHtml(captureCategory === 'NEEDS_HUMAN' ? (t('workspace.needsHumanAttention') || 'Needs your attention') : (t('workspace.notRetryable') || 'Cannot be retried'))}</span>`;
            const errorHtml = item.status === 'FAILED' ? `
              <div style="color: #ef4444; font-size: 0.75rem; margin-top: 0.25rem;">
                Error: ${escapeHtml(item.metadata?.errorMessage || 'Processing error')}
                ${retryControl}
              </div>
            ` : '';

            // Minimal, truthful surface for the real structured understanding
            // result (Phase 1 STEP 2) — topics plus counts, not the full
            // Review UX (that's a later step's concern).
            const topics = item.metadata?.topics || [];
            const dateCount = (item.metadata?.dates || []).length;
            const actionItemCount = (item.metadata?.actionItems || []).length;
            const understandingBits = [
              // Real page count from the PDF parser only — never guessed
              // (Phase 1 STEP 4, item D).
              item.type === 'FILE' && item.metadata?.pageCount ? `${item.metadata.pageCount} page${item.metadata.pageCount > 1 ? 's' : ''}` : '',
              topics.length > 0 ? topics.slice(0, 4).map(escapeHtml).join(', ') : '',
              dateCount > 0 ? `${dateCount} date${dateCount > 1 ? 's' : ''} detected` : '',
              actionItemCount > 0 ? `${actionItemCount} action item${actionItemCount > 1 ? 's' : ''}` : '',
              // Never present a truncated retrieval/document as full-content
              // understanding (Phase 1 STEP 3 fix, reused for PDFs in STEP 4).
              item.metadata?.truncated ? 'based on partial content' : '',
              item.metadata?.hasText === false ? 'no extractable text — OCR not performed' : '',
              (item.metadata?.extractionWarnings || []).length > 0 ? `${item.metadata.extractionWarnings.length} extraction warning${item.metadata.extractionWarnings.length > 1 ? 's' : ''}` : '',
            ].filter(Boolean);
            const understandingHtml = understandingBits.length > 0 ? `
              <span class="inbox-item-understanding" style="font-size: 0.72rem; color: var(--color-text-secondary);">${understandingBits.join(' · ')}</span>
            ` : '';

            // Real source domain only — never a guessed/invented one (Phase
            // 1 STEP 3, item N).
            let sourceDomain = '';
            if (item.metadata?.sourceUrl) {
              try { sourceDomain = new URL(item.metadata.sourceUrl).hostname; } catch { /* leave blank */ }
            }

            return `
              <div class="inbox-item-card">
                <div class="inbox-item-main">
                  <span class="inbox-item-title">${escapeHtml(item.metadata?.extractedTitle || item.content)}</span>
                  <span class="inbox-item-summary">${escapeHtml(item.metadata?.extractedSummary || item.content)} (${item.type} • ${item.source}${sourceDomain ? ` • ${escapeHtml(sourceDomain)}` : ''})</span>
                  ${understandingHtml}
                  ${subStage ? `<span class="inbox-item-substage" style="font-size: 0.75rem; color: var(--color-text-secondary);">${escapeHtml(subStage)}</span>` : ''}
                  ${errorHtml}
                  ${candidatesHtml}
                </div>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                  <span class="badge-status status-${item.status}">${item.status}</span>
                  ${item.status === 'NEEDS_REVIEW' && proposedForCapture.length === 0 ? `<button class="btn-secondary" style="font-size: 0.75rem;" onclick="window.NAGEX.actionCapture('${item.captureId}', 'ACTIONED')">Action</button>` : ''}
                </div>
              </div>
            `;
          }).join('');
        }
      }
    }
    await renderCandidateReviewQueue();
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
      const successText = {
        TASK: t('workspace.candidateSuccessTask') || 'Task created',
        CALENDAR: t('workspace.candidateSuccessCalendar') || 'Added to Google Calendar',
        MEMORY: t('workspace.candidateSuccessMemory') || 'Remembered',
        KNOWLEDGE: t('workspace.candidateSuccessKnowledge') || 'Added to knowledge',
      }[candidate.type];
      const openLink = candidate.type === 'CALENDAR' && action.externalUrl
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

  function initQuickActionChips() {
    const chips = document.querySelectorAll('.quick-action-chip');
    chips.forEach((chip) => {
      chip.onclick = () => {
        const action = chip.getAttribute('data-action');
        let promptText = 'Plan my day';
        if (action === 'summarize-notes') promptText = 'Summarize my recent notes and action items.';
        else if (action === 'prepare-meeting') promptText = 'Prepare my next client meeting and schedule it.';
        else if (action === 'research-topic') promptText = 'Perform deep research on current AI Agent market trends.';
        else if (action === 'execute-task') promptText = 'Run automated code security review on active repository.';
        openAmbientOverlay();
        runAmbientTask(promptText);
      };
    });
  }

  function renderMemory() {
    const container = document.getElementById('memory-cards-container');
    if (!container) return;

    container.innerHTML = state.memories
      .map((m) => {
        const subj = m.content ? m.content.subject : 'Memory Item';
        const pred = m.content ? m.content.predicate : '';
        const val = m.content ? String(m.content.value) : '';
        const updated = m.updated_at ? new Date(m.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recently';

        return `
        <div class="mem-card">
          <div class="card-header-row">
            <span class="card-title">${escapeHtml(subj)} ${escapeHtml(pred)}</span>
            <span class="tag-scope">${m.scope || 'USER'}</span>
          </div>
          <p class="card-body-text"><strong>What NAgex Remembers:</strong> ${escapeHtml(val)}</p>
          <p class="card-body-text" style="font-size:0.75rem;"><strong>Why Remembered:</strong> Saved from task context & user preference</p>
          <p class="card-body-text" style="font-size:0.72rem; color:var(--text-light);">Last updated: ${updated}</p>
          <div class="card-footer-actions">
            <button class="btn-small" onclick="alert('Viewing memory record ${m.id}: \\nSubject: ${escapeHtml(subj)}\\nValue: ${escapeHtml(val)}')">View</button>
            <button class="btn-small" onclick="window.NAGEX.togglePinMemory('${m.id}')">${m.pinned ? '📌 Pinned' : 'Pin'}</button>
            <button class="btn-small danger" onclick="window.NAGEX.deleteMemory('${m.id}')">Forget</button>
          </div>
        </div>`;
      })
      .join('');

    const btnClear = document.getElementById('btn-clear-session-mem');
    if (btnClear) {
      btnClear.onclick = async () => {
        state.memories = state.memories.filter((m) => m.scope !== 'SESSION');
        renderMemory();
      };
    }
  }

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
        const tgUserId = prompt('Enter Telegram User ID to link to your NAgex Main Session (e.g. 12345678):');
        if (tgUserId && tgUserId.trim()) {
          const username = prompt('Optional: Telegram Username (e.g. janesmith):') || undefined;
          await window.NAGEX.linkTelegramIdentity(tgUserId.trim(), 'usr_admin_001', username);
        }
      };
    }
    const btnSlackLink = document.getElementById('btn-slack-link-identity');
    if (btnSlackLink) {
      btnSlackLink.onclick = async () => {
        const slackUserId = prompt('Enter Slack User ID to link to your NAgex Main Session (e.g. U1234567):');
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
            <button class="btn-small danger" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'REJECT')">Reject</button>
            <button class="btn-primary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'APPROVE')">Approve</button>
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
  const ACTIVITY_STATUS_BADGE = { RUNNING: 'status-PROCESSING', COMPLETED: 'status-READY', FAILED: 'status-FAILED', NEEDS_ATTENTION: 'status-NEEDS_REVIEW' };

  function renderActivity() {
    const container = document.getElementById('executions-list-container');
    if (!container) return;
    const t = window.NAGEX_I18N ? window.NAGEX_I18N.t : (k) => k;

    const activities = state.activity || [];
    if (activities.length === 0) {
      container.innerHTML = `<div class="empty-state-text">${escapeHtml(t('workspace.noActivityYet') || 'No activity yet.')}</div>`;
      return;
    }

    container.innerHTML = activities
      .map((a) => {
        const time = new Date(a.occurredAt).toLocaleString();
        const badgeClass = ACTIVITY_STATUS_BADGE[a.status] || 'status-READY';
        return `
      <div class="plan-item-card">
        <div class="plan-item-header">
          <span class="plan-goal-title">${escapeHtml(a.title)}</span>
          <span class="badge-status ${badgeClass}">${escapeHtml(a.status)}</span>
        </div>
        ${a.description ? `<p class="card-body-text" style="font-size:0.8rem;">${escapeHtml(a.description)}</p>` : ''}
        <p class="card-body-text" style="font-size:0.75rem; color:var(--text-muted);">${time}</p>
      </div>`;
      })
      .join('');
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

  function renderSettings() {
    const qwContainer = document.getElementById('quickwake-settings-options');
    const autoContainer = document.getElementById('autonomy-selector-container');

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
            ${o.notSupported ? `<span class="device-tag">${o.label}</span>` : ''}
          </div>
          ${
            !o.notSupported
              ? `<input type="checkbox" ${o.enabled ? 'checked' : ''} onchange="window.NAGEX.toggleQuickWakeOpt('${o.key}', this.checked)">`
              : ''
          }
        </div>`
        )
        .join('');
    }

    if (autoContainer) {
      const levels = [
        { id: 'L0', title: 'Level 0 — Ask Every Time', desc: 'Require human approval for all actions.' },
        { id: 'L1', title: 'Level 1 — Read Only', desc: 'Allow read-only queries autonomously; require approval for changes.' },
        { id: 'L2', title: 'Level 2 — Low-risk Actions', desc: 'Execute low-risk task steps; require approval before external send/edits.' },
        { id: 'L3', title: 'Level 3 — Trusted Workflows', desc: 'Autonomous execution for trusted workflows.' },
      ];

      autoContainer.innerHTML = levels
        .map(
          (l) => `
        <div class="autonomy-level-card ${state.autonomyConfig.level === l.id ? 'selected' : ''}" onclick="window.NAGEX.selectAutonomy('${l.id}')">
          <div class="setting-title">${l.title}</div>
          <div class="setting-sub">${l.desc}</div>
        </div>`
        )
        .join('');
    }

    renderSettingsConnections();
    wireSettingsAdvancedToggle();
  }

  // Real Google OAuth connection status (state.googleOAuth, already fetched
  // by loadAllData) — never a fake "Connected" badge (MASTER.md Section 8).
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
          await apiFetch('/api/v1/oauth/google/disconnect', { method: 'POST' });
          const fresh = await apiFetch('/api/v1/oauth/google/status');
          if (fresh) state.googleOAuth = fresh;
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

    const btnModalApprove = document.getElementById('btn-modal-approve');
    const btnModalReject = document.getElementById('btn-modal-reject');
    if (btnModalApprove) {
      btnModalApprove.onclick = async () => {
        closeApprovalModal();
        closeAmbientOverlay();
      };
    }
    if (btnModalReject) {
      btnModalReject.onclick = () => {
        closeApprovalModal();
        alert('Action execution rejected by user.');
      };
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

    // Remember what had focus so it can be restored when the modal closes.
    ambientModalTriggerElement = document.activeElement;

    if (backdrop) backdrop.style.display = 'flex';
    // The composer always starts empty (placeholder visible), even when an
    // initialPrompt is supplied — every caller passes that prompt straight
    // to runAmbientTask() below, not into this field, so the box is
    // immediately ready for the user's next message rather than showing
    // stale demo/echoed text.
    if (input) input.value = '';
    if (progress) progress.style.display = 'none';
    if (preview) preview.style.display = 'none';
    if (resolution) resolution.style.display = 'none';
    if (result) result.style.display = 'none';
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

  function openApprovalModal(appr) {
    const backdrop = document.getElementById('approval-modal-backdrop');
    const elAction = document.getElementById('appr-field-action');
    const elRecip = document.getElementById('appr-field-recipient');
    const elSubj = document.getElementById('appr-field-subject');
    const elWhy = document.getElementById('appr-field-why');

    if (elAction) elAction.textContent = appr.action;
    if (elRecip) elRecip.textContent = appr.recipient;
    if (elSubj) elSubj.textContent = appr.subject;
    if (elWhy) elWhy.textContent = appr.why;

    if (backdrop) backdrop.style.display = 'flex';
  }

  function closeApprovalModal() {
    const backdrop = document.getElementById('approval-modal-backdrop');
    if (backdrop) backdrop.style.display = 'none';
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

  async function runAmbientTask(promptText) {
    // Single-flight: while one generation is in flight, ignore any further
    // trigger rather than starting a second, legitimately-different plan
    // for what the user perceives as one action.
    if (ambientRunGuard && !ambientRunGuard.tryEnter()) return;
    setAmbientRunControlsDisabled(true);
    try {
      const progress = document.getElementById('ambient-progress-container');
      const fill = document.getElementById('ambient-progress-fill');
      const text = document.getElementById('ambient-progress-text');
      const preview = document.getElementById('ambient-plan-preview');
      const planSteps = document.getElementById('ambient-plan-steps');
      const resultCard = document.getElementById('ambient-result-card');
      const resultText = document.getElementById('ambient-result-text');

      updateFlowStage('User message');
      if (progress) progress.style.display = 'flex';
      if (fill) fill.style.width = '20%';
      if (text) text.textContent = 'Understanding request & recalling memory...';

      if (fill) fill.style.width = '50%';
      if (text) text.textContent = 'Routing to the best available model & creating a plan...';

      const res = await apiFetch('/api/v1/ambient/intent', {
        method: 'POST',
        body: JSON.stringify({ prompt: promptText }),
      });

      if (!res || res.error) {
        if (text) text.textContent = res?.error?.message || 'Unable to generate a plan.';
        return;
      }

      if (fill) fill.style.width = '100%';
      if (text) text.textContent = `Plan ready via ${res.provider} · ${res.model} · ${res.latencyMs}ms`;

      updateFlowStage('Plan Preview');
      addTimelineEntry('Plan created', `plan:${res.requestId}:created`, 'runAmbientTask');

      if (preview && planSteps && res.plan) {
        preview.style.display = 'block';
        planSteps.innerHTML = res.plan.steps
          .map((s) => `<div class="step-row">
            <span class="step-num">${s.step}.</span>
            <span class="step-name"><strong>${escapeHtml(s.title)}</strong><br><small>${escapeHtml(s.reasoning)} · Skill: ${escapeHtml(s.skill)}${s.tool ? ` · Tool: ${escapeHtml(s.tool)}` : ''}${s.requiresApproval ? ' · Approval required' : ''}</small></span>
          </div>`)
          .join('');
      }

      // res.requestId is this plan's stable identity for the rest of the
      // flow (resolution, approval preparation, UI hydration) — never
      // re-minted.
      if (res.plan) await resolvePlanIntoUi(res.plan, promptText, res.requestId);

      if (resultCard && resultText) {
        resultCard.style.display = 'block';
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

    card.style.display = 'block';

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
    const vmView = view.buildCardViewModel(approval, Date.now());
    const f = vmView.fields;
    slot.innerHTML = `
      <div class="calendar-approval-card">
        <h4>Approval required</h4>
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
          <button class="btn-reject-outline" id="btn-calendar-reject" ${vmView.rejectDisabled ? 'disabled' : ''}>Reject</button>
          <button class="btn-plan-action plan-status-ready" id="btn-calendar-approve" ${vmView.approveDisabled ? 'disabled' : ''}>Approve & Create</button>
        </div>
      </div>`;
    return vmView;
  }

  function renderCalendarSuccessCard(slot, approval, result, view) {
    const successVm = view.buildSuccessViewModel(approval.canonicalPayload, result);
    slot.innerHTML = `
      <div class="calendar-preview-card">
        <h4>Calendar event created</h4>
        <p><strong>${escapeHtml(successVm.title)}</strong></p>
        <p>${escapeHtml(successVm.date)} ${escapeHtml(successVm.startTime)}–${escapeHtml(successVm.endTime)} (${escapeHtml(successVm.timezone)})</p>
        <p>Execution ID: ${escapeHtml(successVm.executionId)}</p>
        <a class="btn-plan-action plan-status-ready" href="${encodeURI(successVm.externalUrl)}" target="_blank" rel="noopener">Open in Google Calendar →</a>
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
    handleApprovalAction: async (id, action) => {
      await apiFetch(`/api/v1/approvals/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      const linkedCandidate = (state.candidates || []).find((c) => c.action && c.action.approvalId === id);
      if (linkedCandidate) {
        await apiFetch(`/api/v1/candidates/${linkedCandidate.candidateId}/execute`, { method: 'POST', body: JSON.stringify({}) });
      }
      await loadAllData();
    },
    toggleQuickWakeOpt: async (key, value) => {
      state.quickWakeConfig[key] = value;
      await apiFetch('/api/v1/quickwake/config', {
        method: 'POST',
        body: JSON.stringify({ [key]: value }),
      });
    },
    selectAutonomy: async (level) => {
      state.autonomyConfig.level = level;
      await apiFetch('/api/v1/autonomy/config', {
        method: 'POST',
        body: JSON.stringify({ level }),
      });
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
  });
})();
