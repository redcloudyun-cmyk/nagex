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
      'nav.capture': 'Capture',
      'nav.inbox': 'Capture',
      'nav.vault': 'Vault',
      'nav.memory': 'Memory',
      'nav.plans': 'Plans',
      'nav.tasks': 'Tasks',
      'nav.more': 'More',
      'nav.activity': 'Activity',
      'nav.automations': 'Automations',
      'nav.connections': 'Connections',
      'nav.knowledge': 'Knowledge',
      'nav.settings': 'Settings',
      'nav.advanced': 'Advanced',
      'nav.approvals': 'Approvals',
      'nav.agents': 'Agents',
      'nav.skills': 'Skills',
      'nav.tools': 'Tools',
      'nav.executions': 'Executions',
      'nav.developer': 'Developer',
      'home.greetingPrompt': 'What would you like NAgex to handle?',
      'workspace.inboxTitle': 'NAgex Inbox',
      'workspace.inboxSubtitle': 'Single triage hub for quick captures, files, URLs, and audio notes.',
      'workspace.vaultTitle': 'Personal Cloud Vault',
      'workspace.vaultSubtitle': 'Encrypted canonical storage for captured assets, documents, and reference knowledge.',
      'workspace.askOrDrop': 'Ask or drop anything here...',
      'workspace.working': 'NAgex is working',
      'workspace.attention': 'Needs your attention',
      'workspace.today': 'Today',
      'workspace.recentActivity': 'Recent Activity',
      'nav.quickwake': 'Quick Wake',
      'nav.newTask': 'Quick Action',
      'nav.groupWorkspace': 'Control Center',

      // Desktop Quick Wake
      'desktop.title': 'NAgex Quick Wake',
      'desktop.mainSession': 'Main Session',
      'desktop.tabChat': 'Chat',
      'desktop.tabTasks': 'Tasks Quick View',
      'desktop.placeholder': 'Type command or message... (Alt+N)',
      'desktop.expandControlCenter': 'Open Control Center',
      'desktop.closeWindow': 'Close to tray',
      'desktop.activeTasks': 'Active Tasks',
      'desktop.conditionalWatches': 'Conditional Watches',
      'desktop.backgroundTasks': 'Background Tasks',
      'desktop.nextRun': 'Next Run',
      'desktop.pause': 'Pause',
      'desktop.resume': 'Resume',
      'desktop.runNow': 'Run Now',
      'desktop.openTask': 'Open Task',
      'desktop.trayOpen': 'Open NAgex',
      'desktop.trayQuickWake': 'Quick Wake (Alt+N)',
      'desktop.trayActiveTasks': 'Active Tasks',
      'desktop.trayPauseAutomations': 'Pause Automations',
      'desktop.trayOpenControlCenter': 'Open Control Center',
      'desktop.traySettings': 'Settings',
      'desktop.trayQuit': 'Quit',

      // Ambient Assistant Overlay
      'ambient.title': 'NAgex Ambient Assistant',
      'ambient.modalTitle': 'Plan Preview',
      'ambient.close': 'Close',
      'ambient.pressEscToClose': 'Press Esc to close',
      'ambient.promptPlaceholder': 'Prepare my next client meeting and schedule it.',
      'ambient.promptAriaLabel': 'Ask NAgex',
      'ambient.listening': 'Listening... "What would you like me to do?"',
      'ambient.understood': 'I understood:',
      'ambient.plan': 'Mini Plan',
      'ambient.reviewPlan': 'Review Plan',
      'ambient.run': 'Run',
      'ambient.running': 'Running...',
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

      // Tasks View (MASTER.md Section 14.4)
      'tasks.title': 'Tasks',
      'tasks.subtitle': 'Standing work that runs, recurs, waits, watches a condition, or tracks in the background — distinct from a one-off Plan.',
      'tasks.newTask': 'New Task',
      'tasks.form.namePlaceholder': 'e.g. Daily Morning Brief',
      'tasks.form.objective': 'Objective',
      'tasks.form.objectivePlaceholder': 'What should NAgex do each time this runs?',
      'tasks.form.type': 'Type',
      'tasks.form.trigger': 'Trigger',
      'tasks.form.condition': 'Condition to watch for',
      'tasks.form.conditionPlaceholder': 'e.g. the price is below ₩800,000',
      'tasks.form.watchUrl': 'Page to watch (URL)',
      'tasks.form.checkInterval': 'Check every (minutes)',
      'tasks.form.create': 'Create Task',
      'tasks.empty': 'No tasks yet. Create one to get started.',
      'tasks.pause': 'Pause',
      'tasks.resume': 'Resume',
      'tasks.runNow': 'Run now',
      'tasks.cancelTask': 'Cancel Task',
      'tasks.recheckTask': 'Re-check',
      'tasks.progress': 'Progress',
      'tasks.delete': 'Delete',
      'tasks.nextRun': 'Next run',
      'tasks.lastRun': 'Last run',
      'tasks.never': 'Never',
      'tasks.owner': 'You',

      // Gmail Ambient Composer
      'gmail.confirmSend': 'Confirm the exact email',
      'gmail.confirmReply': 'Confirm the exact reply',
      'gmail.confirmDraft': 'Confirm the exact draft',
      'gmail.to': 'To',
      'gmail.cc': 'Cc',
      'gmail.bcc': 'Bcc',
      'gmail.subject': 'Subject',
      'gmail.body': 'Body',
      'gmail.account': 'Account',
      'gmail.threadId': 'Thread',
      'gmail.replyToMessageId': 'Replying to message',
      'gmail.recipientHint': 'You mentioned',
      'gmail.recipientHintSuffix': '— enter their exact email address.',
      'gmail.toRequired': 'At least one valid "To" recipient is required.',
      'gmail.previewAndRequestApproval': 'Preview & Request Approval',
      'gmail.connectPrompt': 'Gmail is not connected, so this step cannot proceed.',
      'gmail.connectButton': 'Connect Gmail',
      'gmail.connectNotConfigured': 'Google is not configured on this server yet.',
      'gmail.requestingApproval': 'Requesting approval…',
      'gmail.sending': 'Sending email…',
      'gmail.replying': 'Sending reply…',
      'gmail.savingDraft': 'Saving draft…',
      'gmail.sent': 'Email sent',
      'gmail.replySent': 'Reply sent',
      'gmail.draftCreated': 'Draft created',
      'gmail.openInGmail': 'Open in Gmail →',
      'gmail.searching': 'Searching Gmail…',
      'gmail.searchResults': 'Search results',
      'gmail.noResults': 'No matching emails found.',
      'gmail.loadingThread': 'Loading thread…',
      'gmail.threadMessages': 'Messages in this thread',
      'gmail.approveAndSend': 'Approve & Send',
      'gmail.approveAndReply': 'Approve & Reply',
      'gmail.approveAndCreateDraft': 'Approve & Create Draft',
      'gmail.reject': 'Reject',

      // Browser Agent MVP
      'browser.openingWebsite': 'Opening website...',
      'browser.readingPage': 'Reading page...',
      'browser.connectPrompt': 'The browser runtime is not available on this server.',
      'browser.sessionBlocked': 'This browser session requires human verification (CAPTCHA/MFA) and cannot continue automatically.',

      // Telegram Integration
      'telegram.title': 'Telegram Integration',
      'telegram.subtitle': 'Connect NAgex to Telegram to send & receive messages via mobile bot.',
      'telegram.linkIdentity': 'Link Telegram User ID',
      'telegram.linkedUsers': 'Linked Users',
      'telegram.botStatus': 'Bot Status',

      // Slack Integration
      'slack.title': 'Slack Integration',
      'slack.subtitle': 'Connect NAgex to Slack to receive channel events and post responses.',
      'slack.linkIdentity': 'Link Slack User ID',
      'slack.linkedUsers': 'Linked Users',
      'slack.botStatus': 'Bot Status',

      // Notifications
      'notifications.title': 'Notifications',
      'notifications.subtitle': 'Proactive alerts and multi-channel notifications across Web, Telegram, and Slack.',
      'notifications.markAllRead': 'Mark All as Read',
      'notifications.empty': 'No notifications.',
      'browser.approvalRequired': 'Confirm this action before it runs',
      'browser.target': 'Target',
      'browser.currentPage': 'Current page',
      'browser.approveAndClick': 'Approve & Click',
      'browser.reject': 'Reject',
      'browser.actionCompleted': 'Action completed',
      'browser.openLink': 'Open in new tab →',

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
      'nav.capture': '캡처',
      'nav.inbox': '캡처',
      'nav.vault': '보관함',
      'nav.memory': '기억',
      'nav.plans': '플랜',
      'nav.tasks': '할 일',
      'nav.more': '더보기',
      'nav.activity': '활동',
      'nav.automations': '자동화',
      'nav.connections': '연결',
      'nav.knowledge': '지식 베이스',
      'nav.settings': '설정',
      'nav.advanced': '고급',
      'nav.approvals': '승인 요청',
      'nav.agents': '에이전트',
      'nav.skills': '스킬',
      'nav.tools': '툴',
      'nav.executions': '실행 기록',
      'nav.developer': '개발자 도구',
      'home.greetingPrompt': 'NAgex가 오늘 어떤 일을 도와드릴까요?',
      'workspace.inboxTitle': 'NAgex 인박스',
      'workspace.inboxSubtitle': '캡처된 수집품, 문서, URL, 음성 메모의 중앙 분류 탭',
      'workspace.vaultTitle': 'Personal Cloud Vault',
      'workspace.vaultSubtitle': '암호화된 개인 클라우드 보관함 및 지식 벡터 저장소',
      'workspace.askOrDrop': '무엇이든 묻거나 여기에 드롭하세요...',
      'workspace.working': 'NAgex가 실행 중입니다',
      'workspace.attention': '확인이 필요합니다',
      'workspace.today': '오늘 일정',
      'workspace.recentActivity': '최근 활동',
      'nav.quickwake': '빠른 호출',
      'nav.newTask': '빠른 액션',
      'nav.groupWorkspace': '컨트롤 센터',

      // Desktop Quick Wake
      'desktop.title': 'NAgex 빠른 호출',
      'desktop.mainSession': '메인 세션',
      'desktop.tabChat': '대화',
      'desktop.tabTasks': '작업 요약 보기',
      'desktop.placeholder': '명령어 또는 메시지 입력... (Alt+N)',
      'desktop.expandControlCenter': '컨트롤 센터 열기',
      'desktop.closeWindow': '트레이로 닫기',
      'desktop.activeTasks': '활성 작업',
      'desktop.conditionalWatches': '조건부 모니터링',
      'desktop.backgroundTasks': '백그라운드 작업',
      'desktop.nextRun': '다음 실행',
      'desktop.pause': '일시정지',
      'desktop.resume': '재개',
      'desktop.runNow': '지금 실행',
      'desktop.openTask': '작업 열기',
      'desktop.trayOpen': 'NAgex 열기',
      'desktop.trayQuickWake': '빠른 호출 (Alt+N)',
      'desktop.trayActiveTasks': '활성 작업',
      'desktop.trayPauseAutomations': '자동화 일시정지',
      'desktop.trayOpenControlCenter': '컨트롤 센터 열기',
      'desktop.traySettings': '설정',
      'desktop.trayQuit': '종료',

      // Ambient Assistant Overlay
      'ambient.title': 'NAgex 앰비언트 어시스턴트',
      'ambient.modalTitle': '계획 미리보기',
      'ambient.close': '닫기',
      'ambient.pressEscToClose': 'Esc 키를 눌러 닫기',
      'ambient.promptPlaceholder': '다음 고객 미팅을 준비하고 일정을 잡아줘.',
      'ambient.promptAriaLabel': 'NAgex에게 요청하기',
      'ambient.listening': '음성 듣는 중... "어떤 작업을 수행할까요?"',
      'ambient.understood': '인식된 요청:',
      'ambient.plan': '미니 플랜',
      'ambient.reviewPlan': '계획 검토',
      'ambient.run': '실행',
      'ambient.running': '실행 중...',
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

      // Tasks View (MASTER.md Section 14.4)
      'tasks.title': '작업',
      'tasks.subtitle': '실행되거나, 반복되거나, 대기하거나, 조건을 감시하거나, 백그라운드로 추적되는 상시 작업입니다 — 1회성 계획(Plan)과는 다릅니다.',
      'tasks.newTask': '새 작업',
      'tasks.form.namePlaceholder': '예: 매일 아침 브리핑',
      'tasks.form.objective': '목표',
      'tasks.form.objectivePlaceholder': '이 작업이 실행될 때마다 NAgex가 무엇을 해야 하나요?',
      'tasks.form.type': '유형',
      'tasks.form.trigger': '트리거',
      'tasks.form.condition': '감시할 조건',
      'tasks.form.conditionPlaceholder': '예: 가격이 ₩800,000 이하로 떨어짐',
      'tasks.form.watchUrl': '감시할 페이지 (URL)',
      'tasks.form.checkInterval': '확인 주기 (분)',
      'tasks.form.create': '작업 생성',
      'tasks.empty': '아직 작업이 없습니다. 새 작업을 만들어보세요.',
      'tasks.pause': '일시중지',
      'tasks.resume': '재개',
      'tasks.runNow': '지금 실행',
      'tasks.cancelTask': '작업 취소',
      'tasks.recheckTask': '진행 상태 재확인',
      'tasks.progress': '진행률',
      'tasks.delete': '삭제',
      'tasks.nextRun': '다음 실행',
      'tasks.lastRun': '마지막 실행',
      'tasks.never': '없음',
      'tasks.owner': '나',

      // Gmail Ambient Composer
      'gmail.confirmSend': '이메일 내용을 확인하세요',
      'gmail.confirmReply': '답장 내용을 확인하세요',
      'gmail.confirmDraft': '초안 내용을 확인하세요',
      'gmail.to': '받는 사람',
      'gmail.cc': '참조',
      'gmail.bcc': '숨은 참조',
      'gmail.subject': '제목',
      'gmail.body': '본문',
      'gmail.account': '계정',
      'gmail.threadId': '스레드',
      'gmail.replyToMessageId': '답장 대상 메시지',
      'gmail.recipientHint': '언급하신 대상',
      'gmail.recipientHintSuffix': '— 정확한 이메일 주소를 입력하세요.',
      'gmail.toRequired': '"받는 사람" 이메일 주소를 최소 1개 이상 입력해야 합니다.',
      'gmail.previewAndRequestApproval': '미리보기 및 승인 요청',
      'gmail.connectPrompt': 'Gmail이 연결되어 있지 않아 이 단계를 진행할 수 없습니다.',
      'gmail.connectButton': 'Gmail 연결',
      'gmail.connectNotConfigured': '이 서버에는 아직 Google이 구성되어 있지 않습니다.',
      'gmail.requestingApproval': '승인 요청 중…',
      'gmail.sending': '이메일 전송 중…',
      'gmail.replying': '답장 전송 중…',
      'gmail.savingDraft': '초안 저장 중…',
      'gmail.sent': '이메일이 전송되었습니다',
      'gmail.replySent': '답장이 전송되었습니다',
      'gmail.draftCreated': '초안이 생성되었습니다',
      'gmail.openInGmail': 'Gmail에서 열기 →',
      'gmail.searching': 'Gmail 검색 중…',
      'gmail.searchResults': '검색 결과',
      'gmail.noResults': '일치하는 이메일이 없습니다.',
      'gmail.loadingThread': '스레드 불러오는 중…',
      'gmail.threadMessages': '이 스레드의 메시지',
      'gmail.approveAndSend': '승인 및 전송',
      'gmail.approveAndReply': '승인 및 답장',
      'gmail.approveAndCreateDraft': '승인 및 초안 생성',
      'gmail.reject': '거부',

      // Browser Agent MVP
      'browser.openingWebsite': '웹사이트 여는 중...',
      'browser.readingPage': '페이지 읽는 중...',
      'browser.connectPrompt': '이 서버에서는 브라우저 런타임을 사용할 수 없습니다.',
      'browser.sessionBlocked': '이 브라우저 세션은 사람의 확인(캡차/2단계 인증)이 필요하여 자동으로 계속할 수 없습니다.',

      // Telegram Integration
      'telegram.title': '텔레그램 연동',
      'telegram.subtitle': '텔레그램 봇을 통해 모바일에서도 NAgex와 메시지를 주고받을 수 있습니다.',
      'telegram.linkIdentity': '텔레그램 사용자 ID 연결',
      'telegram.linkedUsers': '연결된 사용자',
      'telegram.botStatus': '봇 상태',

      // Slack Integration
      'slack.title': '슬랙 연동',
      'slack.subtitle': '슬랙 워크스페이스 채널 이벤트를 수신하고 답변을 전송합니다.',
      'slack.linkIdentity': '슬랙 사용자 ID 연결',
      'slack.linkedUsers': '연결된 사용자',
      'slack.botStatus': '봇 상태',

      // Notifications
      'notifications.title': '알림',
      'notifications.subtitle': '웹, 텔레그램, 슬랙을 통한 실시간 멀티채널 프로액티브 알림입니다.',
      'notifications.markAllRead': '모두 읽음으로 표시',
      'notifications.empty': '알림이 없습니다.',
      'browser.approvalRequired': '실행 전에 이 작업을 확인하세요',
      'browser.target': '대상',
      'browser.currentPage': '현재 페이지',
      'browser.approveAndClick': '승인 및 클릭',
      'browser.reject': '거부',
      'browser.actionCompleted': '작업이 완료되었습니다',
      'browser.openLink': '새 탭에서 열기 →',

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
