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

  constructor(fixturePath = path.join(process.cwd(), 'demo', 'seed', 'canonical-persona.json')) {
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

  private email(isKo = false) {
    if (!isKo) return this.fixture.email;
    return {
      id: this.fixture.email.id,
      from: 'Sarah Chen',
      subject: '다음 단계를 위한 가격 정책 및 일정 문의',
      summary: 'Sarah가 가격 조정 및 납품 일정 조기 조율이 가능한지 문의했습니다.'
    };
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

  private meetingPrep(isKo = false): Record<string, unknown> {
    const event = this.fixture.events.find((item) => item.id === 'demo_evt_client')!;
    const title = isKo ? '클라이언트 전략 미팅' : event.title;
    return {
      event_id: event.id,
      event_title: title,
      title: title,
      starts_at: this.todayAt(event.time),
      attendees: event.attendees,
      reason: isKo ? '가격 정책 및 일정 조율 결정이 필요합니다.' : 'Pricing and delivery timing need a decision.',
      related_materials: [
        { type: 'VAULT', id: 'demo_vault_notes', title: isKo ? '지난 미팅 노트' : 'Last meeting notes', summary: isKo ? '가격 조율 논의; 일정 미확정.' : 'Pricing flexibility discussed; timeline unresolved.' },
        { type: 'VAULT', id: 'demo_vault_proposal', title: 'Proposal v3', summary: isKo ? '가격, 납품일, 범위 및 미결정 항목.' : 'Pricing, delivery date, scope, and one open decision.' },
        { type: 'EMAIL', id: this.fixture.email.id, title: isKo ? 'Sarah Chen의 최근 이메일' : `Recent email from ${this.fixture.email.from}`, summary: isKo ? 'Sarah가 가격 조정 및 납품 일정 조기 조율이 가능한지 문의했습니다.' : this.fixture.email.summary },
        { type: 'MEMORY', id: 'demo_memory_brief', title: isKo ? '간결한 미팅 브리핑 선호' : this.fixture.persona.preference },
        { type: 'TASK', id: this.fixture.task.id, title: isKo ? '클라이언트 미팅 후 팔로업 작성' : this.fixture.task.title }
      ],
      key_points: isKo ? [
        '클라이언트가 가격 정책 유연성을 문의했습니다.',
        '조기 납품 일정 조율이 논의 중입니다.',
        '이전 미팅에서 전체 일정이 확정되지 않았습니다.'
      ] : [
        'The client asked about pricing flexibility.',
        'An earlier delivery date is under discussion.',
        'The previous meeting left the timeline unresolved.'
      ],
      suggested_agenda: isKo ? [
        '납품 일정 확정',
        '가격 옵션 논의',
        '애널리틱스 옵션 추가 결정'
      ] : [
        'Confirm the delivery timeline',
        'Discuss pricing options',
        'Resolve the analytics add-on decision'
      ]
    };
  }

  public handle(method: string, pathname: string, body: Record<string, unknown> | null, headers?: Record<string, string | string[] | undefined>): ApiResult | undefined {
    const scopeKey = this.getScopeKey(headers);
    const state = this.getState(scopeKey);
    const loc = this.getLocale(headers);
    const isKo = loc === 'ko';

    if (pathname === '/api/v1/demo/reset' && method === 'POST') {
      this.reset(scopeKey);
      return { status: 200, data: { success: true, message: 'Demo reset complete.' } };
    }
    if (pathname === '/api/v1/demo/state' && method === 'GET') {
      return { status: 200, data: { persona: this.fixture.persona, mutationCount: state.mutationCount, addedEvents: state.addedEvents, approvalCount: state.approvals.size } };
    }
    if (pathname === '/api/v1/personal/home' && method === 'GET') {
      const pendingApprovals = [...state.approvals.values()].filter((item) => item.status === 'PENDING');
      let rightNow: Record<string, unknown> | null = null;
      const rightNowSourceIds = new Set<string>();

      if (pendingApprovals.length > 0) {
        const topApr = pendingApprovals[0];
        const aprPayload = (topApr.canonicalPayload || {}) as any;
        const aprTitle = aprPayload.summary || topApr.approvalId;
        rightNow = {
          type: 'APPROVAL',
          title: isKo ? `승인 필요: ${aprTitle}` : `Approval Required: ${aprTitle}`,
          summary: isKo ? '작업 실행 전 사용자 승인이 필요합니다.' : 'Action requires human authorization before proceeding.',
          sourceRef: topApr.approvalId,
          action: { type: 'REVIEW_APPROVAL', label: isKo ? '검토' : 'Review' },
          occurredAt: new Date().toISOString(),
        };
        rightNowSourceIds.add(topApr.approvalId);
      } else {
        const meetingTitle = isKo ? '클라이언트 전략 미팅' : 'Client strategy meeting';
        rightNow = {
          type: 'MEETING',
          title: meetingTitle,
          summary: isKo ? '가격 정책 및 일정 조율 검토가 필요합니다.' : 'Pricing and delivery timing need your attention.',
          sourceRef: 'demo_evt_client',
          startsAt: this.todayAt('15:00'),
          action: {
            type: 'PREPARE_MEETING',
            label: isKo ? '미팅 준비' : 'Review prep'
          }
        };
        rightNowSourceIds.add('demo_evt_client');
      }

      const allEvents = this.events(state, isKo);
      const meetings = allEvents.map((e: any) => ({
        id: e.id,
        title: e.title,
        startsAt: e.start_time || e.start?.dateTime || this.todayAt('15:00'),
        summary: e.title,
      }));

      const todayTaskObj = this.task(isKo);
      const todayEmailObj = this.email(isKo);

      const today = {
        briefStatus: 'AVAILABLE',
        freshness: 'FRESH',
        summary: isKo
          ? '오늘 3개의 주요 일정이 있습니다. 클라이언트 미팅을 포함한 최신 컨텍스트가 준비되었습니다.'
          : 'You have 3 scheduled events today. Client strategy meeting context is ready.',
        meetings,
        counts: {
          meetings: meetings.length,
          emails: 1,
          tasks: 1,
          approvals: pendingApprovals.length,
        },
      };

      const needsAttention: Array<Record<string, unknown>> = [];
      for (const apr of pendingApprovals) {
        if (rightNowSourceIds.has(apr.approvalId)) continue;
        needsAttention.push({
          id: `attn_${apr.approvalId}`,
          type: 'APPROVAL',
          title: `Approval Required`,
          summary: `Action requires human confirmation`,
          sourceType: 'APPROVAL',
          sourceId: apr.approvalId,
          action: { type: 'REVIEW_APPROVAL', label: isKo ? '검토' : 'Review' },
        });
      }

      const preparedForYou: Array<Record<string, unknown>> = [
        {
          id: 'prep_demo_proposal',
          type: 'PROPOSAL',
          title: isKo ? 'Proposal v3 검토 준비' : 'Proposal v3 ready for review',
          summary: isKo ? '가격 $48,000 및 납품 일정 조율안.' : 'Pricing $48,000 and timeline options.',
          sourceType: 'PROPOSAL',
          sourceId: 'demo_vault_proposal',
          action: { type: 'VIEW_PREPARATION', label: isKo ? '초안 검토' : 'Review Draft' },
        }
      ];

      const workingForYou: Array<Record<string, unknown>> = [
        {
          id: 'wrk_demo_task',
          type: 'TASK',
          title: todayTaskObj.title,
          summary: todayTaskObj.title,
          sourceType: 'TASK',
          sourceId: todayTaskObj.id,
        }
      ];

      const vaultItemsList = this.vaultItems(state, isKo);
      const recentResults: Array<Record<string, unknown>> = vaultItemsList.slice(0, 3).map((v: any) => ({
        id: `res_${v.vaultItemId}`,
        type: 'DOCUMENT',
        title: v.title,
        summary: (v.metadata as any)?.summary || v.title,
        sourceType: 'ACTIVITY',
        sourceId: v.vaultItemId,
        createdAt: v.createdAt,
      }));

      return {
        status: 200,
        data: {
          generatedAt: new Date().toISOString(),
          rightNow,
          today,
          needsAttention,
          preparedForYou,
          workingForYou,
          recentResults,
          sourceStatus: {
            calendar: 'CONNECTED',
            gmail: 'CONNECTED',
            activity: 'OK',
            tasks: 'OK',
          },
          userProfile: {
            name: this.fixture.persona.name || 'Alex'
          }
        }
      };
    }
    if (pathname === '/api/v1/personal/morning-brief' && method === 'GET') {
      return {
        status: 200,
        data: {
          dataSource: 'DEMO',
          persona: this.fixture.persona,
          calendarStatus: 'CONNECTED',
          gmailStatus: 'CONNECTED',
          schedule_summary: { count: this.events(state, isKo).length, events: this.events(state, isKo) },
          email_summary: { important_count: 1, emails: [this.email(isKo)] },
          task_summary: { due_today: 1, tasks: [this.task(isKo)] },
          recommendation: {
            title: isKo ? '클라이언트 전략 미팅 · 오후 3:00' : 'Client strategy meeting · 3:00 PM',
            reason: isKo ? '가격 정책 및 일정 조율 검토가 필요합니다.' : 'Pricing and delivery timing need your attention.',
            action_type: 'MEETING_PREP',
            target_id: 'demo_evt_client'
          }
        }
      };
    }
    if (pathname === '/api/v1/personal/quick-wake' && method === 'GET') {
      return {
        status: 200,
        data: {
          dataSource: 'DEMO',
          proactive_suggestion: {
            title: isKo ? '클라이언트 미팅 일정이 다가오고 있습니다.' : 'Your client meeting is coming up.',
            reason: isKo ? '관련 컨텍스트가 준비되었습니다.' : 'You have related context ready.',
            target_id: 'demo_evt_client',
            grounded_on: [
              { type: 'VAULT', id: 'demo_vault_notes', label: isKo ? '지난 미팅 노트' : 'Last meeting notes' },
              { type: 'VAULT', id: 'demo_vault_proposal', label: 'Proposal v3' },
              { type: 'EMAIL', id: this.fixture.email.id, label: isKo ? 'Sarah Chen의 최근 이메일' : 'Recent email from Sarah' }
            ]
          }
        }
      };
    }
    if (pathname === '/api/v1/personal/meeting-prep' && method === 'POST') return { status: 200, data: this.meetingPrep(isKo) };
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
