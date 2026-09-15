// NAgex Desktop Home (UI-4) — mockup-cloned visual composition, bound to
// real NAgex data only.
//
// Deliberately does NOT duplicate app.js's data client or canonical
// state: it reuses window.NAGEX.apiFetch (the same authenticated fetch
// wrapper) and window.NAGEX.getState() (the same in-memory state
// app.js's own render functions already populate from
// GET /api/v1/{approvals,tasks,activity,memory,candidates,inbox}), and
// hooks into window.NAGEX.onHomeRender — called every time app.js's own
// renderHome() runs — rather than polling or re-rendering on a separate
// timer. The one additional real fetch this file makes is
// GET /api/v1/my-space, for the two fields not already covered by
// app.js's eager load: calendar/calendarStatus and history — fetched
// lazily, once, the first time Desktop Home actually renders, mirroring
// the existing My Space tab's own lazy-fetch precedent (My Space's
// Calendar leg makes a real external call that should not repeat on
// every 5s active-work poll).
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  function emptyState(text) {
    return `<div class="nagex-empty-state">${escapeHtml(text)}</div>`;
  }

  // ── Hero greeting — real local time-of-day, never a fabricated name ──
  function renderGreeting() {
    const el = document.getElementById('desktop-hero-greeting');
    if (!el) return;
    const hour = new Date().getHours();
    const key = hour < 12 ? 'home.greetingMorning' : hour < 18 ? 'home.greetingAfternoon' : 'home.greetingEvening';
    const fallback = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    el.textContent = t(key, fallback);
    el.setAttribute('data-i18n', key);
  }

  // ── Notification bell — derived only from already-loaded real state ──
  function renderNotificationBell() {
    const badge = document.getElementById('notif-badge');
    if (!badge || !window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const activity = state.activity || [];
    const count = activity.filter((a) => a.status === 'RUNNING' || a.status === 'NEEDS_ATTENTION').length;
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
    }
  }

  // ── DesktopMemory — reuses state.memories, already loaded by app.js's
  // own loadAllData(); no separate fetch ──
  function renderMemoryPanel() {
    const el = document.getElementById('desktop-memory-list');
    if (!el || !window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const items = (state.memories || [])
      .filter((m) => m && m.lifecycle === 'ACTIVE' && (m.scope === 'USER' || m.scope === 'SESSION'))
      .filter((m) => m.content && typeof m.content.subject === 'string' && m.content.subject.trim() && m.content.value != null && String(m.content.value).trim())
      .filter((m) => !/^(calendar event|task|execution|workflow|plan)$/i.test(m.content.subject.trim()))
      .slice(0, 4);
    if (items.length === 0) {
      el.innerHTML = emptyState(t('home.memoryEmpty', 'Nothing remembered yet.'));
      return;
    }
    el.innerHTML = items.map((m, index) => `
      <div class="nagex-activity-row">
        <div class="nagex-activity-icon memory-icon-${index % 4}">${index % 4 === 0 ? '♥' : index % 4 === 1 ? '✦' : index % 4 === 2 ? '●' : '◆'}</div>
        <div class="nagex-activity-body">
          <div class="nagex-activity-title">${escapeHtml(m.content?.subject || 'Memory')}</div>
          <div class="nagex-activity-desc">${escapeHtml(String(m.content?.value ?? ''))}</div>
        </div>
      </div>`).join('');
  }

  function renderActivitySummary() {
    const el = document.getElementById('desktop-activity-summary');
    if (!el || !window.NAGEX.getState) return;
    const activity = window.NAGEX.getState().activity || [];
    if (activity.length === 0) {
      el.innerHTML = `<div class="activity-summary-empty"><span>✦</span><strong>${escapeHtml(t('home.valueReadyTitle', 'Ready to build your history'))}</strong><small>${escapeHtml(t('home.valueEmpty', 'Completed work and approvals will appear here.'))}</small></div>`;
      return;
    }
    const completed = activity.filter((item) => item.status === 'COMPLETED' || item.status === 'SUCCEEDED').length;
    const needsYou = activity.filter((item) => item.status === 'NEEDS_ATTENTION').length;
    el.innerHTML = `<div class="activity-summary-real"><div><span class="summary-icon summary-icon-green">✓</span><strong>${completed}</strong><small>${escapeHtml(t('home.completedActivity', 'completed activities'))}</small></div><div><span class="summary-icon summary-icon-blue">→</span><strong>${activity.length}</strong><small>${escapeHtml(t('home.recordedActivity', 'recorded activities'))}</small></div>${needsYou ? `<div><span class="summary-icon summary-icon-orange">!</span><strong>${needsYou}</strong><small>${escapeHtml(t('home.needsAttentionActivity', 'need attention'))}</small></div>` : ''}</div>`;
  }

  let deviceStatusFetched = false;
  async function renderDeviceStatus() {
    if (deviceStatusFetched || !window.NAGEX.apiFetch) return;
    deviceStatusFetched = true;
    const card = document.getElementById('sidebar-device-card');
    const stateEl = document.getElementById('sidebar-device-state');
    const detailEl = document.getElementById('sidebar-device-detail');
    const status = await window.NAGEX.apiFetch('/api/v1/desktop/quickwake/status');
    if (!card || !stateEl || !detailEl) return;
    const connected = Boolean(status && status.isRunning);
    card.classList.toggle('is-connected', connected);
    stateEl.textContent = connected ? t('home.deviceConnected', 'Connected') : t('home.deviceUnavailable', 'Not connected');
    detailEl.textContent = connected ? t('home.deviceReady', 'Quick Wake is ready') : t('home.deviceUnavailableDetail', 'Desktop runtime is unavailable');
  }

  // ── DesktopToday — the one real, lazily-fetched GET /api/v1/my-space
  // call this file makes, for calendar/calendarStatus + history (the two
  // fields not already covered by app.js's own eager state). Tasks reuse
  // the already-loaded state.tasks — not re-fetched here. ──
  let mySpaceFetched = false;
  async function renderTodayPanel() {
    const listEl = document.getElementById('desktop-today-list');
    const historyEl = document.getElementById('desktop-recent-actions-list');
    if (!listEl || !window.NAGEX.apiFetch || !window.NAGEX.getState) return;

    const state = window.NAGEX.getState();
    const activeTasks = (state.tasks || []).filter((task) => task.status === 'ACTIVE' || task.status === 'RUNNING' || task.status === 'PAUSED').slice(0, 5);

    let data = null;
    if (!mySpaceFetched) {
      mySpaceFetched = true;
      data = await window.NAGEX.apiFetch('/api/v1/my-space');
    }

    const sections = [];

    // Calendar — real CONNECTED/DISCONNECTED/ERROR states, never faked.
    if (data) {
      if (data.calendarStatus === 'DISCONNECTED') {
        sections.push(`<div class="nagex-activity-row"><div class="nagex-activity-body"><div class="nagex-activity-desc">${escapeHtml(t('mySpace.calendarDisconnected', 'Connect Google Calendar to see upcoming events'))}</div></div></div>`);
      } else if (data.calendarStatus === 'ERROR') {
        sections.push(`<div class="nagex-activity-row"><div class="nagex-activity-body"><div class="nagex-activity-desc">${escapeHtml(t('mySpace.sectionError', 'Could not load this section'))}</div></div></div>`);
      } else if ((data.calendar || []).length === 0) {
        sections.push(`<div class="nagex-activity-row"><div class="nagex-activity-body"><div class="nagex-activity-desc">${escapeHtml(t('mySpace.noCalendar', 'No upcoming events'))}</div></div></div>`);
      } else {
        sections.push(...data.calendar.slice(0, 4).map((ev) => `
          <div class="nagex-activity-row">
            <div class="nagex-activity-icon">📅</div>
            <div class="nagex-activity-body">
              <div class="nagex-activity-title">${escapeHtml(ev.summary || ev.title || 'Event')}</div>
              <div class="nagex-activity-meta">${ev.start ? escapeHtml(new Date(ev.start.dateTime || ev.start.date || ev.start).toLocaleString()) : ''}</div>
            </div>
          </div>`));
      }
    }

    // Tasks — real, non-terminal state.tasks (already loaded).
    if (activeTasks.length === 0) {
      sections.push(`<div class="nagex-activity-row"><div class="nagex-activity-body"><div class="nagex-activity-desc">${escapeHtml(t('mySpace.noTasks', 'No active tasks'))}</div></div></div>`);
    } else {
      sections.push(...activeTasks.map((task) => `
        <div class="nagex-activity-row">
          <div class="nagex-activity-icon">✅</div>
          <div class="nagex-activity-body">
            <div class="nagex-activity-title">${escapeHtml(task.name || 'Task')}</div>
            <div class="nagex-activity-meta">${escapeHtml(task.status)}</div>
          </div>
        </div>`));
    }

    listEl.innerHTML = sections.join('');

    if (historyEl && data) {
      const history = (data.history || []).slice(0, 5);
      historyEl.innerHTML = history.length === 0
        ? emptyState(t('mySpace.noHistory', 'No recent history'))
        : history.map((h) => `
          <div class="nagex-activity-row">
            <div class="nagex-activity-body">
              <div class="nagex-activity-title">${escapeHtml(h.title)}</div>
              <div class="nagex-activity-meta">${escapeHtml(new Date(h.timestamp).toLocaleString())}</div>
            </div>
            <span class="nagex-badge nagex-badge-${(h.status || '').toLowerCase() === 'completed' || (h.status || '').toLowerCase() === 'succeeded' ? 'completed' : (h.status || '').toLowerCase() === 'failed' ? 'failed' : 'muted'}">${escapeHtml(h.status)}</span>
          </div>`).join('');
    }
  }

  // ── Approvals count badge — UI-4-R1, derived only from the already-
  // loaded real state.approvals (same PENDING filter renderHomeWorkspaceSections
  // uses), never a placeholder number. Runs after app.js's own
  // renderHomeWorkspaceSections (onHomeRender fires at the end of
  // renderHome()), so state.approvals is already current. ──
  function renderApprovalsCountBadge() {
    const badge = document.getElementById('approvals-count-badge');
    if (!badge || !window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const count = (state.approvals || []).filter((a) => a.status === 'PENDING').length;
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
    }
  }

  function renderDesktopHome() {
    if (!document.querySelector('.nagex-desktop-home')) return; // not on Home
    renderGreeting();
    renderNotificationBell();
    renderApprovalsCountBadge();
    renderMemoryPanel();
    renderActivitySummary();
    renderDeviceStatus();
    renderTodayPanel();
  }

  function init() {
    window.NAGEX = window.NAGEX || {};
    window.NAGEX.onHomeRender = renderDesktopHome;
    const headerSearch = document.getElementById('btn-header-search');
    const homePrompt = document.getElementById('home-prompt-input');
    if (headerSearch && homePrompt) {
      headerSearch.addEventListener('click', () => homePrompt.focus());
    }
    // First paint: app.js's own initial loadAllData() may already have
    // fired before this script attaches the hook above, so render once
    // immediately too (idempotent — safe to call twice).
    renderDesktopHome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
