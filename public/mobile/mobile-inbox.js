// NAgex Mobile Inbox (UI-5 R2) — a native view inside the shared
// #mobile-app-shell (see mobile-home.js's updateShellVisibility(), which
// is the ONLY place deciding when #mobile-view-inbox is shown). Never
// rendered while hidden — mobile-home.js only calls
// window.NAGEX.renderMobileInbox() when the active tab really is
// 'tab-inbox' on a real mobile viewport.
//
// Data: real GET /api/v1/workspace/inbox + GET /api/v1/candidates only —
// the exact same two calls Desktop's renderInbox()/loadCanonicalCandidates()
// already make (public/app.js). No new backend endpoint, no invented
// field (no id/title/description/timestamp/priority/score/read/unread/
// relatedTaskId/relatedApprovalId/actionable — see the R2 preflight for
// the verified real CaptureItem shape).
//
// Modify flow note: Desktop's window.NAGEX.startModifyCandidate/
// saveModifyCandidate/cancelModifyCandidate hardcode both their own
// module-private edit-state variable AND direct DOM lookups into
// Desktop-specific element ids, then re-render straight into
// #inbox-candidates-list (the Desktop/legacy tree). Reusing them unchanged
// would silently update the wrong (hidden) DOM. This file therefore keeps
// its own small, parallel edit-state (mhCandidateEditState) and its own
// save handler — but that save handler PATCHes the exact same real
// endpoint (/api/v1/candidates/:id) with the exact same real payload
// shape per candidate type as Desktop's saveModifyCandidate, never a new
// field or a new endpoint.
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

  // ── Real CaptureStatus grouping (all 11 enum values placed explicitly,
  // per src/workspace/workspace.types.ts — no silent default). Group 1
  // includes FAILED: a failed capture always needs either a Retry action
  // or at least the user's awareness that something didn't complete, so
  // it is never passively "done" the way READY/ACTIONED/ARCHIVED are. ──
  const GROUP_NEEDS_REVIEW = new Set(['NEEDS_REVIEW', 'FAILED']);
  const GROUP_PROCESSING = new Set(['QUEUED', 'UPLOADING', 'PROCESSING', 'EXTRACTED', 'UNDERSTOOD']);
  const GROUP_READY = new Set(['CAPTURED', 'READY', 'ACTIONED', 'ARCHIVED']);

  // Real filter → real status mapping only (directive §7). "Processing"
  // deliberately excludes EXTRACTED/UNDERSTOOD (not listed in the
  // directive's explicit mapping) — those two still appear under "All",
  // grouped into GROUP_PROCESSING for ordering purposes.
  const FILTER_STATUS_SETS = {
    ALL: null,
    NEEDS_REVIEW: new Set(['NEEDS_REVIEW', 'FAILED']),
    READY: new Set(['READY']),
    PROCESSING: new Set(['QUEUED', 'UPLOADING', 'PROCESSING']),
  };

  let mhInboxFilter = 'ALL';
  let mhCandidateEditState = null;
  let mhCandidatesShowResolved = false;
  let mhInboxLoadError = false;
  let mhInboxLoading = false;

  function groupRank(status) {
    if (GROUP_NEEDS_REVIEW.has(status)) return 0;
    if (GROUP_PROCESSING.has(status)) return 1;
    return 2; // GROUP_READY, and any future status not yet enumerated — never dropped, just lowest priority
  }

  function sortedByGroupThenRecency(items) {
    return [...items].sort((a, b) => {
      const diff = groupRank(a.status) - groupRank(b.status);
      if (diff !== 0) return diff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  function applyFilter(items) {
    const set = FILTER_STATUS_SETS[mhInboxFilter];
    return set ? items.filter((i) => set.has(i.status)) : items;
  }

  const ICONS = {
    file: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
    link: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    mic: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>`,
    note: `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="7" y2="10"/><line x1="17" y1="14" x2="7" y2="14"/><line x1="9" y1="18" x2="7" y2="18"/><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2z"/></svg>`,
  };

  function typeIcon(type) {
    return ICONS[type === 'FILE' ? 'file' : type === 'LINK' ? 'link' : type === 'AUDIO' ? 'mic' : 'note'];
  }

  // Human-readable status label from real, verified enum values only —
  // never raw internal metadata (directive §9).
  function statusLabel(status) {
    const map = {
      NEEDS_REVIEW: t('mobileInbox.statusNeedsReview', 'Needs review'),
      FAILED: t('mobileInbox.statusFailed', 'Failed'),
      QUEUED: t('mobileInbox.statusProcessing', 'Processing'),
      UPLOADING: t('mobileInbox.statusProcessing', 'Processing'),
      PROCESSING: t('mobileInbox.statusProcessing', 'Processing'),
      EXTRACTED: t('mobileInbox.statusProcessing', 'Processing'),
      UNDERSTOOD: t('mobileInbox.statusProcessing', 'Processing'),
      READY: t('mobileInbox.statusReady', 'Ready'),
      ACTIONED: t('mobileInbox.statusActioned', 'Done'),
      ARCHIVED: t('mobileInbox.statusArchived', 'Archived'),
      CAPTURED: t('mobileInbox.statusCaptured', 'New'),
    };
    return map[status] || status;
  }

  function statusBadgeVariant(status) {
    if (GROUP_NEEDS_REVIEW.has(status)) return status === 'FAILED' ? 'failed' : 'attention';
    if (GROUP_PROCESSING.has(status)) return 'running';
    if (status === 'ACTIONED') return 'completed';
    return 'muted';
  }

  function truncate(text, max) {
    const s = String(text || '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  // ── Data refresh — real fetch, real state, shared with Desktop via the
  // same window.NAGEX.getState() reference (never a second data client). ──
  async function refreshInboxData() {
    if (!window.NAGEX.apiFetch || !window.NAGEX.getState) return;
    mhInboxLoading = true;
    mhInboxLoadError = false;
    const [inboxData, candData] = await Promise.all([
      window.NAGEX.apiFetch('/api/v1/workspace/inbox'),
      window.NAGEX.apiFetch('/api/v1/candidates'),
    ]);
    mhInboxLoading = false;
    if (!inboxData || !Array.isArray(inboxData.items)) {
      mhInboxLoadError = true;
      return;
    }
    const state = window.NAGEX.getState();
    state.inbox = inboxData.items;
    state.inboxSummary = {
      unreadCount: typeof inboxData.unreadCount === 'number' ? inboxData.unreadCount : 0,
      needsReviewCount: typeof inboxData.needsReviewCount === 'number' ? inboxData.needsReviewCount : 0,
    };
    if (candData && Array.isArray(candData.candidates)) state.candidates = candData.candidates;
  }

  // ── Filter pills ──
  function initFilterRow() {
    const row = document.getElementById('mh-inbox-filter-row');
    if (!row || row.dataset.bound) return;
    row.dataset.bound = '1';
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mh-filter]');
      if (!btn) return;
      mhInboxFilter = btn.getAttribute('data-mh-filter');
      row.querySelectorAll('.mh-filter-pill').forEach((p) => p.classList.toggle('active', p === btn));
      renderInboxList(); // client-side only — no refetch (directive §7)
    });
  }

  function initLangToggle() {
    if (window.NAGEX.bindMobileLangToggle) window.NAGEX.bindMobileLangToggle('mh-inbox-lang-toggle');
  }

  // ── Header count badge — aggregate only, never a per-item unread
  // dot/label (directive §6/§16: CaptureItem has no read/unread field). ──
  function renderHeaderBadge() {
    const badge = document.getElementById('mh-inbox-count-badge');
    if (!badge || !window.NAGEX.getState) return;
    const summary = window.NAGEX.getState().inboxSummary || { needsReviewCount: 0 };
    if (summary.needsReviewCount > 0) {
      badge.hidden = false;
      badge.textContent = summary.needsReviewCount > 9 ? '9+' : String(summary.needsReviewCount);
    } else {
      badge.hidden = true;
    }
  }

  // ── Capture cards ──
  function captureActionHtml(item) {
    const retryable = item.metadata?.retryable !== false;
    if (item.status === 'FAILED' && retryable) {
      return `<button class="mh-inbox-action-btn" onclick="window.NAGEX.retryCapture('${item.captureId}')">${escapeHtml(t('workspace.retry', 'Retry'))}</button>`;
    }
    if (item.status === 'FAILED' && !retryable) {
      const needsHuman = item.metadata?.failureCategory === 'NEEDS_HUMAN';
      return `<span class="mh-inbox-action-note">${escapeHtml(needsHuman ? t('workspace.needsHumanAttention', 'Needs your attention') : t('workspace.notRetryable', 'Cannot be retried'))}</span>`;
    }
    if (item.status === 'NEEDS_REVIEW') {
      return `<button class="mh-inbox-action-btn" onclick="window.NAGEX.actionCapture('${item.captureId}', 'ACTIONED')">${escapeHtml(t('mobileInbox.actionButton', 'Action'))}</button>`;
    }
    return '';
  }

  function renderCaptureCard(item) {
    const title = item.metadata?.extractedTitle || item.content || '';
    const summary = item.metadata?.extractedSummary || item.content || '';
    const createdAt = item.createdAt ? new Date(item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `
      <div class="mh-inbox-card">
        <div class="mh-row-icon mh-row-icon-blue">${typeIcon(item.type)}</div>
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(truncate(title, 80))}</div>
          <div class="mh-row-detail">${escapeHtml(truncate(summary, 100))}</div>
          <div class="mh-inbox-card-meta">
            <span class="nagex-badge nagex-badge-${statusBadgeVariant(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
            <span class="mh-inbox-timestamp">${escapeHtml(createdAt)}</span>
          </div>
        </div>
        <div class="mh-inbox-card-action">${captureActionHtml(item)}</div>
      </div>`;
  }

  function renderInboxList() {
    const listEl = document.getElementById('mh-inbox-items-list');
    if (!listEl || !window.NAGEX.getState) return;

    if (mhInboxLoadError) {
      listEl.innerHTML = emptyState(t('mobileInbox.loadError', 'Unable to load Inbox. Pull down or reopen to try again.'));
      return;
    }
    if (mhInboxLoading) {
      listEl.innerHTML = '<div class="nagex-loading-row"></div><div class="nagex-loading-row"></div>';
      return;
    }

    const all = (window.NAGEX.getState().inbox || []);
    const visible = sortedByGroupThenRecency(applyFilter(all));

    if (all.length === 0) {
      listEl.innerHTML = emptyState(t('mobileInbox.empty', 'No captured items in Inbox yet.'));
      return;
    }
    if (visible.length === 0) {
      listEl.innerHTML = emptyState(t('mobileInbox.filterEmpty', 'Nothing matches this filter.'));
      return;
    }
    listEl.innerHTML = visible.map(renderCaptureCard).join('');
  }

  // ── Candidate queue — same real state machine/ordering as Desktop
  // (PROPOSED-first, resolved collapsed behind a toggle), restyled with
  // Mobile Home's card/button language. ──
  function candidatePayloadPreview(candidate) {
    const p = candidate.payload || {};
    if (candidate.type === 'TASK') return [p.objective, p.dueAt ? `${t('workspace.candidateDueAt', 'due')} ${new Date(p.dueAt).toLocaleDateString()}` : ''].filter(Boolean).join(' · ');
    if (candidate.type === 'CALENDAR') {
      const bits = [];
      if (p.start) bits.push(new Date(p.start).toLocaleString());
      if (p.attendees && p.attendees.length > 0) bits.push(`${p.attendees.length} ${p.attendees.length > 1 ? 'attendees' : 'attendee'}`);
      return bits.join(' · ');
    }
    if (candidate.type === 'MEMORY') return p.statement || '';
    return p.summary || '';
  }

  function candidateActionControlsHtml(candidate) {
    const action = candidate.action || { status: 'NOT_STARTED' };
    const applyLabel = {
      TASK: t('workspace.candidateApplyTask', 'Create task'),
      CALENDAR: t('workspace.candidateApplyCalendar', 'Review calendar action'),
      MEMORY: t('workspace.candidateApplyMemory', 'Remember'),
      KNOWLEDGE: t('workspace.candidateApplyKnowledge', 'Add to knowledge'),
    }[candidate.type];

    if (action.status === 'NOT_STARTED') {
      return `<button class="mh-btn-approve" onclick="window.NAGEX.executeCandidateAction('${candidate.candidateId}')">${escapeHtml(applyLabel)}</button>`;
    }
    if (action.status === 'PENDING_APPROVAL') {
      return `<span class="mh-inbox-action-note">${escapeHtml(t('workspace.candidateWaitingApproval', 'Waiting for approval'))}</span>
        <button class="mh-btn-review" onclick="window.NAGEX.switchTab('tab-approvals')">${escapeHtml(t('workspace.candidateReviewApproval', 'Review approval'))}</button>`;
    }
    if (action.status === 'RUNNING') {
      return `<span class="mh-inbox-action-note">${escapeHtml(t('workspace.candidateRunning', 'Working...'))}</span>`;
    }
    if (action.status === 'SUCCEEDED') {
      const isDemo = action.executionMode === 'DEMO' || action.providerVerified === false || action.dataSource === 'DEMO';
      const successText = candidate.type === 'CALENDAR' && isDemo
        ? t('workspace.candidateSuccessDemo', 'Demo completed (no calendar event created)')
        : {
            TASK: t('workspace.candidateSuccessTask', 'Task created'),
            CALENDAR: t('workspace.candidateSuccessCalendar', 'Added to Google Calendar'),
            MEMORY: t('workspace.candidateSuccessMemory', 'Remembered'),
            KNOWLEDGE: t('workspace.candidateSuccessKnowledge', 'Added to knowledge'),
          }[candidate.type];
      const openLink = candidate.type === 'CALENDAR' && !isDemo && action.externalUrl
        ? `<a href="${escapeHtml(action.externalUrl)}" target="_blank" rel="noopener noreferrer" class="mh-btn-review">${escapeHtml(t('workspace.candidateOpenCalendar', 'Open in Google Calendar'))}</a>`
        : '';
      return `<span class="nagex-badge nagex-badge-completed">${escapeHtml(successText)}</span>${openLink}`;
    }
    if (action.retryable === true) {
      return `<span class="mh-inbox-action-note mh-inbox-action-note-danger">${escapeHtml(t('workspace.candidateActionFailed', 'Action failed'))}</span>
        <button class="mh-btn-review" onclick="window.NAGEX.retryCandidateAction('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateRetry', 'Retry'))}</button>`;
    }
    if (action.category === 'AMBIGUOUS') {
      return `<span class="mh-inbox-action-note">${escapeHtml(t('workspace.candidateActionAmbiguous', 'Action outcome needs verification before trying again'))}</span>`;
    }
    if (action.category === 'NEEDS_HUMAN') {
      return `<span class="mh-inbox-action-note">${escapeHtml(t('workspace.candidateActionNeedsHuman', 'This needs your attention before it can continue'))}</span>`;
    }
    return `<span class="mh-inbox-action-note mh-inbox-action-note-danger">${escapeHtml(t('workspace.candidateActionFailed', 'Action failed'))} — ${escapeHtml(t('workspace.candidateActionNotRetryable', 'cannot be retried'))}</span>`;
  }

  // ── Modify (edit) form — own local edit-state (see file header comment
  // for why this cannot reuse Desktop's startModifyCandidate/etc as-is).
  // Same real field set per type as Desktop's renderCandidateEditForm,
  // no new field added. ──
  function editFieldHtml(labelKey, fallback, inputHtml) {
    return `<label class="mh-cand-edit-label">${escapeHtml(t(labelKey, fallback))}${inputHtml}</label>`;
  }

  function toLocalDatetimeValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderCandidateEditForm(candidate) {
    const cid = candidate.candidateId;
    const p = candidate.payload || {};
    let fieldsHtml = '';
    if (candidate.type === 'TASK') {
      fieldsHtml =
        editFieldHtml('workspace.candidateName', 'Name', `<input class="mh-cand-edit-input" id="mh-cand-edit-name-${cid}" type="text" value="${escapeHtml(p.name || '')}" />`) +
        editFieldHtml('workspace.candidateObjective', 'Objective', `<input class="mh-cand-edit-input" id="mh-cand-edit-objective-${cid}" type="text" value="${escapeHtml(p.objective || '')}" />`) +
        editFieldHtml('workspace.candidateDueAt', 'Due date', `<input class="mh-cand-edit-input" id="mh-cand-edit-dueAt-${cid}" type="datetime-local" value="${escapeHtml(toLocalDatetimeValue(p.dueAt))}" />`);
    } else if (candidate.type === 'CALENDAR') {
      fieldsHtml =
        editFieldHtml('workspace.candidateSummaryField', 'Summary', `<input class="mh-cand-edit-input" id="mh-cand-edit-summary-${cid}" type="text" value="${escapeHtml(p.summary || '')}" />`) +
        editFieldHtml('workspace.candidateStart', 'Start', `<input class="mh-cand-edit-input" id="mh-cand-edit-start-${cid}" type="datetime-local" value="${escapeHtml(toLocalDatetimeValue(p.start))}" />`) +
        editFieldHtml('workspace.candidateEnd', 'End', `<input class="mh-cand-edit-input" id="mh-cand-edit-end-${cid}" type="datetime-local" value="${escapeHtml(toLocalDatetimeValue(p.end))}" />`) +
        editFieldHtml('workspace.candidateTimezone', 'Timezone', `<input class="mh-cand-edit-input" id="mh-cand-edit-timezone-${cid}" type="text" placeholder="Asia/Seoul" value="${escapeHtml(p.timezone || '')}" />`) +
        editFieldHtml('workspace.candidateAttendees', 'Attendees (comma-separated emails)', `<input class="mh-cand-edit-input" id="mh-cand-edit-attendees-${cid}" type="text" value="${escapeHtml((p.attendees || []).join(', '))}" />`);
    } else if (candidate.type === 'MEMORY') {
      fieldsHtml =
        editFieldHtml('workspace.candidateStatement', 'Statement', `<textarea class="mh-cand-edit-input" id="mh-cand-edit-statement-${cid}" rows="2">${escapeHtml(p.statement || '')}</textarea>`) +
        editFieldHtml('workspace.candidateCategory', 'Category', `<input class="mh-cand-edit-input" id="mh-cand-edit-category-${cid}" type="text" value="${escapeHtml(p.category || '')}" />`);
    } else {
      fieldsHtml =
        editFieldHtml('workspace.candidateKnowledgeTitle', 'Title', `<input class="mh-cand-edit-input" id="mh-cand-edit-title-${cid}" type="text" value="${escapeHtml(p.title || '')}" />`) +
        editFieldHtml('workspace.candidateSummaryField', 'Summary', `<textarea class="mh-cand-edit-input" id="mh-cand-edit-summary2-${cid}" rows="2">${escapeHtml(p.summary || '')}</textarea>`);
    }
    return `
      <div class="mh-inbox-candidate-card mh-inbox-candidate-edit" data-candidate-id="${cid}">
        <span class="nagex-badge nagex-badge-muted">${escapeHtml(candidate.type)}</span>
        <div class="mh-cand-edit-fields">${fieldsHtml}</div>
        <div class="mh-approval-actions">
          <button class="mh-btn-approve" onclick="window.NAGEX.mobileSaveModifyCandidate('${cid}')">${escapeHtml(t('workspace.candidateSave', 'Save changes'))}</button>
          <button class="mh-btn-review" onclick="window.NAGEX.mobileCancelModifyCandidate('${cid}')">${escapeHtml(t('workspace.candidateCancel', 'Cancel'))}</button>
        </div>
      </div>`;
  }

  function renderCandidateCard(candidate) {
    if (mhCandidateEditState === candidate.candidateId) return renderCandidateEditForm(candidate);

    const preview = candidatePayloadPreview(candidate);
    const canAct = candidate.status === 'PROPOSED';
    let actionsHtml = '';
    if (canAct) {
      actionsHtml = `<div class="mh-approval-actions">
        <button class="mh-btn-approve" onclick="window.NAGEX.acceptCandidate('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateAccept', 'Accept'))}</button>
        <button class="mh-btn-review" onclick="window.NAGEX.mobileStartModifyCandidate('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateModify', 'Modify'))}</button>
        <button class="mh-btn-reject" onclick="window.NAGEX.rejectCandidate('${candidate.candidateId}')">${escapeHtml(t('workspace.candidateReject', 'Reject'))}</button>
      </div>`;
    } else if (candidate.status === 'EXPIRED') {
      actionsHtml = `<span class="mh-inbox-action-note">${escapeHtml(t('workspace.candidateSourceChanged', 'Source changed'))}</span>`;
    } else if (candidate.status === 'ACCEPTED') {
      actionsHtml = `<div class="mh-approval-actions">${candidateActionControlsHtml(candidate)}</div>`;
    }

    const statusMap = {
      PROPOSED: t('workspace.candidateStatusProposed', 'Suggested'),
      ACCEPTED: t('workspace.candidateStatusAccepted', 'Accepted for action'),
      REJECTED: t('workspace.candidateStatusRejected', 'Rejected'),
      EXPIRED: t('workspace.candidateStatusExpired', 'Expired'),
    };

    return `
      <div class="mh-inbox-candidate-card" data-candidate-id="${candidate.candidateId}">
        <div class="mh-inbox-candidate-header">
          <span class="nagex-badge nagex-badge-muted">${escapeHtml(candidate.type)}</span>
          <span class="nagex-badge nagex-badge-${candidate.status === 'PROPOSED' ? 'attention' : candidate.status === 'ACCEPTED' ? 'running' : 'muted'}">${escapeHtml(statusMap[candidate.status] || candidate.status)}</span>
        </div>
        <div class="mh-row-title">${escapeHtml(candidate.title)}</div>
        ${preview ? `<div class="mh-row-detail">${escapeHtml(preview)}</div>` : ''}
        ${actionsHtml}
      </div>`;
  }

  function renderCandidateQueue() {
    const listEl = document.getElementById('mh-inbox-candidates-list');
    if (!listEl || !window.NAGEX.getState) return;
    const all = window.NAGEX.getState().candidates || [];

    if (all.length === 0) {
      listEl.innerHTML = emptyState(t('workspace.noSuggestions', 'No suggestions yet.'));
      return;
    }

    const byRecency = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
    const proposed = all.filter((c) => c.status === 'PROPOSED').sort(byRecency);
    const resolved = all.filter((c) => c.status !== 'PROPOSED').sort(byRecency);

    const toggleHtml = resolved.length > 0
      ? `<button class="mh-inbox-resolved-toggle" onclick="window.NAGEX.mobileToggleResolvedCandidates()">${mhCandidatesShowResolved ? escapeHtml(t('workspace.hideResolved', 'Hide resolved')) : `${resolved.length} ${escapeHtml(t('workspace.showResolved', 'resolved — show'))}`}</button>`
      : '';

    const visible = mhCandidatesShowResolved ? [...proposed, ...resolved] : proposed;
    const bodyHtml = visible.length > 0
      ? visible.map(renderCandidateCard).join('')
      : emptyState(t('workspace.allResolved', 'Nothing needs review right now.'));

    listEl.innerHTML = toggleHtml + bodyHtml;
  }

  // ── Bridge actions local to Mobile Inbox's own edit-state (see file
  // header). Real endpoint, real payload shape — see saveModifyCandidate
  // comment below for the exact parity with Desktop's own version. ──
  window.NAGEX = window.NAGEX || {};
  window.NAGEX.mobileStartModifyCandidate = (candidateId) => {
    mhCandidateEditState = candidateId;
    renderCandidateQueue();
  };
  window.NAGEX.mobileCancelModifyCandidate = () => {
    mhCandidateEditState = null;
    renderCandidateQueue();
  };
  window.NAGEX.mobileToggleResolvedCandidates = () => {
    mhCandidatesShowResolved = !mhCandidatesShowResolved;
    renderCandidateQueue();
  };
  window.NAGEX.mobileSaveModifyCandidate = async (candidateId) => {
    const state = window.NAGEX.getState();
    const candidate = (state.candidates || []).find((c) => c.candidateId === candidateId);
    if (!candidate) return;
    const val = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
    let payload = {};
    if (candidate.type === 'TASK') {
      const dueAtRaw = val(`mh-cand-edit-dueAt-${candidateId}`);
      payload = { name: val(`mh-cand-edit-name-${candidateId}`), objective: val(`mh-cand-edit-objective-${candidateId}`) || undefined, dueAt: dueAtRaw ? new Date(dueAtRaw).toISOString() : null };
    } else if (candidate.type === 'CALENDAR') {
      const startRaw = val(`mh-cand-edit-start-${candidateId}`);
      const endRaw = val(`mh-cand-edit-end-${candidateId}`);
      payload = {
        summary: val(`mh-cand-edit-summary-${candidateId}`),
        start: startRaw ? new Date(startRaw).toISOString() : null,
        end: endRaw ? new Date(endRaw).toISOString() : null,
        timezone: val(`mh-cand-edit-timezone-${candidateId}`) || null,
        attendees: val(`mh-cand-edit-attendees-${candidateId}`).split(',').map((s) => s.trim()).filter(Boolean),
      };
    } else if (candidate.type === 'MEMORY') {
      payload = { statement: val(`mh-cand-edit-statement-${candidateId}`), category: val(`mh-cand-edit-category-${candidateId}`) || undefined };
    } else {
      payload = { title: val(`mh-cand-edit-title-${candidateId}`), summary: val(`mh-cand-edit-summary2-${candidateId}`) || undefined };
    }
    const newTitle = candidate.type === 'MEMORY'
      ? `Remember: ${(payload.statement || '').slice(0, 40)}`
      : (payload.name || payload.summary || payload.title || candidate.title);
    const result = await window.NAGEX.apiFetch(`/api/v1/candidates/${candidateId}`, { method: 'PATCH', body: JSON.stringify({ title: newTitle, payload }) });
    if (!result || result.error) {
      alert((result && result.error && result.error.message) || 'Could not save changes.');
      return;
    }
    mhCandidateEditState = null;
    await refreshInboxData();
    renderMobileInbox();
  };

  // ── Wrap every real, reused bridge action (acceptCandidate/
  // rejectCandidate/executeCandidateAction/retryCandidateAction/
  // retryCapture/actionCapture) so Mobile Inbox always re-renders itself
  // afterward. Desktop's own versions of these already refresh state
  // correctly (via loadAllData() or their own renderInbox() call) — they
  // just target Desktop's hidden DOM, not this visible one, so this file
  // never re-implements the action itself, only adds its own re-render. ──
  ['acceptCandidate', 'rejectCandidate', 'executeCandidateAction', 'retryCandidateAction', 'retryCapture', 'actionCapture'].forEach((fnName) => {
    const original = window.NAGEX[fnName];
    if (typeof original !== 'function' || original.__mhWrapped) return;
    const wrapped = async (...args) => {
      await original(...args);
      if (document.getElementById('mobile-view-inbox') && !document.getElementById('mobile-view-inbox').hidden) {
        renderMobileInbox();
      }
    };
    wrapped.__mhWrapped = true;
    window.NAGEX[fnName] = wrapped;
  });

  function renderMobileInbox() {
    if (!document.getElementById('mobile-view-inbox')) return;
    initFilterRow();
    initLangToggle();
    renderHeaderBadge();
    renderInboxList();
    renderCandidateQueue();
    // Real, fresh fetch every time the view becomes active — mirrors
    // Desktop's own renderInbox() always-refetch behavior (see R2
    // preflight's LEGACY_HIDDEN_INBOX_FETCH note: Desktop's own inbox
    // render still separately fires into its own hidden tree; this is
    // this view's own independent, real fetch, not a workaround for it).
    refreshInboxData().then(() => {
      // Guard: don't paint a stale fetch result over a view the user has
      // since navigated away from.
      if (document.getElementById('mobile-view-inbox') && !document.getElementById('mobile-view-inbox').hidden) {
        renderHeaderBadge();
        renderInboxList();
        renderCandidateQueue();
      }
    });
  }

  window.NAGEX.renderMobileInbox = renderMobileInbox;
})();
