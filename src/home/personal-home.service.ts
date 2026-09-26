import type { DailyBriefStore, DailyBriefRecord } from '../governance/daily-brief.store.js';
import type { ActivityStore, ActivityItem } from '../governance/activity.store.js';
import type { ActionProposalStore, ActionProposalRecord } from '../assistant/action-proposal.store.js';
import type { CreationStore } from '../creation/creation.store.js';
import type { IdentityStore } from '../identity/identity.store.js';
import type { CurrentPersonalContextService, ContextApproval, ContextTask, ContextEvent, CurrentPersonalContext } from '../personal/current-personal-context.service.js';
import type { RightNowIntelligenceService, RightNowItem, RightNowItemKind } from '../personal/right-now-intelligence.service.js';
import type { ProactiveSuggestion } from '../personal/proactive-suggestion.service.js';

export interface HomeCalendarItem {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  summary?: string;
}

export interface HomeItemAction {
  type: string;
  label: string;
  targetUrl?: string;
}

export interface HomeItem {
  id: string;
  type: string;
  title: string;
  summary?: string;
  sourceType:
    | 'APPROVAL'
    | 'ACTIVITY'
    | 'TASK'
    | 'CALENDAR'
    | 'INBOX'
    | 'PROPOSAL'
    | 'BRIEF';
  sourceId: string;
  createdAt?: string;
  dueAt?: string;
  startsAt?: string;
  action?: HomeItemAction;
}

export interface PersonalHomeRightNow {
  // R23.2 — 'TASK' and 'REMINDER' are new: RightNowIntelligenceService can
  // now surface a RUNNING/ACTIVE task or a due/near-term reminder as the
  // single primary item, neither of which the pre-R23.2 hand-rolled
  // resolver ever considered. 'BLOCKED_TASK'/'ATTENTION' are kept in the
  // union for response-shape compatibility but are no longer emitted by
  // this service (WAITING/FAILED tasks now surface as 'TASK', with the
  // real blocked reason in `summary`).
  type: 'APPROVAL' | 'MEETING' | 'ATTENTION' | 'BLOCKED_TASK' | 'TASK' | 'REMINDER' | 'INBOX';
  title: string;
  summary: string;
  sourceRef: string;
  action?: HomeItemAction;
  occurredAt?: string;
  startsAt?: string;
}

export interface PersonalHomeResponse {
  generatedAt: string;
  rightNow: PersonalHomeRightNow | null;
  // R23.3 v1.1 — the same RightNowIntelligence.upcoming list (already
  // computed in the one evaluate() call this response's rightNow/
  // suggestions also come from), embedded so the "Next" list never needs
  // its own GET /api/v1/personal/right-now fetch either.
  upcoming: RightNowItem[];
  today: {
    briefStatus: string;
    freshness: 'FRESH' | 'STALE' | null;
    summary: string | null;
    meetings: HomeCalendarItem[];
    counts: {
      meetings: number;
      emails: number;
      tasks: number;
      approvals: number;
    };
  };
  needsAttention: HomeItem[];
  preparedForYou: HomeItem[];
  workingForYou: HomeItem[];
  recentResults: HomeItem[];
  // R23.3 v1.1 — the canonical ProactiveSuggestion list (same instance
  // RightNowIntelligenceService/ProactiveSuggestionService produce
  // everywhere else), embedded here so Desktop/Mobile never need a second
  // GET /api/v1/personal/right-now fetch (and therefore a second
  // buildCurrentContext call) just to render "Suggested for you".
  suggestions: ProactiveSuggestion[];
  sourceStatus: {
    calendar: string;
    gmail: string;
    activity: string;
    tasks: string;
  };
  userProfile?: {
    name: string | null;
  };
}

export interface GetPersonalHomeParams {
  tenantId: string;
  principalId: string;
  dateKey?: string;
  requestId?: string;
}

// R23.2 — action-type/label per RightNowItem kind, so the mapping below
// stays a straight lookup rather than a re-implemented priority ladder.
const RIGHT_NOW_ACTION_BY_KIND: Record<RightNowItemKind, HomeItemAction> = {
  APPROVAL: { type: 'REVIEW_APPROVAL', label: 'Review' },
  TASK: { type: 'INSPECT_TASK', label: 'Inspect' },
  MEETING: { type: 'PREPARE_MEETING', label: 'Review prep' },
  REMINDER: { type: 'VIEW_REMINDER', label: 'View' },
  INBOX: { type: 'REVIEW_CAPTURE', label: 'Review' },
};

// Maps RightNowIntelligenceService's canonical primary item onto the
// pre-existing PersonalHomeRightNow response shape (RESPONSE COMPATIBILITY
// PRESERVED: same field names/types the R22.8 consumer already expects;
// only the *value*/selection logic changed, from PersonalHomeService's own
// hand-rolled ladder to the one canonical deterministic ranking).
function mapPrimaryToHomeRightNow(item: RightNowItem): PersonalHomeRightNow {
  return {
    type: item.kind,
    title: item.title,
    summary: item.reason,
    sourceRef: item.sourceRef.id,
    action: RIGHT_NOW_ACTION_BY_KIND[item.kind],
    occurredAt: item.timestamp,
    startsAt: item.kind === 'MEETING' ? item.timestamp : undefined,
  };
}

export class PersonalHomeService {
  constructor(
    private readonly deps: {
      // R23.1 — Calendar/Task/Approval aggregation now flows exclusively
      // through this one canonical pipeline (CONTEXT_AGGREGATION_PIPELINE_
      // COUNT=1) instead of PersonalHomeService querying GoogleCalendarService/
      // TaskStore/ActionApprovalStore itself.
      currentPersonalContextService?: CurrentPersonalContextService;
      // R23.2 — the single canonical prioritization pipeline
      // (RIGHT_NOW_INTELLIGENCE_PIPELINE_COUNT=1). PersonalHomeService no
      // longer runs its own hand-rolled approval > blocked-task > meeting >
      // proposal priority ladder for `rightNow` — it maps this service's
      // deterministic `primary` item onto the existing response shape.
      rightNowIntelligenceService?: RightNowIntelligenceService;
      dailyBriefStore?: DailyBriefStore;
      activityStore?: ActivityStore;
      actionProposalStore?: ActionProposalStore;
      creationStore?: CreationStore;
      identityStore?: IdentityStore;
    }
  ) {}

  public async getPersonalHome(params: GetPersonalHomeParams): Promise<PersonalHomeResponse> {
    const { tenantId, principalId, dateKey, requestId = `req_home_${Date.now()}` } = params;
    const now = new Date();
    const todayDateKey = dateKey || now.toISOString().slice(0, 10);

    // 1-3, 6. Calendar/tasks/approvals/their source status — one call into
    // the canonical R23.1 aggregator, never queried directly here. The
    // fetched context is also reused below for R23.2's RightNowIntelligence
    // (single fetch — RIGHT_NOW_INTELLIGENCE_PIPELINE_COUNT=1, never a
    // second buildCurrentContext call for the same request).
    let pendingApprovals: ContextApproval[] = [];
    let userTasks: ContextTask[] = [];
    let calendarEvents: ContextEvent[] = [];
    let calendarStatus = 'CONNECTED';
    let gmailStatus = 'CONNECTED';
    let context: CurrentPersonalContext | null = null;
    if (this.deps.currentPersonalContextService) {
      try {
        context = await this.deps.currentPersonalContextService.buildCurrentContext({ tenantId, userId: principalId, now, requestId });
        pendingApprovals = context.rightNow.pendingApprovals;
        userTasks = context.today.tasks;
        calendarEvents = context.today.events;
        calendarStatus = context.sourceStatus.calendar === 'OK' ? 'CONNECTED' : 'UNAVAILABLE';
        gmailStatus = context.sourceStatus.gmail === 'OK' ? 'CONNECTED' : 'UNAVAILABLE';
      } catch {
        calendarStatus = 'UNAVAILABLE';
        gmailStatus = 'UNAVAILABLE';
      }
    } else {
      calendarStatus = 'UNAVAILABLE';
      gmailStatus = 'UNAVAILABLE';
    }
    let calendarMeetings: HomeCalendarItem[] = calendarEvents.map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
    }));

    // 2. Fetch daily brief
    let dailyBrief: DailyBriefRecord | null = null;
    if (this.deps.dailyBriefStore) {
      try {
        dailyBrief = this.deps.dailyBriefStore.getForDate(tenantId, principalId, todayDateKey);
      } catch {
        dailyBrief = null;
      }
    }

    // 4. Fetch proposals
    let proposals: ActionProposalRecord[] = [];
    if (this.deps.actionProposalStore) {
      try {
        proposals = this.deps.actionProposalStore.listPending(tenantId, principalId);
      } catch {
        proposals = [];
      }
    }

    // 5. Fetch activities
    let activities: ActivityItem[] = [];
    if (this.deps.activityStore) {
      try {
        activities = this.deps.activityStore.list(tenantId, principalId);
      } catch {
        activities = [];
      }
    }

    // Calendar unavailable but a persisted Daily Brief still has a schedule
    // — a DailyBrief-specific fallback, unrelated to the R23.1 aggregator.
    if (calendarMeetings.length === 0 && dailyBrief && Array.isArray(dailyBrief.schedule)) {
      calendarMeetings = dailyBrief.schedule.map((m: any) => ({
        id: m.sourceId || m.id || `m_${Math.random().toString(36).slice(2)}`,
        title: m.title || 'Untitled Meeting',
        startsAt: m.start || m.timestamp || new Date().toISOString(),
        summary: m.capability || m.summary,
      }));
    }

    // 7. Resolve RIGHT NOW.
    // R23.2 — this is no longer PersonalHomeService's own hand-rolled
    // approval > blocked-task > meeting ladder. RightNowIntelligenceService
    // owns the one canonical, explicit, deterministic priority-class
    // ranking (P0 Immediate / P1 Soon / P2 Needs attention today) over the
    // exact same context snapshot already fetched above — no second fetch.
    // A consequence worth stating plainly: under the old ladder a pending
    // approval ALWAYS beat a meeting, regardless of how soon the meeting
    // started; under R23.2's rules a meeting in progress or starting within
    // the near-term window (P0/P1) now outranks a routine pending approval
    // (P2, unless it is blocking an explicitly active action — a signal
    // this snapshot does not carry, so it is never fabricated). This is an
    // intended behavior change, not a regression — see the R23.2 report.
    let rightNow: PersonalHomeRightNow | null = null;
    const rightNowSourceIds = new Set<string>();
    // R23.3 v1.1 — suggestions are evaluated from this exact same `context`
    // (no second buildCurrentContext call — CONTEXT_BUILD_COUNT_PER_
    // COMPOSITE_HOME_REQUEST=1) and returned as part of this response, so
    // Desktop/Mobile can read them straight from GET /api/v1/personal/home
    // instead of a separate GET /api/v1/personal/right-now round trip.
    let suggestions: ProactiveSuggestion[] = [];
    let upcoming: RightNowItem[] = [];

    if (context && this.deps.rightNowIntelligenceService) {
      const intelligence = this.deps.rightNowIntelligenceService.evaluate(context);
      suggestions = intelligence.suggestions;
      upcoming = intelligence.upcoming;
      if (intelligence.primary) {
        rightNow = mapPrimaryToHomeRightNow(intelligence.primary);
        rightNowSourceIds.add(intelligence.primary.sourceRef.id);
      }
    }

    // Fallback: an attention-worthy proposal/change. ActionProposalStore is
    // a separate domain outside R23.1's canonical context snapshot (not a
    // Calendar/Gmail/Task/Memory/Vault/Inbox/Reminder/Approval source), so
    // RightNowIntelligenceService has no visibility into it — preserved
    // here exactly as before, only ever used when the canonical
    // intelligence found nothing to surface.
    if (!rightNow && proposals.length > 0) {
      const topProp = proposals.find((p) => p.status === 'PROPOSED');
      if (topProp) {
        rightNow = {
          type: 'ATTENTION',
          title: topProp.title,
          summary: topProp.summary,
          sourceRef: topProp.id,
          action: { type: 'REVIEW_PROPOSAL', label: 'Review' },
          occurredAt: topProp.createdAt,
        };
        rightNowSourceIds.add(topProp.id);
      }
    }

    // 8. Build TODAY section
    const isBriefStale = dailyBrief ? (Date.now() - Date.parse(dailyBrief.generatedAt) > 60 * 60 * 1000) : false;
    const briefStatus = dailyBrief ? (isBriefStale ? 'STALE' : 'AVAILABLE') : 'NOT_GENERATED';
    const freshness: 'FRESH' | 'STALE' | null = dailyBrief ? (isBriefStale ? 'STALE' : 'FRESH') : null;

    const todayMeetingsCount = calendarStatus === 'UNAVAILABLE' ? 0 : calendarMeetings.length;
    const todayEmailsCount = dailyBrief ? (dailyBrief.emails?.length || 0) : 0;
    const todayTasksCount = userTasks.filter((t) => t.status === 'RUNNING' || t.status === 'ACTIVE').length;
    const todayApprovalsCount = pendingApprovals.length;

    const today = {
      briefStatus,
      freshness,
      summary: dailyBrief?.summary || null,
      meetings: calendarMeetings,
      counts: {
        meetings: todayMeetingsCount,
        emails: todayEmailsCount,
        tasks: todayTasksCount,
        approvals: todayApprovalsCount,
      },
    };

    // 9. Build NEEDS YOUR ATTENTION section (max 5)
    const needsAttention: HomeItem[] = [];
    for (const apr of pendingApprovals) {
      if (rightNowSourceIds.has(apr.id)) continue;
      needsAttention.push({
        id: `attn_${apr.id}`,
        type: 'APPROVAL',
        title: `Approval Required: ${apr.toolId}`,
        summary: `Action requires human confirmation`,
        sourceType: 'APPROVAL',
        sourceId: apr.id,
        createdAt: apr.createdAt,
        action: { type: 'REVIEW_APPROVAL', label: 'Review' },
      });
    }

    for (const task of userTasks) {
      if (needsAttention.length >= 5) break;
      if (task.status === 'FAILED' || task.status === 'WAITING') {
        if (rightNowSourceIds.has(task.id)) continue;
        needsAttention.push({
          id: `attn_${task.id}`,
          type: 'BLOCKED_TASK',
          title: `Task Blocked: ${task.name}`,
          summary: task.objective,
          sourceType: 'TASK',
          sourceId: task.id,
          createdAt: task.createdAt,
          action: { type: 'INSPECT_TASK', label: 'Inspect' },
        });
      }
    }

    for (const prop of proposals) {
      if (needsAttention.length >= 5) break;
      if (prop.status === 'PROPOSED' && prop.approvalRequired) {
        if (rightNowSourceIds.has(prop.id)) continue;
        needsAttention.push({
          id: `attn_${prop.id}`,
          type: 'PROPOSAL',
          title: prop.title,
          summary: prop.summary,
          sourceType: 'PROPOSAL',
          sourceId: prop.id,
          createdAt: prop.createdAt,
          action: { type: 'REVIEW_PROPOSAL', label: 'Review' },
        });
      }
    }

    // 10. Build PREPARED FOR YOU section (grounded prepared work)
    const preparedForYou: HomeItem[] = [];
    for (const prop of proposals) {
      if (preparedForYou.length >= 5) break;
      if (prop.status === 'PROPOSED' && !prop.approvalRequired) {
        preparedForYou.push({
          id: `prep_${prop.id}`,
          type: 'PROPOSAL',
          title: prop.title,
          summary: prop.summary,
          sourceType: 'PROPOSAL',
          sourceId: prop.id,
          createdAt: prop.createdAt,
          action: { type: 'VIEW_PREPARATION', label: 'Review Draft' },
        });
      }
    }

    if (this.deps.creationStore) {
      try {
        const creations = this.deps.creationStore.listCreations(tenantId, principalId, 5);
        for (const cr of creations) {
          if (preparedForYou.length >= 5) break;
          if (cr.status === 'COMPLETED') {
            preparedForYou.push({
              id: `prep_cr_${cr.creationId}`,
              type: 'CREATION',
              title: cr.type || 'Prepared Creation',
              summary: cr.prompt,
              sourceType: 'ACTIVITY',
              sourceId: cr.creationId,
              createdAt: cr.createdAt,
              action: { type: 'VIEW_CREATION', label: 'View Draft' },
            });
          }
        }
      } catch {
        // ignore
      }
    }

    // 11. Build WORKING FOR YOU section (real active tasks/automations)
    const workingForYou: HomeItem[] = [];
    for (const task of userTasks) {
      if (workingForYou.length >= 5) break;
      if (task.status === 'RUNNING' || task.status === 'ACTIVE') {
        workingForYou.push({
          id: `wrk_${task.id}`,
          type: 'TASK',
          title: task.name,
          summary: task.objective,
          sourceType: 'TASK',
          sourceId: task.id,
          createdAt: task.createdAt,
        });
      }
    }

    // 12. Build RECENT RESULTS section (completed activities)
    const recentResults: HomeItem[] = [];
    const completedActivities = activities.filter((a) => a.status === 'COMPLETED');
    for (const act of completedActivities.slice(0, 5)) {
      recentResults.push({
        id: `res_${act.activityId}`,
        type: act.type,
        title: act.title,
        summary: act.description,
        sourceType: 'ACTIVITY',
        sourceId: act.activityId,
        createdAt: act.occurredAt,
      });
    }

    // 13. Profile / User Name
    let userName: string | null = null;
    if (this.deps.identityStore) {
      try {
        const profile = (this.deps.identityStore as any).getProfile ? (this.deps.identityStore as any).getProfile(principalId) : null;
        if (profile && profile.name) {
          userName = profile.name;
        }
      } catch {
        userName = null;
      }
    }

    return {
      generatedAt: now.toISOString(),
      rightNow,
      today,
      needsAttention,
      preparedForYou,
      workingForYou,
      recentResults,
      suggestions,
      upcoming,
      sourceStatus: {
        calendar: calendarStatus,
        gmail: gmailStatus,
        activity: 'OK',
        tasks: 'OK',
      },
      userProfile: {
        name: userName,
      },
    };
  }
}
