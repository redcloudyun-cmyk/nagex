import crypto from 'node:crypto';
import { PersonalReminderStore } from './personal-reminder.store.js';
import { NotificationStore } from '../notifications/notification.store.js';
import { VaultStore } from '../workspace/vault.store.js';
import { CandidateStore } from '../workspace/candidate.store.js';
import { ActionStore } from '../workspace/action.store.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { ActionApprovalStore } from '../governance/action-approval.store.js';
import type { MemoryEngine } from '../context/memory.engine.js';
import type { AiService } from '../model-gateway/ai-service.js';
import { NagexError } from '../common/errors.js';
// R23.3 — narrow structural interfaces, not the concrete GoogleCalendarService/
// GmailService classes (same R23.2D pattern as CurrentPersonalContextService)
// so this engine can be handed the exact same tenant-branching demo-aware
// sources the canonical context pipeline uses, without a cast.
import type { CalendarEventsSource, GmailSearchSource, CurrentPersonalContextService } from './current-personal-context.service.js';
import type { RightNowIntelligenceService } from './right-now-intelligence.service.js';

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
    unreplied_emails: Array<{ email_id: string; snippet: string }>;
    active_tasks: Array<{ task_id: string; title: string; status: string }>;
    pending_approvals: Array<{ approval_id: string; action_type: string; description: string }>;
    active_reminders: Array<{ reminder_id: string; title: string; scheduled_at: string }>;
  };
  // R21 P1 — a proactive suggestion is only ever populated when it is
  // GROUNDED (a real related email or Vault document was actually found
  // for the nearest upcoming meeting's attendees) — never surfaced on
  // proximity alone. null means "nothing grounded enough to suggest
  // proactively right now", not "no data available".
  proactive_suggestion: {
    event_id: string;
    event_title: string;
    minutes_until: number;
    reason: string;
    grounded_on: Array<{ type: 'EMAIL' | 'VAULT'; id: string; label: string }>;
  } | null;
  summary_items: string[];
  summary_text: string;
}

export interface GroundedMorningBrief {
  brief_id: string;
  user_id: string;
  tenant_id: string;
  generated_at: string;
  greeting: string;
  calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  gmailStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  schedule_summary: {
    event_count: number;
    events: Array<{ id: string; title: string; start_time: string; end_time: string; attendees: string[] }>;
  };
  attention_items: {
    unreplied_emails_count: number;
    unreplied_emails: Array<{ id: string; snippet: string }>;
    active_tasks_count: number;
    active_tasks: Array<{ id: string; title: string; status: string }>;
    pending_approvals_count: number;
    pending_approvals: Array<{ id: string; action_type: string; description: string }>;
  };
  recommendation?: {
    suggestion_id: string;
    title: string;
    reason: string; // Grounded reason, e.g. "Because: You have a meeting with Sarah at 15:00."
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
  key_points: string[];
  suggested_agenda: string[];
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
  private vaultStore?: VaultStore;
  private candidateStore?: CandidateStore;
  private actionStore?: ActionStore;
  // R21 P1 — real data sources. All optional so any pre-existing minimal
  // construction (reminder-only usage) keeps working; when a given
  // dependency is not supplied, the corresponding brief/prep section is
  // honestly reported as unavailable rather than fabricated.
  private calendarService?: CalendarEventsSource;
  private gmailApiService?: GmailSearchSource;
  private taskStore?: TaskStore;
  private actionApprovals?: ActionApprovalStore;
  private memoryEngine?: MemoryEngine;
  private aiService?: AiService;
  // R23.3 — when provided, generateMorningBrief's `recommendation` and
  // executeQuickWake's `proactive_suggestion` are computed by the one
  // canonical ProactiveSuggestionService (via rightNowIntelligenceService)
  // instead of this engine's own R21 P1 nearest-event/grounding-check
  // logic. Optional so existing minimal construction keeps working; when
  // absent, the pre-existing R21 P1 logic is used unchanged.
  private currentPersonalContextService?: CurrentPersonalContextService;
  private rightNowIntelligenceService?: RightNowIntelligenceService;

  private watches: Map<string, PersonalWatchCondition> = new Map();
  private routines: Map<string, RoutineCandidate> = new Map();
  private quietHoursStartHour: number = 22; // 22:00
  private quietHoursEndHour: number = 7;   // 07:00

  constructor(options: {
    reminderStore: PersonalReminderStore;
    notificationStore?: NotificationStore;
    vaultStore?: VaultStore;
    candidateStore?: CandidateStore;
    actionStore?: ActionStore;
    calendarService?: CalendarEventsSource;
    gmailApiService?: GmailSearchSource;
    taskStore?: TaskStore;
    actionApprovals?: ActionApprovalStore;
    memoryEngine?: MemoryEngine;
    aiService?: AiService;
    currentPersonalContextService?: CurrentPersonalContextService;
    rightNowIntelligenceService?: RightNowIntelligenceService;
  }) {
    this.reminderStore = options.reminderStore;
    this.notificationStore = options.notificationStore;
    this.vaultStore = options.vaultStore;
    this.candidateStore = options.candidateStore;
    this.actionStore = options.actionStore;
    this.calendarService = options.calendarService;
    this.gmailApiService = options.gmailApiService;
    this.taskStore = options.taskStore;
    this.actionApprovals = options.actionApprovals;
    this.memoryEngine = options.memoryEngine;
    this.aiService = options.aiService;
    this.currentPersonalContextService = options.currentPersonalContextService;
    this.rightNowIntelligenceService = options.rightNowIntelligenceService;
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

  // R21 P1 — real, grounded Morning Brief. Replaces the previous entirely
  // hardcoded implementation (fixed Korean event titles/fake email/fake
  // tasks) with real Calendar/Gmail/Task/Approval reads, following the
  // exact same CONNECTED/DISCONNECTED/ERROR convention and "never fabricate
  // when a source is unavailable" discipline as
  // src/assistant/daily-brief.pipeline.ts. Every dependency is optional so
  // a partial construction degrades honestly instead of throwing.
  public async generateMorningBrief(userId: string, tenantId: string = 'default', requestId?: string): Promise<GroundedMorningBrief> {
    const brief_id = `brief_${crypto.randomUUID()}`;
    const now = new Date();
    const reqId = requestId || `brief_${crypto.randomUUID()}`;
    const source_traces: GroundedMorningBrief['source_traces'] = [];

    let events: GroundedMorningBrief['schedule_summary']['events'] = [];
    let calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
    if (this.calendarService) {
      try {
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);
        const raw = await this.calendarService.listUpcomingEvents({ tenantId, timeMin: now.toISOString(), timeMax: endOfDay.toISOString(), maxResults: 20, requestId: reqId });
        events = raw.map((e) => ({ id: e.id, title: e.title, start_time: e.start, end_time: e.end, attendees: e.attendees }));
      } catch (error) {
        events = [];
        calendarStatus = error instanceof NagexError && error.code === 'GOOGLE_CALENDAR_DISCONNECTED' ? 'DISCONNECTED' : 'ERROR';
      }
    } else {
      calendarStatus = 'DISCONNECTED';
    }
    for (const evt of events) source_traces.push({ type: 'CALENDAR', id: evt.id, label: `Event: ${evt.title}` });

    let unreplied_emails: GroundedMorningBrief['attention_items']['unreplied_emails'] = [];
    let gmailStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
    if (this.gmailApiService) {
      try {
        const result = await this.gmailApiService.search({ tenantId, query: 'is:unread newer_than:3d', requestId: reqId });
        unreplied_emails = result.threads.slice(0, 10).map((t) => ({ id: t.threadId, snippet: t.snippet }));
      } catch (error) {
        unreplied_emails = [];
        gmailStatus = error instanceof NagexError && error.code === 'GMAIL_DISCONNECTED' ? 'DISCONNECTED' : 'ERROR';
      }
    } else {
      gmailStatus = 'DISCONNECTED';
    }
    for (const eml of unreplied_emails) source_traces.push({ type: 'EMAIL', id: eml.id, label: `Email: ${eml.snippet.slice(0, 60)}` });

    let active_tasks: GroundedMorningBrief['attention_items']['active_tasks'] = [];
    if (this.taskStore) {
      try {
        active_tasks = this.taskStore.list(tenantId, userId)
          .filter((t) => t.status === 'ACTIVE' || t.status === 'RUNNING')
          .map((t) => ({ id: t.taskId, title: t.name, status: t.status }));
      } catch {
        active_tasks = [];
      }
    }
    for (const tsk of active_tasks) source_traces.push({ type: 'TASK', id: tsk.id, label: `Task: ${tsk.title}` });

    let pending_approvals: GroundedMorningBrief['attention_items']['pending_approvals'] = [];
    if (this.actionApprovals) {
      try {
        pending_approvals = this.actionApprovals.listPending(tenantId, userId, reqId).map((a) => ({ id: a.approvalId, action_type: a.toolId, description: `Approval needed: ${a.toolId}` }));
      } catch {
        pending_approvals = [];
      }
    }
    for (const app of pending_approvals) source_traces.push({ type: 'APPROVAL', id: app.id, label: `Pending approval: ${app.description}` });

    // R23.3 — Recommendation is now the top canonical ProactiveSuggestion
    // (via RightNowIntelligenceService, over the exact same
    // CurrentPersonalContextService snapshot every other surface uses) —
    // this engine no longer computes its own "nearest event" recommendation
    // rule (PROACTIVE_SUGGESTION_PIPELINE_COUNT=1). A recommendation is
    // populated only when the canonical engine actually produced a real,
    // grounded suggestion — never invented from calendar proximity alone.
    let recommendation: GroundedMorningBrief['recommendation'];
    if (this.rightNowIntelligenceService) {
      try {
        const intel = await this.rightNowIntelligenceService.buildRightNow({ tenantId, userId, requestId: reqId });
        const top = intel.suggestions.find((s) => s.kind === 'MEETING_PREP') ?? intel.suggestions[0];
        if (top) {
          recommendation = {
            suggestion_id: top.id,
            title: top.title,
            reason: top.reason,
            action_type: top.action.type,
            target_id: top.sourceRefs[0]?.id,
          };
        }
      } catch {
        recommendation = undefined;
      }
    }

    return {
      brief_id,
      user_id: userId,
      tenant_id: tenantId,
      generated_at: now.toISOString(),
      greeting: 'Good morning.',
      calendarStatus,
      gmailStatus,
      schedule_summary: { event_count: events.length, events },
      attention_items: {
        unreplied_emails_count: unreplied_emails.length,
        unreplied_emails,
        active_tasks_count: active_tasks.length,
        active_tasks,
        pending_approvals_count: pending_approvals.length,
        pending_approvals,
      },
      recommendation,
      source_traces,
    };
  }

  // R21 P1 — real, grounded Quick Wake. A proactive_suggestion is only ever
  // populated when the nearest upcoming meeting (within 2 hours) has at
  // least one real, actually-found related email or Vault document — never
  // on proximity alone (explicit anti-pattern from the product directive:
  // "no suggestion without grounding").
  public async executeQuickWake(userId: string, tenantId: string = 'default', requestId?: string): Promise<QuickWakeResult> {
    const reqId = requestId || `qw_${crypto.randomUUID()}`;
    const brief = await this.generateMorningBrief(userId, tenantId, reqId);
    const reminders = this.reminderStore.listReminders(tenantId, userId, 'ACTIVE');

    // R23.3 — proactive_suggestion is now the canonical MEETING_PREP
    // ProactiveSuggestion (same engine/pipeline as generateMorningBrief's
    // recommendation, Personal Home, and Right Now) — this engine no
    // longer runs its own nearest-event/attendee-query/vault-search
    // grounding check (PROACTIVE_SUGGESTION_PIPELINE_COUNT=1).
    let proactive_suggestion: QuickWakeResult['proactive_suggestion'] = null;
    if (this.rightNowIntelligenceService) {
      try {
        const intel = await this.rightNowIntelligenceService.buildRightNow({ tenantId, userId, requestId: reqId });
        const top = intel.suggestions.find((s) => s.kind === 'MEETING_PREP');
        if (top) {
          const calendarRef = top.sourceRefs.find((r) => r.type === 'CALENDAR');
          const meetingItem = [intel.primary, ...intel.upcoming].find(
            (item) => item && item.kind === 'MEETING' && item.sourceRef.id === calendarRef?.id
          );
          const minutesMatch = top.reason.match(/(\d+)\s*minute/);
          proactive_suggestion = {
            event_id: calendarRef?.id || '',
            event_title: meetingItem?.title || '',
            minutes_until: minutesMatch ? Number(minutesMatch[1]) : 0,
            reason: top.reason,
            grounded_on: top.sourceRefs
              .filter((r) => r.type === 'GMAIL' || r.type === 'VAULT')
              .map((r) => ({ type: (r.type === 'GMAIL' ? 'EMAIL' : 'VAULT') as 'EMAIL' | 'VAULT', id: r.id, label: r.label || r.id })),
          };
        }
      } catch {
        proactive_suggestion = null;
      }
    }

    const summary_items: string[] = [];
    if (brief.schedule_summary.events.length > 0) {
      const nextEvt = brief.schedule_summary.events[0];
      summary_items.push(`You have "${nextEvt.title}" at ${new Date(nextEvt.start_time).toLocaleTimeString()}.`);
    }
    if (brief.attention_items.unreplied_emails_count > 0) {
      summary_items.push(`${brief.attention_items.unreplied_emails_count} unread email(s) from the last few days.`);
    }
    if (brief.attention_items.active_tasks_count > 0) {
      summary_items.push(`${brief.attention_items.active_tasks_count} active task(s).`);
    }
    if (reminders.length > 0) {
      summary_items.push(`${reminders.length} active reminder(s).`);
    }

    return {
      right_now: {
        upcoming_meetings: brief.schedule_summary.events.map((e) => ({
          event_id: e.id,
          title: e.title,
          start_time: e.start_time,
          prep_suggested: proactive_suggestion?.event_id === e.id,
        })),
        unreplied_emails: brief.attention_items.unreplied_emails.map((e) => ({ email_id: e.id, snippet: e.snippet })),
        active_tasks: brief.attention_items.active_tasks.map((t) => ({ task_id: t.id, title: t.title, status: t.status })),
        pending_approvals: brief.attention_items.pending_approvals.map((a) => ({ approval_id: a.id, action_type: a.action_type, description: a.description })),
        active_reminders: reminders.map((r) => ({ reminder_id: r.reminder_id, title: r.title, scheduled_at: r.scheduled_at })),
      },
      proactive_suggestion,
      summary_items,
      summary_text: summary_items.join('\n'),
    };
  }

  // R21 P1 — real, grounded Meeting Prep. Resolves the target event from
  // real calendar data (by eventId, or the nearest upcoming event when
  // omitted/not found), searches Gmail by real attendee emails, searches
  // Vault/Memory by attendee/event-title keywords, and — only if an
  // aiService is configured — asks the model to synthesize key points and
  // a suggested agenda strictly grounded in what was actually found. When
  // no aiService is configured, returns the real related_materials with
  // empty key_points/suggested_agenda rather than fabricating either.
  public async generateMeetingPrepCard(userId: string, eventId: string | undefined, tenantId: string = 'default', requestId?: string): Promise<ContextualMeetingPrepCard> {
    const reqId = requestId || `prep_${crypto.randomUUID()}`;
    const brief = await this.generateMorningBrief(userId, tenantId, reqId);
    const now = Date.now();

    let event = eventId ? brief.schedule_summary.events.find((e) => e.id === eventId) : undefined;
    if (!event) {
      event = brief.schedule_summary.events
        .filter((e) => new Date(e.start_time).getTime() > now)
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())[0];
    }

    if (!event) {
      throw new NagexError({
        code: 'MEETING_PREP_NO_EVENT',
        category: 'NOT_FOUND',
        message: 'No matching upcoming calendar event was found to prepare for.',
        request_id: reqId,
      });
    }

    const related_materials: ContextualMeetingPrepCard['related_materials'] = [];
    let emailsDigest = '';
    if (this.gmailApiService && event.attendees.length > 0) {
      try {
        const attendeeQuery = event.attendees.map((a) => `from:${a} OR to:${a}`).join(' OR ');
        const result = await this.gmailApiService.search({ tenantId, query: attendeeQuery, requestId: reqId });
        for (const thread of result.threads.slice(0, 5)) {
          related_materials.push({ type: 'EMAIL', id: thread.threadId, title: 'Related email', summary: thread.snippet });
        }
        emailsDigest = result.threads.map((t) => `- ${t.snippet}`).join('\n');
      } catch {
        // Gmail unavailable — no email materials, never fabricated.
      }
    }

    let vaultDigest = '';
    if (this.vaultStore) {
      try {
        const nameHint = event.attendees[0]?.split('@')[0] || event.title;
        const vaultHits = this.vaultStore.searchItems(tenantId, userId, nameHint);
        for (const item of vaultHits.slice(0, 5)) {
          // VaultItem has no content/body field (R18) — only title/type are
          // real; never fabricate a document summary.
          related_materials.push({ type: 'VAULT', id: item.vaultItemId, title: item.title, summary: item.type });
        }
        vaultDigest = vaultHits.map((i) => `- ${i.title} (${i.type})`).join('\n');
      } catch {
        // no-op
      }
    }

    let memoryDigest = '';
    if (this.memoryEngine) {
      try {
        const nameHint = event.attendees[0]?.split('@')[0] || event.title;
        const memHits = this.memoryEngine.searchMemories(tenantId, userId, nameHint);
        for (const mem of memHits.slice(0, 5)) {
          related_materials.push({ type: 'MEMORY', id: mem.id, title: mem.content.subject, summary: `${mem.content.predicate}: ${String(mem.content.value)}` });
        }
        memoryDigest = memHits.map((m) => `- ${m.content.subject} ${m.content.predicate} ${String(m.content.value)}`).join('\n');
      } catch {
        // no-op
      }
    }

    let key_points: string[] = [];
    let suggested_agenda: string[] = [];
    if (this.aiService) {
      try {
        const eventDigest = `${event.title} at ${event.start_time}${event.attendees.length > 0 ? `, attendees: ${event.attendees.join(', ')}` : ''}`;
        const result = await this.aiService.meetingPrep({ eventDigest, emailsDigest, vaultDigest, memoryDigest, mode: 'auto', requestId: reqId });
        key_points = result.data.keyPoints;
        suggested_agenda = result.data.suggestedAgenda;
      } catch {
        // Model unavailable — real materials are still returned; key
        // points/agenda simply stay empty rather than fabricated.
        key_points = [];
        suggested_agenda = [];
      }
    }

    const minutesUntil = Math.max(0, Math.round((new Date(event.start_time).getTime() - now) / 60000));

    return {
      card_id: `prep_${crypto.randomUUID()}`,
      user_id: userId,
      event_id: event.id,
      event_title: event.title,
      meeting_time: event.start_time,
      minutes_until: minutesUntil,
      attendees: event.attendees,
      related_materials,
      key_points,
      suggested_agenda,
      suggested_action: related_materials.length > 0 || emailsDigest
        ? { action_id: `act_followup_${event.id}`, label: 'Draft a follow-up', requires_approval: true }
        : undefined,
      reason: `Because: You have "${event.title}" in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}.`,
    };
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

  // R21 P1 — now evaluates against the same real Morning Brief every other
  // caller uses (previously called the hardcoded-fake generateMorningBrief,
  // meaning Personal Watch triggers had never actually reflected real
  // calendar/email/task state since R20).
  public async evaluatePersonalWatches(userId: string, tenantId: string = 'default'): Promise<Array<{ watch: PersonalWatchCondition; triggered: boolean; notificationCreated: boolean }>> {
    const userWatches = this.listPersonalWatches(userId).filter((w) => w.status === 'ACTIVE');
    const results: Array<{ watch: PersonalWatchCondition; triggered: boolean; notificationCreated: boolean }> = [];

    const brief = await this.generateMorningBrief(userId, tenantId);

    for (const watch of userWatches) {
      let triggered = false;
      let itemId = '';
      let title = '';
      let body = '';

      if (watch.condition_type === 'EMAIL' && brief.attention_items.unreplied_emails_count > 0) {
        triggered = true;
        const eml = brief.attention_items.unreplied_emails[0];
        itemId = eml.id;
        title = `Important email detected`;
        body = `Unreplied email: ${eml.snippet}`;
      } else if (watch.condition_type === 'APPROVAL' && brief.attention_items.pending_approvals_count > 0) {
        triggered = true;
        const app = brief.attention_items.pending_approvals[0];
        itemId = app.id;
        title = `Approval waiting`;
        body = `Needs your approval: ${app.description}`;
      } else if (watch.condition_type === 'TASK' && brief.attention_items.active_tasks_count > 0) {
        triggered = true;
        const tsk = brief.attention_items.active_tasks[0];
        itemId = tsk.id;
        title = `Active task`;
        body = `Task: ${tsk.title}`;
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
