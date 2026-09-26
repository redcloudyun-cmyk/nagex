import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ApiResult } from '../http/http-types.js';

type Fixture = {
  persona: { name: string; locale: string; profile: string; preference: string };
  events: Array<{ id: string; time: string; title: string; attendees: string[] }>;
  email: { id: string; from: string; subject: string; summary: string };
  vault: Array<{ id: string; title: string; content: string }>;
  task: { id: string; title: string };
};

type DemoApproval = { approvalId: string; status: 'PENDING' | 'APPROVED' | 'CONSUMED'; canonicalPayload: Record<string, unknown> };

type ScopeState = {
  approvals: Map<string, DemoApproval>;
  addedEvents: Array<Record<string, unknown>>;
  savedVault: Array<Record<string, unknown>>;
  mutationCount: number;
};

export class DemoScenarioService {
  private readonly fixture: Fixture;
  private scopes = new Map<string, ScopeState>();

  constructor(
    fixturePath = path.join(process.cwd(), 'demo', 'seed', 'canonical-persona.json'),
    private readonly reseedCanonicalMemory: () => void = () => {},
    // R23.2D — resets the real Task/Vault/Approval demo records this
    // service no longer owns itself (see DemoCanonicalSeedService).
    private readonly reseedCanonicalStores: () => void = () => {},
  ) {
    this.fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture;
  }

  private getLocale(headers?: Record<string, string | string[] | undefined>): 'ko' | 'en' {
    if (!headers) return 'en';
    const get = (key: string) => {
      const v = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const loc = get('x-nagex-locale') || get('accept-language') || get('x-locale') || get('cookie');
    if (loc && (loc.toLowerCase().includes('ko') || loc.includes('nagex_locale=ko'))) return 'ko';
    return 'en';
  }

  private getScopeKey(headers?: Record<string, string | string[] | undefined>): string {
    if (!headers) return 'default';
    const get = (key: string) => {
      const v = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const session = get('x-nagex-demo-session') || get('x-session-id') || get('cookie');
    const tenant = get('x-nagex-tenant') || get('x-tenant-id');
    const principal = get('x-principal-id');
    if (session) return `session:${session}`;
    if (tenant || principal) return `${tenant || 'ten_demo_hackathon'}:${principal || 'usr_demo_alex'}`;
    return 'default';
  }

  private getState(scopeKey: string): ScopeState {
    let state = this.scopes.get(scopeKey);
    if (!state) {
      state = { approvals: new Map(), addedEvents: [], savedVault: [], mutationCount: 0 };
      this.scopes.set(scopeKey, state);
    }
    return state;
  }

  public reset(scopeKey?: string): void {
    if (scopeKey && scopeKey !== 'default') {
      const state = this.scopes.get(scopeKey);
      if (state) {
        state.approvals.clear();
        state.addedEvents = [];
        state.savedVault = [];
        state.mutationCount = 0;
      }
    } else {
      this.scopes.clear();
    }
  }

  private todayAt(time: string): string {
    const [hour, minute] = time.split(':').map(Number);
    const value = new Date();
    value.setHours(hour, minute, 0, 0);
    return value.toISOString();
  }

  private events(state: ScopeState, isKo = false): Array<Record<string, unknown>> {
    const seeded: Array<Record<string, unknown>> = this.fixture.events.map((event) => {
      let title = event.title;
      if (isKo) {
        if (event.id === 'demo_evt_q3') title = 'Q3 보고서 초안 검토';
        else if (event.id === 'demo_evt_research') title = '제품 리서치 싱크';
        else if (event.id === 'demo_evt_client') title = '클라이언트 전략 미팅';
      }
      return {
        ...event,
        title,
        summary: title,
        start_time: this.todayAt(event.time),
        start: { dateTime: this.todayAt(event.time) }
      };
    });
    return [...seeded, ...state.addedEvents];
  }

  private task(isKo = false) {
    if (!isKo) return this.fixture.task;
    return {
      id: this.fixture.task.id,
      title: '클라이언트 미팅 후 팔로업 작성'
    };
  }

  private vaultItems(state: ScopeState, isKo = false): Array<Record<string, unknown>> {
    const seeded: Array<Record<string, unknown>> = this.fixture.vault.map((item) => {
      let title = item.title;
      let summary = item.content;
      let type: string = 'DOCUMENT';

      if (item.id === 'demo_vault_notes') {
        type = 'SAVED_ANALYSIS';
        if (isKo) {
          title = '지난 미팅 노트';
          summary = '가격 조율 논의; 일정 미확정. 클라이언트 미팅 후 팔로업 필요.';
        }
      } else if (item.id === 'demo_vault_proposal') {
        type = 'DOCUMENT';
        if (isKo) {
          summary = '현재 가격 $48,000. 납품일 10월 18일. 범위: 전략, 구현, 런칭 지원. 미결정: 애널리틱스 옵션 포함 여부.';
        }
      }

      return {
        vaultItemId: item.id,
        userId: 'usr_demo_alex',
        tenantId: 'ten_demo_hackathon',
        workspaceId: 'ws_demo_01',
        type,
        title,
        mimeType: type === 'SAVED_ANALYSIS' ? 'text/markdown' : 'application/pdf',
        storageRef: `demo://vault/${item.id}`,
        source: 'DEMO_SEED',
        sourceRef: undefined,
        metadata: { summary, sizeBytes: 1024 },
        createdAt: item.id === 'demo_vault_proposal' ? '2026-09-05T09:00:00.000Z' : '2026-09-05T08:30:00.000Z',
        updatedAt: item.id === 'demo_vault_proposal' ? '2026-09-05T09:00:00.000Z' : '2026-09-05T08:30:00.000Z'
      };
    });

    return [...seeded, ...state.savedVault];
  }

  public handle(method: string, pathname: string, body: Record<string, unknown> | null, headers?: Record<string, string | string[] | undefined>): ApiResult | undefined {
    const scopeKey = this.getScopeKey(headers);
    const state = this.getState(scopeKey);
    const loc = this.getLocale(headers);
    const isKo = loc === 'ko';

    if (pathname === '/api/v1/demo/reset' && method === 'POST') {
      this.reset(scopeKey);
      this.reseedCanonicalMemory();
      this.reseedCanonicalStores();
      return { status: 200, data: { success: true, message: 'Demo reset complete.' } };
    }
    if (pathname === '/api/v1/demo/state' && method === 'GET') {
      return { status: 200, data: { persona: this.fixture.persona, mutationCount: state.mutationCount, addedEvents: state.addedEvents, approvalCount: state.approvals.size } };
    }
    // R23.2D — Demo Canonicalization: GET /api/v1/personal/home is
    // DELIBERATELY not handled here anymore. It used to return a fully
    // hardcoded response shape (including fabricated fallback text like
    // "Client strategy meeting" / "Pricing and delivery timing need your
    // attention.") that never reached PersonalHomeService/
    // RightNowIntelligenceService/CurrentPersonalContextService at all
    // (DEMO_FAKE_PERSONAL_HOME=0 now). Returning undefined here lets
    // server_web.ts's normal dispatch fall through to the real
    // handlePersonalHomeRoutes, which reads the same demo-tenant records
    // DemoCanonicalSeedService seeds into the real Task/Vault/Approval/
    // Memory stores (see create-nagex-application.ts) — the demo and real
    // paths now differ only in data source, never in service logic
    // (DEMO_PARALLEL_INTELLIGENCE_PIPELINE=0). GET /api/v1/personal/
    // right-now was never intercepted here in the first place and already
    // reached the real RightNowIntelligenceService pipeline.
    // R23.3 — GET /api/v1/personal/morning-brief, GET .../quick-wake, and
    // POST .../meeting-prep are DELIBERATELY not handled here anymore, for
    // the exact same reason /api/v1/personal/home stopped being handled
    // here in R23.2D: they used to return fully hardcoded content
    // ("Client strategy meeting · 3:00 PM", "Pricing and delivery timing
    // need your attention.", "Your client meeting is coming up.", "Recent
    // email from Sarah") that never reached PersonalAssistantEngine at
    // all. Returning undefined here lets server_web.ts's normal dispatch
    // fall through to the real personal-assistant.routes.ts handlers,
    // which call generateMorningBrief/executeQuickWake/
    // generateMeetingPrepCard — now wired (see create-nagex-application.ts)
    // to the same demo-tenant-aware Calendar/Gmail sources and the same
    // ProactiveSuggestionService every real tenant uses
    // (DEMO_PROACTIVE_PARALLEL_PATH=0, DEMO_SUGGESTION_ENGINE_COUNT=1).
    if (pathname === '/api/v1/my-space' && method === 'GET') return { status: 200, data: { calendarStatus: 'CONNECTED', calendar: this.events(state, isKo), history: [] } };
    if (pathname === '/api/v1/tasks' && method === 'GET') {
      const taskObj = this.task(isKo);
      return { status: 200, data: { tasks: [{ taskId: taskObj.id, name: taskObj.title, objective: taskObj.title, status: 'ACTIVE', nextRunAt: this.todayAt('16:30') }] } };
    }
    if (pathname === '/api/v1/notifications' && method === 'GET') {
      return {
        status: 200,
        data: {
          unreadCount: 1,
          notifications: [{
            id: 'demo_notification_client',
            type: 'MEETING_PREP',
            title: isKo ? '클라이언트 전략 미팅 임두' : 'Client strategy meeting approaching',
            body: isKo ? '가격 및 일정 컨텍스트 준비 완료.' : 'Pricing and timeline context is ready.',
            read: false,
            relatesAt: this.todayAt('15:00'),
            createdAt: this.todayAt('13:00'),
            channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }]
          }]
        }
      };
    }
    if (pathname === '/api/v1/workspace/vault' && method === 'GET') {
      const items = this.vaultItems(state, isKo);
      const usedSizeBytes = items.reduce((acc, i) => acc + (typeof (i.metadata as any)?.sizeBytes === 'number' ? (i.metadata as any).sizeBytes : 1024), 0);
      return {
        status: 200,
        data: {
          items,
          recentItems: items,
          total: items.length,
          usedSizeBytes,
          quotaSizeBytes: 10737418240,
          query: null,
          storageInfo: {
            provider: 'local',
            isCloud: false,
            label: 'NAgex Personal Vault'
          }
        }
      };
    }
    if (pathname === '/api/v1/workspace/vault' && method === 'POST') {
      const now = new Date().toISOString();
      const idNum = state.savedVault.length + 1;
      const vaultItemId = `demo_vault_saved_${idNum}`;
      const title = typeof body?.title === 'string' ? body.title : 'Saved Vault Item';
      const type = typeof body?.type === 'string' ? body.type : 'DOCUMENT';
      const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
      const storageRef = typeof body?.storageRef === 'string' ? body.storageRef : `demo://vault/saved_${idNum}`;
      const source = typeof body?.source === 'string' ? body.source : 'MANUAL_SAVE';
      const sourceRef = typeof body?.sourceRef === 'string' ? body.sourceRef : undefined;
      const metadata = body?.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : {};

      const item: Record<string, unknown> = {
        vaultItemId,
        userId: 'usr_demo_alex',
        tenantId: 'ten_demo_hackathon',
        workspaceId: 'ws_demo_01',
        type,
        title,
        mimeType,
        storageRef,
        source,
        sourceRef,
        metadata,
        createdAt: now,
        updatedAt: now,
        dataSource: 'DEMO'
      };

      state.savedVault.push(item);
      return { status: 201, data: item };
    }
    if (pathname === '/api/v1/tools/google-calendar/free-slots' && method === 'POST') {
      const start = new Date(); start.setDate(start.getDate() + ((2 - start.getDay() + 7) % 7 || 7)); start.setHours(14, 30, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return { status: 200, data: { freeSlots: [{ start: start.toISOString(), end: end.toISOString() }], dataSource: 'DEMO' } };
    }
    if (pathname === '/api/v1/approvals' && method === 'GET') return { status: 200, data: { approvals: [...state.approvals.values()].filter((item) => item.status === 'PENDING') } };
    if (pathname === '/api/v1/approvals' && method === 'POST') {
      const approval: DemoApproval = { approvalId: `demo_apr_${crypto.randomUUID()}`, status: 'PENDING', canonicalPayload: (body?.payload as Record<string, unknown>) || {} };
      state.approvals.set(approval.approvalId, approval);
      return { status: 201, data: approval };
    }
    const approvalMatch = pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/(approve|reject)$/);
    if (approvalMatch && method === 'POST') {
      const approval = state.approvals.get(approvalMatch[1]);
      if (!approval) return { status: 404, data: { error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found.' } } };
      if (approvalMatch[2] === 'reject') { state.approvals.delete(approval.approvalId); return { status: 200, data: { ...approval, status: 'REJECTED' } }; }
      approval.status = 'APPROVED';
      return { status: 200, data: approval };
    }
    if (pathname === '/api/v1/tools/google-calendar/create-event' && method === 'POST') {
      const approval = state.approvals.get(String(body?.approvalId || ''));
      if (!approval || approval.status !== 'APPROVED') return { status: 409, data: { error: { code: 'APPROVAL_REQUIRED', message: 'Approval is required.' } } };
      approval.status = 'CONSUMED';
      state.mutationCount += 1;
      const event = { ...approval.canonicalPayload, id: `demo_evt_followup_${state.mutationCount}`, summary: approval.canonicalPayload.summary, start: { dateTime: approval.canonicalPayload.start }, dataSource: 'DEMO' };
      state.addedEvents.push(event);
      return {
        status: 200,
        data: {
          status: 'SUCCEEDED',
          executionMode: 'DEMO',
          providerVerified: false,
          provider: 'DEMO',
          dataSource: 'DEMO',
          externalId: event.id,
          externalUrl: '',
          completedAt: new Date().toISOString()
        }
      };
    }
    return undefined;
  }
}
