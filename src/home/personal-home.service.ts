import type { ActionApprovalStore, ActionApprovalRecord } from '../governance/action-approval.store.js';
import type { DailyBriefStore, DailyBriefRecord } from '../governance/daily-brief.store.js';
import type { TaskStore, TaskRecord } from '../tasks/task.store.js';
import type { ActivityStore, ActivityItem } from '../governance/activity.store.js';
import type { ActionProposalStore, ActionProposalRecord } from '../assistant/action-proposal.store.js';
import type { InboxStore } from '../workspace/inbox.store.js';
import type { CreationStore } from '../creation/creation.store.js';
import type { GoogleCalendarService } from '../modules/calendar/index.js';
import type { GmailService } from '../modules/gmail/index.js';
import type { IdentityStore } from '../identity/identity.store.js';

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
  type: 'APPROVAL' | 'MEETING' | 'ATTENTION' | 'BLOCKED_TASK' | 'INBOX';
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

export class PersonalHomeService {
  constructor(
    private readonly deps: {
      actionApprovals?: ActionApprovalStore;
      dailyBriefStore?: DailyBriefStore;
      taskStore?: TaskStore;
      activityStore?: ActivityStore;
      actionProposalStore?: ActionProposalStore;
      inboxStore?: InboxStore;
      creationStore?: CreationStore;
      googleCalendarService?: GoogleCalendarService;
      gmailService?: GmailService;
      identityStore?: IdentityStore;
    }
  ) {}

  public async getPersonalHome(params: GetPersonalHomeParams): Promise<PersonalHomeResponse> {
    const { tenantId, principalId, dateKey, requestId = `req_home_${Date.now()}` } = params;
    const now = new Date();
    const todayDateKey = dateKey || now.toISOString().slice(0, 10);

    // 1. Fetch pending approvals
    let pendingApprovals: ActionApprovalRecord[] = [];
    if (this.deps.actionApprovals) {
      try {
        pendingApprovals = this.deps.actionApprovals.listPending(tenantId, principalId);
      } catch {
        pendingApprovals = [];
      }
    }

    // 2. Fetch daily brief
    let dailyBrief: DailyBriefRecord | null = null;
    if (this.deps.dailyBriefStore) {
      try {
        dailyBrief = this.deps.dailyBriefStore.getForDate(tenantId, principalId, todayDateKey);
      } catch {
        dailyBrief = null;
      }
    }

    // 3. Fetch tasks
    let userTasks: TaskRecord[] = [];
    if (this.deps.taskStore) {
      try {
        userTasks = this.deps.taskStore.list(tenantId, principalId);
      } catch {
        userTasks = [];
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

    // 6. Calendar & Gmail Source Status
    let calendarStatus = 'CONNECTED';
    let calendarMeetings: HomeCalendarItem[] = [];
    if (this.deps.googleCalendarService) {
      try {
        const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
        const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
        const events = await this.deps.googleCalendarService.listUpcomingEvents({
          tenantId,
          timeMin,
          timeMax,
          maxResults: 10,
          requestId,
        });
        calendarMeetings = (events || []).map((e: any) => ({
          id: e.id || e.eventId || `evt_${Math.random().toString(36).slice(2)}`,
          title: e.summary || e.title || 'Untitled Meeting',
          startsAt: e.start?.dateTime || e.start?.date || e.startsAt || new Date().toISOString(),
          endsAt: e.end?.dateTime || e.end?.date || e.endsAt,
          summary: e.description || e.summary,
        }));
      } catch {
        calendarStatus = 'UNAVAILABLE';
        calendarMeetings = [];
      }
    } else {
      calendarStatus = 'UNAVAILABLE';
    }

    if (calendarMeetings.length === 0 && dailyBrief && Array.isArray(dailyBrief.schedule)) {
      calendarMeetings = dailyBrief.schedule.map((m: any) => ({
        id: m.sourceId || m.id || `m_${Math.random().toString(36).slice(2)}`,
        title: m.title || 'Untitled Meeting',
        startsAt: m.start || m.timestamp || new Date().toISOString(),
        summary: m.capability || m.summary,
      }));
    }

    let gmailStatus = 'CONNECTED';
    if (!this.deps.gmailService) {
      gmailStatus = 'UNAVAILABLE';
    }

    // 7. Resolve RIGHT NOW (Deterministic Priority Resolver)
    let rightNow: PersonalHomeRightNow | null = null;
    const rightNowSourceIds = new Set<string>();

    // Priority 1: Consequential pending approval
    if (pendingApprovals.length > 0) {
      const topApproval = pendingApprovals[0];
      rightNow = {
        type: 'APPROVAL',
        title: `Approval Required: ${topApproval.toolId}`,
        summary: `Action requires human authorization before proceeding.`,
        sourceRef: topApproval.approvalId,
        action: { type: 'REVIEW_APPROVAL', label: 'Review' },
        occurredAt: topApproval.createdAt,
      };
      rightNowSourceIds.add(topApproval.approvalId);
    }

    // Priority 2: Failed/blocked task needing user input
    if (!rightNow) {
      const failedTask = userTasks.find((t) => t.status === 'FAILED' || t.status === 'WAITING');
      if (failedTask) {
        rightNow = {
          type: 'BLOCKED_TASK',
          title: `Task Requires Attention: ${failedTask.name}`,
          summary: failedTask.objective,
          sourceRef: failedTask.taskId,
          action: { type: 'INSPECT_TASK', label: 'Inspect' },
          occurredAt: failedTask.updatedAt || failedTask.createdAt,
        };
        rightNowSourceIds.add(failedTask.taskId);
      }
    }

    // Priority 3: Meeting starting soon
    if (!rightNow && calendarMeetings.length > 0) {
      const nextMeeting = calendarMeetings[0];
      rightNow = {
        type: 'MEETING',
        title: nextMeeting.title,
        summary: nextMeeting.summary || 'Upcoming meeting scheduled for today',
        sourceRef: nextMeeting.id,
        startsAt: nextMeeting.startsAt,
        action: { type: 'PREPARE_MEETING', label: 'Review prep' },
      };
      rightNowSourceIds.add(nextMeeting.id);
    }

    // Priority 4: Attention proposal / change
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
      if (rightNowSourceIds.has(apr.approvalId)) continue;
      needsAttention.push({
        id: `attn_${apr.approvalId}`,
        type: 'APPROVAL',
        title: `Approval Required: ${apr.toolId}`,
        summary: `Action requires human confirmation`,
        sourceType: 'APPROVAL',
        sourceId: apr.approvalId,
        createdAt: apr.createdAt,
        action: { type: 'REVIEW_APPROVAL', label: 'Review' },
      });
    }

    for (const task of userTasks) {
      if (needsAttention.length >= 5) break;
      if (task.status === 'FAILED' || task.status === 'WAITING') {
        if (rightNowSourceIds.has(task.taskId)) continue;
        needsAttention.push({
          id: `attn_${task.taskId}`,
          type: 'BLOCKED_TASK',
          title: `Task Blocked: ${task.name}`,
          summary: task.objective,
          sourceType: 'TASK',
          sourceId: task.taskId,
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
          id: `wrk_${task.taskId}`,
          type: 'TASK',
          title: task.name,
          summary: task.objective,
          sourceType: 'TASK',
          sourceId: task.taskId,
          createdAt: task.createdAt,
          dueAt: task.trigger?.schedule,
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
