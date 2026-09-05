document.addEventListener('DOMContentLoaded', () => {
  const i18n = window.AGEX_I18N;
  if (i18n) i18n.applyLocale();

  const btnRun = document.getElementById('btn-run-task');
  const promptInput = document.getElementById('prompt-input');

  // ─── Language Toggle ───
  const btnLangToggle = document.getElementById('btn-lang-toggle');
  if (btnLangToggle && i18n) {
    btnLangToggle.addEventListener('click', () => {
      i18n.toggleLocale();
    });
  }

  // ─── Manus Style Profile Trigger & Popover Menu ───
  const userProfileTrigger = document.getElementById('user-profile-trigger');
  const manusPopover = document.getElementById('manus-popover');

  if (userProfileTrigger && manusPopover) {
    userProfileTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = manusPopover.style.display === 'block';
      manusPopover.style.display = isVisible ? 'none' : 'block';
    });

    document.addEventListener('click', () => {
      manusPopover.style.display = 'none';
    });

    manusPopover.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // ─── Output Format Picker (chat / document / image / slides / video / code) ───
  // Lets the user pick what deliverable they want back before running a
  // task, instead of only ever getting a plain chat reply.
  const formatChipGroup = document.getElementById('format-chip-group');
  let selectedOutputFormat = 'chat';
  if (formatChipGroup) {
    formatChipGroup.querySelectorAll('.format-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        formatChipGroup.querySelectorAll('.format-chip').forEach((c) => {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        selectedOutputFormat = chip.getAttribute('data-format');
      });
    });
  }

  function resetOutputFormat() {
    if (!formatChipGroup) return;
    selectedOutputFormat = 'chat';
    formatChipGroup.querySelectorAll('.format-chip').forEach((c) => {
      const isChat = c.getAttribute('data-format') === 'chat';
      c.classList.toggle('active', isChat);
      c.setAttribute('aria-pressed', String(isChat));
    });
  }

  // ─── Session View: chat thread (left) + working canvas (right) ───
  // Reuses appendChatMessage/showTypingIndicator (defined further below,
  // hoisted since they're function declarations) with an explicit container
  // so this doesn't duplicate the AI Customer Support chat's rendering code.
  const FORMAT_ICONS = {
    chat: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4-4H3c-.55 0-1 .45-1 1v14l4-4h11c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1z"/></svg>',
    document: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
    image: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
    slides: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M2 3h20v14H2V3zm2 2v10h16V5H4zm4 3l6 4-6 4V8z"/></svg>',
    video: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
    code: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
  };
  const FORMAT_I18N_KEY = {
    chat: 'format.chat', document: 'format.document', image: 'format.image',
    slides: 'format.slides', video: 'format.video', code: 'format.code',
  };

  const workspaceHome = document.getElementById('workspace-home');
  const workspaceSession = document.getElementById('workspace-session');
  const sessionShell = document.querySelector('.session-shell');
  const sessionChatMessages = document.getElementById('session-chat-messages');
  const sessionChatInput = document.getElementById('session-chat-input');
  const sessionCanvasIcon = document.getElementById('session-canvas-icon');
  const sessionCanvasTitle = document.getElementById('session-canvas-title');

  function enterSessionView(taskText, format) {
    if (!workspaceHome || !workspaceSession) return;
    workspaceHome.style.display = 'none';
    workspaceSession.style.display = 'flex';
    if (sessionShell) sessionShell.classList.remove('show-canvas');

    if (sessionCanvasIcon) sessionCanvasIcon.innerHTML = FORMAT_ICONS[format] || FORMAT_ICONS.chat;
    if (sessionCanvasTitle) sessionCanvasTitle.textContent = i18n ? i18n.t(FORMAT_I18N_KEY[format] || 'format.chat') : format;

    if (sessionChatMessages) sessionChatMessages.innerHTML = '';
    appendChatMessage('user', taskText, sessionChatMessages);
    const typingRow = showTypingIndicator(sessionChatMessages);
    setTimeout(() => {
      if (typingRow) typingRow.remove();
      const formatLabel = i18n ? i18n.t(FORMAT_I18N_KEY[format] || 'format.chat') : format;
      const template = i18n ? i18n.t('session.mockAck') : "'{format}' 형식으로 작업을 준비하고 있어요.";
      appendChatMessage('ai', template.replace('{format}', formatLabel), sessionChatMessages);
    }, 900);
  }

  function exitSessionView() {
    if (!workspaceHome || !workspaceSession) return;
    workspaceSession.style.display = 'none';
    workspaceHome.style.display = 'flex';
  }

  const btnSessionBack = document.getElementById('btn-session-back');
  if (btnSessionBack) btnSessionBack.addEventListener('click', exitSessionView);

  const btnSessionToggleToCanvas = document.getElementById('btn-session-toggle-to-canvas');
  const btnSessionToggleToChat = document.getElementById('btn-session-toggle-to-chat');
  if (btnSessionToggleToCanvas && sessionShell) {
    btnSessionToggleToCanvas.addEventListener('click', () => sessionShell.classList.add('show-canvas'));
  }
  if (btnSessionToggleToChat && sessionShell) {
    btnSessionToggleToChat.addEventListener('click', () => sessionShell.classList.remove('show-canvas'));
  }

  function sendSessionFollowUp(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || !sessionChatMessages) return;
    appendChatMessage('user', trimmed, sessionChatMessages);
    if (sessionChatInput) sessionChatInput.value = '';
    const typingRow = showTypingIndicator(sessionChatMessages);
    setTimeout(() => {
      if (typingRow) typingRow.remove();
      appendChatMessage('ai', i18n ? i18n.t('session.followUpReply') : '확인했습니다. 캔버스에 반영해드릴게요.', sessionChatMessages);
    }, 700);
  }

  const btnSessionSend = document.getElementById('btn-session-send');
  if (btnSessionSend && sessionChatInput) {
    btnSessionSend.addEventListener('click', () => sendSessionFollowUp(sessionChatInput.value));
    sessionChatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendSessionFollowUp(sessionChatInput.value);
    });
  }

  // ─── Run Task Button ───
  if (btnRun && promptInput) {
    btnRun.addEventListener('click', () => {
      const taskText = promptInput.value.trim();
      if (!taskText) return;
      enterSessionView(taskText, selectedOutputFormat);
      promptInput.value = '';
    });
  }

  // ─── New Task Button (sidebar) ───
  const btnSidebarNew = document.getElementById('btn-sidebar-new');
  if (btnSidebarNew && promptInput) {
    btnSidebarNew.addEventListener('click', () => {
      const workspaceNav = document.querySelector('[data-tab="tab-workspace"]');
      if (workspaceNav) workspaceNav.click();
      exitSessionView();
      promptInput.value = '';
      promptInput.focus();
      resetOutputFormat();
    });
  }

  // ─── Attach File Button ───
  const btnAttach = document.getElementById('btn-attach');
  if (btnAttach) {
    const hiddenFileInput = document.createElement('input');
    hiddenFileInput.type = 'file';
    hiddenFileInput.style.display = 'none';
    document.body.appendChild(hiddenFileInput);

    btnAttach.addEventListener('click', () => hiddenFileInput.click());
    hiddenFileInput.addEventListener('change', () => {
      const file = hiddenFileInput.files && hiddenFileInput.files[0];
      if (!file) return;
      const template = i18n ? i18n.t('toast.fileAttached') : '{name} 파일이 첨부되었습니다.';
      showToast(template.replace('{name}', file.name));
      hiddenFileInput.value = '';
    });
  }

  // ─── Knowledge Base Upload Button ───
  const btnKnowledgeUpload = document.getElementById('btn-knowledge-upload');
  if (btnKnowledgeUpload) {
    const hiddenKnowledgeInput = document.createElement('input');
    hiddenKnowledgeInput.type = 'file';
    hiddenKnowledgeInput.style.display = 'none';
    document.body.appendChild(hiddenKnowledgeInput);

    btnKnowledgeUpload.addEventListener('click', () => hiddenKnowledgeInput.click());
    hiddenKnowledgeInput.addEventListener('change', () => {
      const file = hiddenKnowledgeInput.files && hiddenKnowledgeInput.files[0];
      if (!file) return;
      const template = i18n ? i18n.t('toast.fileAttached') : '{name} 파일이 첨부되었습니다.';
      showToast(template.replace('{name}', file.name));
      hiddenKnowledgeInput.value = '';
    });
  }

  // ─── "새 에이전트 만들기" Card (no agent builder yet) ───
  const btnAgentNew = document.getElementById('btn-agent-new');
  if (btnAgentNew) {
    btnAgentNew.addEventListener('click', () => {
      showToast(i18n ? i18n.t('toast.comingSoon') : '준비 중인 기능입니다.');
    });
  }

  // ─── System Settings (popover item, no dedicated page yet) ───
  // ─── Logout (popover item, no real auth session yet) ───
  const popLogout = document.getElementById('pop-logout');
  if (popLogout) {
    popLogout.addEventListener('click', () => {
      showToast(i18n ? i18n.t('toast.loggedOut') : '로그아웃되었습니다.');
      if (manusPopover) manusPopover.style.display = 'none';
    });
  }

  // ─── Settings: sub-nav switching ───
  const settingsNav = document.getElementById('settings-nav');
  if (settingsNav) {
    settingsNav.querySelectorAll('.settings-nav-item').forEach((navBtn) => {
      navBtn.addEventListener('click', () => {
        settingsNav.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
        navBtn.classList.add('active');
        const section = navBtn.getAttribute('data-settings-section');
        document.querySelectorAll('.settings-section').forEach((s) => {
          s.classList.toggle('active', s.getAttribute('data-settings-section') === section);
        });
      });
    });
  }

  // ─── Settings: General — language select synced with the header toggle ───
  const settingsLanguageSelect = document.getElementById('settings-language-select');
  if (settingsLanguageSelect && i18n) {
    settingsLanguageSelect.value = i18n.getLocale();
    settingsLanguageSelect.addEventListener('change', () => {
      i18n.setLocale(settingsLanguageSelect.value);
    });
  }

  // ─── Settings: Appearance — theme cards (only Light is actually implemented) ───
  document.querySelectorAll('.settings-theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      const option = card.getAttribute('data-theme-option');
      if (option === 'light') return;
      showToast(i18n ? i18n.t('toast.comingSoon') : '준비 중인 기능입니다.');
    });
  });

  // ─── Settings: Personalization — custom instructions (localStorage-backed) ───
  const customInstructionsEl = document.getElementById('settings-custom-instructions');
  const btnSaveInstructions = document.getElementById('btn-save-instructions');
  if (customInstructionsEl) {
    customInstructionsEl.value = localStorage.getItem('agex_custom_instructions') || '';
  }
  if (btnSaveInstructions && customInstructionsEl) {
    btnSaveInstructions.addEventListener('click', () => {
      localStorage.setItem('agex_custom_instructions', customInstructionsEl.value);
      showToast(i18n ? i18n.t('toast.instructionsSaved') : '맞춤형 지침이 저장되었습니다.');
    });
  }

  // ─── Settings: Personalization — local memory toggle + clear ───
  const memoryToggleEl = document.getElementById('settings-memory-toggle');
  const btnClearMemory = document.getElementById('btn-clear-memory');
  if (memoryToggleEl) {
    memoryToggleEl.checked = localStorage.getItem('agex_memory_enabled') === 'true';
    memoryToggleEl.addEventListener('change', () => {
      localStorage.setItem('agex_memory_enabled', String(memoryToggleEl.checked));
    });
  }
  if (btnClearMemory) {
    btnClearMemory.addEventListener('click', () => {
      localStorage.removeItem('agex_memory_enabled');
      if (memoryToggleEl) memoryToggleEl.checked = false;
      showToast(i18n ? i18n.t('toast.memoryCleared') : '로컬 메모리를 삭제했습니다.');
    });
  }

  // ─── Settings: Agent Configuration — approval / sandbox / reasoning defaults ───
  // Persisted locally for now; not yet read by the PDP or Model Gateway —
  // see the section's own subtitle disclaimer in index.html.
  [
    ['settings-approval-select', 'agex_approval_policy'],
    ['settings-sandbox-select', 'agex_sandbox_setting'],
    ['settings-reasoning-select', 'agex_reasoning_level'],
  ].forEach(([id, storageKey]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = localStorage.getItem(storageKey);
    if (saved) el.value = saved;
    el.addEventListener('change', () => {
      localStorage.setItem(storageKey, el.value);
      showToast(i18n ? i18n.t('toast.settingSaved') : '설정이 저장되었습니다.');
    });
  });

  // ─── Feature Banner CTA ───
  const btnBanner = document.querySelector('.btn-banner');
  if (btnBanner) {
    btnBanner.addEventListener('click', () => {
      showToast(i18n ? i18n.t('toast.comingSoon') : '준비 중인 기능입니다.');
    });
  }

  // ─── Skill / Data Source "Add" Toggle Buttons ───
  document.querySelectorAll('.card-add-btn:not(.added)').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.add('added');
      btn.disabled = true;
      btn.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';
      const card = btn.closest('.agent-card');
      const name = card ? card.querySelector('.agent-name')?.textContent : '';
      showToast(i18n ? i18n.t('toast.skillAdded').replace('{name}', name) : `${name} 추가됨`);
    });
  });

  // ─── Custom Data Source Card (no generic connector builder yet) ───
  const btnDatasourceCustom = document.getElementById('btn-datasource-custom');
  if (btnDatasourceCustom) {
    btnDatasourceCustom.addEventListener('click', () => {
      showToast(i18n ? i18n.t('toast.comingSoon') : '준비 중인 기능입니다.');
    });
  }

  // ─── Recent History Items & Nested Project Chats ───
  document.querySelectorAll('.history-item, .project-chat-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const workspaceNav = document.querySelector('[data-tab="tab-workspace"]');
      if (workspaceNav) workspaceNav.click();
      const title = item.textContent.trim();
      if (promptInput) promptInput.value = title;
      const template = i18n ? i18n.t('toast.taskLoaded') : "'{title}' 작업을 불러왔습니다.";
      showToast(template.replace('{title}', title));
    });
  });

  // ─── Projects: expand/collapse + create new ───
  const projectList = document.getElementById('project-list');
  if (projectList) {
    projectList.querySelectorAll('.project-item-row').forEach((row) => {
      row.addEventListener('click', () => {
        row.closest('.project-item').classList.toggle('expanded');
      });
    });
  }

  const btnNewProject = document.getElementById('btn-new-project');
  if (btnNewProject && projectList) {
    btnNewProject.addEventListener('click', () => {
      const li = document.createElement('li');
      li.className = 'project-item expanded';
      li.innerHTML = `
        <div class="project-item-row">
          <svg class="svg-icon project-chevron" viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
          <svg class="svg-icon" viewBox="0 0 24 24" style="width:14px;height:14px;color:var(--text-light); flex-shrink:0;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
        </div>
        <ul class="project-chat-list"></ul>
      `;
      const row = li.querySelector('.project-item-row');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'project-name-input';
      input.placeholder = i18n ? i18n.t('nav.newProjectPlaceholder') : '프로젝트 이름';
      row.appendChild(input);
      projectList.insertBefore(li, projectList.firstChild);
      input.focus();

      const commit = () => {
        const name = input.value.trim();
        if (!name) {
          li.remove();
          return;
        }
        const span = document.createElement('span');
        span.className = 'project-item-name';
        span.textContent = name;
        input.replaceWith(span);
        row.addEventListener('click', () => li.classList.toggle('expanded'));
        showToast(i18n ? i18n.t('toast.projectCreated').replace('{name}', name) : `'${name}' 프로젝트를 만들었습니다.`);
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  // ─── Sidebar Navigation & Tab Switching ───
  const navItems = document.querySelectorAll('.nav-item, .popover-item[data-tab], .project-item-row[data-tab]');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      if (item.classList.contains('nav-item')) {
        item.classList.add('active');
      }

      const tabId = item.getAttribute('data-tab');
      document.querySelectorAll('.tab-view').forEach(view => {
        view.style.display = 'none';
      });

      const viewMap = {
        'tab-workspace': { id: 'view-workspace', display: 'flex' },
        'tab-knowledge': { id: 'view-knowledge', display: 'block' },
        'tab-billing': { id: 'view-billing', display: 'block' },
        'tab-plugins': { id: 'view-plugins', display: 'block' },
        'tab-agents': { id: 'view-agents', display: 'block' },
        'tab-library': { id: 'view-library', display: 'block' },
        'tab-iam': { id: 'view-iam', display: 'block' },
        'tab-skills': { id: 'view-skills', display: 'block' },
        'tab-datasources': { id: 'view-datasources', display: 'block' },
        'tab-vcs': { id: 'view-vcs', display: 'block' },
        'tab-support': { id: 'view-support', display: 'block' },
        'tab-settings': { id: 'view-settings', display: 'block' },
      };

      const target = viewMap[tabId];
      const activate = (el, display) => {
        if (!el) return;
        el.style.display = display;
        el.classList.remove('view-enter');
        void el.offsetWidth;
        el.classList.add('view-enter');
      };

      if (target) {
        activate(document.getElementById(target.id), target.display);
      } else {
        activate(document.getElementById('view-workspace'), 'flex');
      }

      if (tabId === 'tab-vcs') loadVcsStatus();
      if (tabId === 'tab-billing') loadBillingUsage();

      if (manusPopover) manusPopover.style.display = 'none';

      // 모바일: 탭 전환 후 사이드바 닫기
      closeMobileSidebar();
    });
  });

  // ─── Plugin Marketplace Search ───
  const pluginSearchInput = document.getElementById('plugin-search-input');
  const pluginSearchEmpty = document.getElementById('plugin-search-empty');
  if (pluginSearchInput) {
    pluginSearchInput.addEventListener('input', () => {
      const query = pluginSearchInput.value.trim().toLowerCase();
      let anyVisible = false;

      document.querySelectorAll('.plugin-category').forEach((category) => {
        const categoryName = category.querySelector('.plugin-category-heading')?.textContent.toLowerCase() || '';
        const categoryNameMatches = !query || categoryName.includes(query);
        let categoryHasMatch = false;
        category.querySelectorAll('.connector-row').forEach((row) => {
          const title = row.querySelector('.connector-title')?.textContent.toLowerCase() || '';
          const desc = row.querySelector('.connector-desc')?.textContent.toLowerCase() || '';
          const matches = categoryNameMatches || title.includes(query) || desc.includes(query);
          row.style.display = matches ? 'flex' : 'none';
          if (matches) categoryHasMatch = true;
        });
        category.style.display = categoryHasMatch ? 'block' : 'none';
        if (categoryHasMatch) anyVisible = true;
      });

      if (pluginSearchEmpty) pluginSearchEmpty.style.display = anyVisible ? 'none' : 'block';
    });
  }

  // ─── Plugin Connector Buttons ───
  document.querySelectorAll('.btn-connect').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.connector-row');
      const name = row ? row.querySelector('.connector-title').textContent : '';
      const statusTag = document.createElement('span');
      statusTag.className = 'status-tag status-running';
      statusTag.textContent = i18n ? i18n.t('plugins.connected') : '연결됨';
      btn.replaceWith(statusTag);
      const suffix = i18n ? i18n.t('toast.connectDone') : '연동 완료';
      showToast(`${name} ${suffix}`);
    });
  });

  // ─── Free-Tier Plan State (Core) vs Paid (Prime) ───
  // Not wired to real billing/entitlement data yet (Phase 10), so this reads
  // a local mock flag: 'free' (default — AGEX Core) or 'pro' (AGEX Prime).
  const adWidget = document.getElementById('ad-widget-free');
  const btnAdUpgrade = document.getElementById('btn-ad-upgrade');
  const planSummaryPro = document.getElementById('plan-summary-pro');
  const planSummaryFree = document.getElementById('plan-summary-free');
  const modelTierNotice = document.getElementById('billing-model-tier-notice');
  const earnCreditsSection = document.getElementById('earn-credits-section');
  const btnPrimeAgent = document.getElementById('btn-prime-agent');
  const proBadgePrime = document.getElementById('pro-badge-prime');
  const proBadgeFree = document.getElementById('pro-badge-free');
  const settingsPlanBadge = document.getElementById('settings-plan-badge');

  function isFreePlan() {
    return (localStorage.getItem('agex_plan') || 'free') === 'free';
  }

  function refreshPlanUI() {
    const free = isFreePlan();

    if (adWidget) adWidget.classList.toggle('hidden', !free);

    if (planSummaryPro) planSummaryPro.style.display = free ? 'none' : 'grid';
    if (planSummaryFree) planSummaryFree.style.display = free ? 'grid' : 'none';
    if (modelTierNotice) modelTierNotice.style.display = free ? 'flex' : 'none';
    if (earnCreditsSection) earnCreditsSection.style.display = free ? 'block' : 'none';
    if (proBadgePrime) proBadgePrime.style.display = free ? 'none' : 'inline';
    if (proBadgeFree) proBadgeFree.style.display = free ? 'inline' : 'none';
    if (settingsPlanBadge) {
      settingsPlanBadge.textContent = i18n
        ? i18n.t(free ? 'billing.freePlanName' : 'billing.primePlanName')
        : (free ? 'AGEX 코어' : 'AGEX 프라임');
    }
  }

  function upgradeToPrime() {
    localStorage.setItem('agex_plan', 'pro');
    refreshPlanUI();
    showToast(i18n ? i18n.t('toast.upgraded') : 'AGEX 프라임으로 업그레이드되었습니다.');
  }

  // Pro-plan balance now reflects the real CreditEngine (S-07 Phase 1) via
  // GET /api/v1/billing/usage, instead of the previous static "8,450 /
  // 10,000". The free-tier ad/referral balance (#free-credit-balance) stays
  // a client-side demo -- it isn't backed by the real ledger yet.
  async function loadBillingUsage() {
    const balanceEl = document.getElementById('pro-credit-balance');
    const totalEl = document.getElementById('pro-credit-total');
    if (!balanceEl || !totalEl) return;
    try {
      const res = await fetch('/api/v1/billing/usage');
      const data = await res.json();
      balanceEl.textContent = data.remaining_credits.toLocaleString();
      totalEl.textContent = data.total_credits.toLocaleString();
    } catch {
      /* keep the last-known display on failure */
    }
  }

  refreshPlanUI();

  if (btnAdUpgrade) {
    btnAdUpgrade.addEventListener('click', upgradeToPrime);
  }

  // Prime Agent pill is a paid-tier feature — free accounts get a nudge
  // toward upgrading instead of silently doing nothing.
  if (btnPrimeAgent) {
    btnPrimeAgent.addEventListener('click', () => {
      if (isFreePlan()) {
        showToast(i18n ? i18n.t('toast.superAgentLocked') : '프라임 에이전트는 AGEX 프라임 전용입니다. 코어 탭에서 업그레이드하세요.');
      }
    });
  }

  // ─── "코어 충전" (Top Up Core) — routes to the Billing tab ───
  const btnChargeCore = document.getElementById('btn-charge-core');
  if (btnChargeCore) {
    btnChargeCore.addEventListener('click', () => {
      const billingNav = document.querySelector('[data-tab="tab-billing"]');
      if (billingNav) billingNav.click();
    });
  }

  // ─── Free-Tier: Earn Core via Referral ───
  const btnCopyReferral = document.getElementById('btn-copy-referral');
  if (btnCopyReferral) {
    btnCopyReferral.addEventListener('click', async () => {
      const code = document.getElementById('referral-code');
      const link = 'https://' + (code ? code.textContent : '');
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        /* clipboard API unavailable — still show confirmation for the demo */
      }
      showToast(i18n ? i18n.t('toast.referralCopied') : '추천 링크가 복사되었습니다.');
    });
  }

  // ─── Free-Tier: Earn Core via Rewarded Interstitial Ad ───
  const btnWatchAd = document.getElementById('btn-watch-ad');
  const interstitialOverlay = document.getElementById('interstitial-ad-overlay');
  const interstitialTimer = document.getElementById('interstitial-timer');
  const btnInterstitialClaim = document.getElementById('btn-interstitial-claim');
  const freeCreditBalanceEl = document.getElementById('free-credit-balance');

  if (btnWatchAd && interstitialOverlay && interstitialTimer && btnInterstitialClaim) {
    let countdownHandle = null;

    btnWatchAd.addEventListener('click', () => {
      let secondsLeft = 5;
      interstitialTimer.textContent = String(secondsLeft);
      btnInterstitialClaim.disabled = true;
      interstitialOverlay.style.display = 'flex';

      countdownHandle = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft <= 0) {
          clearInterval(countdownHandle);
          interstitialTimer.textContent = '✓';
          btnInterstitialClaim.disabled = false;
        } else {
          interstitialTimer.textContent = String(secondsLeft);
        }
      }, 1000);
    });

    btnInterstitialClaim.addEventListener('click', () => {
      if (btnInterstitialClaim.disabled) return;
      interstitialOverlay.style.display = 'none';

      if (freeCreditBalanceEl) {
        const current = parseInt(freeCreditBalanceEl.textContent, 10) || 0;
        freeCreditBalanceEl.textContent = String(Math.min(current + 100, 500));
      }
      showToast(i18n ? i18n.t('toast.creditsEarned') : '코어 100개를 받았습니다!');
    });
  }

  // ─── Mobile Hamburger Menu Toggle ───
  const btnHamburger = document.getElementById('btn-hamburger');
  const sidebarLeft = document.getElementById('sidebar-left');
  const sidebarOverlay = document.getElementById('sidebar-overlay');

  function openMobileSidebar() {
    if (sidebarLeft) sidebarLeft.classList.add('open');
    if (sidebarOverlay) sidebarOverlay.classList.add('active');
  }

  function closeMobileSidebar() {
    if (sidebarLeft) sidebarLeft.classList.remove('open');
    if (sidebarOverlay) sidebarOverlay.classList.remove('active');
  }

  if (btnHamburger) {
    btnHamburger.addEventListener('click', openMobileSidebar);
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeMobileSidebar);
  }

  // ─── Voice Input (Speech-to-Text via Web Speech API) ───
  const btnVoiceInput = document.getElementById('btn-voice-input');
  let recognition = null;
  let isRecording = false;

  function speechLangTag() {
    return i18n && i18n.getLocale() === 'en' ? 'en-US' : 'ko-KR';
  }

  if (btnVoiceInput) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      recognition = new SpeechRecognition();
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        isRecording = true;
        btnVoiceInput.classList.add('recording');
        showToast(i18n ? i18n.t('toast.listening') : '음성 인식 중...', true);
      };

      recognition.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (promptInput) {
          promptInput.value = transcript;
        }
      };

      recognition.onend = () => {
        isRecording = false;
        btnVoiceInput.classList.remove('recording');
        removeToast();
        if (promptInput && promptInput.value.trim()) {
          showToast(i18n ? i18n.t('toast.voiceDone') : '음성 입력 완료!');
        }
      };

      recognition.onerror = (event) => {
        isRecording = false;
        btnVoiceInput.classList.remove('recording');
        removeToast();
        if (event.error === 'not-allowed') {
          showToast(i18n ? i18n.t('toast.micDenied') : '마이크 접근이 거부되었습니다. 브라우저 설정을 확인하세요.');
        } else if (event.error === 'no-speech') {
          showToast(i18n ? i18n.t('toast.noSpeech') : '음성이 감지되지 않았습니다. 다시 시도해주세요.');
        } else {
          showToast((i18n ? i18n.t('toast.recognitionError') : '음성 인식 오류:') + ' ' + event.error);
        }
      };

      btnVoiceInput.addEventListener('click', () => {
        if (isRecording) {
          recognition.stop();
        } else {
          recognition.lang = speechLangTag();
          recognition.start();
        }
      });
    } else {
      btnVoiceInput.addEventListener('click', () => {
        showToast(i18n ? i18n.t('toast.sttUnsupported') : '이 브라우저는 음성 인식을 지원하지 않습니다.');
      });
    }
  }

  // ─── Voice Output (Text-to-Speech via Web Speech API) ───
  const btnVoiceOutput = document.getElementById('btn-voice-output');
  let isSpeaking = false;

  if (btnVoiceOutput) {
    if ('speechSynthesis' in window) {
      btnVoiceOutput.addEventListener('click', () => {
        if (isSpeaking) {
          window.speechSynthesis.cancel();
          isSpeaking = false;
          btnVoiceOutput.classList.remove('speaking');
          removeToast();
          return;
        }

        // 현재 입력창의 텍스트를 읽거나, 없으면 기본 AI 응답 텍스트를 읽음
        const textToSpeak = promptInput && promptInput.value.trim()
          ? promptInput.value.trim()
          : (i18n ? i18n.t('toast.defaultSpeak') : 'AGEX AI 워크스페이스에 오신 것을 환영합니다. 원하시는 작업을 말씀해 주세요.');

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        const langTag = speechLangTag();
        utterance.lang = langTag;
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const matchedVoice = voices.find(v => v.lang.startsWith(langTag.split('-')[0]));
        if (matchedVoice) {
          utterance.voice = matchedVoice;
        }

        utterance.onstart = () => {
          isSpeaking = true;
          btnVoiceOutput.classList.add('speaking');
          showToast(i18n ? i18n.t('toast.speaking') : 'AI 음성 출력 중...');
        };

        utterance.onend = () => {
          isSpeaking = false;
          btnVoiceOutput.classList.remove('speaking');
          removeToast();
        };

        utterance.onerror = () => {
          isSpeaking = false;
          btnVoiceOutput.classList.remove('speaking');
          removeToast();
        };

        window.speechSynthesis.speak(utterance);
      });
    } else {
      btnVoiceOutput.addEventListener('click', () => {
        showToast(i18n ? i18n.t('toast.ttsUnsupported') : '이 브라우저는 음성 출력을 지원하지 않습니다.');
      });
    }
  }

  // ─── AI Customer Support Chat ───
  const supportMessages = document.getElementById('support-chat-messages');
  const supportInput = document.getElementById('support-chat-input');
  const btnSupportSend = document.getElementById('btn-support-send');
  const supportChips = document.querySelectorAll('.support-chip');

  function appendChatMessage(role, text, container) {
    const target = container || supportMessages;
    if (!target) return null;
    const row = document.createElement('div');
    row.className = 'chat-message ' + role;

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar ' + (role === 'ai' ? 'ai-avatar' : 'user-avatar');
    avatar.textContent = role === 'ai' ? 'AI' : (i18n ? i18n.t('support.you') : '나');

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = text;

    row.appendChild(avatar);
    row.appendChild(bubble);
    target.appendChild(row);
    target.scrollTop = target.scrollHeight;
    return row;
  }

  function showTypingIndicator(container) {
    const row = appendChatMessage('ai', '', container);
    if (!row) return null;
    const bubble = row.querySelector('.chat-bubble');
    bubble.innerHTML = '<span class="chat-typing-dots"><span></span><span></span><span></span></span>';
    return row;
  }

  function answerFor(userText) {
    const q = userText.toLowerCase();
    const key = () => {
      if (q.includes('코어') || q.includes('크레딧') || q.includes('core') || q.includes('credit') || q.includes('초기화') || q.includes('reset')) return 'support.answerCredits';
      if (q.includes('프라임') || q.includes('업그레이드') || q.includes('prime') || q.includes('upgrade')) return 'support.answerUpgrade';
      if (q.includes('테넌트') || q.includes('tenant')) return 'support.answerTenant';
      if (q.includes('플러그인') || q.includes('연동') || q.includes('plugin') || q.includes('connector') || q.includes('mcp')) return 'support.answerPlugins';
      if (q.includes('스킬') || q.includes('skill')) return 'support.answerSkills';
      if (q.includes('데이터 소스') || q.includes('데이터소스') || q.includes('data source') || q.includes('datasource')) return 'support.answerDataSources';
      if (q.includes('프로젝트') || q.includes('project')) return 'support.answerProjects';
      if (q.includes('버전 관리') || q.includes('git') || q.includes('커밋') || q.includes('commit')) return 'support.answerGit';
      if (q.includes('승인') || q.includes('샌드박스') || q.includes('approval') || q.includes('sandbox')) return 'support.answerAgentConfig';
      if (q.includes('형식') || q.includes('슬라이드') || q.includes('format') || q.includes('slide')) return 'support.answerFormat';
      if (q.includes('메모리') || q.includes('맞춤형 지침') || q.includes('memory') || q.includes('instructions')) return 'support.answerMemory';
      if (q.includes('담당자') || q.includes('사람') || q.includes('상담원') || q.includes('human') || q.includes('person') || q.includes('talk')) return 'support.answerHuman';
      return 'support.answerDefault';
    };
    return i18n ? i18n.t(key()) : '문의 감사합니다. 담당 팀에게 전달했어요.';
  }

  function sendSupportMessage(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || !supportMessages) return;

    appendChatMessage('user', trimmed);
    if (supportInput) supportInput.value = '';

    const typingRow = showTypingIndicator();
    setTimeout(() => {
      if (typingRow) typingRow.remove();
      appendChatMessage('ai', answerFor(trimmed));
    }, 700);
  }

  if (btnSupportSend && supportInput) {
    btnSupportSend.addEventListener('click', () => sendSupportMessage(supportInput.value));
    supportInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendSupportMessage(supportInput.value);
    });
  }

  supportChips.forEach((chip) => {
    chip.addEventListener('click', () => sendSupportMessage(chip.textContent));
  });

  // ─── Toast Notification System ───
  let currentToast = null;
  let toastTimer = null;

  function showToast(message, persistent) {
    removeToast();
    const toast = document.createElement('div');
    toast.className = 'voice-status-toast';

    if (persistent) {
      toast.innerHTML = `<span class="dot-recording"></span>${message}`;
    } else {
      toast.textContent = message;
    }

    document.body.appendChild(toast);
    currentToast = toast;

    if (!persistent) {
      toastTimer = setTimeout(() => {
        removeToast();
      }, 3000);
    }
  }

  function removeToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (currentToast) {
      currentToast.remove();
      currentToast = null;
    }
  }

  // ─── Version Control (Git) — read-only live status from /api/v1/vcs/status ───
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function vcsStatusLetter(code) {
    if (code === '??') return 'U';
    if (code.includes('D')) return 'D';
    if (code.includes('A')) return 'A';
    if (code.includes('R')) return 'R';
    return 'M';
  }

  function vcsStatusClass(letter) {
    return 'vcs-status-' + letter.toLowerCase();
  }

  async function loadVcsStatus() {
    const loadingEl = document.getElementById('vcs-loading');
    const contentEl = document.getElementById('vcs-content');
    const errorEl = document.getElementById('vcs-error');
    if (!loadingEl || !contentEl || !errorEl) return;

    loadingEl.style.display = 'block';
    contentEl.style.display = 'none';
    errorEl.style.display = 'none';

    try {
      const res = await fetch('/api/v1/vcs/status');
      const data = await res.json();
      if (!data.available) throw new Error(data.error || 'unavailable');

      const branchNameEl = document.getElementById('vcs-branch-name');
      if (branchNameEl) branchNameEl.textContent = data.branch || '—';

      const filesEl = document.getElementById('vcs-changed-files');
      const noChangesEl = document.getElementById('vcs-no-changes');
      if (filesEl && noChangesEl) {
        filesEl.innerHTML = '';
        if (data.changed_files.length === 0) {
          noChangesEl.style.display = 'block';
        } else {
          noChangesEl.style.display = 'none';
          data.changed_files.forEach((f) => {
            const letter = vcsStatusLetter(f.status);
            const row = document.createElement('div');
            row.className = 'vcs-file-row';
            row.innerHTML = `
              <span class="vcs-file-status ${vcsStatusClass(letter)}">${letter}</span>
              <span class="vcs-file-path">${escapeHtml(f.path)}</span>
            `;
            filesEl.appendChild(row);
          });
        }
      }

      const commitsEl = document.getElementById('vcs-commits');
      if (commitsEl) {
        commitsEl.innerHTML = '';
        const locale = i18n && i18n.getLocale && i18n.getLocale() === 'en' ? 'en-US' : 'ko-KR';
        data.commits.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'vcs-commit-row';
          const dateStr = c.date ? new Date(c.date).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
          row.innerHTML = `
            <div class="vcs-commit-dot-col"><span class="vcs-commit-dot"></span></div>
            <div class="vcs-commit-body">
              <div class="vcs-commit-message">${escapeHtml(c.message)}</div>
              <div class="vcs-commit-meta">
                <span class="vcs-commit-hash">${escapeHtml(c.hash)}</span>
                <span>${escapeHtml(c.author)} · ${escapeHtml(dateStr)}</span>
              </div>
            </div>
          `;
          commitsEl.appendChild(row);
        });
      }

      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';
    } catch (err) {
      loadingEl.style.display = 'none';
      errorEl.style.display = 'block';
    }
  }
});
