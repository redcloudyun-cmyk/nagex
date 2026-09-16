// NAgex Mobile Home (UI-5 R1) — a genuinely separate DOM tree
// (#mobile-app-shell) bound to real NAgex data only, NOT a CSS-collapsed
// copy of DesktopHome's #view-home.
//
// Shell visibility rule (directive §4/28): #mobile-app-shell is shown only
// when BOTH matchMedia('(max-width: 768px)') is true AND the active tab is
// Home. Every other tab, at any viewport, keeps using the existing
// .app-wrapper responsive tree (legacy .mobile-bottom-nav included) until
// each gets its own UI-5 mobile-native slice. The two conditions are
// re-evaluated on every resize/orientation change AND on every real tab
// change (window.NAGEX.onTabChange, fired by app.js's switchTab()) — never
// on a viewport check alone.
//
// Reuses window.NAGEX.apiFetch/getState/switchTab/submitPrompt/
// handleApprovalAction/cancelTask exactly as desktop-home.js does — no
// second data client, no new backend endpoint.
(function () {
  'use strict';

  const mq = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  function emptyState(text) {
    return `<div class="nagex-empty-state">${escapeHtml(text)}</div>`;
  }

  // ── Shell visibility — the one place viewport + activeTab are both
  // checked together (directive §4/28: never viewport alone). UI-5 R2:
  // #mobile-app-shell is now the shared Mobile Native shell (not a
  // Home-only structure) — MOBILE_NATIVE_TABS is the single source of
  // truth for which tabs have a native view. Adding Activity/Vault/
  // Settings in R3-R5 means adding their tab id here + a view element +
  // a dispatch branch below, nothing else in the shell-visibility
  // contract changes. ──
  const MOBILE_NATIVE_TABS = new Set(['tab-home', 'tab-inbox']);

  function isMobileViewport() {
    return Boolean(mq && mq.matches);
  }

  // Returns the active tab id only when it both is a real tab AND has a
  // native mobile view — null otherwise (covers "not mobile viewport" by
  // being checked alongside isMobileViewport() at the one call site).
  function activeNativeTab() {
    const tab = window.NAGEX.getState && window.NAGEX.getState().activeTab;
    return tab && MOBILE_NATIVE_TABS.has(tab) ? tab : null;
  }

  function updateShellVisibility() {
    const shell = document.getElementById('mobile-app-shell');
    const desktopWrapper = document.querySelector('.app-wrapper');
    if (!shell) return;
    const nativeTab = isMobileViewport() ? activeNativeTab() : null;
    const showMobileShell = Boolean(nativeTab);

    shell.hidden = !showMobileShell;
    if (desktopWrapper) {
      desktopWrapper.style.display = showMobileShell ? 'none' : '';
    }

    // Directive §20 — the legacy responsive .mobile-bottom-nav and the new
    // #mobile-app-shell bottom nav must never both be visible. Note:
    // .mobile-bottom-nav and .floating-quickwake-btn are NOT descendants
    // of .app-wrapper (both are direct <body> siblings of it, confirmed via
    // the real parsed DOM, not assumed from source order) — display:none on
    // .app-wrapper alone does not hide them, so each is toggled explicitly.
    const legacyMobileNav = document.querySelector('.mobile-bottom-nav');
    if (legacyMobileNav) {
      legacyMobileNav.style.display = showMobileShell ? 'none' : '';
    }
    const floatingQuickWake = document.querySelector('.floating-quickwake-btn');
    if (floatingQuickWake) {
      floatingQuickWake.style.display = showMobileShell ? 'none' : '';
    }

    // Mutually exclusive native views — exactly one [hidden=false] (or
    // none, when the shell itself is hidden) at any time. R3-R5 add one
    // more `viewX.hidden = nativeTab !== 'tab-x'` line each, same pattern.
    const viewHome = document.getElementById('mobile-view-home');
    const viewInbox = document.getElementById('mobile-view-inbox');
    if (viewHome) viewHome.hidden = nativeTab !== 'tab-home';
    if (viewInbox) viewInbox.hidden = nativeTab !== 'tab-inbox';

    if (nativeTab === 'tab-home') {
      renderMobileHome();
    } else if (nativeTab === 'tab-inbox' && typeof window.NAGEX.renderMobileInbox === 'function') {
      window.NAGEX.renderMobileInbox();
    }
  }

  // ── Header ── real time-of-day greeting (no fabricated name/photo),
  // real notification state ──
  function renderHeader() {
    const eyebrow = document.getElementById('mh-hero-eyebrow');
    const hour = new Date().getHours();
    const key = hour < 12 ? 'home.greetingMorning' : hour < 18 ? 'home.greetingAfternoon' : 'home.greetingEvening';
    const fallback = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    if (eyebrow) {
      eyebrow.textContent = t(key, fallback);
      eyebrow.setAttribute('data-i18n', key);
    }

    const dot = document.getElementById('mh-notif-dot');
    if (dot && window.NAGEX.getState) {
      const notif = window.NAGEX.getState().notifications || { unreadCount: 0 };
      dot.hidden = !(notif.unreadCount > 0);
    }
  }

  // ── D. Background task banner + E. Working list — same real filters
  // DesktopWorking (app.js renderHomeWorkspaceSections) already uses:
  // state.tasks (RUNNING), state.inbox (PROCESSING/QUEUED/UPLOADING),
  // state.candidates (RUNNING action). No progress percentage is invented
  // — items render an indeterminate "Working…" state (directive §13),
  // never a fabricated number. ──
  function getWorkingItems(state) {
    const runningTasks = (state.tasks || [])
      .filter((task) => task.status === 'RUNNING')
      .map((task) => ({ title: task.name || 'Task in progress...', detail: task.lastRunAt ? `Started ${new Date(task.lastRunAt).toLocaleTimeString()}` : 'Started recently', taskId: task.taskId }));
    const processingCaptures = (state.inbox || [])
      .filter((i) => i.status === 'PROCESSING' || i.status === 'QUEUED' || i.status === 'UPLOADING')
      .map((i) => ({ title: i.metadata?.extractedTitle || i.content || 'Processing capture...', detail: i.metadata?.processingSubStage || i.status }));
    const runningActions = (state.candidates || [])
      .filter((c) => c.action && c.action.status === 'RUNNING')
      .map((c) => ({ title: c.title, detail: `${c.type} action in progress` }));
    return [...runningTasks, ...processingCaptures, ...runningActions];
  }

  function renderTaskBannerAndWorking() {
    if (!window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const items = getWorkingItems(state);

    const bannerDot = document.getElementById('mh-task-banner-dot');
    const bannerTitle = document.getElementById('mh-task-banner-title');
    const bannerSub = document.getElementById('mh-task-banner-sub');
    const bannerCount = document.getElementById('mh-task-banner-count');
    if (bannerTitle && bannerSub) {
      if (items.length > 0) {
        bannerTitle.textContent = t('home.taskBannerActiveTitle', 'Background tasks active');
        bannerSub.textContent = t('home.taskBannerActiveSub', 'NAgex is working for you. You stay in control.');
        if (bannerCount) {
          bannerCount.hidden = false;
          bannerCount.textContent = t('home.taskBannerCount', '{count} tasks running').replace('{count}', String(items.length));
        }
        if (bannerDot) bannerDot.classList.add('mh-task-banner-dot-active');
      } else {
        bannerTitle.textContent = t('home.workingReadyTitle', 'Ready when you are');
        bannerSub.textContent = t('home.workingEmpty', 'Nothing is running right now.');
        if (bannerCount) bannerCount.hidden = true;
        if (bannerDot) bannerDot.classList.remove('mh-task-banner-dot-active');
      }
    }

    const listEl = document.getElementById('mh-working-list');
    if (!listEl) return;
    if (items.length === 0) {
      listEl.innerHTML = emptyState(t('home.workingEmpty', 'Nothing is running right now.'));
      return;
    }
    listEl.innerHTML = items.slice(0, 3).map((w) => `
      <div class="mh-row">
        <div class="mh-row-icon mh-row-icon-blue">
          <svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3M6 6v11M10 3v18M14 6v11M18 10v3"/></svg>
        </div>
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(w.title)}</div>
          <div class="mh-row-detail">${escapeHtml(w.detail)}</div>
        </div>
        <div class="mh-row-trailing">
          <span class="nagex-badge nagex-badge-running">${escapeHtml(t('workspace.working', 'Working…'))}</span>
          ${w.taskId ? `<button class="mh-stop-btn" onclick="window.NAGEX.cancelTask('${w.taskId}')" title="${escapeHtml(t('workspace.stop', 'Stop'))}">${escapeHtml(t('workspace.stop', 'Stop'))}</button>` : ''}
        </div>
      </div>`).join('');
  }

  // ── F. Needs Your Approval — same real sources DesktopApprovals uses
  // (state.approvals PENDING + proposed/failed candidates + NEEDS_HUMAN
  // captures), max 2 in Mobile Home per directive §15. "Modify" is not a
  // real action anywhere in NAgex today (only Approve/Review/Reject are
  // real) — the mockup's second button is mapped to the real "Review"
  // action (opens the full Approvals view) rather than fabricating a
  // Modify flow, per directive §15's own instruction to use only real
  // supported actions when the mockup's exact action isn't real. ──
  function renderApprovals() {
    if (!window.NAGEX.getState) return;
    const state = window.NAGEX.getState();
    const pending = (state.approvals || []).filter((a) => a.status === 'PENDING');
    const proposedCandidates = (state.candidates || []).filter((c) => c.status === 'PROPOSED');
    const needsHumanCaptures = (state.inbox || []).filter((i) => i.status === 'NEEDS_REVIEW' && i.metadata?.errorCode === 'BLOCKED_NEEDS_HUMAN');

    const badge = document.getElementById('mh-approvals-badge');
    const total = pending.length + proposedCandidates.length + needsHumanCaptures.length;
    if (badge) {
      if (total > 0) {
        badge.hidden = false;
        badge.textContent = total > 9 ? '9+' : String(total);
      } else {
        badge.hidden = true;
      }
    }

    const listEl = document.getElementById('mh-approvals-list');
    if (!listEl) return;

    const items = [
      ...pending.map((a) => ({ kind: 'approval', data: a })),
      ...proposedCandidates.map((c) => ({ kind: 'candidate', data: c })),
      ...needsHumanCaptures.map((i) => ({ kind: 'needs-human', data: i })),
    ].slice(0, 2);

    if (items.length === 0) {
      listEl.innerHTML = emptyState(t('home.approvalsEmpty', "No approvals waiting. You're all caught up."));
      return;
    }

    listEl.innerHTML = items.map((entry) => {
      if (entry.kind === 'approval') {
        const a = entry.data;
        const title = a.intent || a.action || 'Approval Required';
        const detail = a.resource?.id || 'Action Approval';
        return `<div class="mh-approval-card">
          <div class="mh-row-icon mh-row-icon-danger">
            <svg class="svg-icon-sm" viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
          </div>
          <div class="mh-approval-body">
            <div class="mh-row-title">${escapeHtml(title)}</div>
            <div class="mh-row-detail">${escapeHtml(detail)}</div>
            <div class="mh-approval-actions">
              <button class="mh-btn-approve" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'APPROVE')">${escapeHtml(t('ambient.approve', 'Approve'))}</button>
              <button class="mh-btn-review" onclick="window.NAGEX.switchTab('tab-approvals')">${escapeHtml(t('home.reviewAction', 'Review'))}</button>
            </div>
          </div>
        </div>`;
      }
      if (entry.kind === 'candidate') {
        const c = entry.data;
        return `<div class="mh-approval-card" onclick="window.NAGEX.switchTab('tab-inbox')" role="button" tabindex="0">
          <div class="mh-row-icon mh-row-icon-blue">
            <svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
          <div class="mh-approval-body">
            <div class="mh-row-title">${escapeHtml(c.title)}</div>
            <div class="mh-row-detail">${escapeHtml(t('workspace.candidateStatusProposed', 'Suggested'))}</div>
          </div>
        </div>`;
      }
      const i = entry.data;
      const title = i.metadata?.extractedTitle || i.content || 'A page';
      return `<div class="mh-approval-card" onclick="window.NAGEX.switchTab('tab-inbox')" role="button" tabindex="0">
        <div class="mh-row-icon mh-row-icon-warning">
          <svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="mh-approval-body">
          <div class="mh-row-title">${escapeHtml(title)}</div>
          <div class="mh-row-detail">${escapeHtml(t('workspace.needsHumanAttention', 'Needs your attention'))}</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── G. Today — real GET /api/v1/my-space (calendar/calendarStatus) +
  // real state.tasks. Lazily fetched once per real render cycle the shell
  // is actually visible for (own flag, independent of desktop-home.js's
  // own lazy fetch — never fires unless Mobile Home is actually the
  // visible shell). "What NAgex did for you" is a separate section with
  // its own real source (state.activity, per directive §17) — deliberately
  // not my-space's `history` field, so the two sections never race to
  // write the same element. ──
  let mySpaceFetched = false;
  async function renderToday() {
    const listEl = document.getElementById('mh-today-list');
    if (!listEl || !window.NAGEX.apiFetch || !window.NAGEX.getState) return;

    const state = window.NAGEX.getState();
    const activeTasks = (state.tasks || []).filter((task) => task.status === 'ACTIVE' || task.status === 'RUNNING' || task.status === 'PAUSED').slice(0, 4);

    let data = null;
    if (!mySpaceFetched) {
      mySpaceFetched = true;
      data = await window.NAGEX.apiFetch('/api/v1/my-space');
    }

    if (listEl) {
      const rows = [];
      if (data) {
        if (data.calendarStatus === 'DISCONNECTED') {
          rows.push({ title: t('mySpace.calendarDisconnected', 'Connect Google Calendar to see upcoming events'), done: null });
        } else if (data.calendarStatus === 'ERROR') {
          rows.push({ title: t('mySpace.sectionError', 'Could not load this section'), done: null });
        } else if ((data.calendar || []).length === 0 && activeTasks.length === 0) {
          rows.push({ title: t('mySpace.noCalendar', 'No upcoming events'), done: null });
        } else {
          (data.calendar || []).slice(0, 4).forEach((ev) => {
            const time = ev.start ? new Date(ev.start.dateTime || ev.start.date || ev.start) : null;
            rows.push({
              time: time ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
              title: ev.summary || ev.title || 'Event',
              detail: '',
              done: false,
            });
          });
        }
      }
      activeTasks.forEach((task) => {
        rows.push({ time: '', title: task.name || 'Task', detail: task.status, done: task.status === 'PAUSED' ? null : false });
      });

      listEl.innerHTML = rows.length === 0
        ? emptyState(t('mySpace.noCalendar', 'No upcoming events'))
        : `<div class="mh-timeline">${rows.slice(0, 4).map((r) => `
          <div class="mh-timeline-row">
            <div class="mh-timeline-rail">
              <span class="mh-timeline-time">${escapeHtml(r.time || '')}</span>
              <span class="mh-timeline-dot ${r.done === false ? 'mh-timeline-dot-open' : r.done === true ? 'mh-timeline-dot-done' : ''}"></span>
            </div>
            <div class="mh-timeline-body">
              <div class="mh-row-title">${escapeHtml(r.title)}</div>
              ${r.detail ? `<div class="mh-row-detail">${escapeHtml(r.detail)}</div>` : ''}
            </div>
          </div>`).join('')}</div>`;
    }
  }

  // ── What NAgex Did — real state.activity (COMPLETED only). ActivityStore
  // already guarantees human-readable titles (never raw audit event names
  // — see governance/activity.store.ts + the Activity & Execution
  // Transparency Amendment), so no extra label-generation is needed or
  // performed here. ──
  function renderDoneForYou() {
    if (!window.NAGEX.getState) return;
    const el = document.getElementById('mh-history-list');
    if (!el) return;
    const state = window.NAGEX.getState();
    const completed = (state.activity || []).filter((a) => a.status === 'COMPLETED').slice(0, 3);
    if (completed.length === 0) {
      el.innerHTML = emptyState(t('home.doneForYouEmpty', 'Nothing completed yet.'));
      return;
    }
    el.innerHTML = completed.map((a) => `
      <div class="mh-row">
        <div class="mh-row-icon mh-row-icon-success">
          <svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="mh-row-body">
          <div class="mh-row-title">${escapeHtml(a.title)}</div>
          <div class="mh-row-detail">${new Date(a.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      </div>`).join('');
  }

  // ── Language toggle — reuses the exact real window.NAGEX_I18N
  // (toggleLocale/applyLocale/localStorage) the Desktop #btn-lang-toggle
  // already uses; no second locale system. toggleLocale() already calls
  // applyLocale() internally (updates every [data-i18n*] element, this
  // button's own label included, via i18n.js's own generic
  // [data-i18n-lang-toggle] handling — no mobile-specific text logic
  // needed here). The extra switchTab() call re-runs the real render
  // pipeline for this tab so JS-templated lists (approvals/working/today,
  // and — since R2 — the Inbox lists) pick up the new locale too, exactly
  // mirroring what Desktop's own lang button handler already does with
  // renderActiveTab(). UI-5 R2: generalized to accept any button id so
  // both #mh-lang-toggle (Home) and #mh-inbox-lang-toggle (Inbox) — one
  // per native view's own header, since only one view is ever visible at
  // a time — share this one real implementation. ──
  function bindLangToggle(btnId) {
    const btn = document.getElementById(btnId);
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      if (!window.NAGEX_I18N || !window.NAGEX.switchTab || !window.NAGEX.getState) return;
      window.NAGEX_I18N.toggleLocale();
      window.NAGEX.switchTab(window.NAGEX.getState().activeTab);
    });
  }

  function initLangToggle() {
    bindLangToggle('mh-lang-toggle');
  }

  // ── B. Command bar — reuses window.NAGEX.submitPrompt, the exact same
  // real route-input classification + ambient/capture dispatch the
  // Desktop composer's send button uses. Voice reuses the exact same real
  // MediaRecorder → POST /api/v1/workspace/upload path DesktopHome's own
  // audio button uses (no new endpoint). ──
  let mhMediaRecorder = null;
  let mhAudioChunks = [];

  function initCommandBar() {
    const input = document.getElementById('mh-command-input');
    const sendBtn = document.getElementById('mh-command-send');
    const voiceBtn = document.getElementById('mh-voice-btn');
    if (sendBtn && input && !sendBtn.dataset.bound) {
      sendBtn.dataset.bound = '1';
      const send = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        await window.NAGEX.submitPrompt(text);
      };
      sendBtn.addEventListener('click', send);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); send(); }
      });
    }
    if (voiceBtn && !voiceBtn.dataset.bound) {
      voiceBtn.dataset.bound = '1';
      voiceBtn.addEventListener('click', async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert('Microphone recording is not supported by your browser.');
          return;
        }
        if (mhMediaRecorder && mhMediaRecorder.state === 'recording') {
          mhMediaRecorder.stop();
          voiceBtn.classList.remove('mh-voice-recording');
          return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          mhAudioChunks = [];
          mhMediaRecorder = new MediaRecorder(stream);
          mhMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) mhAudioChunks.push(e.data); };
          mhMediaRecorder.onstop = async () => {
            const audioBlob = new Blob(mhAudioChunks, { type: 'audio/webm' });
            stream.getTracks().forEach((track) => track.stop());
            if (audioBlob.size === 0) return;
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64Data = (reader.result || '').toString().split(',')[1];
              if (!base64Data) return;
              await window.NAGEX.apiFetch('/api/v1/workspace/upload', {
                method: 'POST',
                body: JSON.stringify({
                  type: 'AUDIO',
                  filename: `voice_memo_${Date.now()}.webm`,
                  mimeType: 'audio/webm',
                  base64: base64Data,
                  source: 'WEB',
                }),
              });
              window.NAGEX.switchTab('tab-inbox');
            };
            reader.readAsDataURL(audioBlob);
          };
          mhMediaRecorder.start();
          voiceBtn.classList.add('mh-voice-recording');
        } catch (err) {
          alert('Microphone access denied or error: ' + (err.message || err));
        }
      });
    }
  }

  function renderMobileHome() {
    if (!document.getElementById('mobile-app-shell')) return;
    initCommandBar();
    initLangToggle();
    renderHeader();
    renderTaskBannerAndWorking();
    renderApprovals();
    renderToday();
    renderDoneForYou();
  }

  function init() {
    window.NAGEX = window.NAGEX || {};
    // Own hook name (never window.NAGEX.onHomeRender — that belongs to
    // desktop-home.js; a shared name would make whichever script loads
    // last silently overwrite the other's registration).
    window.NAGEX.onHomeRenderMobile = () => { if (isMobileViewport() && activeNativeTab() === 'tab-home') renderMobileHome(); };
    window.NAGEX.onTabChange = updateShellVisibility;
    // Shared real implementation other mobile-native view modules (e.g.
    // mobile-inbox.js) reuse for their own view-local lang-toggle button,
    // rather than each reimplementing the same window.NAGEX_I18N wiring.
    window.NAGEX.bindMobileLangToggle = bindLangToggle;
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', updateShellVisibility);
      else if (mq.addListener) mq.addListener(updateShellVisibility); // Safari <14 fallback
    }
    updateShellVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
