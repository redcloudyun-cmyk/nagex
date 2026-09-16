// NAgex Mobile Activity (UI-5 R3) — a native view inside the shared
// #mobile-app-shell (see mobile-home.js's updateShellVisibility(), the
// ONLY place deciding when #mobile-view-activity is shown). Never
// rendered while hidden — mobile-home.js only calls
// window.NAGEX.renderMobileActivity() when the active tab really is
// 'tab-executions' on a real mobile viewport.
//
// Data: real GET /api/v1/activity?limit=30 only — the same ActivityStore
// projection Desktop's renderActivity() (public/app.js) already reads,
// just with a smaller limit sized for a phone screen. No new backend
// endpoint, no invented field (no actor/category/metadata/success/
// failure/actionable/priority/score — see the R3 preflight for the
// verified real ActivityItem shape). a.title/a.description are already
// real, human-authored content written at record time (see
// src/workspace/capture-processor.ts, action-resolver.ts,
// desktop-activity-adapter.ts) — never re-summarized, rewritten, or run
// through any LLM here. Only the status badge is translated, because
// that is UI chrome (an enum), not user data.
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

  function truncate(text, max) {
    const s = String(text || '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  // ── Real, taxonomy-grounded filter mapping (R3 directive §8) — no
  // invented Approval/System/Agent category, since no real ActivityItem
  // type backs any of those today (verified in the R3 preflight). ──
  function matchesFilter(item, filter) {
    if (filter === 'ALL') return true;
    if (filter === 'TASKS') return item.type === 'candidate.action.task';
    if (filter === 'CAPTURES') return item.type.indexOf('capture.') === 0;
    if (filter === 'DEVICE') return item.type === 'desktop_execution';
    if (filter === 'SUGGESTIONS') return item.type.indexOf('candidate.action.') === 0 && item.type !== 'candidate.action.task';
    return true;
  }

  const ICONS = {
    device: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    action: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    capture: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  };

  // Icon family from the real type string only — desktop_execution /
  // candidate.action.* / capture.* — never a per-exact-type icon set
  // (directive §10: only the three real families).
  function typeIcon(type) {
    if (type === 'desktop_execution') return ICONS.device;
    if (type.indexOf('candidate.action.') === 0) return ICONS.action;
    if (type.indexOf('capture.') === 0) return ICONS.capture;
    return ICONS.action;
  }

  function typeIconVariant(type) {
    if (type === 'desktop_execution') return 'mh-row-icon-blue';
    if (type.indexOf('capture.') === 0) return 'mh-row-icon-warning';
    return 'mh-row-icon-success';
  }

  // ── Status: real enum → translated human label + real badge variant.
  // Never the raw enum text (directive §11 — Desktop's own view still
  // shows it raw; not fixed there, fixed here). ──
  function statusLabel(status) {
    const map = {
      RUNNING: t('mobileActivity.statusRunning', 'Running'),
      COMPLETED: t('mobileActivity.statusCompleted', 'Completed'),
      FAILED: t('mobileActivity.statusFailed', 'Failed'),
      NEEDS_ATTENTION: t('mobileActivity.statusNeedsAttention', 'Needs attention'),
    };
    return map[status] || status;
  }

  function statusBadgeVariant(status) {
    const map = { RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', NEEDS_ATTENTION: 'attention' };
    return map[status] || 'muted';
  }

  // ── Date grouping — deterministic from real occurredAt only, local
  // calendar-day comparison (directive §7). Order within/between groups
  // stays exactly the server's own occurredAt DESC — grouping never
  // re-sorts. ──
  function dayKey(dateStr) {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function groupByDate(items) {
    const now = new Date();
    const todayKey = dayKey(now.toISOString());
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = dayKey(yesterday.toISOString());

    const groups = { today: [], yesterday: [], older: [] };
    items.forEach((item) => {
      const key = dayKey(item.occurredAt);
      if (key === todayKey) groups.today.push(item);
      else if (key === yesterdayKey) groups.yesterday.push(item);
      else groups.older.push(item);
    });
    return groups;
  }

  let mhActivityFilter = 'ALL';
  let mhActivityLoadError = false;
  let mhActivityLoading = false;

  // ── Real data refresh — GET /api/v1/activity?limit=30, mutating the
  // shared state.activity (same reference window.NAGEX.getState() already
  // returns, per the established R1/R2 pattern) so Desktop's own
  // renderActivity() stays consistent too if the user later switches to
  // desktop. Desktop's own render path/behavior is NOT touched (directive
  // §5/§18). ──
  async function refreshActivityData() {
    if (!window.NAGEX.apiFetch || !window.NAGEX.getState) return;
    mhActivityLoading = true;
    mhActivityLoadError = false;
    const data = await window.NAGEX.apiFetch('/api/v1/activity?limit=30');
    mhActivityLoading = false;
    if (!data || !Array.isArray(data.activities)) {
      mhActivityLoadError = true;
      return;
    }
    window.NAGEX.getState().activity = data.activities;
  }

  function initFilterRow() {
    const row = document.getElementById('mh-activity-filter-row');
    if (!row || row.dataset.bound) return;
    row.dataset.bound = '1';
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mh-filter]');
      if (!btn) return;
      mhActivityFilter = btn.getAttribute('data-mh-filter');
      row.querySelectorAll('.mh-activity-filter-pill').forEach((p) => p.classList.toggle('active', p === btn));
      renderActivityList(); // client-side only — no refetch
    });
  }

  function initLangToggle() {
    if (window.NAGEX.bindMobileLangToggle) window.NAGEX.bindMobileLangToggle('mh-activity-lang-toggle');
  }

  function renderHeaderCount() {
    const el = document.getElementById('mh-activity-count');
    if (!el || !window.NAGEX.getState) return;
    const total = (window.NAGEX.getState().activity || []).length;
    if (total > 0) {
      el.hidden = false;
      el.textContent = String(total);
    } else {
      el.hidden = true;
    }
  }

  // ── Related entity tap-through — real source.taskId/approvalId only,
  // never a guessed id, never shown when absent, never the whole card
  // (directive §12: an explicit affordance only). Navigates to the real
  // canonical tab-tasks/tab-approvals screen — no per-item deep link
  // exists anywhere in NAgex today, so none is invented here. ──
  function relatedActionHtml(item) {
    const source = item.source || {};
    if (source.taskId) {
      return `<button class="mh-activity-action-btn" onclick="window.NAGEX.switchTab('tab-tasks')">${escapeHtml(t('mobileActivity.viewTask', 'View task'))}</button>`;
    }
    if (source.approvalId) {
      return `<button class="mh-activity-action-btn" onclick="window.NAGEX.switchTab('tab-approvals')">${escapeHtml(t('mobileActivity.viewApproval', 'View approval'))}</button>`;
    }
    return '';
  }

  function renderActivityRow(item) {
    const time = item.occurredAt ? new Date(item.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return `
      <div class="mh-activity-card">
        <div class="mh-row-icon ${typeIconVariant(item.type)}">${typeIcon(item.type)}</div>
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(truncate(item.title, 90))}</div>
          ${item.description ? `<div class="mh-row-detail">${escapeHtml(truncate(item.description, 110))}</div>` : ''}
          <div class="mh-activity-card-meta">
            <span class="nagex-badge nagex-badge-${statusBadgeVariant(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
            <span class="mh-activity-timestamp">${escapeHtml(time)}</span>
          </div>
        </div>
        <div class="mh-activity-card-action">${relatedActionHtml(item)}</div>
      </div>`;
  }

  function renderGroup(labelKey, labelFallback, items) {
    if (items.length === 0) return '';
    return `
      <div class="mh-activity-group-heading">${escapeHtml(t(labelKey, labelFallback))}</div>
      ${items.map(renderActivityRow).join('')}`;
  }

  function renderActivityList() {
    const listEl = document.getElementById('mh-activity-list');
    if (!listEl || !window.NAGEX.getState) return;

    if (mhActivityLoadError) {
      listEl.innerHTML = emptyState(t('mobileActivity.loadError', 'Unable to load Activity. Reopen to try again.'));
      return;
    }
    if (mhActivityLoading) {
      listEl.innerHTML = '<div class="nagex-loading-row"></div><div class="nagex-loading-row"></div>';
      return;
    }

    const all = window.NAGEX.getState().activity || [];
    if (all.length === 0) {
      listEl.innerHTML = emptyState(t('mobileActivity.empty', 'No activity yet.'));
      return;
    }

    const filtered = all.filter((item) => matchesFilter(item, mhActivityFilter));
    if (filtered.length === 0) {
      listEl.innerHTML = emptyState(t('mobileInbox.filterEmpty', 'Nothing matches this filter.'));
      return;
    }

    // Grouping never re-sorts — filtered retains the server's own
    // occurredAt DESC order throughout (directive §7).
    const groups = groupByDate(filtered);
    listEl.innerHTML = [
      renderGroup('mobileActivity.groupToday', 'Today', groups.today),
      renderGroup('mobileActivity.groupYesterday', 'Yesterday', groups.yesterday),
      renderGroup('mobileActivity.groupOlder', 'Older', groups.older),
    ].join('');
  }

  function renderMobileActivity() {
    if (!document.getElementById('mobile-view-activity')) return;
    initFilterRow();
    initLangToggle();
    renderHeaderCount();
    renderActivityList();
    refreshActivityData().then(() => {
      // Guard: don't paint a stale fetch result over a view the user has
      // since navigated away from.
      if (document.getElementById('mobile-view-activity') && !document.getElementById('mobile-view-activity').hidden) {
        renderHeaderCount();
        renderActivityList();
      }
    });
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMobileActivity = renderMobileActivity;
})();
