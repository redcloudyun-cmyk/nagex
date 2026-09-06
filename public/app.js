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
  };

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

  document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initQuickWake();
    initPrimaryScenario();
    initQuickActionChips();
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
    const [memData, planData, skillData, toolData, apprData, execData, knowData, qwData, autoData] = await Promise.all([
      apiFetch('/api/v1/memory'),
      apiFetch('/api/v1/plans'),
      apiFetch('/api/v1/skills'),
      apiFetch('/api/v1/tools'),
      apiFetch('/api/v1/approvals'),
      apiFetch('/api/v1/executions'),
      apiFetch('/api/v1/knowledge'),
      apiFetch('/api/v1/quickwake/config'),
      apiFetch('/api/v1/autonomy/config'),
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
      </div>`
      )
      .join('');
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

    if (preview && planSteps && res.plan) {
      preview.style.display = 'block';
      planSteps.innerHTML = res.plan.steps
        .map((s) => `<div class="step-row">
          <span class="step-num">${s.step}.</span>
          <span class="step-name"><strong>${escapeHtml(s.title)}</strong><br><small>${escapeHtml(s.reasoning)} · Skill: ${escapeHtml(s.skill)}${s.tool ? ` · Tool: ${escapeHtml(s.tool)}` : ''}${s.requiresApproval ? ' · Approval required' : ''}</small></span>
        </div>`)
        .join('');
    }

    if (res.plan) await resolvePlanIntoUi(res.plan);

    if (resultCard && resultText) {
      resultCard.style.display = 'block';
      resultText.textContent = `${res.plan.summary} No tools have been executed. Request ID: ${res.requestId}`;
    }
  }

  async function resolvePlanIntoUi(plan) {
    const card = document.getElementById('ambient-resolution-card');
    const statusEl = document.getElementById('ambient-resolution-status');
    const stepsEl = document.getElementById('ambient-resolution-steps');
    const warningsEl = document.getElementById('ambient-resolution-warnings');
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

    if (vm.showRunButton && vm.actionLabel) {
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
