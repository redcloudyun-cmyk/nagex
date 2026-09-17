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
    const headerSub = document.getElementById('header-greeting-sub');
    const hour = new Date().getHours();
    const key = hour < 12 ? 'home.greetingMorning' : hour < 18 ? 'home.greetingAfternoon' : 'home.greetingEvening';
    const fallback = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const textVal = t(key, fallback);
    if (el) {
      el.textContent = textVal;
      el.setAttribute('data-i18n', key);
    }
    if (headerSub) {
      headerSub.textContent = `${fallback},`;
    }
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

  const SVGS = {
    plane: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3.5c-.5-.5-2.5 0-4 1.5L13 8.5 4.8 6.7c-.6-.1-1.2.1-1.5.6l-1 1.7c-.3.5-.2 1.2.3 1.6L8 15l-3 3-2.5-.5L1 19l3 3 1.5-1.5L5 18l3-3 3.4 5.4c.4.5 1.1.6 1.6.3l1.7-1c.5-.3.7-.9.6-1.5z"/></svg>`,
    heart: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`,
    zap: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    globe: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    clock: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    check: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    calendar: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    star: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    fork: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2v20M6 2v6a4 4 0 0 0 4 4h0a4 4 0 0 0 4-4V2M10 12v10"/></svg>`,
    screen: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    circle: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>`,
    sparkles: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`
  };

  // ── DesktopMemory — reuses state.memories, filtered to human personal
  // context. R12.1 Increment 2 — the previous fallback here fabricated a
  // handful of fictional personal-preference entries and displayed them
  // as if NAgex had actually remembered them, which it never had.
  // Truthful empty state only, per §24/§25 and MASTER.md's "no
  // misleading mock behavior" rule. ──
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
      el.innerHTML = emptyState(t('home.memoryEmpty', 'NAgex hasn’t remembered anything yet.'));
      return;
    }
    const memorySvgs = [SVGS.plane, SVGS.heart, SVGS.zap, SVGS.globe];
    el.innerHTML = items.map((m, index) => `
      <div class="memory-context-row">
        <span class="memory-context-icon memory-icon-${index % 4}">${memorySvgs[index % 4]}</span>
        <div class="memory-context-body">
          <strong class="memory-context-title">${escapeHtml(m.content?.subject || 'Memory')}</strong>
          <small class="memory-context-desc">${escapeHtml(String(m.content?.value ?? ''))}</small>
        </div>
      </div>`).join('');
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

  // R12.1 Increment 2 — the previous version of this function fell back to
  // a fully fabricated demo agenda of invented calendar/reservation events
  // and a hardcoded fake date whenever there was no real calendar/task
  // data, presenting them as if they were the user's actual schedule.
  // Replaced with the real current date and a truthful empty state
  // (§18/§19/§24/§25). A my-space fetch failure is now also distinguished
  // from "genuinely nothing scheduled" (§19) rather than silently
  // rendering as an empty state either way.
  let mySpaceFetched = false;
  let mySpaceFetchFailed = false;
  async function renderTodayPanel() {
    const listEl = document.getElementById('desktop-today-list');
    const historyEl = document.getElementById('desktop-recent-actions-list');
    if (!listEl || !window.NAGEX.apiFetch || !window.NAGEX.getState) return;

    const state = window.NAGEX.getState();
    const dateEl = document.getElementById('desktop-today-date');
    if (dateEl) {
      dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }
    const activeTasks = (state.tasks || []).filter((task) => task.status === 'ACTIVE' || task.status === 'RUNNING' || task.status === 'PAUSED').slice(0, 5);

    let data = null;
    if (!mySpaceFetched) {
      mySpaceFetched = true;
      data = await window.NAGEX.apiFetch('/api/v1/my-space');
      mySpaceFetchFailed = !data;
    }

    const timelineRows = [];

    if (data && data.calendarStatus !== 'DISCONNECTED' && (data.calendar || []).length > 0) {
      data.calendar.slice(0, 4).forEach((ev, idx) => {
        const startTime = ev.start ? new Date(ev.start.dateTime || ev.start.date || ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '9:00 AM';
        const iconSvg = idx % 3 === 0 ? SVGS.check : idx % 3 === 1 ? SVGS.screen : SVGS.fork;
        const iconClass = idx % 3 === 0 ? 'node-green' : idx % 3 === 1 ? 'node-blue' : 'node-green-fork';
        timelineRows.push(`
          <div class="timeline-row">
            <div class="timeline-time">${escapeHtml(startTime)}</div>
            <div class="timeline-rail-col">
              <div class="timeline-node ${iconClass}">${iconSvg}</div>
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
              <div class="timeline-node node-blue">${SVGS.screen}</div>
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
      listEl.innerHTML = mySpaceFetchFailed
        ? emptyState(t('home.todayLoadError', "Today's schedule could not be loaded."))
        : emptyState(t('home.todayEmpty', 'Nothing scheduled right now.'));
    } else {
      listEl.innerHTML = timelineRows.join('');
    }

    if (historyEl) {
      const history = data && data.history ? data.history.slice(0, 4) : [];
      if (history.length > 0) {
        historyEl.innerHTML = history.map((h) => `
          <div class="recent-action-card">
            <span class="recent-action-check">${SVGS.check}</span>
            <div class="recent-action-body">
              <strong class="recent-action-title">${escapeHtml(h.title)}</strong>
              <small class="recent-action-meta">${escapeHtml(new Date(h.timestamp).toLocaleString())}</small>
            </div>
          </div>
        `).join('');
      } else {
        historyEl.innerHTML = emptyState(t('home.recentActionsEmpty', 'No recent results yet.'));
      }
    }
  }

  // ── Approvals count badge — UI-4-R1, derived only from the already-
  // loaded real state.approvals (same PENDING filter renderHomeWorkspaceSections
  // uses), never a placeholder number. Runs after app.js's own
  // renderHomeWorkspaceSections (onHomeRender fires at the end of
  // renderHome()), so state.approvals is already current.
  // R12.1 Increment 2.5 (DEBT-0006 closure) — GET /api/v1/approvals is now
  // a real, tenant/principal-scoped source (ActionApprovalStore.
  // listPending()), so no id-based demo/seed filtering is needed here
  // anymore. On a load failure the badge simply shows nothing (0), rather
  // than a false count — the approval section itself (not this badge)
  // carries the truthful "could not be loaded" message. ──
  function renderApprovalsCountBadge() {
    const badge = document.getElementById('approvals-count-badge');
    if (!badge || !window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const count = state.approvalsLoadFailed ? 0 : (state.approvals || []).filter((a) => a.status === 'PENDING').length;
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
