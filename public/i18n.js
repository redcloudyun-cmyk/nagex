// NAgex Console i18n — Personal AI Localization Dictionary.
// Supports English (en - default) and Korean (ko).
(function () {
  const STORAGE_KEY = 'nagex_locale';

  const translations = {
    en: {
      'page.title': 'NAgex — Personal AI Control Center',
      'header.langToggle': 'KR',

      // Navigation
      'nav.home': 'Home',
      'nav.memory': 'Memory',
      'nav.plans': 'Plans',
      'nav.skills': 'Skills',
      'nav.tools': 'Tools',
      'nav.approvals': 'Approvals',
      'nav.executions': 'Executions',
      'nav.knowledge': 'Knowledge',
      'nav.settings': 'Settings',
      'nav.quickwake': 'Quick Wake',
      'nav.newTask': 'Quick Action',
      'nav.groupWorkspace': 'Control Center',

      // Ambient Assistant Overlay
      'ambient.title': 'NAgex Ambient Assistant',
      'ambient.modalTitle': 'Plan Preview',
      'ambient.close': 'Close',
      'ambient.pressEscToClose': 'Press Esc to close',
      'ambient.listening': 'Listening... "What would you like me to do?"',
      'ambient.understood': 'I understood:',
      'ambient.plan': 'Mini Plan',
      'ambient.reviewPlan': 'Review Plan',
      'ambient.run': 'Run',
      'ambient.cancel': 'Cancel',
      'ambient.approvalRequired': 'Human Approval Required',
      'ambient.action': 'Action',
      'ambient.recipient': 'Recipient',
      'ambient.subject': 'Subject',
      'ambient.sharedData': 'Data Involved',
      'ambient.why': 'Reasoning & Purpose',
      'ambient.impact': 'Impact Analysis',
      'ambient.approve': 'Approve',
      'ambient.reject': 'Reject',
      'ambient.progress.understanding': 'Understanding request...',
      'ambient.progress.memory': 'Recalling personal memory...',
      'ambient.progress.planning': 'Creating action plan...',
      'ambient.progress.skill': 'Selecting reusable skill...',
      'ambient.progress.tool': 'Selecting capability tool...',
      'ambient.progress.approval': 'Waiting for human approval...',
      'ambient.progress.executing': 'Executing task...',
      'ambient.progress.verifying': 'Verifying result...',
      'ambient.progress.done': 'Task Completed',
      'ambient.result.title': 'Result & Outcome',
      'ambient.result.meeting': 'Meeting scheduled for Tomorrow at 10:30 AM',
      'ambient.result.emailSent': 'Client update email dispatched after approval.',
      'ambient.result.reminder': 'I will remind you 30 minutes before the meeting.',
      'ambient.result.viewDetails': 'View Details',
      'ambient.result.dismiss': 'Dismiss',

      // Home View
      'home.greeting': 'Hello, Jane',
      'home.subtitle': 'What would you like to do today?',
      'home.promptPlaceholder': 'Ask NAgex anything...',
      'home.runDemoBtn': 'Run Primary Scenario: Prepare Client Meeting',
      'home.quickActions': 'Quick Actions',
      'home.actionPlanDay': 'Plan my day',
      'home.actionSummarizeNotes': 'Summarize my notes',
      'home.actionPrepareMeeting': 'Prepare for a meeting',
      'home.actionResearchTopic': 'Research a topic',
      'home.actionExecuteTask': 'Execute a task',
      'home.statusMemoryActive': 'Memory Active',
      'home.statusOpenPlans': 'Open Plans',
      'home.statusPendingApprovals': 'Pending Approvals',
      'home.statusConnectedTools': 'Connected Tools',
      'home.recentConvos': 'Recent Conversations',
      'home.suggestedTasks': 'Suggested for You',
      'home.todayAtGlance': 'Today at a Glance',

      // Memory View
      'memory.title': 'Personal Memory',
      'memory.subtitle': 'NAgex remembers preferences, session context, and task history across interactions. Fully inspectable and controllable.',
      'memory.catProfile': 'Profile',
      'memory.catPreferences': 'Preferences',
      'memory.catSession': 'Session Memory',
      'memory.catTaskHistory': 'Task History',
      'memory.catLongTerm': 'Long-term Memory',
      'memory.catGoals': 'Goals',
      'memory.catToolPrefs': 'Tool Preferences',
      'memory.btnForget': 'Forget',
      'memory.btnPin': 'Pin',
      'memory.btnEdit': 'Edit',
      'memory.btnView': 'View',
      'memory.btnClearSession': 'Clear Session Memory',

      // Plans View
      'plans.title': 'Executable Action Plans',
      'plans.subtitle': 'Goal-driven plans broken down into executable steps with skills, tools, and approval states.',
      'plans.statusWaiting': 'Waiting',
      'plans.statusReady': 'Ready',
      'plans.statusRunning': 'Running',
      'plans.statusApproval': 'Awaiting Approval',
      'plans.statusCompleted': 'Completed',
      'plans.statusBlocked': 'Blocked',
      'plans.statusFailed': 'Failed',
      'plans.statusCancelled': 'Cancelled',

      // Skills View
      'skills.title': 'Reusable Skills',
      'skills.subtitle': 'Skill = How NAgex performs a reusable task. Procedural behaviors defining execution rules.',
      'skills.tagHow': 'Skill = How NAgex performs a task',
      'skills.tagTool': 'Tool = What capability NAgex invokes',

      // Tools View
      'tools.title': 'Executable Tools',
      'tools.subtitle': 'Tool = What capability NAgex invokes. Integration endpoints with explicit safety policies.',
      'tools.connected': 'Connected',
      'tools.disconnected': 'Not Connected',
      'tools.limitedAccess': 'Limited Access',
      'tools.approvalRequired': 'Approval Required',
      'tools.unavailable': 'Unavailable',

      // Approvals View
      'approvals.title': 'Human Approvals',
      'approvals.subtitle': 'Human-Controlled Autonomy. Inspect action impact, recipient, shared data, and intent before execution.',
      'approvals.tabPending': 'Pending',
      'approvals.tabApproved': 'Approved',
      'approvals.tabRejected': 'Rejected',

      // Executions View
      'executions.title': 'Executions & Audit Timeline',
      'executions.subtitle': 'Live execution lifecycle tracking from goal intake to verified outcome and memory update.',

      // Knowledge View
      'knowledge.title': 'Reference Knowledge',
      'knowledge.subtitle': 'External files, documents, and reference materials NAgex can access during reasoning (Knowledge ≠ Memory).',

      // Settings View
      'settings.title': 'Personal AI & Provider Settings',
      'settings.subtitle': 'Configure Quick Wake invocation triggers, autonomy levels, connected tools, and Nebius / NVIDIA runtime integrations.',
      'settings.quickWake': 'Quick Wake Invocation',
      'settings.autonomy': 'Autonomy Level',
      'settings.autonomy.l0': 'Level 0 — Ask Every Time',
      'settings.autonomy.l1': 'Level 1 — Read Only',
      'settings.autonomy.l2': 'Level 2 — Low-risk Actions',
      'settings.autonomy.l3': 'Level 3 — Trusted Workflows',
      'settings.providers': 'Nebius & NVIDIA Model Gateway',
    },
    ko: {
      'page.title': 'NAgex — 개인용 AI 컨트롤 센터',
      'header.langToggle': 'EN',

      // Navigation
      'nav.home': '홈',
      'nav.memory': '메모리',
      'nav.plans': '계획',
      'nav.skills': '스킬',
      'nav.tools': '도구',
      'nav.approvals': '승인',
      'nav.executions': '실행',
      'nav.knowledge': '지식',
      'nav.settings': '설정',
      'nav.quickwake': '빠른 호출',
      'nav.newTask': '빠른 액션',
      'nav.groupWorkspace': '컨트롤 센터',

      // Ambient Assistant Overlay
      'ambient.title': 'NAgex 앰비언트 어시스턴트',
      'ambient.modalTitle': '계획 미리보기',
      'ambient.close': '닫기',
      'ambient.pressEscToClose': 'Esc 키를 눌러 닫기',
      'ambient.listening': '음성 듣는 중... "어떤 작업을 수행할까요?"',
      'ambient.understood': '인식된 요청:',
      'ambient.plan': '미니 플랜',
      'ambient.reviewPlan': '계획 검토',
      'ambient.run': '실행',
      'ambient.cancel': '취소',
      'ambient.approvalRequired': '사용자 승인 필요',
      'ambient.action': '실행 작업',
      'ambient.recipient': '수신자',
      'ambient.subject': '제목',
      'ambient.sharedData': '관련 데이터',
      'ambient.why': '추론 및 실행 목적',
      'ambient.impact': '영향 분석',
      'ambient.approve': '승인',
      'ambient.reject': '거절',
      'ambient.progress.understanding': '요청 이해 중...',
      'ambient.progress.memory': '개인 메모리 조회 중...',
      'ambient.progress.planning': '실행 계획 생성 중...',
      'ambient.progress.skill': '재사용 스킬 선택 중...',
      'ambient.progress.tool': '실행 도구 선택 중...',
      'ambient.progress.approval': '사용자 승인 대기 중...',
      'ambient.progress.executing': '작업 실행 중...',
      'ambient.progress.verifying': '결과 검증 중...',
      'ambient.progress.done': '작업 완료',
      'ambient.result.title': '실행 결과',
      'ambient.result.meeting': '내일 오전 10:30 미팅 일정이 등록되었습니다.',
      'ambient.result.emailSent': '승인에 따라 클라이언트 공유용 메일이 전송되었습니다.',
      'ambient.result.reminder': '미팅 시작 30분 전에 알림을 드리겠습니다.',
      'ambient.result.viewDetails': '자세히 보기',
      'ambient.result.dismiss': '닫기',

      // Home View
      'home.greeting': '안녕하세요, Jane님',
      'home.subtitle': '오늘 NAgex가 어떤 작업을 도와드릴까요?',
      'home.promptPlaceholder': 'Ask NAgex anything...',
      'home.runDemoBtn': '주요 시나리오 실행: 미팅 준비 및 일정 등록',
      'home.quickActions': '빠른 액션',
      'home.actionPlanDay': '하루 일정 계획',
      'home.actionSummarizeNotes': '메모 요약',
      'home.actionPrepareMeeting': '미팅 사전 준비',
      'home.actionResearchTopic': '주제 리서치',
      'home.actionExecuteTask': '작업 실행',
      'home.statusMemoryActive': '활성 메모리',
      'home.statusOpenPlans': '진행 중인 계획',
      'home.statusPendingApprovals': '승인 대기 건',
      'home.statusConnectedTools': '연결된 도구',
      'home.recentConvos': '최근 대화',
      'home.suggestedTasks': '추천 액션',
      'home.todayAtGlance': '오늘의 한눈에 보기',

      // Memory View
      'memory.title': '개인 메모리',
      'memory.subtitle': 'NAgex가 기억하는 사용자 컨텍스트, 선호도 및 작업 이력입니다. 자유롭게 확인하고 관리할 수 있습니다.',
      'memory.catProfile': '프로필',
      'memory.catPreferences': '선호도',
      'memory.catSession': '세션 메모리',
      'memory.catTaskHistory': '작업 이력',
      'memory.catLongTerm': '장기 메모리',
      'memory.catGoals': '목표',
      'memory.catToolPrefs': '도구 설정',
      'memory.btnForget': '삭제',
      'memory.btnPin': '고정',
      'memory.btnEdit': '수정',
      'memory.btnView': '상세보기',
      'memory.btnClearSession': '세션 메모리 초기화',

      // Plans View
      'plans.title': '실행 액션 플랜',
      'plans.subtitle': '목표를 구체적인 단계로 분할하고 스킬, 도구, 승인 상태를 배정한 실행 계획입니다.',
      'plans.statusWaiting': '대기 중',
      'plans.statusReady': '준비됨',
      'plans.statusRunning': '실행 중',
      'plans.statusApproval': '승인 대기 중',
      'plans.statusCompleted': '완료됨',
      'plans.statusBlocked': '차단됨',
      'plans.statusFailed': '실패',
      'plans.statusCancelled': '취소됨',

      // Skills View
      'skills.title': '재사용 스킬',
      'skills.subtitle': 'Skill = NAgex가 작업을 수행하는 방법. 안전 규칙과 실행 절차를 정의합니다.',
      'skills.tagHow': 'Skill = NAgex가 작업을 수행하는 방식',
      'skills.tagTool': 'Tool = NAgex가 호출하는 실행 수단',

      // Tools View
      'tools.title': '실행 도구 연동',
      'tools.subtitle': 'Tool = NAgex가 실제 행동에 사용하는 수단. 외부 서비스 연동과 안전 정책을 보여줍니다.',
      'tools.connected': '연결됨',
      'tools.disconnected': '연결 안 됨',
      'tools.limitedAccess': '제한된 접근',
      'tools.approvalRequired': '승인 필요',
      'tools.unavailable': '사용 불가',

      // Approvals View
      'approvals.title': '사용자 승인 센터',
      'approvals.subtitle': 'Human-Controlled Autonomy. 외부 영향력이 큰 작업을 실행하기 전 영향도, 수신자, 데이터를 검토합니다.',
      'approvals.tabPending': '대기 중',
      'approvals.tabApproved': '승인됨',
      'approvals.tabRejected': '거절됨',

      // Executions View
      'executions.title': '실행이력 & 감사 타임라인',
      'executions.subtitle': '목표 수립부터 메모리 조회, 계획, 승인, 도구 실행, 감사 기록까지의 라이프사이클 타임라인입니다.',

      // Knowledge View
      'knowledge.title': '참조 지식',
      'knowledge.subtitle': 'NAgex가 추론 시 참조하는 외부 문서 및 파일입니다 (Knowledge ≠ Memory).',

      // Settings View
      'settings.title': '개인용 AI & 프로바이더 설정',
      'settings.subtitle': '빠른 호출 수단, 자율 실행 레벨, 연동 도구 및 Nebius / NVIDIA 모델 가이트웨이 연동 상태를 관리합니다.',
      'settings.quickWake': '빠른 호출 설정',
      'settings.autonomy': '자율 실행 레벨',
      'settings.autonomy.l0': '레벨 0 — 매번 물어보기',
      'settings.autonomy.l1': '레벨 1 — 읽기 전용',
      'settings.autonomy.l2': '레벨 2 — 저위험 액션',
      'settings.autonomy.l3': '레벨 3 — 신뢰된 워크플로',
      'settings.providers': 'Nebius & NVIDIA 모델 가이트웨이',
    },
  };

  function detectLocale() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
    return 'en';
  }

  let currentLocale = detectLocale();

  function t(key) {
    return (translations[currentLocale] && translations[currentLocale][key]) || translations.en[key] || key;
  }

  function applyLocale() {
    document.documentElement.lang = currentLocale;
    document.title = t('page.title');

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-value]').forEach((el) => {
      el.value = t(el.getAttribute('data-i18n-value'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });

    document.querySelectorAll('[data-i18n-lang-toggle]').forEach((el) => {
      el.textContent = t('header.langToggle');
    });
  }

  function getLocale() {
    return currentLocale;
  }

  function setLocale(locale) {
    if (locale !== 'ko' && locale !== 'en') return;
    currentLocale = locale;
    localStorage.setItem(STORAGE_KEY, locale);
    applyLocale();
  }

  function toggleLocale() {
    setLocale(currentLocale === 'ko' ? 'en' : 'ko');
  }

  window.NAGEX_I18N = { t, getLocale, setLocale, toggleLocale, applyLocale };
})();
