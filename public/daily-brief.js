// NAgex Personal Daily Brief (R8/R9) — real GET /api/v1/daily-brief +
// POST /api/v1/daily-brief/refresh + GET /api/v1/daily-brief/history only.
// Shared by both Desktop (#daily-brief-card) and Mobile
// (#mh-daily-brief-card) Home, same real fetch/state, two renderers for
// two different markups (Dual Experience directive: layout differs, data
// does not). Lazily fetched once per Home visit, same pattern as
// desktop-home.js/mobile-home.js's own lazy My Space fetch — never on a
// timer, never refetched on every render; a manual [Refresh Brief] click
// is the only thing that triggers a real re-generation after that.
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  const PRIORITY_KEY = { LOW: 'dailyBrief.priorityLow', MEDIUM: 'dailyBrief.priorityMedium', HIGH: 'dailyBrief.priorityHigh' };
  const PRIORITY_FALLBACK = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };
  const PRIORITY_CLASS = { LOW: 'db-priority-low', MEDIUM: 'db-priority-medium', HIGH: 'db-priority-high' };

  let briefData = null;
  let briefFetched = false;
  let briefExpanded = false;
  let historyExpanded = false;
  let historyData = null;
  let refreshInFlight = false; // R9 §2 — client-side duplicate-refresh guard, mirrors the server's own in-flight guard

  async function fetchBrief() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/daily-brief');
    if (data && !data.error) briefData = data;
    return briefData;
  }

  async function refreshBrief() {
    if (refreshInFlight || !window.NAGEX.apiFetch) return;
    refreshInFlight = true;
    renderAll();
    try {
      const data = await window.NAGEX.apiFetch('/api/v1/daily-brief/refresh', { method: 'POST' });
      if (data && !data.error) briefData = data;
    } finally {
      refreshInFlight = false;
      renderAll();
    }
  }

  async function fetchHistory() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/daily-brief/history?days=7');
    if (data && Array.isArray(data.history)) historyData = data.history;
    return historyData;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function scheduleRowHtml(item) {
    return `<div class="db-row"><span class="db-row-time">${escapeHtml(formatTime(item.start))}</span><div><div class="db-row-title">${escapeHtml(item.title)}</div><div class="db-row-source">${escapeHtml(t('dailyBrief.fromCalendar', 'From Calendar'))}</div></div></div>`;
  }
  function emailRowHtml(item) {
    return `<div class="db-row"><div><div class="db-row-title">${escapeHtml(item.snippet || '(no preview)')}</div><div class="db-row-source">${escapeHtml(t('dailyBrief.fromGmail', 'From Gmail'))}</div></div></div>`;
  }
  function actionRowHtml(item) {
    const cls = PRIORITY_CLASS[item.priority] || PRIORITY_CLASS.MEDIUM;
    const label = t(PRIORITY_KEY[item.priority], PRIORITY_FALLBACK[item.priority] || item.priority);
    return `<div class="db-row db-action-row"><span class="db-priority-dot ${cls}" title="${escapeHtml(label)}"></span><div><div class="db-row-title">${escapeHtml(item.title)}</div><div class="db-row-detail">${escapeHtml(item.reasoning)}</div></div></div>`;
  }
  function approvalRowHtml(item) {
    return `<div class="db-row"><div><div class="db-row-title">${escapeHtml(item.toolId)}</div><div class="db-row-source">${escapeHtml(t('dailyBrief.fromApproval', 'From Approvals'))} · ${escapeHtml(item.status)}</div></div></div>`;
  }

  function sectionHtml(titleKey, titleFallback, rows, emptyKey, emptyFallback, disconnectedMsg) {
    const body = disconnectedMsg
      ? `<div class="db-empty">${escapeHtml(disconnectedMsg)}</div>`
      : rows.length === 0
        ? `<div class="db-empty">${escapeHtml(t(emptyKey, emptyFallback))}</div>`
        : rows.join('');
    return `<div class="db-section"><h4>${escapeHtml(t(titleKey, titleFallback))}</h4>${body}</div>`;
  }

  function buildDetailHtml(data) {
    const scheduleMsg = data.calendarStatus === 'DISCONNECTED' ? t('dailyBrief.calendarDisconnected', 'Connect Google Calendar to include your schedule.') : null;
    const emailsMsg = data.gmailStatus === 'DISCONNECTED' ? t('dailyBrief.gmailDisconnected', 'Connect Gmail to include your important emails.') : null;
    const sections = [
      sectionHtml('dailyBrief.schedule', "Today's Schedule", (data.schedule || []).map(scheduleRowHtml), 'dailyBrief.noSchedule', 'No events on your calendar today.', scheduleMsg),
      sectionHtml('dailyBrief.emails', 'Important Emails', (data.emails || []).map(emailRowHtml), 'dailyBrief.noEmails', 'No unread emails from the last few days.', emailsMsg),
      sectionHtml('dailyBrief.recommended', 'Recommended Actions', (data.actionItems || []).map(actionRowHtml), 'dailyBrief.noActions', 'Nothing recommended right now.', null),
      sectionHtml('dailyBrief.approvals', 'Needs Your Approval', (data.approvals || []).map(approvalRowHtml), 'dailyBrief.noApprovals', 'Nothing waiting on your approval.', null),
    ];
    return sections.join('') + buildHistoryHtml();
  }

  function historyRowHtml(record) {
    const isToday = record.date === new Date().toISOString().slice(0, 10);
    const label = isToday ? t('dailyBrief.today', 'Today') : record.date;
    return `<div class="db-row db-history-row"><span class="db-row-title">${escapeHtml(label)}</span><span class="db-row-detail">${escapeHtml(record.summary || '')}</span></div>`;
  }

  function buildHistoryHtml() {
    if (!historyExpanded) return '';
    const rows = (historyData || []).map(historyRowHtml);
    return `<div class="db-section db-history-section"><h4>${escapeHtml(t('dailyBrief.history', 'History'))}</h4>${rows.length ? rows.join('') : `<div class="db-empty">${escapeHtml(t('dailyBrief.noHistory', 'No previous briefs yet.'))}</div>`}</div>`;
  }

  function buildSummaryLine(data) {
    if (data.status === 'UNAVAILABLE') return t('dailyBrief.unavailable', 'Brief generation unavailable.');
    if (data.status === 'PARTIAL') return `${data.summary || ''} ${t('dailyBrief.partial', 'Partial brief — one or more sources were unavailable.')}`.trim();
    return data.summary || '';
  }

  // R9 §2/§6 — "Last updated HH:MM" + a STALE badge when the persisted
  // brief is older than the server's own freshness window, plus a
  // truthful note when the most recent refresh attempt failed (the brief
  // shown is still the last known good one, never relabeled as current).
  function buildMetaLine(data) {
    const parts = [];
    if (data.generatedAt) {
      parts.push(`${t('dailyBrief.lastUpdated', 'Last updated')} ${escapeHtml(formatTime(data.generatedAt))}`);
    }
    if (data.freshness === 'STALE') {
      parts.push(`<span class="db-stale-badge">${escapeHtml(t('dailyBrief.stale', 'Stale'))}</span>`);
    }
    let html = parts.join(' · ');
    if (data.lastRefreshAttempt) {
      html += `<div class="db-refresh-error">${escapeHtml(t('dailyBrief.refreshFailed', 'Refresh failed — showing the last successful brief.'))}</div>`;
    }
    return html;
  }

  function bindCommon(refreshBtnId, historyBtnId) {
    const refreshBtn = document.getElementById(refreshBtnId);
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = '1';
      refreshBtn.addEventListener('click', () => { refreshBrief(); });
    }
    const historyBtn = document.getElementById(historyBtnId);
    if (historyBtn && !historyBtn.dataset.bound) {
      historyBtn.dataset.bound = '1';
      historyBtn.addEventListener('click', async () => {
        historyExpanded = !historyExpanded;
        if (historyExpanded && !historyData) await fetchHistory();
        renderAll();
      });
    }
  }

  // Uniform id scheme for both markups: desktop uses plain `daily-brief-*`
  // ids, mobile uses `mh-daily-brief-*` — every element name after the
  // prefix is identical, so one render function serves both.
  function renderInto(prefix, data) {
    const card = document.getElementById(`${prefix}daily-brief-card`);
    if (!card) return;
    card.hidden = false;
    const summaryLine = document.getElementById(`${prefix}daily-brief-summary`);
    if (summaryLine) summaryLine.textContent = buildSummaryLine(data);
    const metaLine = document.getElementById(`${prefix}daily-brief-meta`);
    if (metaLine) metaLine.innerHTML = buildMetaLine(data);

    const counts = document.getElementById(`${prefix}daily-brief-counts`);
    if (counts) {
      counts.innerHTML = [
        { key: 'dailyBrief.meetings', fallback: 'Meetings', n: (data.schedule || []).length },
        { key: 'dailyBrief.importantEmails', fallback: 'Important Emails', n: (data.emails || []).length },
        { key: 'dailyBrief.actionItems', fallback: 'Action Items', n: (data.actionItems || []).length },
        { key: 'dailyBrief.needsApproval', fallback: 'Needs Approval', n: (data.approvals || []).length },
      ].map((c) => `<span class="db-count-pill"><strong>${c.n}</strong> ${escapeHtml(t(c.key, c.fallback))}</span>`).join('');
    }

    const detail = document.getElementById(`${prefix}daily-brief-detail`);
    if (detail) {
      detail.hidden = !briefExpanded;
      if (briefExpanded) detail.innerHTML = buildDetailHtml(data);
    }
    const toggle = document.getElementById(`${prefix}daily-brief-toggle`);
    if (toggle) toggle.textContent = briefExpanded ? t('dailyBrief.hideFull', 'Hide Full Brief') : t('dailyBrief.viewFull', 'View Full Brief');

    const refreshBtn = document.getElementById(`${prefix}daily-brief-refresh`);
    if (refreshBtn) {
      refreshBtn.disabled = refreshInFlight;
      refreshBtn.textContent = refreshInFlight ? t('dailyBrief.refreshing', 'Refreshing…') : t('dailyBrief.refresh', 'Refresh');
    }
    const historyBtn = document.getElementById(`${prefix}daily-brief-history-toggle`);
    if (historyBtn) historyBtn.textContent = historyExpanded ? t('dailyBrief.hideHistory', 'Hide History') : t('dailyBrief.viewHistory', 'History');
  }

  function initToggle(toggleId) {
    const toggle = document.getElementById(toggleId);
    if (!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
      briefExpanded = !briefExpanded;
      renderAll();
    });
  }

  function renderAll() {
    if (!briefData) return;
    renderInto('', briefData);
    renderInto('mh-', briefData);
  }

  async function renderDailyBrief() {
    initToggle('daily-brief-toggle');
    initToggle('mh-daily-brief-toggle');
    bindCommon('daily-brief-refresh', 'daily-brief-history-toggle');
    bindCommon('mh-daily-brief-refresh', 'mh-daily-brief-history-toggle');
    if (!briefFetched) {
      briefFetched = true;
      await fetchBrief();
    }
    renderAll();
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderDailyBrief = renderDailyBrief;
})();
