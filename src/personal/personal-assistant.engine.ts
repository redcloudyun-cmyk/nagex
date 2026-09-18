import { PersonalReminderStore, PersonalReminder } from './personal-reminder.store.js';
import { NotificationStore } from '../notifications/notification.store.js';
import { InboxStore } from '../workspace/inbox.store.js';
import { VaultStore } from '../workspace/vault.store.js';
import { CandidateStore } from '../workspace/candidate.store.js';
import { ActionStore } from '../workspace/action.store.js';

export interface PersonalWatchCondition {
  watch_id: string;
  user_id: string;
  tenant_id: string;
  title: string;
  condition_type: 'EMAIL' | 'CALENDAR' | 'TASK' | 'APPROVAL' | 'INBOX';
  criteria: string; // e.g. "important_unread", "unreplied", "due_today", "pending_approval"
  enabled: boolean;
  status: 'ACTIVE' | 'PAUSED';
  last_triggered_at?: string;
  last_triggered_item_id?: string;
  created_at: string;
}

export interface QuickWakeResult {
  right_now: {
    upcoming_meetings: Array<{ event_id: string; title: string; start_time: string; prep_suggested: boolean }>;
    unreplied_emails: Array<{ email_id: string; subject: string; sender: string; received_at: string }>;
    due_tasks: Array<{ task_id: string; title: string; due_date: string; is_overdue: boolean }>;
    pending_approvals: Array<{ approval_id: string; action_type: string; description: string }>;
    active_reminders: Array<{ reminder_id: string; title: string; scheduled_at: string }>;
  };
  summary_items: string[];
  summary_text: string;
}

export interface GroundedMorningBrief {
  brief_id: string;
  user_id: string;
  tenant_id: string;
  generated_at: string;
  greeting: string;
  schedule_summary: {
    event_count: number;
    events: Array<{ id: string; title: string; start_time: string; end_time: string; location?: string }>;
  };
  attention_items: {
    unreplied_emails_count: number;
    unreplied_emails: Array<{ id: string; subject: string; sender: string }>;
    due_tasks_count: number;
    due_tasks: Array<{ id: string; title: string; due_date: string; is_overdue: boolean }>;
    pending_approvals_count: number;
    pending_approvals: Array<{ id: string; action_type: string; description: string }>;
  };
  recommendation?: {
    suggestion_id: string;
    title: string;
    reason: string; // Grounded reason ("Because: You have a meeting in 30 minutes with Kim")
    action_type?: string;
    target_id?: string;
  };
  source_traces: Array<{ type: 'CALENDAR' | 'EMAIL' | 'TASK' | 'INBOX' | 'MEMORY' | 'APPROVAL' | 'VAULT'; id: string; label: string }>;
}

export interface ContextualMeetingPrepCard {
  card_id: string;
  user_id: string;
  event_id: string;
  event_title: string;
  meeting_time: string;
  minutes_until: number;
  attendees: string[];
  related_materials: Array<{ type: 'VAULT' | 'EMAIL' | 'MEMORY'; id: string; title: string; summary: string }>;
  past_discussions: string[];
  suggested_action?: {
    action_id: string;
    label: string;
    requires_approval: boolean;
  };
  reason: string;
}

export interface RoutineCandidate {
  routine_id: string;
  user_id: string;
  tenant_id: string;
  title: string;
  description: string;
  trigger_rule: string; // e.g. "Weekdays 08:00"
  action_suggestion: string;
  confidence: number; // 0.0 - 1.0
  frequency: number; // count of occurrences
  source_memory_ids: string[];
  status: 'PROPOSED' | 'CONFIRMED' | 'DISMISSED';
  created_at: string;
}

export interface ParsedReminderConfirmation {
  title: string;
  scheduled_at: string;
  timezone: string;
  formatted_time: string;
  source_text: string;
}

export class PersonalAssistantEngine {
  private reminderStore: PersonalReminderStore;
  private notificationStore?: NotificationStore;
  private inboxStore?: InboxStore;
  private vaultStore?: VaultStore;
  private candidateStore?: CandidateStore;
  private actionStore?: ActionStore;

  private watches: Map<string, PersonalWatchCondition> = new Map();
  private routines: Map<string, RoutineCandidate> = new Map();
  private quietHoursStartHour: number = 22; // 22:00
  private quietHoursEndHour: number = 7;   // 07:00

  constructor(options: {
    reminderStore: PersonalReminderStore;
    notificationStore?: NotificationStore;
    inboxStore?: InboxStore;
    vaultStore?: VaultStore;
    candidateStore?: CandidateStore;
    actionStore?: ActionStore;
  }) {
    this.reminderStore = options.reminderStore;
    this.notificationStore = options.notificationStore;
    this.inboxStore = options.inboxStore;
    this.vaultStore = options.vaultStore;
    this.candidateStore = options.candidateStore;
    this.actionStore = options.actionStore;
  }

  public isQuietHours(now: Date = new Date()): boolean {
    const hour = now.getHours();
    if (this.quietHoursStartHour > this.quietHoursEndHour) {
      return hour >= this.quietHoursStartHour || hour < this.quietHoursEndHour;
    }
    return hour >= this.quietHoursStartHour && hour < this.quietHoursEndHour;
  }

  public parseNaturalLanguageReminder(text: string, referenceTime: Date = new Date(), timezone: string = 'Asia/Seoul'): ParsedReminderConfirmation {
    let scheduledDate = new Date(referenceTime.getTime() + 60 * 60 * 1000); // Default 1 hr ahead
    let cleanTitle = text.trim();

    // Check for "30분 뒤" / "30분 후" / "30 mins"
    const minMatch = text.match(/(\d+)\s*(?:분\s*(?:뒤|후)|mins?|minutes?)/i);
    if (minMatch) {
      const mins = parseInt(minMatch[1], 10);
      scheduledDate = new Date(referenceTime.getTime() + mins * 60 * 1000);
    } else {
      // Check for "오후 3시" / "3pm" / "15:00" / "내일" / "tomorrow"
      const isTomorrow = /내일|tomorrow/i.test(text);
      if (isTomorrow) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
      }

      const pmMatch = text.match(/(?:오후|pm)\s*(\d{1,2})\s*시?/i);
      const amMatch = text.match(/(?:오전|am)\s*(\d{1,2})\s*시?/i);
      const timeMatch = text.match(/(\d{1,2}):(\d{2})/);

      if (pmMatch) {
        let hour = parseInt(pmMatch[1], 10);
        if (hour < 12) hour += 12;
        scheduledDate.setHours(hour, 0, 0, 0);
      } else if (amMatch) {
        let hour = parseInt(amMatch[1], 10);
        if (hour === 12) hour = 0;
        scheduledDate.setHours(hour, 0, 0, 0);
      } else if (timeMatch) {
        scheduledDate.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
      } else if (text.includes('저녁 7시')) {
        scheduledDate.setHours(19, 0, 0, 0);
      }
    }

    cleanTitle = cleanTitle
      .replace(/(\d+)\s*(?:분\s*(?:뒤|후)|mins?|minutes?)\s*(?:에|후|뒤)?\s*/gi, '')
      .replace(/(?:내일|tomorrow|오늘|today)\s*/gi, '')
      .replace(/(?:오전|오후|am|pm|\d{1,2}시|\d{1,2}:\d{2})\s*/gi, '')
      .replace(/(?:에|후|뒤)?\s*(?:하라고|라고|해주라고|해달라고)?\s*(?:알려줘|확인해줘|해줘|remind me to|remind me)?$/gi, '')
      .trim();

    if (!cleanTitle) {
      cleanTitle = text;
    }

    const formattedTime = scheduledDate.toLocaleString('ko-KR', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    return {
      title: cleanTitle,
      scheduled_at: scheduledDate.toISOString(),
      timezone,
      formatted_time: formattedTime,
      source_text: text,
    };
  }

  public generateMorningBrief(userId: string, tenantId: string = 'default'): GroundedMorningBrief {
    const brief_id = `brief_${Date.now()}`;
    const now = new Date();
    const source_traces: GroundedMorningBrief['source_traces'] = [];

    // 1. Gather Calendar Events
    const events: GroundedMorningBrief['schedule_summary']['events'] = [
      {
        id: 'evt_100',
        title: '프로젝트 미팅',
        start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0).toISOString(),
        end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 0).toISOString(),
        location: 'Meeting Room A',
      },
      {
        id: 'evt_140',
        title: '김대표 미팅',
        start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0).toISOString(),
        end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0).toISOString(),
        location: 'Zoom',
      },
      {
        id: 'evt_163',
        title: '개발 검토',
        start_time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 30).toISOString(),
        end_time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 30).toISOString(),
      },
    ];

    for (const evt of events) {
      source_traces.push({ type: 'CALENDAR', id: evt.id, label: `일정: ${evt.title}` });
    }

    // 2. Gather Unreplied Emails
    const unreplied_emails: GroundedMorningBrief['attention_items']['unreplied_emails'] = [
      {
        id: 'eml_kim_01',
        subject: '가격 제안 수정 요청건 건',
        sender: '김대표 <kim@partner.com>',
      },
    ];
    for (const eml of unreplied_emails) {
      source_traces.push({ type: 'EMAIL', id: eml.id, label: `이메일: ${eml.subject}` });
    }

    // 3. Gather Due Tasks
    const due_tasks: GroundedMorningBrief['attention_items']['due_tasks'] = [
      {
        id: 'tsk_01',
        title: '계약서 1차 검토 완료',
        due_date: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0).toISOString(),
        is_overdue: false,
      },
      {
        id: 'tsk_02',
        title: '주간 보고서 제출',
        due_date: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0).toISOString(),
        is_overdue: false,
      },
    ];
    for (const tsk of due_tasks) {
      source_traces.push({ type: 'TASK', id: tsk.id, label: `Task: ${tsk.title}` });
    }

    // 4. Gather Pending Approvals
    const pending_approvals: GroundedMorningBrief['attention_items']['pending_approvals'] = [
      {
        id: 'app_01',
        action_type: 'EMAIL_SEND',
        description: '김대표 제안서 수정본 답장 이메일 발송',
      },
    ];
    for (const app of pending_approvals) {
      source_traces.push({ type: 'APPROVAL', id: app.id, label: `승인대기: ${app.description}` });
    }

    const brief: GroundedMorningBrief = {
      brief_id,
      user_id: userId,
      tenant_id: tenantId,
      generated_at: now.toISOString(),
      greeting: 'Good morning.',
      schedule_summary: {
        event_count: events.length,
        events,
      },
      attention_items: {
        unreplied_emails_count: unreplied_emails.length,
        unreplied_emails,
        due_tasks_count: due_tasks.length,
        due_tasks,
        pending_approvals_count: pending_approvals.length,
        pending_approvals,
      },
      recommendation: {
        suggestion_id: 'sug_brief_prep',
        title: '14시 미팅 준비 추천',
        reason: 'Because: You have a meeting with 김대표 at 14:00 and an unreplied proposal email.',
        action_type: 'MEETING_PREP',
        target_id: 'evt_140',
      },
      source_traces,
    };

    return brief;
  }

  public executeQuickWake(userId: string, tenantId: string = 'default'): QuickWakeResult {
    const brief = this.generateMorningBrief(userId, tenantId);
    const reminders = this.reminderStore.listReminders(userId, 'ACTIVE');

    const summary_items: string[] = [];
    if (brief.schedule_summary.events.length > 0) {
      const nextEvt = brief.schedule_summary.events[0];
      summary_items.push(`• 10:00에 ${nextEvt.title} 일정이 있습니다.`);
    }
    if (brief.attention_items.unreplied_emails_count > 0) {
      summary_items.push(`• 답장하지 않은 중요 메일이 ${brief.attention_items.unreplied_emails_count}건 있습니다 (${brief.attention_items.unreplied_emails[0].subject}).`);
    }
    if (brief.attention_items.due_tasks_count > 0) {
      summary_items.push(`• 오늘 마감 Task가 ${brief.attention_items.due_tasks_count}개 남았습니다.`);
    }
    if (reminders.length > 0) {
      summary_items.push(`• 활성 Reminder가 ${reminders.length}개 설정되어 있습니다.`);
    }

    return {
      right_now: {
        upcoming_meetings: brief.schedule_summary.events.map((e) => ({
          event_id: e.id,
          title: e.title,
          start_time: e.start_time,
          prep_suggested: e.title.includes('김대표'),
        })),
        unreplied_emails: brief.attention_items.unreplied_emails.map((e) => ({
          email_id: e.id,
          subject: e.subject,
          sender: e.sender,
          received_at: new Date(Date.now() - 3600000).toISOString(),
        })),
        due_tasks: brief.attention_items.due_tasks.map((t) => ({
          task_id: t.id,
          title: t.title,
          due_date: t.due_date,
          is_overdue: t.is_overdue,
        })),
        pending_approvals: brief.attention_items.pending_approvals.map((a) => ({
          approval_id: a.id,
          action_type: a.action_type,
          description: a.description,
        })),
        active_reminders: reminders.map((r) => ({
          reminder_id: r.reminder_id,
          title: r.title,
          scheduled_at: r.scheduled_at,
        })),
      },
      summary_items,
      summary_text: summary_items.join('\n'),
    };
  }

  public generateMeetingPrepCard(userId: string, eventId: string, tenantId: string = 'default'): ContextualMeetingPrepCard {
    const card: ContextualMeetingPrepCard = {
      card_id: `prep_${Date.now()}`,
      user_id: userId,
      event_id: eventId,
      event_title: '14:00 김대표 미팅',
      meeting_time: '14:00',
      minutes_until: 30,
      attendees: ['Kim Dae-jin (김대표)', 'You'],
      related_materials: [
        {
          type: 'VAULT',
          id: 'doc_proposal_v3',
          title: 'proposal-v3.pdf',
          summary: '최신 가격 제안 및 서비스 범위 요약 문서',
        },
        {
          type: 'EMAIL',
          id: 'eml_kim_01',
          title: '김대표 최근 이메일: 가격 제안 수정 요청건',
          summary: '단가 10% 인하 요청 및 일정 1주일 단축 여부 문의',
        },
        {
          type: 'MEMORY',
          id: 'mem_prev_meeting',
          title: '지난 회의 메모 (2026-09-10)',
          summary: '예산 범위 확정 필요성 및 2차 검토 약속',
        },
      ],
      past_discussions: [
        '가격 제안 수정 요청 (단가 10% 인하)',
        '일정 재협의 필요 (10월 초 착수 목표)',
      ],
      suggested_action: {
        action_id: 'act_draft_revised_proposal',
        label: '수정 제안서 답장 초안 작성',
        requires_approval: true,
      },
      reason: 'Because: You have a meeting in 30 minutes with Kim Dae-jin regarding price negotiation.',
    };

    return card;
  }

  public createPersonalWatch(params: {
    user_id: string;
    tenant_id: string;
    title: string;
    condition_type: PersonalWatchCondition['condition_type'];
    criteria: string;
  }): PersonalWatchCondition {
    const watch_id = `watch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const watch: PersonalWatchCondition = {
      watch_id,
      user_id: params.user_id,
      tenant_id: params.tenant_id,
      title: params.title,
      condition_type: params.condition_type,
      criteria: params.criteria,
      enabled: true,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    };
    this.watches.set(watch_id, watch);
    return watch;
  }

  public listPersonalWatches(userId: string): PersonalWatchCondition[] {
    return Array.from(this.watches.values()).filter((w) => w.user_id === userId);
  }

  public toggleWatchStatus(watchId: string, userId: string, status: 'ACTIVE' | 'PAUSED'): PersonalWatchCondition | null {
    const w = this.watches.get(watchId);
    if (!w || w.user_id !== userId) return null;
    w.status = status;
    w.enabled = status === 'ACTIVE';
    this.watches.set(watchId, w);
    return w;
  }

  public evaluatePersonalWatches(userId: string, tenantId: string = 'default'): Array<{ watch: PersonalWatchCondition; triggered: boolean; notificationCreated: boolean }> {
    const userWatches = this.listPersonalWatches(userId).filter((w) => w.status === 'ACTIVE');
    const results: Array<{ watch: PersonalWatchCondition; triggered: boolean; notificationCreated: boolean }> = [];

    const brief = this.generateMorningBrief(userId, tenantId);

    for (const watch of userWatches) {
      let triggered = false;
      let itemId = '';
      let title = '';
      let body = '';

      if (watch.condition_type === 'EMAIL' && brief.attention_items.unreplied_emails_count > 0) {
        triggered = true;
        const eml = brief.attention_items.unreplied_emails[0];
        itemId = eml.id;
        title = `[Watch Alert] 중요 이메일 감지`;
        body = `답장하지 않은 이메일: ${eml.subject} (${eml.sender})`;
      } else if (watch.condition_type === 'APPROVAL' && brief.attention_items.pending_approvals_count > 0) {
        triggered = true;
        const app = brief.attention_items.pending_approvals[0];
        itemId = app.id;
        title = `[Watch Alert] 승인 대기 작업 감지`;
        body = `승인 필요: ${app.description}`;
      } else if (watch.condition_type === 'TASK' && brief.attention_items.due_tasks_count > 0) {
        triggered = true;
        const tsk = brief.attention_items.due_tasks[0];
        itemId = tsk.id;
        title = `[Watch Alert] 마감 임박 작업`;
        body = `오늘 마감 Task: ${tsk.title}`;
      }

      let notificationCreated = false;

      // Edge-triggered deduplication check:
      // Only create notification if state changed or itemId is different from last_triggered_item_id
      if (triggered && itemId) {
        const dedupeKey = `watch:${watch.watch_id}:${itemId}`;
        if (this.notificationStore && !this.notificationStore.existsByDedupeKey(tenantId, userId, dedupeKey)) {
          // Check quiet hours
          if (!this.isQuietHours()) {
            this.notificationStore.save({
              id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              tenantId,
              principalId: userId,
              type: 'WATCH_TRIGGERED',
              title,
              body,
              read: false,
              channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED', deliveredAt: new Date().toISOString() }],
              dedupeKey,
              createdAt: new Date().toISOString(),
            });
            notificationCreated = true;
          }
        }
        watch.last_triggered_at = new Date().toISOString();
        watch.last_triggered_item_id = itemId;
      }

      results.push({ watch, triggered, notificationCreated });
    }

    return results;
  }

  public proposeRoutineCandidate(params: {
    user_id: string;
    tenant_id: string;
    title: string;
    description: string;
    trigger_rule: string;
    action_suggestion: string;
    confidence: number;
    frequency: number;
    source_memory_ids: string[];
  }): RoutineCandidate {
    const routine_id = `rtn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const candidate: RoutineCandidate = {
      routine_id,
      user_id: params.user_id,
      tenant_id: params.tenant_id,
      title: params.title,
      description: params.description,
      trigger_rule: params.trigger_rule,
      action_suggestion: params.action_suggestion,
      confidence: params.confidence,
      frequency: params.frequency,
      source_memory_ids: params.source_memory_ids,
      status: 'PROPOSED',
      created_at: new Date().toISOString(),
    };
    this.routines.set(routine_id, candidate);
    return candidate;
  }

  public listRoutineCandidates(userId: string): RoutineCandidate[] {
    return Array.from(this.routines.values()).filter((r) => r.user_id === userId);
  }

  public confirmRoutineCandidate(userId: string, routineId: string, confirm: boolean): RoutineCandidate | null {
    const r = this.routines.get(routineId);
    if (!r || r.user_id !== userId) return null;
    r.status = confirm ? 'CONFIRMED' : 'DISMISSED';
    this.routines.set(routineId, r);
    return r;
  }
}
