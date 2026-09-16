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
  let proactiveConfig = null; // R10.1 §3 — Proactive Assistant config, lazily fetched once per Home visit, same pattern as briefData
  let proactiveConfigFetched = false;
  let proposalsData = null; // R11 — fetched lazily only when "View Full Brief" is first expanded (same lazy pattern as historyData)
  let proposalsFetched = false;
  let proposalActionInFlight = null; // proposalId currently mid approve/reject/execute call, for per-card busy state

  async function fetchBrief() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/daily-brief');
    if (data && !data.error) briefData = data;
    return briefData;
  }

  async function fetchProactiveConfig() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/proactive-assistant/config');
    if (data && !data.error) proactiveConfig = data;
    return proactiveConfig;
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

  async function fetchProposals() {
    if (!window.NAGEX.apiFetch) return null;
    const data = await window.NAGEX.apiFetch('/api/v1/action-proposals');
    if (data && Array.isArray(data.proposals)) proposalsData = data.proposals;
    return proposalsData;
  }

  // §14 — the ONLY place this UI ever calls approve/reject/execute; always
  // an explicit click, never automatic. Re-fetches the list afterward so
  // status/result/failure reflect the real, just-persisted server state.
  async function decideProposal(proposalId, action) {
    if (!window.NAGEX.apiFetch || proposalActionInFlight) return;
    proposalActionInFlight = proposalId;
    renderAll();
    try {
      await window.NAGEX.apiFetch(`/api/v1/action-proposals/${encodeURIComponent(proposalId)}/${action}`, { method: 'POST' });
      await fetchProposals();
    } finally {
      proposalActionInFlight = null;
      renderAll();
    }
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

  const RISK_KEY = { LOW: 'dailyBrief.priorityLow', MEDIUM: 'dailyBrief.priorityMedium', HIGH: 'dailyBrief.priorityHigh' };
  const SOURCE_LABEL_KEY = {
    CALENDAR: ['dailyBrief.fromCalendar', 'From Calendar'],
    GMAIL: ['dailyBrief.fromGmail', 'From Gmail'],
    APPROVAL: ['dailyBrief.fromApproval', 'From Approvals'],
    ACTION_ITEM: ['dailyBrief.recommended', 'Recommended Actions'],
  };

  // §6 — a proposal card is always honest about whether it can actually be
  // executed: `executable:false` (e.g. EMAIL_REPLY_DRAFT/REVIEW_APPROVAL —
  // no grounded recipient/subject, or nothing of its own to execute) never
  // shows an Execute affordance, only Approve/Reject.
  function proposalCardHtml(p) {
    const busy = proposalActionInFlight === p.id;
    const [srcKey, srcFallback] = SOURCE_LABEL_KEY[p.sourceType] || ['dailyBrief.fromCalendar', 'From Calendar'];
    const riskLabel = t(RISK_KEY[p.riskLevel], p.riskLevel);
    let actionsHtml = '';
    let statusHtml = '';
    if (p.status === 'PROPOSED') {
      actionsHtml = `
        <button type="button" class="btn-secondary db-proposal-approve" data-proposal-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('dailyBrief.approve', 'Approve'))}</button>
        <button type="button" class="btn-secondary db-proposal-reject" data-proposal-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('dailyBrief.reject', 'Reject'))}</button>`;
    } else if (p.status === 'APPROVED' && p.executable) {
      actionsHtml = `<button type="button" class="btn-secondary db-proposal-execute" data-proposal-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('dailyBrief.execute', 'Execute'))}</button>`;
    } else if (p.status === 'APPROVED' && !p.executable) {
      statusHtml = `<span class="db-proposal-status db-proposal-status-approved">${escapeHtml(t('dailyBrief.approvedReviewOnly', 'Approved — review only, no automatic action available'))}</span>`;
    } else if (p.status === 'EXECUTING') {
      statusHtml = `<span class="db-proposal-status db-proposal-status-executing">${escapeHtml(t('dailyBrief.proposalExecuting', 'Waiting on a separate approval…'))}</span>`;
      actionsHtml = `<button type="button" class="btn-secondary db-proposal-execute" data-proposal-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('dailyBrief.checkStatus', 'Check status'))}</button>`;
    } else if (p.status === 'COMPLETED') {
      statusHtml = `<span class="db-proposal-status db-proposal-status-completed">${escapeHtml(t('dailyBrief.proposalCompleted', 'Done'))}</span>`;
    } else if (p.status === 'FAILED') {
      const msg = (p.failure && p.failure.message) || '';
      statusHtml = `<span class="db-proposal-status db-proposal-status-failed">${escapeHtml(t('dailyBrief.proposalFailed', 'Failed'))}${msg ? ': ' + escapeHtml(msg) : ''}</span>`;
      if (p.failure && p.failure.retryable) {
        actionsHtml = `<button type="button" class="btn-secondary db-proposal-execute" data-proposal-id="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('dailyBrief.retry', 'Retry'))}</button>`;
      }
    } else if (p.status === 'REJECTED') {
      statusHtml = `<span class="db-proposal-status db-proposal-status-rejected">${escapeHtml(t('dailyBrief.proposalRejected', 'Rejected'))}</span>`;
    }
    return `
      <div class="db-proposal-card" data-proposal-id="${escapeHtml(p.id)}">
        <div class="db-proposal-header">
          <span class="db-proposal-title">${escapeHtml(p.title)}</span>
          <span class="db-proposal-risk db-proposal-risk-${escapeHtml((p.riskLevel || 'LOW').toLowerCase())}">${escapeHtml(riskLabel)}</span>
        </div>
        <div class="db-proposal-source">${escapeHtml(t(srcKey, srcFallback))}</div>
        <div class="db-proposal-rationale">${escapeHtml(p.rationale || p.summary || '')}</div>
        <div class="db-proposal-approval-note">${p.approvalRequired ? escapeHtml(t('dailyBrief.approvalRequired', 'Approval required')) : ''}</div>
        <div class="db-proposal-footer">${statusHtml}<div class="db-proposal-actions">${actionsHtml}</div></div>
      </div>`;
  }

  function buildProposalsHtml() {
    const list = proposalsData || [];
    const body = list.length === 0
      ? `<div class="db-empty">${escapeHtml(t('dailyBrief.noProposals', 'No suggested actions right now.'))}</div>`
      : list.map(proposalCardHtml).join('');
    return `<div class="db-section db-proposals-section"><h4>${escapeHtml(t('dailyBrief.suggestedActions', 'Suggested actions'))}</h4>${body}</div>`;
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
    return sections.join('') + buildProposalsHtml() + buildHistoryHtml();
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

  // R10.1 §3 — the Home Proactive Assistant state line. Truthful only:
  // never shows "Ready" for a failed/partial-and-unusable generation, never
  // shows "Scheduled"/"Generating" when automation is actually off. Returns
  // null when there is nothing honest to say (automation off, or no
  // schedule/brief data yet), in which case the line stays hidden.
  function buildProactiveState(data, cfg) {
    if (!cfg || !cfg.enabled) return null;
    if (cfg.taskStatus === 'RUNNING') {
      return { text: t('dailyBrief.proactiveGenerating', 'Generating your morning brief…'), cls: 'db-proactive-generating', retry: false };
    }
    const today = new Date().toISOString().slice(0, 10);
    const hasTodayBrief = Boolean(data && data.date === today && data.status !== 'UNAVAILABLE');
    if (!hasTodayBrief && cfg.lastRunStatus === 'FAILED') {
      return { text: t('dailyBrief.proactiveFailed', "Morning brief couldn't be generated."), cls: 'db-proactive-failed', retry: true };
    }
    if (hasTodayBrief && data.source === 'SCHEDULED') {
      const time = cfg.localTime || '';
      const label = data.status === 'PARTIAL'
        ? `${t('dailyBrief.proactiveReady', 'Generated automatically at')} ${time} — ${t('dailyBrief.proactivePartial', 'partial')}`
        : `${t('dailyBrief.proactiveReady', 'Generated automatically at')} ${time}`;
      return { text: label, cls: 'db-proactive-ready', retry: false };
    }
    if (cfg.nextRunAt) {
      return { text: `${t('dailyBrief.proactiveScheduled', 'Next automatic brief at')} ${formatTime(cfg.nextRunAt)}`, cls: 'db-proactive-scheduled', retry: false };
    }
    return null;
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

    const proactiveLine = document.getElementById(`${prefix}daily-brief-proactive-state`);
    if (proactiveLine) {
      const state = buildProactiveState(data, proactiveConfig);
      if (!state) {
        proactiveLine.hidden = true;
      } else {
        proactiveLine.hidden = false;
        proactiveLine.textContent = state.text + (state.retry ? ` — ${t('dailyBrief.proactiveRetry', 'Retry')}` : '');
        proactiveLine.className = `daily-brief-proactive-line ${state.cls}`;
        proactiveLine.style.cursor = state.retry ? 'pointer' : '';
        proactiveLine.dataset.retry = state.retry ? '1' : '';
        if (state.retry && !proactiveLine.dataset.bound) {
          proactiveLine.dataset.bound = '1';
          proactiveLine.addEventListener('click', () => {
            if (proactiveLine.dataset.retry === '1') refreshBrief();
          });
        }
      }
    }

    const counts = document.getElementById(`${prefix}daily-brief-counts`);
    if (counts) {
      const pills = [
        { key: 'dailyBrief.meetings', fallback: 'Meetings', n: (data.schedule || []).length },
        { key: 'dailyBrief.importantEmails', fallback: 'Important Emails', n: (data.emails || []).length },
        { key: 'dailyBrief.actionItems', fallback: 'Action Items', n: (data.actionItems || []).length },
        { key: 'dailyBrief.needsApproval', fallback: 'Needs Approval', n: (data.approvals || []).length },
      ];
      // R11 §7 — real, persisted counts only (never inferred), shown only
      // when actually > 0 so an ordinary quiet day never shows a "0
      // suggested actions" pill.
      if (typeof data.changeCount === 'number' && data.changeCount > 0) {
        pills.push({ key: data.changeCount === 1 ? 'dailyBrief.changeSingular' : 'dailyBrief.changePlural', fallback: data.changeCount === 1 ? 'important change' : 'important changes', n: data.changeCount });
      }
      if (Array.isArray(data.proposalIds) && data.proposalIds.length > 0) {
        pills.push({ key: data.proposalIds.length === 1 ? 'dailyBrief.actionSingular' : 'dailyBrief.actionPlural', fallback: data.proposalIds.length === 1 ? 'suggested action' : 'suggested actions', n: data.proposalIds.length });
      }
      counts.innerHTML = pills.map((c) => `<span class="db-count-pill"><strong>${c.n}</strong> ${escapeHtml(t(c.key, c.fallback))}</span>`).join('');
    }

    const detail = document.getElementById(`${prefix}daily-brief-detail`);
    if (detail) {
      detail.hidden = !briefExpanded;
      if (briefExpanded) {
        detail.innerHTML = buildDetailHtml(data);
        detail.querySelectorAll('.db-proposal-approve').forEach((btn) => {
          btn.addEventListener('click', () => decideProposal(btn.getAttribute('data-proposal-id'), 'approve'));
        });
        detail.querySelectorAll('.db-proposal-reject').forEach((btn) => {
          btn.addEventListener('click', () => decideProposal(btn.getAttribute('data-proposal-id'), 'reject'));
        });
        detail.querySelectorAll('.db-proposal-execute').forEach((btn) => {
          btn.addEventListener('click', () => decideProposal(btn.getAttribute('data-proposal-id'), 'execute'));
        });
      }
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
    toggle.addEventListener('click', async () => {
      briefExpanded = !briefExpanded;
      if (briefExpanded && !proposalsFetched) {
        proposalsFetched = true;
        await fetchProposals();
      }
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
    if (!proactiveConfigFetched) {
      proactiveConfigFetched = true;
      await fetchProactiveConfig();
    }
    renderAll();
  }

  window.NAGEX = window.NAGEX || {};
  window.NAGEX.renderDailyBrief = renderDailyBrief;
  // Exposed purely so tests can exercise the real, unmodified state logic
  // (no DOM needed — buildProactiveState only reads its two plain-object
  // arguments plus window.NAGEX_I18N) instead of re-implementing it in the
  // test file, matching the existing plan-resolution-view.js precedent.
  window.NAGEX_DAILY_BRIEF_VIEW = { buildProactiveState };
})();
