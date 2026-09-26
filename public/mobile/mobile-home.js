// NAgex Mobile Home — Personal AI Decision + Next Action Surface (R22.1)
(function () {
  'use strict';

  const mq = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  const MOBILE_NATIVE_TABS = new Set(['tab-home', 'tab-inbox', 'tab-executions', 'tab-vault', 'tab-settings']);

  function isMobileViewport() {
    return Boolean(mq && mq.matches);
  }

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

    const legacyMobileNav = document.querySelector('.mobile-bottom-nav');
    if (legacyMobileNav) {
      legacyMobileNav.style.display = showMobileShell ? 'none' : '';
    }
    const floatingQuickWake = document.querySelector('.floating-quickwake-btn');
    if (floatingQuickWake) {
      floatingQuickWake.style.display = showMobileShell ? 'none' : '';
    }

    const viewHome = document.getElementById('mobile-view-home');
    const viewInbox = document.getElementById('mobile-view-inbox');
    const viewActivity = document.getElementById('mobile-view-activity');
    const viewVault = document.getElementById('mobile-view-vault');
    const viewSettings = document.getElementById('mobile-view-settings');
    if (viewHome) viewHome.hidden = nativeTab !== 'tab-home';
    if (viewInbox) viewInbox.hidden = nativeTab !== 'tab-inbox';
    if (viewActivity) viewActivity.hidden = nativeTab !== 'tab-executions';
    if (viewVault) viewVault.hidden = nativeTab !== 'tab-vault';
    if (viewSettings) viewSettings.hidden = nativeTab !== 'tab-settings';

    if (nativeTab === 'tab-home') {
      renderMobileHome();
    } else if (nativeTab === 'tab-inbox' && typeof window.NAGEX.renderMobileInbox === 'function') {
      window.NAGEX.renderMobileInbox();
    } else if (nativeTab === 'tab-executions' && typeof window.NAGEX.renderMobileActivity === 'function') {
      window.NAGEX.renderMobileActivity();
    } else if (nativeTab === 'tab-vault' && typeof window.NAGEX.renderMobileVault === 'function') {
      window.NAGEX.renderMobileVault();
    } else if (nativeTab === 'tab-settings' && typeof window.NAGEX.renderMobileSettings === 'function') {
      window.NAGEX.renderMobileSettings();
    }
  }

  // ── A. Header ──
  function renderHeader() {
    const greetingEl = document.getElementById('mh-greeting-small');
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    if (greetingEl) {
      greetingEl.textContent = isKo ? '안녕하세요, Alex' : `Good ${timeOfDay}, Alex`;
    }

    const avatarEl = document.getElementById('mh-avatar');
    if (avatarEl) avatarEl.textContent = 'A';

    const dot = document.getElementById('mh-notif-dot');
    if (dot && window.NAGEX.getState) {
      const notif = window.NAGEX.getState().notifications || { unreadCount: 0 };
      dot.hidden = !(notif.unreadCount > 0);
    }
  }

  // ── B. Right Now Hero ──
  //
  // R23.2H — this hero previously computed its own priority ladder over
  // /api/v1/personal/morning-brief + /api/v1/my-space and, on the fallback
  // paths, rendered hardcoded fabricated text ("Sarah asked about pricing
  // and delivery timing.", a generic "Pricing and delivery timing need
  // your attention.") that had no connection to real data — a direct
  // UI_FABRICATED_REASON violation. It now only renders the same canonical
  // GET /api/v1/personal/home `rightNow` (RightNowIntelligenceService's
  // deterministic primary item, mapped by PersonalHomeService — the exact
  // same source desktop-home.js's renderRightNowSection() already uses,
  // satisfying "Desktop and Mobile use the same canonical endpoint") plus
  // GET /api/v1/personal/right-now purely to find a real, grounded related-
  // material note for that same primary item. No priority recomputation,
  // no Calendar/Gmail combination, and no relevance judgment happen here
  // (UI_AGGREGATION_LOGIC=0, UI_PRIORITY_LOGIC=0) — this function only maps
  // fields already computed by the backend onto DOM text.
  function unwrapApiData(value) {
    return value && value.data ? value.data : value;
  }

  // Kept for renderPreparedForYou() below only (untouched by R23.2H) —
  // the Right Now Hero itself no longer computes event validity/ordering,
  // that now comes pre-ranked from RightNowIntelligenceService.
  function isEventValidForHero(e) {
    if (!e) return false;
    const startTimeIso = e.start_time || e.start?.dateTime || e.start;
    if (!startTimeIso) return true;
    const eventTime = new Date(startTimeIso).getTime();
    if (isNaN(eventTime)) return true;

    const now = Date.now();
    const endTimeIso = e.end_time || e.end?.dateTime || e.end;
    if (endTimeIso) {
      const endTime = new Date(endTimeIso).getTime();
      if (!isNaN(endTime)) {
        return now <= endTime;
      }
    }

    const diffMinutes = Math.round((eventTime - now) / 60000);
    return diffMinutes >= -30;
  }

  function sortEventsChronologically(eventsList) {
    if (!Array.isArray(eventsList)) return [];
    return [...eventsList].sort((a, b) => {
      const aTime = new Date(a.start_time || a.start?.dateTime || a.start || 0).getTime();
      const bTime = new Date(b.start_time || b.start?.dateTime || b.start || 0).getTime();
      return aTime - bTime;
    });
  }

  // A real Vault/Gmail item is "related" to the primary item only when
  // RightNowIntelligenceService itself already said so (a MEETING_PREP-
  // style suggestion whose sourceRefs include the primary's own
  // sourceRef) — never inferred here.
  function findRelatedNote(rightNow, intel) {
    if (!rightNow || !intel || !Array.isArray(intel.suggestions)) return '';
    const suggestion = intel.suggestions.find(
      (s) => Array.isArray(s.sourceRefs) && s.sourceRefs.some((r) => r && r.id === rightNow.sourceRef)
    );
    return suggestion ? suggestion.reason : '';
  }

  function deriveRightNowHeroInfo(home, intel, isKo) {
    const rightNow = home && home.rightNow;
    if (!rightNow) {
      // Truthful empty state — no invented meeting/task/suggestion.
      return {
        empty: true,
        tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
        emptyText: t('inbox.emptyState', isKo ? '지금은 확인할 항목이 없습니다.' : 'Nothing needs your attention right now.'),
        secondaryCtaText: t('home.askAnything', isKo ? 'NAgex에게 무엇이든 물어보세요' : 'Ask NAgex anything'),
      };
    }

    return {
      empty: false,
      tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
      headline: rightNow.title,
      // rightNow.summary is already the grounded reason text computed by
      // RightNowIntelligenceService (e.g. "Starts in 42 minutes",
      // "Overdue by 5 minutes", "Requires your approval") — rendered as-is.
      body: rightNow.summary,
      relatedNote: findRelatedNote(rightNow, intel),
      primaryCtaText: (rightNow.action && rightNow.action.label) || t('home.reviewAction', isKo ? '검토' : 'Review'),
      primaryCtaAction: () => {
        if (window.NAGEX && window.NAGEX.handleHomeItemAction) {
          window.NAGEX.handleHomeItemAction(rightNow.type, rightNow.sourceRef);
        }
      },
    };
  }

  let heroContextFetching = false;
  let heroHomeData = null;
  // heroBriefData/heroMySpaceData are unrelated to the Right Now Hero — they
  // back renderPreparedForYou() below only (untouched by R23.2H), still
  // fetched alongside in the same batch purely to keep one shared
  // fetch/locale-invalidation cycle rather than two independent ones.
  let heroBriefData = null;
  let heroMySpaceData = null;
  let lastHeroLocale = null;

  async function fetchHeroContext() {
    if (!window.NAGEX || typeof window.NAGEX.apiFetch !== 'function') return;
    try {
      // R23.3 v1.1 — GET /api/v1/personal/home alone now carries
      // rightNow/upcoming/suggestions together (one buildCurrentContext()
      // call server-side) — no separate GET /api/v1/personal/right-now
      // fetch here anymore (CONTEXT_BUILD_COUNT_PER_COMPOSITE_HOME_
      // REQUEST=1).
      const [home, mb, ms] = await Promise.all([
        window.NAGEX.apiFetch('/api/v1/personal/home'),
        window.NAGEX.apiFetch('/api/v1/personal/morning-brief'),
        window.NAGEX.apiFetch('/api/v1/my-space'),
      ]);
      if (home && !home.error) heroHomeData = unwrapApiData(home);
      if (mb && !mb.error) heroBriefData = unwrapApiData(mb);
      if (ms && !ms.error) heroMySpaceData = unwrapApiData(ms);
    } catch (e) {
      // Ignore API fetch errors in offline fallback
    }
  }

  function applyHeroInfoToDOM(info) {
    if (!info) return;
    const heroSection = document.getElementById('mh-right-now-hero');
    const tagEl = document.getElementById('mh-hero-tag');
    const headlineEl = document.getElementById('mh-hero-headline');
    const bodyEl = document.getElementById('mh-hero-body');
    const relatedEl = document.getElementById('mh-hero-related');
    const primaryBtn = document.getElementById('mh-hero-primary-cta');
    const secondaryLink = document.getElementById('mh-hero-secondary-link');

    if (tagEl) tagEl.textContent = info.tag;

    if (info.empty) {
      if (headlineEl) headlineEl.textContent = info.emptyText;
      if (bodyEl) bodyEl.textContent = '';
      if (relatedEl) { relatedEl.hidden = true; relatedEl.textContent = ''; }
      if (primaryBtn) {
        primaryBtn.textContent = info.secondaryCtaText;
        primaryBtn.disabled = false;
        primaryBtn.style.opacity = '';
        primaryBtn.style.pointerEvents = '';
        primaryBtn.onclick = () => {
          const input = document.getElementById('mh-command-input');
          if (input) input.focus();
        };
      }
    } else {
      if (headlineEl) headlineEl.textContent = info.headline;
      if (bodyEl) bodyEl.textContent = info.body;
      if (relatedEl) {
        if (info.relatedNote) {
          relatedEl.hidden = false;
          relatedEl.textContent = info.relatedNote;
        } else {
          relatedEl.hidden = true;
          relatedEl.textContent = '';
        }
      }
      if (primaryBtn) {
        primaryBtn.textContent = info.primaryCtaText;
        primaryBtn.disabled = false;
        primaryBtn.style.opacity = '';
        primaryBtn.style.pointerEvents = '';
        primaryBtn.onclick = (e) => {
          if (typeof info.primaryCtaAction === 'function') info.primaryCtaAction(e);
        };
      }
    }
    if (secondaryLink) secondaryLink.textContent = t('home.viewToday', 'View today');

    if (heroSection) {
      heroSection.setAttribute('aria-busy', 'false');
      heroSection.setAttribute('data-context-ready', 'true');
      heroSection.setAttribute('data-hero-resolved', 'true');
    }
  }

  async function renderRightNowHero() {
    const heroSection = document.getElementById('mh-right-now-hero');
    if (!heroSection) return;

    const currentLocale = window.NAGEX_I18N ? window.NAGEX_I18N.getLocale() : 'en';
    const isKo = currentLocale === 'ko';
    if (lastHeroLocale !== currentLocale) {
      lastHeroLocale = currentLocale;
      heroHomeData = null;
      heroBriefData = null;
      heroMySpaceData = null;
    }

    let info = deriveRightNowHeroInfo(heroHomeData, heroHomeData, isKo);
    applyHeroInfoToDOM(info);

    if (!heroHomeData && !heroContextFetching) {
      heroContextFetching = true;
      await fetchHeroContext();
      heroContextFetching = false;
      info = deriveRightNowHeroInfo(heroHomeData, heroHomeData, isKo);
      applyHeroInfoToDOM(info);
    }

    renderSuggestions();
  }

  // R23.3 v1.1 — "Suggested for you": the canonical ProactiveSuggestion
  // list, embedded in the same GET /api/v1/personal/home response already
  // fetched above (heroHomeData.suggestions) — no separate fetch, no
  // priority/relevance logic here (UI_PRIORITY_LOGIC=0,
  // UI_RELEVANCE_LOGIC=0). Hidden entirely when there are none, never a
  // filler card.
  function renderSuggestions() {
    const section = document.getElementById('mh-section-suggestions');
    const listEl = document.getElementById('mh-suggestions-list');
    if (!section || !listEl) return;

    const primaryId = heroHomeData && heroHomeData.rightNow ? heroHomeData.rightNow.sourceRef : null;
    const items = ((heroHomeData && heroHomeData.suggestions) || [])
      .filter((s) => !(s.sourceRefs && s.sourceRefs.some((r) => r.id === primaryId)))
      .slice(0, 3);

    if (items.length === 0) {
      section.hidden = true;
      listEl.innerHTML = '';
      return;
    }

    section.hidden = false;
    listEl.innerHTML = items.map((s) => `
      <div class="mh-approval-card">
        <div class="mh-approval-body">
          <div class="mh-row-title">${escapeHtml(s.title)}</div>
          <div class="mh-row-detail">${escapeHtml(s.reason)}</div>
          <div class="mh-approval-actions">
            <button class="mh-btn-review" onclick="window.NAGEX.handleHomeItemAction('${escapeHtml((s.sourceRefs && s.sourceRefs[0] && s.sourceRefs[0].type) || '')}', '${escapeHtml((s.sourceRefs && s.sourceRefs[0] && s.sourceRefs[0].id) || '')}')">${escapeHtml((s.action && s.action.label) || 'View')}</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  // ── C. Needs Your Attention — rendered ONLY if items exist ──
  function approvalActionLabel(a) {
    const toolId = String(a.toolId || '').toUpperCase();
    const action = String(a.action || a.intent || '').toLowerCase();
    const tool = String(a.tool || '').toLowerCase();
    if (toolId.includes('CALENDAR_CREATE') || (action.includes('create') && (action.includes('calendar') || action.includes('event') || tool.includes('calendar')))) {
      return t('home.approveAndCreateEvent', 'Approve and create event');
    }
    if (toolId.includes('GMAIL_SEND') || toolId.includes('GMAIL_REPLY') || action.includes('send') || action.includes('email') || tool.includes('gmail')) {
      return t('home.approveAndSend', 'Approve and send');
    }
    if (toolId.includes('CANCEL') || action.includes('delete') || action.includes('cancel')) {
      return t('home.approveAndDelete', 'Approve and delete');
    }
    if (action.includes('submit')) {
      return t('home.approveAndSubmit', 'Approve and submit');
    }
    return t('home.approveGeneric', 'Approve request');
  }

  function renderNeedsYourAttention() {
    if (!window.NAGEX.getState) return 0;
    const state = window.NAGEX.getState();
    const pending = state.approvalsLoadFailed ? [] : (state.approvals || []).filter((a) => a.status === 'PENDING');
    const proposedCandidates = (state.candidates || []).filter((c) => c.status === 'PROPOSED');
    const needsHumanCaptures = (state.inbox || []).filter((i) => i.status === 'NEEDS_REVIEW' && i.metadata?.errorCode === 'BLOCKED_NEEDS_HUMAN');

    const total = pending.length + proposedCandidates.length + needsHumanCaptures.length;
    const approvalsSection = document.getElementById('mh-section-approvals');
    const badge = document.getElementById('mh-approvals-badge');

    // Rule: If no attention required, HIDE the section entirely!
    if (approvalsSection) {
      approvalsSection.hidden = total === 0;
    }
    if (badge) {
      badge.hidden = total === 0;
      badge.textContent = total > 9 ? '9+' : String(total);
    }

    const listEl = document.getElementById('mh-approvals-list');
    if (!listEl || total === 0) return total;

    const items = [
      ...pending.map((a) => ({ kind: 'approval', data: a })),
      ...proposedCandidates.map((c) => ({ kind: 'candidate', data: c })),
      ...needsHumanCaptures.map((i) => ({ kind: 'needs-human', data: i })),
    ].slice(0, 2);

    listEl.innerHTML = items.map((entry) => {
      if (entry.kind === 'approval') {
        const a = entry.data;
        const title = a.intent || a.action || t('home.approvalRequiredFallback', 'Ready for review');
        const detail = a.resource?.id || t('home.actionApprovalFallback', 'Review the details');
        return `<div class="mh-approval-card">
          <div class="mh-row-icon mh-row-icon-danger">
            <svg class="svg-icon-sm" viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
          </div>
          <div class="mh-approval-body">
            <div class="mh-row-title">${escapeHtml(title)}</div>
            <div class="mh-row-detail">${escapeHtml(detail)}</div>
            <div class="mh-approval-actions">
              <button class="mh-btn-approve" onclick="window.NAGEX.handleApprovalAction('${a.id || a.approvalId}', 'APPROVE', event)">${escapeHtml(approvalActionLabel(a))}</button>
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
      const title = i.metadata?.extractedTitle || i.content || t('home.pageFallback', 'A page');
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
    return total;
  }

  // ── D. Prepared For You ──
  function renderPreparedForYou() {
    const listEl = document.getElementById('mh-prepared-list');
    if (!listEl) return;

    const brief = unwrapApiData(heroBriefData);
    const mySpace = unwrapApiData(heroMySpaceData);
    const rec = brief?.recommendation;
    const rawEvents = (brief?.schedule_summary?.events) || (mySpace?.calendar) || [];
    const events = sortEventsChronologically(rawEvents);

    let meetingTarget = null;
    if (rec && rec.target_id) {
      meetingTarget = events.find((e) => (e.id || e.event_id) === rec.target_id);
    }
    if (!meetingTarget && rec && rec.action_type === 'MEETING_PREP') {
      meetingTarget = events.find((e) => e.id || e.event_id);
    }
    if (!meetingTarget && events.length > 0) {
      const validEv = events.find(isEventValidForHero);
      if (validEv) meetingTarget = validEv;
    }

    const cards = [];

    // Meeting brief card — only when a real target event/recommendation exists with a valid target_id
    if (meetingTarget && (meetingTarget.id || meetingTarget.event_id || rec?.target_id)) {
      const targetId = rec?.target_id || meetingTarget.id || meetingTarget.event_id;
      const title = meetingTarget.title || meetingTarget.summary || rec?.title || t('home.meetingBriefTitle', 'Client meeting brief');
      const desc = rec?.reason || meetingTarget.description || t('home.meetingBriefDesc', 'Meeting notes and key context prepared.');

      cards.push({
        title,
        desc,
        action: t('home.openAction', 'Open'),
        onClick: `if(window.NAGEX_MEETING_PREP)window.NAGEX_MEETING_PREP.open('${targetId}')`
      });
    }

    // Research Plan card — only when an actual prepared research plan/result state exists in window.NAGEX.getState()
    const state = window.NAGEX.getState ? window.NAGEX.getState() : {};
    const hasResearchPlan = Boolean(state.researchPlan || state.researchResult || state.ambientResearch);
    if (hasResearchPlan) {
      cards.push({
        title: t('home.researchPlanTitle', 'Research plan'),
        desc: state.researchPlan?.title || t('home.researchPlanDesc', 'Research plan is ready for review.'),
        action: t('home.reviewPlanAction', 'Review plan'),
        onClick: "if(window.NAGEX&&window.NAGEX.openAmbientOverlay)window.NAGEX.openAmbientOverlay()"
      });
    }

    if (cards.length === 0) {
      const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
      listEl.innerHTML = `<div class="mh-prepared-empty">${escapeHtml(isKo ? '준비된 항목이 없습니다' : 'No prepared items right now')}</div>`;
      return;
    }

    listEl.innerHTML = cards.map((c) => `
      <div class="mh-prepared-card">
        <div class="mh-prepared-body">
          <div class="mh-row-title">${escapeHtml(c.title)}</div>
          <div class="mh-row-detail">${escapeHtml(c.desc)}</div>
        </div>
        <button class="mh-btn-review" onclick="${c.onClick}">${escapeHtml(c.action)}</button>
      </div>
    `).join('');
  }

  // ── E. Today — Compact schedule derived from normalized /api/v1/my-space ──
  async function renderToday() {
    const listEl = document.getElementById('mh-today-list');
    if (!listEl || !window.NAGEX.apiFetch) return;

    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    let rawData = null;
    try {
      rawData = await window.NAGEX.apiFetch('/api/v1/my-space');
    } catch (err) {
      rawData = null;
    }

    const data = unwrapApiData(rawData);
    const events = (data && Array.isArray(data.calendar)) ? data.calendar : (data?.schedule_summary?.events || []);

    if (!rawData || (rawData.error && !events.length)) {
      listEl.innerHTML = `<div class="mh-today-empty">${escapeHtml(isKo ? '일정을 불러올 수 없습니다' : "Couldn't load today's schedule")}</div>`;
      return;
    }

    if (events.length === 0) {
      listEl.innerHTML = `<div class="mh-today-empty">${escapeHtml(isKo ? '오늘 남은 일정이 없습니다' : 'No more events today')}</div>`;
      return;
    }

    // Time-based next event selection
    const now = Date.now();
    let nextEventIndex = -1;

    // 1. Check for active current event (start <= now <= end)
    nextEventIndex = events.findIndex((ev) => {
      const startTime = new Date(ev.start_time || ev.start?.dateTime || ev.start || 0).getTime();
      const endTime = new Date(ev.end_time || ev.end?.dateTime || ev.end || 0).getTime();
      return startTime && endTime && now >= startTime && now <= endTime;
    });

    // 2. If no active current event, find earliest future event (start >= now)
    if (nextEventIndex === -1) {
      nextEventIndex = events.findIndex((ev) => {
        const startTime = new Date(ev.start_time || ev.start?.dateTime || ev.start || 0).getTime();
        return startTime && startTime >= now;
      });
    }

    const items = events.slice(0, 4).map((ev, idx) => {
      const startRaw = ev.start_time || ev.start?.dateTime || ev.start;
      const timeStr = startRaw ? new Date(startRaw).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return {
        time: timeStr || '09:00',
        title: ev.title || ev.summary || (isKo ? '미팅' : 'Meeting'),
        isNext: idx === nextEventIndex
      };
    });

    listEl.innerHTML = `<div class="mh-today-timeline">${items.map((r) => `
      <div class="mh-today-row ${r.isNext ? 'mh-today-row-next' : ''}">
        <span class="mh-today-time">${escapeHtml(r.time)}</span>
        <div class="mh-today-body">
          <span class="mh-today-title">${escapeHtml(r.title)}</span>
          ${r.isNext ? `<span class="mh-today-next-badge">${escapeHtml(t('home.nextBadge', 'Next'))}</span>` : ''}
        </div>
      </div>`).join('')}</div>`;
  }

  // ── F. Ask NAgex Composer ──
  let mhMediaRecorder = null;
  let mhAudioChunks = [];

  function initCommandBar() {
    const input = document.getElementById('mh-command-input');
    const sendBtn = document.getElementById('mh-command-send');
    const voiceBtn = document.getElementById('mh-voice-btn');
    const addBtn = document.getElementById('mh-add-btn');

    if (input) {
      input.placeholder = t('home.askPlaceholder', 'Ask NAgex anything…');
    }

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

    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => {
        if (input) input.focus();
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

  function renderMobileHome() {
    if (!document.getElementById('mobile-app-shell')) return;
    initCommandBar();
    initLangToggle();
    renderHeader();
    renderRightNowHero();
    renderNeedsYourAttention();
    renderPreparedForYou();
    renderToday();
  }

  function init() {
    window.NAGEX = window.NAGEX || {};
    window.NAGEX.deriveRightNowHeroInfo = deriveRightNowHeroInfo;
    window.NAGEX.onHomeRenderMobile = () => { if (isMobileViewport() && activeNativeTab() === 'tab-home') renderMobileHome(); };
    window.NAGEX.onTabChange = updateShellVisibility;
    window.NAGEX.bindMobileLangToggle = bindLangToggle;
    window.NAGEX.scrollToToday = () => {
      const todaySection = document.getElementById('mh-section-today');
      if (todaySection) todaySection.scrollIntoView({ behavior: 'smooth' });
    };
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', updateShellVisibility);
      else if (mq.addListener) mq.addListener(updateShellVisibility);
    }
    updateShellVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
