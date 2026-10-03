// NAgex Mobile Home ??Personal AI Decision + Next Action Surface (R22.1)
(function () {
  'use strict';

  const mq = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function t(key, fallback) {
    return (window.NAGEX_I18N ? window.NAGEX_I18N.t(key) : null) || fallback || key;
  }

  const MOBILE_NATIVE_TABS = new Set(['tab-home', 'tab-inbox', 'tab-executions', 'tab-vault', 'tab-settings', 'tab-canvas', 'tab-knowledge']);

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
    const viewCanvas = document.getElementById('mobile-view-canvas');
    const viewKnowledge = document.getElementById('mobile-view-knowledge');
    if (viewHome) viewHome.hidden = nativeTab !== 'tab-home';
    if (viewInbox) viewInbox.hidden = nativeTab !== 'tab-inbox';
    if (viewActivity) viewActivity.hidden = nativeTab !== 'tab-executions';
    if (viewVault) viewVault.hidden = nativeTab !== 'tab-vault';
    if (viewSettings) viewSettings.hidden = nativeTab !== 'tab-settings';
    if (viewCanvas) viewCanvas.hidden = nativeTab !== 'tab-canvas';
    if (viewKnowledge) viewKnowledge.hidden = nativeTab !== 'tab-knowledge';

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
    } else if (nativeTab === 'tab-knowledge' && typeof window.NAGEX.renderMobileKnowledge === 'function') {
      window.NAGEX.renderMobileKnowledge();
    }
  }

  // ?? A. Header ??real local time-of-day only, never a fabricated name
  // (R23.7H-C Phase D.2 짠12: this used to hardcode a mock sample name
  // regardless of who was actually signed in ??desktop's renderGreeting()
  // already got this right with an explicit "never a fabricated name"
  // comment; this brings mobile in line with it rather than plumbing a
  // name through). ??
  function renderHeader() {
    const greetingEl = document.getElementById('mh-greeting-small');
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    if (greetingEl) {
      greetingEl.textContent = isKo ? '안녕하세요' : `Good ${timeOfDay}`;
    }

    // Matches desktop's own generic "U" placeholder (index.html's
    // .user-avatar-img) ??desktop doesn't derive a real initial either,
    // so mobile shouldn't invent one from a name it doesn't truthfully have.
    const avatarEl = document.getElementById('mh-avatar');
    if (avatarEl) avatarEl.textContent = 'U';

    const dot = document.getElementById('mh-notif-dot');
    if (dot && window.NAGEX.getState) {
      const notif = window.NAGEX.getState().notifications || { unreadCount: 0 };
      dot.hidden = !(notif.unreadCount > 0);
    }
  }

  // ?? B. Right Now Hero ??
  //
  // R23.2H ??this hero previously computed its own priority ladder over
  // /api/v1/personal/morning-brief + /api/v1/my-space and, on the fallback
  // paths, rendered hardcoded fabricated text ("Sarah asked about pricing
  // and delivery timing.", a generic "Pricing and delivery timing need
  // your attention.") that had no connection to real data ??a direct
  // UI_FABRICATED_REASON violation. It now only renders the same canonical
  // GET /api/v1/personal/home `rightNow` (RightNowIntelligenceService's
  // deterministic primary item, mapped by PersonalHomeService ??the exact
  // same source desktop-home.js's renderRightNowSection() already uses,
  // satisfying "Desktop and Mobile use the same canonical endpoint") plus
  // GET /api/v1/personal/right-now purely to find a real, grounded related-
  // material note for that same primary item. No priority recomputation,
  // no Calendar/Gmail combination, and no relevance judgment happen here
  // (UI_AGGREGATION_LOGIC=0, UI_PRIORITY_LOGIC=0) ??this function only maps
  // fields already computed by the backend onto DOM text.
  function getOrCreateContinueSection() {
    let target = document.getElementById('mh-section-continue');
    if (target) return target;
    const createSection = document.getElementById('mh-section-create');
    if (!createSection || !createSection.parentNode) return null;
    target = document.createElement('section');
    target.className = 'mh-card';
    target.id = 'mh-section-continue';
    target.setAttribute('aria-live', 'polite');
    target.hidden = true;
    createSection.insertAdjacentElement('afterend', target);
    return target;
  }

  function renderContinueSection(model) {
    const target = getOrCreateContinueSection();
    if (!target) return;
    const recent = (model.recentCreations || []).find((item) => item.artifactProjection && (item.artifactProjection.previewKind === 'IMAGE' || item.artifactProjection.previewKind === 'TEXT'));
    if (!recent || !window.NAGEX.renderArtifactThumbnail) {
      target.hidden = true;
      target.innerHTML = '';
      return;
    }
    target.hidden = false;
    const proj = recent.artifactProjection;
    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    const heading = isKo ? '이어서 작업하기' : 'Continue working';
    const thumbHtml = window.NAGEX.renderArtifactThumbnail(proj) || '';
    target.innerHTML = `
      <div class="mh-card-header"><h2>${escapeHtml(heading)}</h2></div>
      <button type="button" class="mh-continue-card" id="mh-continue-open-btn" aria-label="${escapeHtml(heading)}: ${escapeHtml(proj.title || '')}">
        ${thumbHtml}
        <span class="mh-continue-copy">
          <span class="mh-continue-type">${escapeHtml(proj.artifactType || '')}</span>
          <strong class="mh-continue-title">${escapeHtml(proj.title || '')}</strong>
        </span>
        <svg class="svg-icon-sm mh-continue-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </button>
    `;
    const btn = document.getElementById('mh-continue-open-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        window.NAGEX.dispatchArtifactOpen(proj.artifactType, recent.sourceRef, recent);
      });
    }
  }

  // ?? E3. Intelligence (R23.7H-C M4) ??Needs Attention + Today combined
  // under one compact section, Right Now removed from display. #mh-
  // section-approvals/#mh-section-today are REAL, already-rendered
  // elements (personal-home-view.js's shared renderMobile()/
  // renderSection() populates them every cycle with real data) ??this
  // only MOVES those two existing nodes into one new wrapper the first
  // time it runs; it never recreates, forks, or re-renders their
  // content. Subsequent calls are no-ops (moveIntelligenceChildrenOnce
  // guards against re-moving on every render). No index.html change ??
  // same dynamic-creation pattern as M3's Continue section. ??
  let intelligenceChildrenMoved = false;
  function getOrCreateIntelligenceSection() {
    let wrapper = document.getElementById('mh-section-intelligence');
    const attention = document.getElementById('mh-section-approvals');
    const today = document.getElementById('mh-section-today');
    if (!attention || !today) return null;
    if (wrapper) {
      if (!intelligenceChildrenMoved) {
        wrapper.appendChild(attention);
        wrapper.appendChild(today);
        intelligenceChildrenMoved = true;
      }
      return wrapper;
    }
    const continueSection = document.getElementById('mh-section-continue') || document.getElementById('mh-section-create');
    if (!continueSection || !continueSection.parentNode) return null;

    wrapper = document.createElement('section');
    wrapper.className = 'mh-card mh-intelligence-wrapper';
    wrapper.id = 'mh-section-intelligence';

    const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
    const heading = document.createElement('div');
    heading.className = 'mh-intelligence-heading';
    heading.innerHTML = `<h2>${escapeHtml(isKo ? '지금 중요한 일' : 'What matters now')}</h2>`;
    wrapper.appendChild(heading);

    attention.classList.add('mh-intelligence-sub');
    today.classList.add('mh-intelligence-sub');
    wrapper.appendChild(attention);
    wrapper.appendChild(today);
    intelligenceChildrenMoved = true;

    continueSection.insertAdjacentElement('afterend', wrapper);
    return wrapper;
  }

  // R23.7H-C M4.1 ??corrected empty-state rule. The shared renderSection()
  // (personal-home-view.js, untouched) already distinguishes EMPTY from
  // ERROR for Today on its own, without any change here:
  //   - genuinely no meetings + calendar connection fine ??todayItems=[]
  //     ??renderSection hides #mh-section-today entirely (today.hidden
  //     = true) ??real EMPTY semantics, already built in.
  //   - calendar connection failed (sourceStatus.calendar==='UNAVAILABLE')
  //     ??a real synthetic "This source is currently unavailable" item is
  //     pushed so items.length>0 ??renderSection keeps the section
  //     visible (today.hidden = false) ??real ERROR semantics, already
  //     built in, never conflated with empty.
  // Needs Attention already hides itself the same way when empty.
  // So the wrapper's own visibility is simply the AND of both children's
  // already-correct hidden states ??no new empty/error logic invented,
  // no backend/runtime/shared-renderer change, just reading the real
  // state renderSection() already computed this cycle.
  function syncIntelligenceSection() {
    const wrapper = getOrCreateIntelligenceSection();
    if (!wrapper) return;
    const attention = document.getElementById('mh-section-approvals');
    const today = document.getElementById('mh-section-today');
    wrapper.hidden = Boolean(attention && attention.hidden) && Boolean(today && today.hidden);
    const headingEl = wrapper.querySelector('.mh-intelligence-heading h2');
    if (headingEl) {
      const isKo = window.NAGEX_I18N && window.NAGEX_I18N.getLocale() === 'ko';
      headingEl.textContent = isKo ? '지금 중요한 일' : 'What matters now';
    }
  }

  // ?? F. Ask NAgex Composer ??
  let mhMediaRecorder = null;
  let mhAudioChunks = [];

  function initCommandBar() {
    const input = document.getElementById('mh-command-input');
    const sendBtn = document.getElementById('mh-command-send');
    const voiceBtn = document.getElementById('mh-voice-btn');
    const addBtn = document.getElementById('mh-add-btn');

    if (input) {
      input.placeholder = t('home.askPlaceholder', 'Ask NAgex anything...');
    }

    if (sendBtn && input && !sendBtn.dataset.bound) {
      sendBtn.dataset.bound = '1';
      const send = async () => {
        const text = input.value.trim();
        if (!text) return;
        if (input.dataset.creationMode === 'RESEARCH' && window.NAGEX_PERSONAL_HOME) {
          const result = await window.NAGEX_PERSONAL_HOME.submitResearch(text);
          // R24.8B — a failed research request is explained (it used to fail silently); the text stays for a retry.
          const failure = window.NAGEX_PERSONAL_HOME.explainCreationFailure('RESEARCH', result);
          if (failure) { window.alert(failure); return; }
          input.value = '';
          delete input.dataset.creationMode;
          return;
        }
        // R24.8B — the REPORT tile sets this mode; it used to be ignored here (the request fell through to general Ask).
        if (input.dataset.creationMode === 'REPORT' && window.NAGEX_PERSONAL_HOME) {
          const result = await window.NAGEX_PERSONAL_HOME.submitReport(text);
          const failure = window.NAGEX_PERSONAL_HOME.explainCreationFailure('REPORT', result);
          if (failure) { window.alert(failure); return; }
          input.value = '';
          delete input.dataset.creationMode;
          return;
        }
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

  async function renderMobileHome() {
    if (!document.getElementById('mobile-app-shell')) return;
    initCommandBar();
    initLangToggle();
    renderHeader();
    if (!window.NAGEX_PERSONAL_HOME) return;
    const model = await window.NAGEX_PERSONAL_HOME.fetchHome();
    window.NAGEX_PERSONAL_HOME.renderMobile(model);
    renderContinueSection(model);
    syncIntelligenceSection();
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
