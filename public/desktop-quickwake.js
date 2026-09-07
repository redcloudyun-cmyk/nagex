// NAgex Desktop Quick Wake Client Controller
(function () {
  'use strict';

  const state = {
    activeTab: 'chat',
    mainSession: null,
    memories: [],
    plans: [],
    tasks: [],
    approvals: [],
    desktopStatus: null,
    isSubmitting: false,
  };

  async function apiFetch(url, options = {}) {
    const opts = { ...options };
    opts.headers = {
      'Content-Type': 'application/json',
      'x-nagex-tenant': 'ten_production_01',
      'x-principal-id': 'usr_admin_001',
      ...(options.headers || {}),
    };
    try {
      const res = await fetch(url, opts);
      if (res.status === 204) return null;
      return await res.json();
    } catch (err) {
      console.error(`API Fetch Error [${url}]:`, err);
      return null;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init & Event Wiring ──────────────────────────────────────────────────
  async function init() {
    setupTabNav();
    setupChips();
    setupComposer();
    setupHotkeyListener();
    setupLangButton();

    await loadData();
  }

  function setupTabNav() {
    const btnChat = document.getElementById('qw-tab-chat');
    const btnTasks = document.getElementById('qw-tab-tasks');
    const viewChat = document.getElementById('qw-view-chat');
    const viewTasks = document.getElementById('qw-view-tasks');

    if (btnChat && btnTasks) {
      btnChat.onclick = () => {
        state.activeTab = 'chat';
        btnChat.classList.add('active');
        btnTasks.classList.remove('active');
        if (viewChat) viewChat.style.display = 'block';
        if (viewTasks) viewTasks.style.display = 'none';
      };
      btnTasks.onclick = () => {
        state.activeTab = 'tasks';
        btnTasks.classList.add('active');
        btnChat.classList.remove('active');
        if (viewTasks) viewTasks.style.display = 'block';
        if (viewChat) viewChat.style.display = 'none';
        renderTasks();
      };
    }
  }

  function setupChips() {
    const chips = document.querySelectorAll('.qw-chip');
    chips.forEach((chip) => {
      chip.onclick = () => {
        const prompt = chip.getAttribute('data-prompt');
        if (prompt) submitPrompt(prompt);
      };
    });
  }

  function setupComposer() {
    const input = document.getElementById('qw-composer-input');
    const btnSend = document.getElementById('qw-btn-send');

    if (input && btnSend) {
      btnSend.onclick = () => {
        const val = input.value.trim();
        if (val) {
          input.value = '';
          submitPrompt(val);
        }
      };

      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const val = input.value.trim();
          if (val) {
            input.value = '';
            submitPrompt(val);
          }
        }
      };
    }
  }

  function setupHotkeyListener() {
    window.addEventListener('keydown', (e) => {
      // Alt+N toggles window / focuses composer
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        const input = document.getElementById('qw-composer-input');
        if (input) input.focus();
        apiFetch('/api/v1/desktop/quickwake/toggle', { method: 'POST' });
      }
    });
  }

  function setupLangButton() {
    const btn = document.getElementById('qw-btn-lang');
    if (btn && window.NAGEX_I18N) {
      btn.onclick = () => {
        window.NAGEX_I18N.toggleLocale();
        btn.textContent = window.NAGEX_I18N.getLocale() === 'ko' ? 'EN' : 'KR';
        renderTasks();
      };
    }
  }

  // ── Data Loading & Synchronization (Same Main Session) ─────────────────
  async function loadData() {
    const [sessData, memData, taskData, apprData, desktopData] = await Promise.all([
      apiFetch('/api/v1/sessions/main'),
      apiFetch('/api/v1/memory'),
      apiFetch('/api/v1/tasks'),
      apiFetch('/api/v1/approvals'),
      apiFetch('/api/v1/desktop/quickwake/status'),
    ]);

    if (sessData) {
      state.mainSession = sessData;
      const badge = document.getElementById('qw-session-badge');
      if (badge) badge.textContent = `Session: ${sessData.sessionId || 'sess_main_001'}`;
    }
    if (memData) state.memories = memData.memories || [];
    if (taskData) {
      state.tasks = taskData.tasks || [];
      const badge = document.getElementById('qw-task-count');
      if (badge) badge.textContent = String(state.tasks.filter((t) => t.status === 'ACTIVE' || t.status === 'RUNNING' || t.status === 'WAITING').length);
    }
    if (apprData) state.approvals = apprData.approvals || [];
    if (desktopData) state.desktopStatus = desktopData;

    if (state.activeTab === 'tasks') renderTasks();
  }

  // ── Prompt Submission (Single Flight Guard) ──────────────────────────────
  async function submitPrompt(promptText) {
    if (state.isSubmitting) return; // Prevent duplicate submit
    state.isSubmitting = true;

    const stream = document.getElementById('qw-stream-body');
    if (stream) {
      // 1. User Bubble
      const userBubble = document.createElement('div');
      userBubble.className = 'qw-bubble user';
      userBubble.textContent = promptText;
      stream.appendChild(userBubble);

      // 2. NAgex Thinking Bubble
      const nagexBubble = document.createElement('div');
      nagexBubble.className = 'qw-bubble nagex';
      nagexBubble.innerHTML = '⚡ <em>NAgex is thinking & planning...</em>';
      stream.appendChild(nagexBubble);

      stream.scrollTop = stream.scrollHeight;

      // 3. Call Ambient Plan API
      const res = await apiFetch('/api/v1/ambient/intent', {
        method: 'POST',
        body: JSON.stringify({ prompt: promptText }),
      });

      if (res && res.plan) {
        let stepsHtml = res.plan.steps
          .map((s, idx) => `<div>${idx + 1}. <strong>${escapeHtml(s.title)}</strong> (${escapeHtml(s.tool || 'System')})</div>`)
          .join('');

        nagexBubble.innerHTML = `
          <strong>Plan generated for:</strong> ${escapeHtml(res.plan.goal)}
          <div style="margin-top:0.4rem; font-size:0.8rem; background:#0d1117; padding:0.4rem; border-radius:6px;">
            ${stepsHtml}
          </div>
          <div style="margin-top:0.5rem; text-align:right;">
            <button class="qw-icon-btn" onclick="window.NAGEX_DESKTOP.executePlan('${res.plan.goal}')">▶ Execute Plan</button>
          </div>
        `;
      } else if (res && res.message) {
        nagexBubble.textContent = res.message;
      } else {
        nagexBubble.textContent = 'I processed your request in your Main Session.';
      }

      stream.scrollTop = stream.scrollHeight;
    }

    state.isSubmitting = false;
    await loadData();
  }

  // ── Tasks Quick View Renderer ───────────────────────────────────────────
  function renderTasks() {
    const container = document.getElementById('qw-tasks-list-container');
    if (!container) return;

    if (!state.tasks.length) {
      container.innerHTML = '<p class="qw-empty-text">No active tasks found in your Main Session.</p>';
      return;
    }

    container.innerHTML = state.tasks
      .map((t) => {
        const nextRun = t.nextRunAt ? new Date(t.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Standing';
        return `
        <div style="background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:0.6rem; margin-bottom:0.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size:0.82rem;">${escapeHtml(t.name)}</strong>
            <span style="font-size:0.68rem; background:#21262d; padding:0.1rem 0.4rem; border-radius:4px;">${escapeHtml(t.status)}</span>
          </div>
          <p style="font-size:0.75rem; color:#8b949e; margin:0.3rem 0;">${escapeHtml(t.objective)}</p>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.7rem; color:#8b949e;">
            <span>Next: ${escapeHtml(nextRun)}</span>
            <div>
              ${t.status === 'ACTIVE' ? `<button class="qw-icon-btn" onclick="window.NAGEX_DESKTOP.pauseTask('${t.taskId}')">Pause</button>` : ''}
              ${t.status === 'PAUSED' ? `<button class="qw-icon-btn" onclick="window.NAGEX_DESKTOP.resumeTask('${t.taskId}')">Resume</button>` : ''}
              <button class="qw-icon-btn" onclick="window.NAGEX_DESKTOP.runTaskNow('${t.taskId}')">Run Now</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  // ── Global Desktop Exposed API ──────────────────────────────────────────
  window.NAGEX_DESKTOP = {
    openControlCenter: (tab = 'tab-home') => {
      apiFetch('/api/v1/desktop/quickwake/tray/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'OPEN_CONTROL_CENTER' }),
      });
      window.location.href = `/?tab=${tab}`;
    },

    hideWindow: () => {
      apiFetch('/api/v1/desktop/quickwake/toggle', { method: 'POST' });
    },

    pauseTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/pause`, { method: 'POST' });
      await loadData();
    },

    resumeTask: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/resume`, { method: 'POST' });
      await loadData();
    },

    runTaskNow: async (taskId) => {
      await apiFetch(`/api/v1/tasks/${taskId}/run`, { method: 'POST' });
      await loadData();
    },

    approveAction: async (approvalId) => {
      await apiFetch(`/api/v1/approvals/${approvalId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'APPROVE' }),
      });
      await loadData();
    },

    rejectAction: async (approvalId) => {
      await apiFetch(`/api/v1/approvals/${approvalId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'REJECT' }),
      });
      await loadData();
    },

    executePlan: async (goal) => {
      submitPrompt(`Execute plan: ${goal}`);
    },
  };

  document.addEventListener('DOMContentLoaded', init);
})();
