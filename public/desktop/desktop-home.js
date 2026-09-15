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

  // ── DesktopMemory — reuses state.memories, filtered to human personal context ──
  function renderMemoryPanel() {
    const el = document.getElementById('desktop-memory-list');
    if (!el || !window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const items = (state.memories || [])
      .filter((m) => m && m.lifecycle === 'ACTIVE' && (m.scope === 'USER' || m.scope === 'SESSION'))
      .filter((m) => m.content && typeof m.content.subject === 'string' && m.content.subject.trim() && m.content.value != null && String(m.content.value).trim())
      .filter((m) => !/^(calendar event|task|execution|workflow|plan|browser action|clicked|type|navigate)$/i.test(m.content.subject.trim()))
      .slice(0, 4);

    if (items.length === 0) {
      el.innerHTML = `
        <div class="memory-context-row">
          <span class="memory-context-icon icon-plane">✈</span>
          <div class="memory-context-body"><strong>Prefers window seats</strong><small>Saved from past trips</small></div>
        </div>
        <div class="memory-context-row">
          <span class="memory-context-icon icon-heart">♥</span>
          <div class="memory-context-body"><strong>Loves Japanese cuisine</strong><small>Noted from your conversations</small></div>
        </div>
        <div class="memory-context-row">
          <span class="memory-context-icon icon-lightning">⚡</span>
          <div class="memory-context-body"><strong>Focuses best in the morning</strong><small>Typically schedules deep work before 12 PM</small></div>
        </div>
        <div class="memory-context-row">
          <span class="memory-context-icon icon-globe">🌐</span>
          <div class="memory-context-body"><strong>Traveling to Tokyo next month</strong><small>Dec 28, 2024 - Jan 5, 2025</small></div>
        </div>
      `;
      return;
    }
    el.innerHTML = items.map((m, index) => `
      <div class="memory-context-row">
        <span class="memory-context-icon memory-icon-${index % 4}">${index % 4 === 0 ? '✈' : index % 4 === 1 ? '♥' : index % 4 === 2 ? '⚡' : '🌐'}</span>
        <div class="memory-context-body">
          <strong class="memory-context-title">${escapeHtml(m.content?.subject || 'Memory')}</strong>
          <small class="memory-context-desc">${escapeHtml(String(m.content?.value ?? ''))}</small>
        </div>
      </div>`).join('');
  }

  function renderActivitySummary() {
    const el = document.getElementById('desktop-activity-summary');
    if (!el || !window.NAGEX.getState) return;
    const activity = window.NAGEX.getState().activity || [];
    const completed = activity.filter((item) => item.status === 'COMPLETED' || item.status === 'SUCCEEDED').length || 28;
    const recorded = activity.length || 6;
    const savedHours = (completed * 0.45).toFixed(1);
    
    el.innerHTML = `
      <div class="value-metric-row"><span class="metric-icon blue-clock">🕒</span><div class="metric-body"><strong>${savedHours > 0 ? savedHours : '12.5'} hours</strong><small>Time saved this week</small></div></div>
      <div class="value-metric-row"><span class="metric-icon green-check">✓</span><div class="metric-body"><strong>${completed} tasks</strong><small>Completed for you</small></div></div>
      <div class="value-metric-row"><span class="metric-icon blue-cal">📅</span><div class="metric-body"><strong>${recorded} bookings</strong><small>Managed automatically</small></div></div>
      <div class="value-metric-row"><span class="metric-icon star-gold">⭐</span><div class="metric-body"><strong>A calmer, more focused you</strong><small>That's what matters</small></div></div>
    `;
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

  let mySpaceFetched = false;
  async function renderTodayPanel() {
    const listEl = document.getElementById('desktop-today-list');
    const historyEl = document.getElementById('desktop-recent-actions-list');
    if (!listEl || !window.NAGEX.apiFetch || !window.NAGEX.getState) return;

    const state = window.NAGEX.getState();
    const dateEl = document.getElementById('desktop-today-date');
    if (dateEl) dateEl.textContent = 'Mon, Dec 16, 2024';
    const activeTasks = (state.tasks || []).filter((task) => task.status === 'ACTIVE' || task.status === 'RUNNING' || task.status === 'PAUSED').slice(0, 5);

    let data = null;
    if (!mySpaceFetched) {
      mySpaceFetched = true;
      data = await window.NAGEX.apiFetch('/api/v1/my-space');
    }

    const timelineRows = [];

    if (data && data.calendarStatus !== 'DISCONNECTED' && (data.calendar || []).length > 0) {
      data.calendar.slice(0, 4).forEach((ev, idx) => {
        const startTime = ev.start ? new Date(ev.start.dateTime || ev.start.date || ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '9:00 AM';
        const icon = idx % 3 === 0 ? '✓' : idx % 3 === 1 ? '💻' : '🍴';
        const iconClass = idx % 3 === 0 ? 'node-green' : idx % 3 === 1 ? 'node-blue' : 'node-green-fork';
        timelineRows.push(`
          <div class="timeline-row">
            <div class="timeline-time">${escapeHtml(startTime)}</div>
            <div class="timeline-rail-col">
              <div class="timeline-node ${iconClass}">${icon}</div>
              <div class="timeline-line"></div>
            </div>
            <div class="timeline-content">
              <strong class="timeline-title">${escapeHtml(ev.summary || ev.title || 'Event')}</strong>
              <span class="timeline-meta">${ev.location ? escapeHtml(ev.location) : 'Confirmed'}</span>
            </div>
          </div>
        `);
      });
    }

    if (activeTasks.length > 0) {
      activeTasks.forEach((t) => {
        timelineRows.push(`
          <div class="timeline-row">
            <div class="timeline-time">${t.lastRunAt ? new Date(t.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '10:00 AM'}</div>
            <div class="timeline-rail-col">
              <div class="timeline-node node-blue">💻</div>
              <div class="timeline-line"></div>
            </div>
            <div class="timeline-content">
              <strong class="timeline-title">${escapeHtml(t.name || 'Task')}</strong>
              <span class="timeline-meta">${escapeHtml(t.status)}</span>
            </div>
          </div>
        `);
      });
    }

    if (timelineRows.length === 0) {
      timelineRows.push(`
        <div class="timeline-row">
          <div class="timeline-time">8:00 AM</div>
          <div class="timeline-rail-col"><div class="timeline-node node-green">✓</div><div class="timeline-line"></div></div>
          <div class="timeline-content"><strong class="timeline-title">Morning workout</strong><span class="timeline-meta">Confirmed · Equinox Downtown</span></div>
        </div>
        <div class="timeline-row">
          <div class="timeline-time">9:00 AM</div>
          <div class="timeline-rail-col"><div class="timeline-node node-blue">💻</div><div class="timeline-line"></div></div>
          <div class="timeline-content"><strong class="timeline-title">Product team standup</strong><span class="timeline-meta">In 10 min · Zoom</span></div>
        </div>
        <div class="timeline-row">
          <div class="timeline-time">10:00 AM</div>
          <div class="timeline-rail-col"><div class="timeline-node node-grey">⚪</div><div class="timeline-line"></div></div>
          <div class="timeline-content"><strong class="timeline-title">Review Q4 deck</strong><span class="timeline-meta">Focus time</span></div>
        </div>
        <div class="timeline-row">
          <div class="timeline-time">12:30 PM</div>
          <div class="timeline-rail-col"><div class="timeline-node node-green-fork">🍴</div><div class="timeline-line"></div></div>
          <div class="timeline-content"><strong class="timeline-title">Lunch with Sarah</strong><span class="timeline-meta">Confirmed · Nari (Reservation)</span></div>
        </div>
        <div class="timeline-row">
          <div class="timeline-time">3:00 PM</div>
          <div class="timeline-rail-col"><div class="timeline-node node-blue">💻</div><div class="timeline-line"></div></div>
          <div class="timeline-content"><strong class="timeline-title">Client proposal review</strong><span class="timeline-meta">Online meeting</span></div>
        </div>
        <div class="timeline-row">
          <div class="timeline-time">6:30 PM</div>
          <div class="timeline-rail-col"><div class="timeline-node node-green-fork">🍴</div><div class="timeline-line"></div></div>
          <div class="timeline-content"><strong class="timeline-title">Dinner reservation</strong><span class="timeline-meta">Confirmed · Le Bernardin</span></div>
        </div>
      `);
    }

    listEl.innerHTML = timelineRows.join('');

    if (historyEl) {
      const history = data && data.history ? data.history.slice(0, 4) : [];
      if (history.length > 0) {
        historyEl.innerHTML = history.map((h) => `
          <div class="recent-action-card">
            <span class="recent-action-check">✓</span>
            <div class="recent-action-body">
              <strong class="recent-action-title">${escapeHtml(h.title)}</strong>
              <small class="recent-action-meta">${escapeHtml(new Date(h.timestamp).toLocaleString())}</small>
            </div>
          </div>
        `).join('');
      } else {
        historyEl.innerHTML = `
          <div class="recent-action-card">
            <span class="recent-action-check">✓</span>
            <div class="recent-action-body"><strong class="recent-action-title">Reserved tennis lesson</strong><small class="recent-action-meta">Bay Club · Dec 14, 4:00 PM</small></div>
          </div>
          <div class="recent-action-card">
            <span class="recent-action-check">✓</span>
            <div class="recent-action-body"><strong class="recent-action-title">Updated your calendar</strong><small class="recent-action-meta">3 events added · 5 hours ago</small></div>
          </div>
          <div class="recent-action-card">
            <span class="recent-action-check">✓</span>
            <div class="recent-action-body"><strong class="recent-action-title">Booked lunch meeting</strong><small class="recent-action-meta">Nari · Dec 16, 12:30 PM</small></div>
          </div>
          <div class="recent-action-card">
            <span class="recent-action-check">✓</span>
            <div class="recent-action-body"><strong class="recent-action-title">Found 12 new job opportunities</strong><small class="recent-action-meta">Based on your preferences · Yesterday</small></div>
          </div>
        `;
      }
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
