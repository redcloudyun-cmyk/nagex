// NAgex Personal AI — Control Center & Ambient Assistant Client Controller
(function () {
  'use strict';

  const state = {
    activeTab: 'tab-home',
    memories: [],
    plans: [],
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
  };

  var FLOW_STAGES = ['User message', 'Plan Preview', 'Plan Resolution', 'Approval Card', 'Human Approval', 'Execution', 'Result'];

  function updateFlowStage(stageLabel) {
    const el = document.getElementById('ambient-flow-stepper');
    if (!el) return;
    const activeIdx = FLOW_STAGES.indexOf(stageLabel);
    el.innerHTML = FLOW_STAGES.map((s, idx) => {
      const cls = idx === activeIdx ? 'flow-stage active' : idx < activeIdx ? 'flow-stage done' : 'flow-stage';
      return `<span class="${cls}">${escapeHtml(s)}</span>`;
    }).join('');
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

  function addTimelineEntry(label) {
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
    else if (state.activeTab === 'tab-memory') renderMemory();
    else if (state.activeTab === 'tab-plans') renderPlans();
    else if (state.activeTab === 'tab-skills') renderSkills();
    else if (state.activeTab === 'tab-tools') renderTools();
    else if (state.activeTab === 'tab-approvals') renderApprovals();
    else if (state.activeTab === 'tab-executions') renderExecutions();
    else if (state.activeTab === 'tab-knowledge') renderKnowledge();
    else if (state.activeTab === 'tab-settings') renderSettings();
  }

  async function loadAllData() {
    const [memData, planData, skillData, toolData, apprData, execData, knowData, qwData, autoData, oauthData] = await Promise.all([
      apiFetch('/api/v1/memory'),
      apiFetch('/api/v1/plans'),
      apiFetch('/api/v1/skills'),
      apiFetch('/api/v1/tools'),
      apiFetch('/api/v1/approvals'),
      apiFetch('/api/v1/executions'),
      apiFetch('/api/v1/knowledge'),
      apiFetch('/api/v1/quickwake/config'),
      apiFetch('/api/v1/autonomy/config'),
      apiFetch('/api/v1/oauth/google/status'),
    ]);

    if (memData) state.memories = memData.memories || [];
    if (planData) state.plans = planData.plans || [];
    if (skillData) state.skills = skillData.skills || [];
    if (toolData) state.tools = toolData.tools || [];
    if (apprData) state.approvals = apprData.approvals || [];
    if (execData) state.executions = execData.executions || [];
    if (knowData) state.knowledge = knowData.documents || [];
    if (qwData) state.quickWakeConfig = qwData;
    if (autoData) state.autonomyConfig = autoData;
    if (oauthData && typeof oauthData.connected === 'boolean') state.googleOAuth = oauthData;

    renderActiveTab();
  }

  function renderHome() {
    // Update summary counters
    const elMemCount = document.getElementById('val-memory-count');
    const elPlanCount = document.getElementById('val-open-plans-count');
    const elApprCount = document.getElementById('val-pending-appr-count');
    const elToolCount = document.getElementById('val-tools-count');

    if (elMemCount) elMemCount.textContent = state.memories.length;
    if (elPlanCount) elPlanCount.textContent = state.plans.filter((p) => p.status === 'RUNNING' || p.status === 'AWAITING_APPROVAL').length || state.plans.length;
    if (elApprCount) elApprCount.textContent = state.approvals.filter((a) => a.status === 'PENDING').length;
    if (elToolCount) elToolCount.textContent = `${state.tools.filter((t) => t.connectionStatus === 'connected' && t.executionMode === 'live').length} / ${state.tools.length}`;

    // Home Prompt Button
    const btnSend = document.getElementById('btn-home-prompt-send');
    const homeInput = document.getElementById('home-prompt-input');
    if (btnSend && homeInput) {
      btnSend.onclick = () => {
        const text = homeInput.value.trim();
        if (text) {
          openAmbientOverlay(text);
          runAmbientTask(text);
        }
      };
    }
  }

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
        openAmbientOverlay(promptText);
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

    container.innerHTML = state.plans
      .map(
        (p) => `
      <div class="plan-item-card">
        <div class="plan-item-header">
          <span class="plan-goal-title">Goal: ${escapeHtml(p.goal)}</span>
          <span class="step-badge ${p.status.toLowerCase()}">${p.status}</span>
        </div>
        <div class="plan-step-list">
          ${p.steps
            .map(
              (s) => `
            <div class="step-row">
              <span class="step-num">${s.step}.</span>
              <span class="step-name">${escapeHtml(s.title)} <small style="color:var(--text-muted);">[Skill: ${s.skill} | Tool: ${s.tool}]</small></span>
              <span class="step-badge ${s.status.toLowerCase().replace('_', '-')}">${s.status}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>`
      )
      .join('');
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
  }

  function renderApprovals() {
    const container = document.getElementById('approvals-list-container');
    if (!container) return;

    container.innerHTML = state.approvals
      .map(
        (a) => `
      <div class="plan-item-card">
        <div class="plan-item-header">
          <span class="plan-goal-title">Action: ${escapeHtml(a.action)}</span>
          <span class="step-badge ${a.status.toLowerCase()}">${a.status}</span>
        </div>
        <p class="card-body-text"><strong>Tool Involved:</strong> ${escapeHtml(a.tool)}</p>
        <p class="card-body-text"><strong>Recipient:</strong> ${escapeHtml(a.recipient)}</p>
        <p class="card-body-text"><strong>Subject:</strong> ${escapeHtml(a.subject)}</p>
        <p class="card-body-text"><strong>Data Involved:</strong> ${a.shared_data.join(', ')}</p>
        <p class="card-body-text" style="color:var(--text-muted);">Reason: ${escapeHtml(a.why)}</p>
        ${
          a.status === 'PENDING'
            ? `
          <div class="card-footer-actions" style="margin-top:0.75rem;">
            <button class="btn-small danger" onclick="window.NAGEX.handleApprovalAction('${a.id}', 'REJECT')">Reject</button>
            <button class="btn-primary" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="window.NAGEX.handleApprovalAction('${a.id}', 'APPROVE')">Approve</button>
          </div>`
            : ''
        }
      </div>`
      )
      .join('');
  }

  function renderExecutions() {
    const container = document.getElementById('executions-list-container');
    if (!container) return;

    container.innerHTML = state.executions
      .map(
        (e) => `
      <div class="plan-item-card">
        <div class="plan-item-header">
          <span class="plan-goal-title">${escapeHtml(e.objective || 'Execution Trace')}</span>
          <span class="step-badge completed">${e.status}</span>
        </div>
        <p class="card-body-text" style="font-size:0.75rem; color:var(--text-muted);">Execution ID: ${e.execution_id} | Created: ${e.created_at}</p>
        ${
          e.steps_log
            ? `
          <div class="plan-step-list">
            ${(e.steps_log || [])
              .map(
                (stepMsg, idx) => `
              <div class="step-row">
                <span class="step-num">${idx + 1}.</span>
                <span class="step-name">${escapeHtml(stepMsg)}</span>
              </div>`
              )
              .join('')}
          </div>`
            : ''
        }
      </div>`
      )
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
  }

  function initQuickWake() {
    const btnFloat = document.getElementById('btn-floating-quickwake');
    const btnHeader = document.getElementById('btn-header-quickwake');
    const btnClose = document.getElementById('btn-close-ambient');
    const btnCancel = document.getElementById('btn-ambient-cancel');
    const btnRun = document.getElementById('btn-ambient-run');
    const btnVoice = document.getElementById('btn-ambient-voice-toggle');

    if (btnFloat) btnFloat.onclick = () => openAmbientOverlay();
    if (btnHeader) btnHeader.onclick = () => openAmbientOverlay();
    if (btnClose) btnClose.onclick = closeAmbientOverlay;
    if (btnCancel) btnCancel.onclick = closeAmbientOverlay;

    if (btnVoice) {
      btnVoice.onclick = () => {
        const wave = document.getElementById('ambient-waveform');
        if (wave) wave.style.display = wave.style.display === 'none' ? 'flex' : 'none';
      };
    }

    if (btnRun) {
      btnRun.onclick = () => {
        const input = document.getElementById('ambient-prompt-input');
        const text = input ? input.value.trim() : '';
        if (text) runAmbientTask(text);
      };
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

  function openAmbientOverlay(initialPrompt = '') {
    const backdrop = document.getElementById('ambient-overlay-backdrop');
    const input = document.getElementById('ambient-prompt-input');
    const progress = document.getElementById('ambient-progress-container');
    const preview = document.getElementById('ambient-plan-preview');
    const resolution = document.getElementById('ambient-resolution-card');
    const result = document.getElementById('ambient-result-card');

    if (backdrop) backdrop.style.display = 'flex';
    if (input) input.value = initialPrompt || 'Prepare my next client meeting and schedule it.';
    if (progress) progress.style.display = 'none';
    if (preview) preview.style.display = 'none';
    if (resolution) resolution.style.display = 'none';
    if (result) result.style.display = 'none';
    resetAmbientFlowUi();
  }

  function closeAmbientOverlay() {
    const backdrop = document.getElementById('ambient-overlay-backdrop');
    if (backdrop) backdrop.style.display = 'none';
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

  async function runAmbientTask(promptText) {
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
    addTimelineEntry('Plan created');

    if (preview && planSteps && res.plan) {
      preview.style.display = 'block';
      planSteps.innerHTML = res.plan.steps
        .map((s) => `<div class="step-row">
          <span class="step-num">${s.step}.</span>
          <span class="step-name"><strong>${escapeHtml(s.title)}</strong><br><small>${escapeHtml(s.reasoning)} · Skill: ${escapeHtml(s.skill)}${s.tool ? ` · Tool: ${escapeHtml(s.tool)}` : ''}${s.requiresApproval ? ' · Approval required' : ''}</small></span>
        </div>`)
        .join('');
    }

    if (res.plan) await resolvePlanIntoUi(res.plan, promptText);

    if (resultCard && resultText) {
      resultCard.style.display = 'block';
      resultText.textContent = `${res.plan.summary} No tools have been executed. Request ID: ${res.requestId}`;
    }
  }

  async function resolvePlanIntoUi(plan, originalPromptText) {
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
      if (extracted) {
        // The prompt already fully specifies the event: skip the manual
        // compose form and go straight to requesting approval (per the
        // Ambient UI flow: Plan Preview -> one Calendar step -> Approval
        // Card, with no intermediate form for a fully-specified request).
        actionsEl.innerHTML = '<div id="calendar-preview-slot"></div>';
        requestCalendarApproval(extracted);
      } else {
        renderCalendarComposeForm(actionsEl, calendarStep);
      }
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

  function defaultEventStartLocal() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderCalendarComposeForm(actionsEl, calendarStep) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    actionsEl.innerHTML = `
      <form class="calendar-compose-form" id="calendar-compose-form">
        <h4>Confirm the exact calendar event</h4>
        <label>Title
          <input type="text" id="cal-title" value="${escapeHtml(calendarStep.title)}" required>
        </label>
        <label>Start
          <input type="datetime-local" id="cal-start" value="${defaultEventStartLocal()}" required>
        </label>
        <label>Duration (minutes)
          <input type="number" id="cal-duration" value="30" min="5" step="5" required>
        </label>
        <label>Timezone
          <input type="text" value="${escapeHtml(timezone)}" disabled>
        </label>
        <label>Attendee emails (comma-separated)
          <input type="text" id="cal-attendees" placeholder="name@example.com">
        </label>
        <label>Description
          <textarea id="cal-description" rows="2">${escapeHtml(calendarStep.reasoning || '')}</textarea>
        </label>
        <label class="calendar-checkbox-label">
          <input type="checkbox" id="cal-meet-link"> Add a Google Meet link
        </label>
        <label>Calendar
          <input type="text" value="primary" disabled>
        </label>
        <button type="submit" class="btn-plan-action plan-status-approval">🛡️ Preview & Request Approval</button>
      </form>
      <div id="calendar-preview-slot"></div>`;

    const form = document.getElementById('calendar-compose-form');
    if (form) {
      form.onsubmit = (event) => {
        event.preventDefault();
        const start = document.getElementById('cal-start').value;
        const durationMin = Number(document.getElementById('cal-duration').value) || 30;
        const startDate = new Date(`${start}:00`);
        const endDate = new Date(startDate.getTime() + durationMin * 60000);
        const pad = (n) => String(n).padStart(2, '0');
        const toLocalIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

        const payload = {
          calendarId: 'primary',
          summary: document.getElementById('cal-title').value.trim(),
          description: document.getElementById('cal-description').value,
          start: toLocalIso(startDate),
          end: toLocalIso(endDate),
          timezone,
          attendees: document.getElementById('cal-attendees').value.split(',').map((e) => e.trim()).filter(Boolean),
          conferenceData: document.getElementById('cal-meet-link').checked,
        };
        requestCalendarApproval(payload);
      };
    }
  }

  const GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID = 'google_calendar.create_event';

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
    addTimelineEntry('Approval requested');
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
            addTimelineEntry('Rejected');
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
          addTimelineEntry('Approved');

          // Step 7: execute with the exact canonicalPayload the approval API
          // returned — never the locally-composed `payload` variable.
          const result = await apiFetch('/api/v1/tools/google-calendar/create-event', {
            method: 'POST',
            body: JSON.stringify({ approvalId: approval.approvalId, payload: approval.canonicalPayload }),
          });

          updateFlowStage('Result');

          if (result && result.status === 'SUCCEEDED') {
            addTimelineEntry('Calendar event created');
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
        addTimelineEntry('Approval expired');
      }
    }, 1000);
  }

  function initPrimaryScenario() {
    const btnHero = document.getElementById('btn-run-primary-scenario');
    const btnAmbientPlan = document.getElementById('btn-run-ambient-plan');
    const runPrimaryScenario = () => {
      const scenarioPrompt = 'Prepare my next client meeting and schedule it.';
      openAmbientOverlay(scenarioPrompt);
      runAmbientTask(scenarioPrompt);
    };
    if (btnHero) {
      btnHero.onclick = runPrimaryScenario;
    }
    if (btnAmbientPlan) btnAmbientPlan.onclick = runPrimaryScenario;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.NAGEX = {
    switchTab,
    openAmbientWithPrompt: (promptText) => {
      openAmbientOverlay(promptText);
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
    handleApprovalAction: async (id, action) => {
      await apiFetch(`/api/v1/approvals/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
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
  };
})();
