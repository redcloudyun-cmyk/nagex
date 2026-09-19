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
  function renderRightNowHero() {
    const heroSection = document.getElementById('mh-right-now-hero');
    if (!heroSection) return;

    const tagEl = document.getElementById('mh-hero-tag');
    const headlineEl = document.getElementById('mh-hero-headline');
    const bodyEl = document.getElementById('mh-hero-body');
    const primaryBtn = document.getElementById('mh-hero-primary-cta');
    const secondaryLink = document.getElementById('mh-hero-secondary-link');

    if (tagEl) tagEl.textContent = t('home.rightNow', 'Right now');
    if (headlineEl) headlineEl.textContent = t('home.rightNowHeroTitle', 'Client meeting in 42 min');
    if (bodyEl) bodyEl.textContent = t('home.rightNowHeroDesc', 'Sarah asked about pricing and delivery timing.');
    if (primaryBtn) primaryBtn.textContent = t('home.prepareMe', 'Prepare me');
    if (secondaryLink) secondaryLink.textContent = t('home.viewToday', 'View today');
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

    const cards = [
      {
        title: t('home.meetingBriefTitle', 'Client meeting brief'),
        desc: t('home.meetingBriefDesc', "Last meeting notes, Proposal v3 and Sarah's latest email are ready."),
        action: t('home.openAction', 'Open'),
        onClick: "if(window.NAGEX_MEETING_PREP)window.NAGEX_MEETING_PREP.open('evt_demo_client_strategy')"
      },
      {
        title: t('home.researchPlanTitle', 'Research plan'),
        desc: t('home.researchPlanDesc', "I've prepared how to investigate the latest AI-agent architecture."),
        action: t('home.reviewPlanAction', 'Review plan'),
        onClick: "if(window.NAGEX&&window.NAGEX.openAmbientOverlay)window.NAGEX.openAmbientOverlay()"
      }
    ];

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

  // ── E. Today — Compact schedule (3-4 items, next item highlighted) ──
  let mySpaceFetched = false;
  async function renderToday() {
    const listEl = document.getElementById('mh-today-list');
    if (!listEl || !window.NAGEX.apiFetch || !window.NAGEX.getState) return;

    const state = window.NAGEX.getState();
    let data = null;
    if (!mySpaceFetched) {
      mySpaceFetched = true;
      data = await window.NAGEX.apiFetch('/api/v1/my-space');
    }

    const items = [];
    if (data && Array.isArray(data.calendar) && data.calendar.length > 0) {
      data.calendar.slice(0, 4).forEach((ev, idx) => {
        const timeStr = ev.start ? new Date(ev.start.dateTime || ev.start.date || ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        items.push({
          time: timeStr || (idx === 0 ? '09:00' : idx === 1 ? '11:30' : '15:00'),
          title: ev.summary || ev.title || 'Meeting',
          isNext: idx === 2 || String(ev.summary || '').includes('Client strategy'),
        });
      });
    }

    if (items.length === 0) {
      const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
      items.push(
        { time: '09:00', title: isKo ? 'Q3 보고서 검토' : 'Review Q3 report', isNext: false },
        { time: '11:30', title: isKo ? '제품 리서치 동기화' : 'Product research sync', isNext: false },
        { time: '15:00', title: isKo ? '클라이언트 전략 미팅' : 'Client strategy meeting', isNext: true }
      );
    }

    listEl.innerHTML = `<div class="mh-today-timeline">${items.slice(0, 4).map((r) => `
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
