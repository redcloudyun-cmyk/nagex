import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import type { PersonalReminderStore, ReminderStatus } from '../../personal/personal-reminder.store.js';
import type { PersonalAssistantEngine } from '../../personal/personal-assistant.engine.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface PersonalAssistantRouteDeps {
  reminderStore: PersonalReminderStore;
  assistantEngine: PersonalAssistantEngine;
}

export const handlePersonalAssistantRoutes: AsyncRouteRegistrar<PersonalAssistantRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  query,
  deps
): Promise<ApiResult | undefined> => {
  const { reminderStore, assistantEngine } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_pers_${crypto.randomUUID()}`;

  // 1. Natural language reminder parse / confirm preview
  if (pathname === '/api/v1/personal/reminders/parse' && method === 'POST') {
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) {
      throw new NagexError({
        code: 'INVALID_REMINDER_TEXT',
        category: 'VALIDATION',
        message: 'Text field is required for reminder parsing.',
        request_id: requestId,
      });
    }
    const referenceTime = typeof body?.referenceTime === 'string' || typeof body?.referenceTime === 'number' ? new Date(body.referenceTime) : new Date();
    const timezone = typeof body?.timezone === 'string' ? body.timezone : 'Asia/Seoul';
    const parsed = assistantEngine.parseNaturalLanguageReminder(text, referenceTime, timezone);
    return { status: 200, data: parsed };
  }

  // 2. Reminders collection (GET, POST)
  if (pathname === '/api/v1/personal/reminders') {
    if (method === 'GET') {
      const status = typeof query?.status === 'string' ? (query.status as ReminderStatus) : undefined;
      const reminders = reminderStore.listReminders(principalId, status);
      return { status: 200, data: { reminders } };
    }

    if (method === 'POST') {
      let title = typeof body?.title === 'string' ? body.title : '';
      let scheduled_at = typeof body?.scheduled_at === 'string' ? body.scheduled_at : '';
      let timezone = typeof body?.timezone === 'string' ? body.timezone : 'Asia/Seoul';
      const instruction = typeof body?.instruction === 'string' ? body.instruction : undefined;

      const bodyText = typeof body?.text === 'string' ? body.text : undefined;
      if (bodyText && (!title || !scheduled_at)) {
        const parsed = assistantEngine.parseNaturalLanguageReminder(bodyText, new Date(), timezone);
        title = parsed.title;
        scheduled_at = parsed.scheduled_at;
        timezone = parsed.timezone;
      }

      if (!title || !scheduled_at) {
        throw new NagexError({
          code: 'INVALID_REMINDER_DATA',
          category: 'VALIDATION',
          message: 'Title and scheduled_at (or text) are required to create a reminder.',
          request_id: requestId,
        });
      }

      const status = typeof body?.status === 'string' ? (body.status as ReminderStatus) : 'ACTIVE';
      const source_context = body?.source_context && typeof body.source_context === 'object' ? (body.source_context as any) : undefined;

      const reminder = reminderStore.createReminder({
        user_id: principalId,
        title,
        instruction,
        scheduled_at,
        timezone,
        status,
        source_context,
      });

      return { status: 201, data: reminder };
    }
  }

  // 3. Reminder item actions (GET, PATCH, DELETE)
  if (pathname.startsWith('/api/v1/personal/reminders/')) {
    const reminderId = pathname.replace('/api/v1/personal/reminders/', '');
    if (reminderId && !reminderId.includes('/')) {
      if (method === 'GET') {
        const r = reminderStore.getReminder(reminderId);
        if (!r || r.user_id !== principalId) {
          return { status: 404, data: { error: 'Reminder not found' } };
        }
        return { status: 200, data: r };
      }

      if (method === 'PATCH') {
        const status = typeof body?.status === 'string' ? (body.status as ReminderStatus) : undefined;
        if (!status) {
          throw new NagexError({
            code: 'INVALID_REMINDER_STATUS',
            category: 'VALIDATION',
            message: 'Status is required for PATCH update.',
            request_id: requestId,
          });
        }
        const updated = reminderStore.updateStatus(reminderId, principalId, status);
        if (!updated) {
          return { status: 404, data: { error: 'Reminder not found' } };
        }
        return { status: 200, data: updated };
      }

      if (method === 'DELETE') {
        const deleted = reminderStore.deleteReminder(reminderId, principalId);
        if (!deleted) {
          return { status: 404, data: { error: 'Reminder not found' } };
        }
        return { status: 200, data: { success: true, reminder_id: reminderId } };
      }
    }
  }

  // 4. Quick Wake
  if (pathname === '/api/v1/personal/quick-wake' && method === 'GET') {
    const result = assistantEngine.executeQuickWake(principalId, tenantId);
    return { status: 200, data: result };
  }

  // 5. Grounded Morning Brief
  if (pathname === '/api/v1/personal/morning-brief' && method === 'GET') {
    const brief = assistantEngine.generateMorningBrief(principalId, tenantId);
    return { status: 200, data: brief };
  }

  // 6. Contextual Meeting Prep Card
  if (pathname === '/api/v1/personal/meeting-prep' && method === 'POST') {
    const eventId = typeof body?.eventId === 'string' ? body.eventId : 'evt_140';
    const prepCard = assistantEngine.generateMeetingPrepCard(principalId, eventId, tenantId);
    return { status: 200, data: prepCard };
  }

  // 7. Personal Watch endpoints (GET, POST, evaluation)
  if (pathname === '/api/v1/personal/watches') {
    if (method === 'GET') {
      const watches = assistantEngine.listPersonalWatches(principalId);
      return { status: 200, data: { watches } };
    }

    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : 'Personal Watch';
      const condition_type = (typeof body?.condition_type === 'string' ? body.condition_type : 'EMAIL') as any;
      const criteria = typeof body?.criteria === 'string' ? body.criteria : 'unreplied';

      const watch = assistantEngine.createPersonalWatch({
        user_id: principalId,
        tenant_id: tenantId,
        title,
        condition_type,
        criteria,
      });

      return { status: 201, data: watch };
    }
  }

  if (pathname === '/api/v1/personal/watches/evaluate' && method === 'POST') {
    const results = assistantEngine.evaluatePersonalWatches(principalId, tenantId);
    return { status: 200, data: { results } };
  }

  if (pathname.startsWith('/api/v1/personal/watches/') && pathname.endsWith('/toggle') && method === 'POST') {
    const watchId = pathname.replace('/api/v1/personal/watches/', '').replace('/toggle', '');
    const status = body?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
    const updated = assistantEngine.toggleWatchStatus(watchId, principalId, status);
    if (!updated) {
      return { status: 404, data: { error: 'Personal Watch not found' } };
    }
    return { status: 200, data: updated };
  }

  // 8. Routine Candidates (GET, POST propose, POST confirm)
  if (pathname === '/api/v1/personal/routines') {
    if (method === 'GET') {
      const routines = assistantEngine.listRoutineCandidates(principalId);
      return { status: 200, data: { routines } };
    }

    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '오전 브리핑 자동수신 Routine';
      const description = typeof body?.description === 'string' ? body.description : '매일 아침 8시 일정 및 이메일 자동 브리핑';
      const trigger_rule = typeof body?.trigger_rule === 'string' ? body.trigger_rule : 'Weekdays 08:00';
      const action_suggestion = typeof body?.action_suggestion === 'string' ? body.action_suggestion : 'Daily Morning Brief';

      const proposed = assistantEngine.proposeRoutineCandidate({
        user_id: principalId,
        tenant_id: tenantId,
        title,
        description,
        trigger_rule,
        action_suggestion,
        confidence: typeof body?.confidence === 'number' ? body.confidence : 0.9,
        frequency: typeof body?.frequency === 'number' ? body.frequency : 5,
        source_memory_ids: Array.isArray(body?.source_memory_ids) ? body.source_memory_ids.map(String) : ['mem_1001'],
      });
      return { status: 201, data: proposed };
    }
  }

  if (pathname.startsWith('/api/v1/personal/routines/') && pathname.endsWith('/confirm') && method === 'POST') {
    const routineId = pathname.replace('/api/v1/personal/routines/', '').replace('/confirm', '');
    const confirm = body?.confirm !== false;
    const updated = assistantEngine.confirmRoutineCandidate(principalId, routineId, confirm);
    if (!updated) {
      return { status: 404, data: { error: 'Routine candidate not found' } };
    }
    return { status: 200, data: updated };
  }

  return undefined;
};
