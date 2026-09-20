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

  function formatHeroHeadline(title, startTimeIso, isKo, endTimeIso) {
    let baseTitle = title || (isKo ? '클라이언트 미팅' : 'Client meeting');

    if (!startTimeIso) {
      return baseTitle;
    }

    const eventTime = new Date(startTimeIso).getTime();
    if (isNaN(eventTime)) return baseTitle;

    const now = Date.now();
    const diffMinutes = Math.round((eventTime - now) / 60000);

    if (diffMinutes > 60) {
      const timeStrRaw = new Date(startTimeIso).toLocaleTimeString(isKo ? 'ko-KR' : 'en-US', {
        hour: 'numeric',
        minute: '2-digit'
      });
      if (isKo) {
        const timeStr = timeStrRaw.replace(':00', '시');
        return `${timeStr} ${baseTitle}`;
      } else {
        return `${baseTitle} at ${timeStrRaw}`;
      }
    } else if (diffMinutes > 0) {
      if (isKo) {
        return `${diffMinutes}분 후 ${baseTitle}`;
      } else {
        return `${baseTitle} in ${diffMinutes} min`;
      }
    } else {
      let isNow = false;
      if (endTimeIso) {
        const endTime = new Date(endTimeIso).getTime();
        if (!isNaN(endTime)) {
          isNow = now >= eventTime && now <= endTime;
        }
      }
      if (!endTimeIso || isNaN(new Date(endTimeIso).getTime())) {
        isNow = diffMinutes >= -30;
      }

      if (isNow) {
        if (isKo) {
          return `${baseTitle} 진행 중`;
        } else {
          return `${baseTitle} now`;
        }
      } else {
        return baseTitle;
      }
    }
  }

  function unwrapApiData(value) {
    return value && value.data ? value.data : value;
  }

  function hasUsableHeroContext(rawBrief, rawMySpace) {
    const brief = unwrapApiData(rawBrief);
    const mySpace = unwrapApiData(rawMySpace);
    return Boolean(
      brief?.recommendation ||
      brief?.schedule_summary?.events?.length ||
      mySpace?.calendar?.length
    );
  }

  function sortEventsChronologically(eventsList) {
    if (!Array.isArray(eventsList)) return [];
    return [...eventsList].sort((a, b) => {
      const aTime = new Date(a.start_time || a.start?.dateTime || a.start || 0).getTime();
      const bTime = new Date(b.start_time || b.start?.dateTime || b.start || 0).getTime();
      return aTime - bTime;
    });
  }

  function deriveRightNowHeroInfo(rawMorningBrief, rawMySpaceData, state) {
    const morningBrief = unwrapApiData(rawMorningBrief);
    const mySpaceData = unwrapApiData(rawMySpaceData);
    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';

    // A. Personal Morning Brief recommendation
    const rec = morningBrief && morningBrief.recommendation;
    const rawEvents = (morningBrief && morningBrief.schedule_summary && morningBrief.schedule_summary.events)
                   || (mySpaceData && mySpaceData.calendar)
                   || [];
    const events = sortEventsChronologically(rawEvents);

    let targetEvent = null;
    if (rec && rec.target_id) {
      targetEvent = events.find((e) => (e.id || e.event_id) === rec.target_id);
    }
    if (!targetEvent && rec && rec.title) {
      targetEvent = events.find((e) => {
        const et = e.title || e.summary || '';
        return et && rec.title.includes(et);
      });
    }
    let recommendationUsable = Boolean(rec);
    if (rec && rec.action_type === 'MEETING_PREP' && rec.target_id) {
      recommendationUsable = Boolean(targetEvent && isEventValidForHero(targetEvent));
    } else if (rec && rec.target_id) {
      const recTargetEvent = events.find((e) => (e.id || e.event_id) === rec.target_id);
      if (recTargetEvent && !isEventValidForHero(recTargetEvent)) {
        recommendationUsable = false;
      }
    }

    if (targetEvent && !isEventValidForHero(targetEvent)) {
      targetEvent = null;
    }
    if (!targetEvent && events.length > 0) {
      targetEvent = events.find((e) => isEventValidForHero(e)) || null;
    }

    if (recommendationUsable || targetEvent) {
      const effectiveRec = recommendationUsable ? rec : null;

      let rawTitle = (targetEvent && (targetEvent.title || targetEvent.summary))
                  || (effectiveRec && effectiveRec.title)
                  || (isKo ? '클라이언트 미팅' : 'Client meeting');
      rawTitle = rawTitle.replace(/\s*·\s*.*$/, '').trim();

      const startTimeIso = targetEvent ? (targetEvent.start_time || targetEvent.start?.dateTime || targetEvent.start) : null;
      const endTimeIso = targetEvent ? (targetEvent.end_time || targetEvent.end?.dateTime || targetEvent.end) : null;
      const headline = formatHeroHeadline(rawTitle, startTimeIso, isKo, endTimeIso);

      let body = (effectiveRec && effectiveRec.reason) || (targetEvent && targetEvent.description) || '';
      if (!body && targetEvent) {
        const attendees = targetEvent.attendees || [];
        const hasSarah = attendees.some((a) => String(a).toLowerCase().includes('sarah'));
        if (hasSarah) {
          body = isKo ? 'Sarah가 가격 정책 및 일정 조율을 요청했습니다.' : 'Sarah asked about pricing and delivery timing.';
        } else {
          body = isKo ? '가격 정책 및 일정 조율 검토가 필요합니다.' : 'Pricing and delivery timing need your attention.';
        }
      }

      const actionType = (effectiveRec && effectiveRec.action_type) || (targetEvent ? 'MEETING_PREP' : 'GENERIC');
      const targetId = (effectiveRec && effectiveRec.target_id) || (targetEvent && (targetEvent.id || targetEvent.event_id)) || 'demo_evt_client';

      return {
        tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
        headline,
        body,
        actionType,
        targetId,
        primaryCtaText: actionType === 'MEETING_PREP'
          ? t('home.prepareMe', isKo ? '미팅 준비' : 'Prepare me')
          : t('home.reviewAction', isKo ? '검토' : 'Review'),
        primaryCtaAction: () => {
          if (actionType === 'MEETING_PREP' && window.NAGEX_MEETING_PREP) {
            window.NAGEX_MEETING_PREP.open(targetId);
          } else if (window.NAGEX && window.NAGEX.switchTab) {
            window.NAGEX.switchTab('tab-inbox');
          }
        }
      };
    }

    // B. Upcoming Calendar Event (without recommendation)
    const validUpcomingEvents = events.filter(isEventValidForHero);
    if (validUpcomingEvents.length > 0) {
      const ev = validUpcomingEvents[0];
      const rawTitle = ev.title || ev.summary || (isKo ? '미팅' : 'Meeting');
      const startTimeIso = ev.start_time || ev.start?.dateTime || ev.start;
      const endTimeIso = ev.end_time || ev.end?.dateTime || ev.end;
      const headline = formatHeroHeadline(rawTitle, startTimeIso, isKo, endTimeIso);
      const actionType = 'MEETING_PREP';
      const targetId = ev.id || ev.event_id || 'demo_evt_client';

      return {
        tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
        headline,
        body: ev.description || (isKo ? '가격 정책 및 일정 조율 검토가 필요합니다.' : 'Pricing and delivery timing need your attention.'),
        actionType,
        targetId,
        primaryCtaText: t('home.prepareMe', isKo ? '미팅 준비' : 'Prepare me'),
        primaryCtaAction: () => {
          if (window.NAGEX_MEETING_PREP) window.NAGEX_MEETING_PREP.open(targetId);
        }
      };
    }

    // C. Notification / Approval requiring attention
    const pendingApprovals = (state && state.approvals ? state.approvals : []).filter((a) => a.status === 'PENDING');
    if (pendingApprovals.length > 0) {
      const app = pendingApprovals[0];
      return {
        tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
        headline: app.intent || app.action || (isKo ? '승인 대기 항목이 있습니다' : 'Approval required'),
        body: app.resource?.id || (isKo ? '요청 내용을 검토하고 승인하세요.' : 'Review and approve this pending request.'),
        actionType: 'APPROVAL_REQUIRED',
        targetId: app.id,
        primaryCtaText: t('home.reviewAction', isKo ? '검토' : 'Review'),
        primaryCtaAction: () => {
          if (window.NAGEX && window.NAGEX.switchTab) window.NAGEX.switchTab('tab-approvals');
        }
      };
    }

    // D. Task/deadline
    const activeTasks = (state && state.tasks ? state.tasks : []).filter((t) => t.status === 'ACTIVE');
    if (activeTasks.length > 0) {
      const task = activeTasks[0];
      return {
        tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
        headline: task.name || task.objective || (isKo ? '진행 중인 작업' : 'Active task'),
        body: task.objective || (isKo ? '작업이 진행 중입니다.' : 'Task is currently active.'),
        actionType: 'TASK_DUE',
        targetId: task.taskId || task.id,
        primaryCtaText: t('mobileActivity.viewTask', isKo ? '할 일 보기' : 'View task'),
        primaryCtaAction: () => {
          if (window.NAGEX && window.NAGEX.switchTab) window.NAGEX.switchTab('tab-executions');
        }
      };
    }

    // E. Fallback only when demo data truly unavailable
    return {
      tag: t('home.rightNow', isKo ? '지금 가장 중요한 일' : 'Right now'),
      headline: isKo ? '예정된 일정이 없습니다' : 'No upcoming events',
      body: isKo ? '새로운 요청이나 일정을 NAgex에 말해보세요.' : 'Ask NAgex to schedule or prepare work for you.',
      actionType: 'NONE',
      targetId: null,
      primaryCtaText: t('home.prepareMe', isKo ? '미팅 준비' : 'Prepare me'),
      primaryCtaAction: () => {
        const input = document.getElementById('mh-command-input');
        if (input) input.focus();
      }
    };
  }

  let heroContextFetching = false;
  let heroBriefData = null;
  let heroMySpaceData = null;
  let lastHeroLocale = null;

  async function fetchHeroContext() {
    if (!window.NAGEX || typeof window.NAGEX.apiFetch !== 'function') return;
    try {
      const [mb, ms] = await Promise.all([
        window.NAGEX.apiFetch('/api/v1/personal/morning-brief'),
        window.NAGEX.apiFetch('/api/v1/my-space')
      ]);
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
    const primaryBtn = document.getElementById('mh-hero-primary-cta');
    const secondaryLink = document.getElementById('mh-hero-secondary-link');

    if (tagEl) tagEl.textContent = info.tag;
    if (headlineEl) headlineEl.textContent = info.headline;
    if (bodyEl) bodyEl.textContent = info.body;
    if (primaryBtn) {
      primaryBtn.textContent = info.primaryCtaText;
      primaryBtn.disabled = false;
      primaryBtn.style.opacity = '';
      primaryBtn.style.pointerEvents = '';
      primaryBtn.onclick = (e) => {
        if (typeof info.primaryCtaAction === 'function') info.primaryCtaAction(e);
      };
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
    if (lastHeroLocale !== currentLocale) {
      lastHeroLocale = currentLocale;
      heroBriefData = null;
      heroMySpaceData = null;
    }

    const state = window.NAGEX.getState ? window.NAGEX.getState() : {};

    let info = deriveRightNowHeroInfo(heroBriefData, heroMySpaceData, state);
    applyHeroInfoToDOM(info);

    if (!heroBriefData && !heroContextFetching) {
      heroContextFetching = true;
      await fetchHeroContext();
      heroContextFetching = false;
      info = deriveRightNowHeroInfo(heroBriefData, heroMySpaceData, state);
      applyHeroInfoToDOM(info);
    }
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
    window.NAGEX.formatHeroHeadline = formatHeroHeadline;
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
