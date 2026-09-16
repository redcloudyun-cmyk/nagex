// NAgex Personal Daily Brief (R8) — real GET /api/v1/daily-brief only.
// Shared by both Desktop (#daily-brief-card) and Mobile
// (#mh-daily-brief-card) Home, same real fetch/state, two renderers for
// two different markups (Dual Experience directive: layout differs, data
// does not). Lazily fetched once per Home visit, same pattern as
// desktop-home.js/mobile-home.js's own lazy My Space fetch — never on a
// timer, never refetched on every render.
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

  async function fetchBrief(forceRefresh) {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch(`/api/v1/daily-brief${forceRefresh ? '?refresh=true' : ''}`);
    if (data && !data.error) briefData = data;
    return briefData;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function scheduleRowHtml(item) {
    return `<div class="db-row"><span class="db-row-time">${escapeHtml(formatTime(item.start))}</span><span class="db-row-title">${escapeHtml(item.title)}</span></div>`;
  }
  function emailRowHtml(item) {
    return `<div class="db-row"><span class="db-row-title">${escapeHtml(item.snippet || '(no preview)')}</span></div>`;
  }
  function actionRowHtml(item) {
    const cls = PRIORITY_CLASS[item.priority] || PRIORITY_CLASS.MEDIUM;
    const label = t(PRIORITY_KEY[item.priority], PRIORITY_FALLBACK[item.priority] || item.priority);
    return `<div class="db-row db-action-row"><span class="db-priority-dot ${cls}" title="${escapeHtml(label)}"></span><div><div class="db-row-title">${escapeHtml(item.title)}</div><div class="db-row-detail">${escapeHtml(item.reasoning)}</div></div></div>`;
  }
  function approvalRowHtml(item) {
    return `<div class="db-row"><span class="db-row-title">${escapeHtml(item.toolId)}</span><span class="db-row-detail">${escapeHtml(item.status)}</span></div>`;
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
    return [
      sectionHtml('dailyBrief.schedule', "Today's Schedule", (data.schedule || []).map(scheduleRowHtml), 'dailyBrief.noSchedule', 'No events on your calendar today.', scheduleMsg),
      sectionHtml('dailyBrief.emails', 'Important Emails', (data.emails || []).map(emailRowHtml), 'dailyBrief.noEmails', 'No unread emails from the last few days.', emailsMsg),
      sectionHtml('dailyBrief.recommended', 'Recommended Actions', (data.actionItems || []).map(actionRowHtml), 'dailyBrief.noActions', 'Nothing recommended right now.', null),
      sectionHtml('dailyBrief.approvals', 'Needs Your Approval', (data.approvals || []).map(approvalRowHtml), 'dailyBrief.noApprovals', 'Nothing waiting on your approval.', null),
    ].join('');
  }

  function buildSummaryLine(data) {
    if (data.status === 'UNAVAILABLE') return t('dailyBrief.unavailable', 'Brief generation unavailable.');
    if (data.status === 'PARTIAL') return `${data.summary || ''} ${t('dailyBrief.partial', 'Partial brief — one or more sources were unavailable.')}`.trim();
    return data.summary || '';
  }

  // ── Desktop renderer ──────────────────────────────────────────────────
  function renderDesktop(data) {
    const card = document.getElementById('daily-brief-card');
    if (!card) return;
    card.hidden = false;
    const summaryLine = document.getElementById('daily-brief-summary-line');
    if (summaryLine) summaryLine.textContent = buildSummaryLine(data);

    const counts = document.getElementById('daily-brief-counts');
    if (counts) {
      counts.innerHTML = [
        { key: 'dailyBrief.meetings', fallback: 'Meetings', n: (data.schedule || []).length },
        { key: 'dailyBrief.importantEmails', fallback: 'Important Emails', n: (data.emails || []).length },
        { key: 'dailyBrief.actionItems', fallback: 'Action Items', n: (data.actionItems || []).length },
        { key: 'dailyBrief.needsApproval', fallback: 'Needs Approval', n: (data.approvals || []).length },
      ].map((c) => `<span class="db-count-pill"><strong>${c.n}</strong> ${escapeHtml(t(c.key, c.fallback))}</span>`).join('');
    }

    const detail = document.getElementById('daily-brief-detail');
    if (detail) {
      detail.hidden = !briefExpanded;
      if (briefExpanded) detail.innerHTML = buildDetailHtml(data);
    }
    const toggle = document.getElementById('btn-daily-brief-toggle');
    if (toggle) toggle.textContent = briefExpanded ? t('dailyBrief.hideFull', 'Hide Full Brief') : t('dailyBrief.viewFull', 'View Full Brief');
  }

  function initDesktopToggle() {
    const toggle = document.getElementById('btn-daily-brief-toggle');
    if (!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
      briefExpanded = !briefExpanded;
      if (briefData) renderDesktop(briefData);
    });
  }

  // ── Mobile renderer ───────────────────────────────────────────────────
  function renderMobile(data) {
    const card = document.getElementById('mh-daily-brief-card');
    if (!card) return;
    card.hidden = false;
    const summaryLine = document.getElementById('mh-daily-brief-summary');
    if (summaryLine) summaryLine.textContent = buildSummaryLine(data);
    const counts = document.getElementById('mh-daily-brief-counts');
    if (counts) {
      counts.innerHTML = [
        { key: 'dailyBrief.meetings', fallback: 'Meetings', n: (data.schedule || []).length },
        { key: 'dailyBrief.importantEmails', fallback: 'Important Emails', n: (data.emails || []).length },
        { key: 'dailyBrief.actionItems', fallback: 'Action Items', n: (data.actionItems || []).length },
        { key: 'dailyBrief.needsApproval', fallback: 'Needs Approval', n: (data.approvals || []).length },
      ].map((c) => `<span class="db-count-pill"><strong>${c.n}</strong> ${escapeHtml(t(c.key, c.fallback))}</span>`).join('');
    }
    const detail = document.getElementById('mh-daily-brief-detail');
    if (detail) {
      detail.hidden = !briefExpanded;
      if (briefExpanded) detail.innerHTML = buildDetailHtml(data);
    }
    const toggle = document.getElementById('mh-daily-brief-toggle');
    if (toggle) toggle.textContent = briefExpanded ? t('dailyBrief.hideFull', 'Hide Full Brief') : t('dailyBrief.viewFull', 'View Full Brief');
  }

  function initMobileToggle() {
    const toggle = document.getElementById('mh-daily-brief-toggle');
    if (!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
      briefExpanded = !briefExpanded;
      if (briefData) renderMobile(briefData);
    });
  }

  async function renderDailyBrief(target) {
    initDesktopToggle();
    initMobileToggle();
    if (!briefFetched) {
      briefFetched = true;
      await fetchBrief(false);
    }
    if (!briefData) return;
    if (target === 'mobile') renderMobile(briefData);
    else renderDesktop(briefData);
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderDailyBrief = renderDailyBrief;
})();
