// R21 P1 — Meeting Prep modal. Self-contained (injects its own DOM into
// document.body rather than requiring pre-existing markup) so it can be
// loaded from both index.html (Home/Quick Wake proactive card) and
// desktop-quickwake.html (the separate mini command window) without any
// dependency on app.js's larger ambient-modal machinery. Calls only real,
// already-existing endpoints: POST /api/v1/personal/meeting-prep (R21 P1),
// POST /api/v1/tools/google-calendar/free-slots (read-only), and the exact
// same POST /api/v1/approvals -> approve -> POST /api/v1/tools/... sequence
// requestCalendarApproval()/the Gmail draft flow in app.js already use —
// PLAN ACCEPTANCE ("Find a time") is kept structurally distinct from ACTION
// APPROVAL ("Add to calendar"/"Create draft").
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    const resolved = window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null;
    return resolved && resolved !== key ? resolved : (fallback || key);
  }

  async function apiFetch(url, opts) {
    if (window.NAGEX && typeof window.NAGEX.apiFetch === 'function') return window.NAGEX.apiFetch(url, opts);
    try {
      const demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
      const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json', ...(demoMode ? { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' } : {}) } }, opts));
      return await res.json();
    } catch {
      return null;
    }
  }

  let modalEl = null;
  let scrollLock = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    const el = document.createElement('div');
    el.className = 'nagex-modal-backdrop meeting-prep-backdrop hidden';
    el.id = 'meeting-prep-backdrop';
    el.innerHTML =
      '<div class="nagex-modal meeting-prep-modal" role="dialog" aria-modal="true" aria-labelledby="meeting-prep-title">' +
      '<button class="modal-close-btn" id="meeting-prep-close" aria-label="Close">×</button>' +
      '<div id="meeting-prep-body"></div>' +
      '</div>';
    document.body.appendChild(el);
    modalEl = el;

    el.addEventListener('mousedown', (e) => {
      if (window.NAGEX_MODAL_BEHAVIOR && window.NAGEX_MODAL_BEHAVIOR.isBackdropSelfClick(e.target, el)) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.classList.contains('hidden')) closeModal();
    });
    el.querySelector('#meeting-prep-close').addEventListener('click', closeModal);
    return el;
  }

  function openModal() {
    const el = ensureModal();
    el.classList.remove('hidden');
    if (window.NAGEX_MODAL_BEHAVIOR) {
      scrollLock = scrollLock || window.NAGEX_MODAL_BEHAVIOR.createScrollLock();
      scrollLock.lock(document.body.style.overflow);
      document.body.style.overflow = 'hidden';
    }
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    if (scrollLock) {
      const restore = scrollLock.unlock();
      document.body.style.overflow = restore == null ? '' : restore;
    }
  }

  function renderProgress(step) {
    const body = document.getElementById('meeting-prep-body');
    if (!body) return;
    const steps = [
      t('meetingPrep.stepCalendar', 'Checked your calendar'),
      t('meetingPrep.stepContext', 'Found related notes and emails'),
      t('meetingPrep.stepSynth', 'Preparing the key points'),
    ];
    body.innerHTML =
      '<h3>' + escapeHtml(t('meetingPrep.preparingTitle', 'Preparing your meeting')) + '</h3>' +
      '<ul class="meeting-prep-progress">' +
      steps.map((label, i) => {
        const mark = i < step ? '✓' : i === step ? '●' : '○';
        const cls = i < step ? 'done' : i === step ? 'active' : '';
        return '<li class="' + cls + '">' + mark + ' ' + escapeHtml(label) + '</li>';
      }).join('') +
      '</ul>';
  }

  function sourceIcon(type) {
    return type === 'VAULT' ? '🗂️' : type === 'EMAIL' ? '✉️' : type === 'MEMORY' ? '🧠' : '📅';
  }

  // ── "Related context" — reused by both the Meeting Prep result and Quick
  // Wake's proactive suggestion card (§13/§G): real sources only, never a
  // confidence score shown to the user. ──
  function renderRelatedContextList(items) {
    if (!items || items.length === 0) {
      return '<p class="nagex-empty-state">' + escapeHtml(t('meetingPrep.noRelated', 'Nothing else found related to this meeting yet.')) + '</p>';
    }
    return '<ul class="meeting-prep-related">' + items.map((m) => {
      const title = escapeHtml(m.title || m.label || '');
      const summary = m.summary ? '<br><small>' + escapeHtml(m.summary) + '</small>' : '';
      return '<li>' + sourceIcon(m.type) + ' <strong>' + title + '</strong>' + summary + '</li>';
    }).join('') + '</ul>';
  }
  window.NAGEX_RELATED_CONTEXT_LIST = { render: renderRelatedContextList };

  function renderResult(card) {
    const body = document.getElementById('meeting-prep-body');
    if (!body) return;
    const keyPointsHtml = card.key_points && card.key_points.length
      ? '<ol class="meeting-prep-keypoints">' + card.key_points.map((p) => '<li>' + escapeHtml(p) + '</li>').join('') + '</ol>'
      : '<p class="nagex-empty-state">' + escapeHtml(t('meetingPrep.noKeyPoints', 'Nothing specific to flag — you are all set.')) + '</p>';
    const agendaHtml = card.suggested_agenda && card.suggested_agenda.length
      ? '<h4>' + escapeHtml(t('meetingPrep.agenda', 'Suggested agenda')) + '</h4><ul class="meeting-prep-agenda">' + card.suggested_agenda.map((a) => '<li>' + escapeHtml(a) + '</li>').join('') + '</ul>'
      : '';

    body.innerHTML =
      '<h3 id="meeting-prep-title">' + escapeHtml(card.event_title) + '</h3>' +
      '<p class="meeting-prep-reason">' + escapeHtml(card.reason) + '</p>' +
      '<h4>' + escapeHtml(t('meetingPrep.related', 'Related to this meeting')) + '</h4>' +
      renderRelatedContextList(card.related_materials) +
      '<h4>' + escapeHtml(t('meetingPrep.keyThings', 'Key things to know')) + '</h4>' +
      keyPointsHtml +
      agendaHtml +
      '<div class="meeting-prep-actions">' +
      '<button class="btn-secondary" id="meeting-prep-find-time">' + escapeHtml(t('meetingPrep.findTime', 'Find a time for a follow-up')) + '</button>' +
      '<button class="btn-secondary" id="meeting-prep-draft-followup">' + escapeHtml(t('meetingPrep.draftFollowup', 'Draft a follow-up')) + '</button>' +
      '</div>' +
      '<div id="meeting-prep-continuation"></div>';

    const findBtn = document.getElementById('meeting-prep-find-time');
    const draftBtn = document.getElementById('meeting-prep-draft-followup');
    if (findBtn) findBtn.addEventListener('click', () => findTime(card));
    if (draftBtn) draftBtn.addEventListener('click', () => draftFollowup(card));
  }

  // ── "Find a time" is preparation only (a real free-slots read) — no
  // mutation happens until "Add to calendar" below. PLAN ACCEPTANCE !=
  // ACTION APPROVAL. ──
  async function findTime(card) {
    const cont = document.getElementById('meeting-prep-continuation');
    if (!cont) return;
    cont.innerHTML = '<p>' + escapeHtml(t('meetingPrep.findingTime', 'Checking your calendar for a good time...')) + '</p>';
    const timeMin = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const timeMax = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString();
    const result = await apiFetch('/api/v1/tools/google-calendar/free-slots', { method: 'POST', body: JSON.stringify({ timeMin, timeMax }) });
    const slot = result && Array.isArray(result.freeSlots) && result.freeSlots.length > 0 ? result.freeSlots[0] : null;
    if (!slot) {
      cont.innerHTML = '<p class="nagex-empty-state">' + escapeHtml(t('meetingPrep.noSlotFound', 'I could not find an open slot in the next week.')) + '</p>';
      return;
    }
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    cont.innerHTML =
      '<p><strong>' + escapeHtml(start.toLocaleString()) + '</strong> – ' + escapeHtml(end.toLocaleTimeString()) + '</p>' +
      '<p>' + escapeHtml(t('meetingPrep.noConflicts', 'No conflicts found.')) + '</p>' +
      '<div class="meeting-prep-confirm-actions">' +
      '<button class="btn-reject-outline" id="meeting-prep-choose-other">' + escapeHtml(t('meetingPrep.chooseAnother', 'Choose another time')) + '</button>' +
      '<button class="btn-plan-action plan-status-ready" id="meeting-prep-add-to-calendar">' + escapeHtml(t('meetingPrep.addToCalendar', 'Add to calendar')) + '</button>' +
      '</div>';
    const chooseOther = document.getElementById('meeting-prep-choose-other');
    const addBtn = document.getElementById('meeting-prep-add-to-calendar');
    if (chooseOther) chooseOther.addEventListener('click', () => { cont.innerHTML = ''; });
    if (addBtn) addBtn.addEventListener('click', () => requestCalendarFollowup(card, slot));
  }

  async function requestCalendarFollowup(card, slot) {
    const cont = document.getElementById('meeting-prep-continuation');
    if (!cont) return;
    cont.innerHTML = '<p>' + escapeHtml(t('meetingPrep.requestingApproval', 'Requesting approval...')) + '</p>';
    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    const summary = isKo ? '클라이언트 후속 미팅' : 'Client follow-up';
    const payload = {
      calendarId: 'primary',
      summary: summary,
      description: isKo ? 'NAgex가 예약한 후속 미팅입니다.' : 'Follow-up meeting scheduled by NAgex.',
      start: slot.start,
      end: slot.end,
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
      attendees: card.attendees || [],
    };
    const approval = await apiFetch('/api/v1/approvals', { method: 'POST', body: JSON.stringify({ toolId: 'google_calendar.create_event', payload }) });
    if (!approval || approval.error || !approval.approvalId) {
      cont.innerHTML = '<p class="resolution-warnings">' + escapeHtml((approval && approval.error && approval.error.message) || t('meetingPrep.genericError', "I couldn't complete that. Please try again.")) + '</p>';
      return;
    }
    renderCalendarConfirm(cont, approval, card);
  }

  function formatDateTime(iso) {
    try {
      const loc = (window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko') ? 'ko-KR' : 'en-US';
      return new Date(iso).toLocaleString(loc, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return String(iso || '');
    }
  }

  function scrollToTopOrContinuation() {
    const modal = document.querySelector('.meeting-prep-modal');
    if (modal) modal.scrollTop = 0;
  }

  function renderCalendarConfirm(cont, approval, card) {
    const p = approval.canonicalPayload || {};
    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    const summary = (isKo && (p.summary === 'Client follow-up' || !p.summary)) ? '클라이언트 후속 미팅' : (p.summary || (isKo ? '클라이언트 후속 미팅' : 'Client follow-up'));
    const body = document.getElementById('meeting-prep-body');
    if (body && cont.parentNode === body) {
      body.insertBefore(cont, body.firstChild);
    }
    cont.innerHTML =
      '<div class="meeting-prep-confirm-card">' +
      '<h4>' + escapeHtml(t('meetingPrep.readyToAdd', 'Ready to add to your calendar')) + '</h4>' +
      '<p class="meeting-prep-impact">' + escapeHtml(t('meetingPrep.approvalImpact', 'Adds a follow-up meeting event to your Google Calendar.')) + '</p>' +
      '<p class="meeting-prep-summary"><strong>' + escapeHtml(summary) + '</strong></p>' +
      '<p class="meeting-prep-time">' + escapeHtml(formatDateTime(p.start)) + '</p>' +
      '<div class="meeting-prep-confirm-actions">' +
      '<button class="btn-reject-outline" id="meeting-prep-cancel-add">' + escapeHtml(t('meetingPrep.notNow', 'Not now')) + '</button>' +
      '<button class="btn-plan-action plan-status-ready" id="meeting-prep-confirm-add">' + escapeHtml(t('meetingPrep.addToCalendar', 'Add to calendar')) + '</button>' +
      '</div></div>';
    const modal = document.querySelector('.meeting-prep-modal');
    if (modal) modal.scrollTop = 0;
    const cancelBtn = document.getElementById('meeting-prep-cancel-add');
    const confirmBtn = document.getElementById('meeting-prep-confirm-add');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      await apiFetch('/api/v1/approvals/' + approval.approvalId + '/reject', { method: 'POST' });
      cont.innerHTML = '';
      if (body) body.appendChild(cont);
    });
    if (confirmBtn) confirmBtn.addEventListener('click', async () => {
      const approvalStartedAt = performance.now();
      cont.innerHTML = '<p>' + escapeHtml(t('meetingPrep.addingToCalendar', 'Adding to your calendar...')) + '</p>';
      const approved = await apiFetch('/api/v1/approvals/' + approval.approvalId + '/approve', { method: 'POST' });
      if (!approved || approved.error) {
        cont.innerHTML = '<p class="resolution-warnings">' + escapeHtml(t('meetingPrep.couldNotComplete', "I couldn't finish this task right now.")) + '</p>';
        return;
      }
      const result = await apiFetch('/api/v1/tools/google-calendar/create-event', { method: 'POST', body: JSON.stringify({ approvalId: approval.approvalId, payload: approved.canonicalPayload }) });
      if (result && result.status === 'SUCCEEDED') {
        window.NAGEX_METRICS = window.NAGEX_METRICS || {};
        window.NAGEX_METRICS.APPROVAL_TO_RESULT_MS = Math.max(0, Math.round(performance.now() - approvalStartedAt));
        const isDemo = result.executionMode === 'DEMO' || result.providerVerified === false || result.dataSource === 'DEMO';
        const updatedIsKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
        const finalSummary = (updatedIsKo && (p.summary === 'Client follow-up' || !p.summary)) ? '클라이언트 후속 미팅' : (p.summary || (updatedIsKo ? '클라이언트 후속 미팅' : 'Client follow-up'));
        if (isDemo) {
          const mainTitle = updatedIsKo ? '데모 완료' : 'Demo completed';
          const subNotice = updatedIsKo ? '실제 Google Calendar 이벤트는 생성되지 않았습니다.' : 'No real Google Calendar event was created.';
          cont.innerHTML =
            '<div class="meeting-prep-done-card">' +
            '<h4>' + escapeHtml(mainTitle) + '</h4>' +
            '<p class="meeting-prep-done-notice">' + escapeHtml(subNotice) + '</p>' +
            '<p class="meeting-prep-done-summary"><strong>' + escapeHtml(finalSummary) + '</strong></p>' +
            '<p class="meeting-prep-done-time">' + escapeHtml(formatDateTime(p.start)) + '</p>' +
            '</div>';
        } else {
          cont.innerHTML =
            '<div class="meeting-prep-done-card">' +
            '<h4>' + escapeHtml(t('meetingPrep.addedToCalendar', 'Added to your calendar')) + '</h4>' +
            '<p class="meeting-prep-done-summary"><strong>' + escapeHtml(finalSummary) + '</strong></p>' +
            '<p class="meeting-prep-done-time">' + escapeHtml(formatDateTime(p.start)) + '</p>' +
            (result.externalUrl ? '<a href="' + encodeURI(result.externalUrl) + '" target="_blank" rel="noopener" class="btn-plan-action plan-status-ready">' + escapeHtml(t('meetingPrep.viewEvent', 'View event')) + ' →</a>' : '') +
            '</div>';
        }
        if (modal) modal.scrollTop = 0;
      } else {
        cont.innerHTML = '<p class="resolution-warnings">' + escapeHtml(t('meetingPrep.couldNotComplete', "I couldn't finish this task right now.")) + '</p>';
      }
    });
  }

  async function draftFollowup(card) {
    const cont = document.getElementById('meeting-prep-continuation');
    if (!cont) return;
    cont.innerHTML = '<p>' + escapeHtml(t('meetingPrep.draftingEmail', 'Drafting a follow-up email...')) + '</p>';
    const lines = ['Hi,', '', 'Following up after our meeting on ' + card.event_title + '.'];
    (card.key_points || []).forEach((p) => lines.push('- ' + p));
    lines.push('', 'Best,');
    const payload = { to: card.attendees || [], subject: 'Following up: ' + card.event_title, body: lines.join('\n') };
    const approval = await apiFetch('/api/v1/approvals', { method: 'POST', body: JSON.stringify({ toolId: 'gmail.create_draft', payload }) });
    if (!approval || approval.error || !approval.approvalId) {
      cont.innerHTML = '<p class="resolution-warnings">' + escapeHtml((approval && approval.error && approval.error.message) || t('meetingPrep.genericError', "I couldn't complete that. Please try again.")) + '</p>';
      return;
    }
    renderEmailConfirm(cont, approval);
  }

  function renderEmailConfirm(cont, approval) {
    const p = approval.canonicalPayload || {};
    cont.innerHTML =
      '<div class="meeting-prep-confirm-card">' +
      '<h4>' + escapeHtml(t('meetingPrep.readyToDraft', 'Ready to create this draft')) + '</h4>' +
      '<p><strong>' + escapeHtml(p.subject || '') + '</strong></p>' +
      '<p>' + escapeHtml((p.to || []).join(', ')) + '</p>' +
      '<pre class="meeting-prep-email-body">' + escapeHtml(p.body || '') + '</pre>' +
      '<div class="meeting-prep-confirm-actions">' +
      '<button class="btn-reject-outline" id="meeting-prep-cancel-draft">' + escapeHtml(t('meetingPrep.notNow', 'Not now')) + '</button>' +
      '<button class="btn-plan-action plan-status-ready" id="meeting-prep-confirm-draft">' + escapeHtml(t('meetingPrep.createDraft', 'Create draft')) + '</button>' +
      '</div></div>';
    const cancelBtn = document.getElementById('meeting-prep-cancel-draft');
    const confirmBtn = document.getElementById('meeting-prep-confirm-draft');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      await apiFetch('/api/v1/approvals/' + approval.approvalId + '/reject', { method: 'POST' });
      cont.innerHTML = '';
    });
    if (confirmBtn) confirmBtn.addEventListener('click', async () => {
      cont.innerHTML = '<p>' + escapeHtml(t('meetingPrep.creatingDraft', 'Creating draft...')) + '</p>';
      const approved = await apiFetch('/api/v1/approvals/' + approval.approvalId + '/approve', { method: 'POST' });
      if (!approved || approved.error) {
        cont.innerHTML = '<p class="resolution-warnings">' + escapeHtml(t('meetingPrep.couldNotComplete', "I couldn't finish this task right now.")) + '</p>';
        return;
      }
      const result = await apiFetch('/api/v1/tools/gmail/create-draft', { method: 'POST', body: JSON.stringify({ approvalId: approval.approvalId, payload: approved.canonicalPayload }) });
      if (result && result.status === 'SUCCEEDED') {
        cont.innerHTML = '<div class="meeting-prep-done-card"><h4>' + escapeHtml(t('meetingPrep.draftCreated', 'Draft created')) + '</h4></div>';
      } else {
        cont.innerHTML = '<p class="resolution-warnings">' + escapeHtml(t('meetingPrep.couldNotComplete', "I couldn't finish this task right now.")) + '</p>';
      }
    });
  }

  async function openMeetingPrep(eventId) {
    const startedAt = performance.now();
    openModal();
    renderProgress(0);
    window.NAGEX_METRICS = window.NAGEX_METRICS || {};
    window.NAGEX_METRICS.MEETING_PREP_FIRST_FEEDBACK_MS = Math.max(0, Math.round(performance.now() - startedAt));
    renderProgress(1);
    let card = null;
    let errorMessage = null;
    try {
      const res = await apiFetch('/api/v1/personal/meeting-prep', { method: 'POST', body: JSON.stringify(eventId ? { eventId } : {}) });
      if (res && res.error) {
        errorMessage = res.error.code === 'MEETING_PREP_NO_EVENT'
          ? t('meetingPrep.noUpcomingMeeting', "I don't see an upcoming meeting to prepare for.")
          : t('meetingPrep.genericError', "I couldn't complete that. Please try again.");
      } else {
        card = res;
      }
    } catch {
      errorMessage = t('meetingPrep.genericError', "I couldn't complete that. Please try again.");
    }
    renderProgress(2);
    if (!card) {
      const body = document.getElementById('meeting-prep-body');
      if (body) body.innerHTML = '<p class="resolution-warnings">' + escapeHtml(errorMessage || t('meetingPrep.genericError', "I couldn't complete that. Please try again.")) + '</p>';
      return;
    }
    renderResult(card);
    window.NAGEX_METRICS.MEETING_PREP_RESULT_MS = Math.max(0, Math.round(performance.now() - startedAt));
  }

  window.NAGEX_MEETING_PREP = { open: openMeetingPrep, close: closeModal };
})();
