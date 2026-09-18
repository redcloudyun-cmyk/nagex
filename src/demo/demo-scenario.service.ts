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

  private events(state: ScopeState): Array<Record<string, unknown>> {
    const seeded: Array<Record<string, unknown>> = this.fixture.events.map((event) => ({ ...event, start_time: this.todayAt(event.time), start: { dateTime: this.todayAt(event.time) }, summary: event.title }));
    return [...seeded, ...state.addedEvents];
  }

  private meetingPrep(): Record<string, unknown> {
    const event = this.fixture.events.find((item) => item.id === 'demo_evt_client')!;
    return {
      event_id: event.id,
      event_title: event.title,
      title: event.title,
      starts_at: this.todayAt(event.time),
      attendees: event.attendees,
      reason: 'Pricing and delivery timing need a decision.',
      related_materials: [
        { type: 'VAULT', id: 'demo_vault_notes', title: 'Last meeting notes', summary: 'Pricing flexibility discussed; timeline unresolved.' },
        { type: 'VAULT', id: 'demo_vault_proposal', title: 'Proposal v3', summary: 'Pricing, delivery date, scope, and one open decision.' },
        { type: 'EMAIL', id: this.fixture.email.id, title: `Recent email from ${this.fixture.email.from}`, summary: this.fixture.email.summary },
        { type: 'MEMORY', id: 'demo_memory_brief', title: this.fixture.persona.preference },
        { type: 'TASK', id: this.fixture.task.id, title: this.fixture.task.title }
      ],
      key_points: ['The client asked about pricing flexibility.', 'An earlier delivery date is under discussion.', 'The previous meeting left the timeline unresolved.'],
      suggested_agenda: ['Confirm the delivery timeline', 'Discuss pricing options', 'Resolve the analytics add-on decision']
    };
  }

  public handle(method: string, pathname: string, body: Record<string, unknown> | null, headers?: Record<string, string | string[] | undefined>): ApiResult | undefined {
    const scopeKey = this.getScopeKey(headers);
    const state = this.getState(scopeKey);

    if (pathname === '/api/v1/demo/reset' && method === 'POST') {
      this.reset(scopeKey);
      return { status: 200, data: { success: true, message: 'Demo reset complete.' } };
    }
    if (pathname === '/api/v1/demo/state' && method === 'GET') {
      return { status: 200, data: { persona: this.fixture.persona, mutationCount: state.mutationCount, addedEvents: state.addedEvents, approvalCount: state.approvals.size } };
    }
    if (pathname === '/api/v1/personal/morning-brief' && method === 'GET') {
      return { status: 200, data: { dataSource: 'DEMO', persona: this.fixture.persona, calendarStatus: 'CONNECTED', gmailStatus: 'CONNECTED', schedule_summary: { count: this.events(state).length, events: this.events(state) }, email_summary: { important_count: 1, emails: [this.fixture.email] }, task_summary: { due_today: 1, tasks: [this.fixture.task] }, recommendation: { title: 'Client strategy meeting · 3:00 PM', reason: 'Pricing and delivery timing need your attention.', action_type: 'MEETING_PREP', target_id: 'demo_evt_client' } } };
    }
    if (pathname === '/api/v1/personal/quick-wake' && method === 'GET') {
      return { status: 200, data: { dataSource: 'DEMO', proactive_suggestion: { title: 'Your client meeting is coming up.', reason: 'You have related context ready.', target_id: 'demo_evt_client', grounded_on: [{ type: 'VAULT', id: 'demo_vault_notes', label: 'Last meeting notes' }, { type: 'VAULT', id: 'demo_vault_proposal', label: 'Proposal v3' }, { type: 'EMAIL', id: this.fixture.email.id, label: 'Recent email from Sarah' }] } } };
    }
    if (pathname === '/api/v1/personal/meeting-prep' && method === 'POST') return { status: 200, data: this.meetingPrep() };
    if (pathname === '/api/v1/my-space' && method === 'GET') return { status: 200, data: { calendarStatus: 'CONNECTED', calendar: this.events(state), history: [] } };
    if (pathname === '/api/v1/tasks' && method === 'GET') return { status: 200, data: { tasks: [{ taskId: this.fixture.task.id, name: this.fixture.task.title, objective: this.fixture.task.title, status: 'ACTIVE', nextRunAt: this.todayAt('16:30') }] } };
    if (pathname === '/api/v1/memory' && method === 'GET') return { status: 200, data: { memories: [{ id: 'demo_memory_brief', scope: 'USER', lifecycle: 'ACTIVE', content: { subject: 'Meeting brief preference', predicate: 'prefers', value: this.fixture.persona.preference } }] } };
    if (pathname === '/api/v1/notifications' && method === 'GET') return { status: 200, data: { unreadCount: 1, notifications: [{ id: 'demo_notification_client', type: 'MEETING_PREP', title: 'Client strategy meeting approaching', body: 'Pricing and timeline context is ready.', read: false, relatesAt: this.todayAt('15:00'), createdAt: this.todayAt('13:00'), channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }] }] } };
    if (pathname === '/api/v1/workspace/vault' && method === 'GET') return { status: 200, data: { items: [...this.fixture.vault, ...state.savedVault], recentItems: [...this.fixture.vault, ...state.savedVault], total: this.fixture.vault.length + state.savedVault.length } };
    if (pathname === '/api/v1/workspace/vault' && method === 'POST') {
      const item = { ...body, vaultItemId: `demo_vault_saved_${state.savedVault.length + 1}`, createdAt: new Date().toISOString(), dataSource: 'DEMO' };
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
