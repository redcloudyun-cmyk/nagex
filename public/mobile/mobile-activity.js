// NAgex Mobile Activity (R22.2 Contextual UX)
// Human-intent grouping (NEEDS YOU, NOW, RECENT) and progressive disclosure.
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

  function unwrapApiData(res) {
    if (!res) return null;
    return res.data !== undefined ? res.data : res;
  }

  // Real statuses: RUNNING, COMPLETED, FAILED, NEEDS_ATTENTION
  function matchesFilter(item, filter) {
    if (filter === 'ALL') return true;
    if (filter === 'NEEDS_YOU') return item.status === 'NEEDS_ATTENTION' || item.status === 'FAILED';
    if (filter === 'COMPLETED') return item.status === 'COMPLETED';
    if (filter === 'FAILED') return item.status === 'FAILED';
    return true;
  }

  const ICONS = {
    device: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    action: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    capture: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  };

  function typeIcon(type) {
    if (type === 'desktop_execution') return ICONS.device;
    if (type && type.indexOf('candidate.action.') === 0) return ICONS.action;
    if (type && type.indexOf('capture.') === 0) return ICONS.capture;
    return ICONS.action;
  }

  function typeIconVariant(type) {
    if (type === 'desktop_execution') return 'mh-row-icon-blue';
    if (type && type.indexOf('capture.') === 0) return 'mh-row-icon-warning';
    return 'mh-row-icon-success';
  }

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

  // Primary human intent grouping (R22.2 Section 1 & 7):
  // 1. NEEDS YOU: status === NEEDS_ATTENTION or FAILED
  // 2. NOW: status === RUNNING
  // 3. RECENT: COMPLETED and remaining items
  function groupItemsByIntent(items) {
    const needsYou = [];
    const now = [];
    const recent = [];

    items.forEach((item) => {
      if (item.status === 'NEEDS_ATTENTION' || item.status === 'FAILED') {
        needsYou.push(item);
      } else if (item.status === 'RUNNING') {
        now.push(item);
      } else {
        recent.push(item);
      }
    });

    const sortByDate = (a, b) => new Date(b.occurredAt || 0).getTime() - new Date(a.occurredAt || 0).getTime();
    needsYou.sort(sortByDate);
    now.sort(sortByDate);
    recent.sort(sortByDate);

    return { needsYou, now, recent };
  }

  let mhActivityFilter = 'ALL';
  let mhActivityLoadError = false;
  let mhActivityLoading = false;

  async function refreshActivityData() {
    if (!window.NAGEX.apiFetch || !window.NAGEX.getState) return;
    mhActivityLoading = true;
    mhActivityLoadError = false;
    try {
      const res = await window.NAGEX.apiFetch('/api/v1/activity?limit=30');
      mhActivityLoading = false;
      const data = unwrapApiData(res);
      if (!data || !Array.isArray(data.activities)) {
        mhActivityLoadError = true;
        return;
      }
      window.NAGEX.getState().activity = data.activities;
    } catch (err) {
      mhActivityLoading = false;
      mhActivityLoadError = true;
    }
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
      renderActivityList();
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

  // Related entity tap-through — only real source IDs (R22.2 Section 4)
  function relatedActionHtml(item) {
    const source = item.source || {};
    if (source.taskId) {
      return `<button class="mh-activity-action-btn" onclick="event.stopPropagation(); window.NAGEX.switchTab('tab-tasks')">${escapeHtml(t('mobileActivity.viewTask', 'View task'))}</button>`;
    }
    if (source.approvalId) {
      return `<button class="mh-activity-action-btn" onclick="event.stopPropagation(); window.NAGEX.switchTab('tab-approvals')">${escapeHtml(t('home.reviewAction', 'Review'))}</button>`;
    }
    if (source.captureId) {
      return `<button class="mh-activity-action-btn" onclick="event.stopPropagation(); window.NAGEX.switchTab('tab-inbox')">${escapeHtml(t('mobileActivity.viewItem', 'View item'))}</button>`;
    }
    return '';
  }

  function showActivityDetailModal(item) {
    let modal = document.getElementById('mh-activity-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'mh-activity-detail-modal';
      modal.className = 'mh-detail-modal-overlay';
      document.body.appendChild(modal);
    }

    const time = item.occurredAt ? new Date(item.occurredAt).toLocaleString() : '';
    const source = item.source || {};
    let sourceTypeLabel = '';
    if (source.taskId) sourceTypeLabel = t('home.taskFallback', 'Task');
    else if (source.approvalId) sourceTypeLabel = t('nav.approvals', 'Approval');
    else if (source.captureId) sourceTypeLabel = t('nav.inbox', 'Inbox Item');

    modal.innerHTML = `
      <div class="mh-detail-modal-card">
        <div class="mh-detail-modal-header">
          <h3>${escapeHtml(item.title)}</h3>
          <button class="mh-detail-modal-close" onclick="document.getElementById('mh-activity-detail-modal').style.display='none'">&times;</button>
        </div>
        <div class="mh-detail-modal-body">
          ${item.description ? `<p class="mh-detail-desc">${escapeHtml(item.description)}</p>` : ''}
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">${escapeHtml(t('mobileCommon.status', 'Status:'))}</span>
            <span class="nagex-badge nagex-badge-${statusBadgeVariant(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
          </div>
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">${escapeHtml(t('mobileCommon.time', 'Time:'))}</span>
            <span>${escapeHtml(time)}</span>
          </div>
          ${sourceTypeLabel ? `
          <div class="mh-detail-meta-row">
            <span class="mh-detail-label">${escapeHtml(t('mobileCommon.source', 'Source:'))}</span>
            <span>${escapeHtml(sourceTypeLabel)}</span>
          </div>` : ''}
        </div>
        <div class="mh-detail-modal-footer">
          ${relatedActionHtml(item)}
          <button class="mh-activity-action-btn secondary" onclick="document.getElementById('mh-activity-detail-modal').style.display='none'">${escapeHtml(t('mobileActivity.close', 'Close'))}</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
  }

  function renderActivityRow(item) {
    const time = item.occurredAt ? new Date(item.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return `
      <div class="mh-activity-card" data-activity-id="${escapeHtml(item.activityId)}">
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
    if (!items || items.length === 0) return '';
    return `
      <div class="mh-activity-group-heading">${escapeHtml(t(labelKey, labelFallback))}</div>
      ${items.map(renderActivityRow).join('')}`;
  }

  function bindCardClickHandlers() {
    const listEl = document.getElementById('mh-activity-list');
    if (!listEl || listEl.dataset.cardBound) return;
    listEl.dataset.cardBound = '1';
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.mh-activity-card');
      if (!card || e.target.closest('button')) return;
      const actId = card.getAttribute('data-activity-id');
      const all = (window.NAGEX.getState && window.NAGEX.getState().activity) || [];
      const item = all.find((a) => a.activityId === actId);
      if (item) showActivityDetailModal(item);
    });
  }

  function renderActivityList() {
    const listEl = document.getElementById('mh-activity-list');
    if (!listEl || !window.NAGEX.getState) return;

    if (mhActivityLoadError) {
      listEl.innerHTML = emptyState(t('mobileActivity.loadError', "Couldn't load Activity."));
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

    const groups = groupItemsByIntent(filtered);
    listEl.innerHTML = [
      renderGroup('mobileActivity.groupNeedsYou', 'Needs You', groups.needsYou),
      renderGroup('mobileActivity.groupNow', 'Now', groups.now),
      renderGroup('mobileActivity.groupRecent', 'Recent', groups.recent),
    ].join('');

    bindCardClickHandlers();
  }

  function renderMobileActivity() {
    if (!document.getElementById('mobile-view-activity')) return;
    initFilterRow();
    initLangToggle();
    renderHeaderCount();
    renderActivityList();
    refreshActivityData().then(() => {
      if (document.getElementById('mobile-view-activity') && !document.getElementById('mobile-view-activity').hidden) {
        renderHeaderCount();
        renderActivityList();
      }
    });
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderMobileActivity = renderMobileActivity;
})();
