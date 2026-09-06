import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AuditLogger } from '../governance/audit.logger.js';
import { ActionApprovalStore, type ActionApprovalRecord } from '../governance/action-approval.store.js';
import { MemoryEngine } from '../context/memory.engine.js';
import { createCalendarEvent, type CalendarEventPayload } from '../integrations/google/calendar.client.js';
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from '../integrations/google/oauth.client.js';
import type { GoogleOAuthTokenStore } from '../integrations/google/token.store.js';

export const GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID = 'google_calendar.create_event';

export interface NormalizedExecutionResult {
  executionId: string;
  toolId: string;
  status: 'SUCCESS';
  externalId: string;
  externalUrl: string;
  startedAt: string;
  completedAt: string;
}

type FetchFn = typeof fetch;

// Structural validation only — approvalId/OAuth/payload-match gating happens
// in requestApproval/executeCreateEvent, which is where "fail closed" matters.
function assertValidPayload(payload: unknown, requestId: string): asserts payload is CalendarEventPayload {
  const p = payload as Partial<CalendarEventPayload> | null;
  if (
    !p ||
    typeof p.calendarId !== 'string' || !p.calendarId ||
    typeof p.summary !== 'string' || !p.summary.trim() ||
    typeof p.description !== 'string' ||
    typeof p.start !== 'string' || !p.start ||
    typeof p.end !== 'string' || !p.end ||
    typeof p.timezone !== 'string' || !p.timezone ||
    !Array.isArray(p.attendees) || !p.attendees.every((email) => typeof email === 'string') ||
    (p.conferenceDataPreference !== 'none' && p.conferenceDataPreference !== 'hangoutsMeet')
  ) {
    throw new NagexError({
      code: 'INVALID_CALENDAR_EVENT_PAYLOAD',
      category: 'VALIDATION',
      message: 'A calendar event approval payload must include calendarId, summary, description, start, end, timezone, attendees, and conferenceDataPreference.',
      request_id: requestId,
    });
  }
}

function formatScheduledFor(isoDateTime: string, timezone: string): string {
  // "YYYY-MM-DD HH:mm" — the sv-SE locale happens to format this way by default.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoDateTime));
}

export class GoogleCalendarService {
  constructor(
    private readonly tokenStore: GoogleOAuthTokenStore,
    private readonly approvals: ActionApprovalStore,
    private readonly audit: AuditLogger,
    private readonly memory: MemoryEngine,
    private readonly fetchFn: FetchFn = fetch,
    private readonly getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfig | null = readGoogleOAuthConfig,
  ) {}

  public requestCreateEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    assertValidPayload(input.payload, input.requestId);
    const record = this.approvals.request({
      toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
      tenantId: input.tenantId,
      principalId: input.principalId,
      payload: input.payload as unknown as Record<string, unknown>,
    });
    this.audit.logEvent({
      actor: { type: 'user', id: input.principalId },
      tenant_id: input.tenantId,
      action: 'approval:requested',
      resource: { type: 'ActionApproval', id: record.id },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, summary: input.payload.summary },
    });
    return record;
  }

  public approve(approvalId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.approve(approvalId, requestId);
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval:granted',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'SUCCESS',
      request_id: requestId,
    });
    return record;
  }

  public reject(approvalId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.reject(approvalId, requestId);
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval:rejected',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'DENIED',
      request_id: requestId,
    });
    return record;
  }

  public async executeCreateEvent(input: {
    approvalId: string;
    payload: unknown;
    tenantId: string;
    principalId: string;
    requestId: string;
  }): Promise<NormalizedExecutionResult> {
    assertValidPayload(input.payload, input.requestId);
    const startedAt = getCurrentISOString();
    const executionId = generateResourceId('exe');

    this.audit.logEvent({
      actor: { type: 'user', id: input.principalId },
      tenant_id: input.tenantId,
      action: 'tool:execution_started',
      resource: { type: 'ToolExecution', id: executionId },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, approvalId: input.approvalId },
    });

    const config = this.getConfig();
    const accessToken = config ? await this.tokenStore.getValidAccessToken(input.tenantId, config, this.fetchFn, input.requestId) : null;
    if (!accessToken) {
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool:execution_failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: 'GOOGLE_CALENDAR_DISCONNECTED',
        request_id: input.requestId,
        details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID },
      });
      throw new NagexError({
        code: 'GOOGLE_CALENDAR_DISCONNECTED',
        category: 'POLICY',
        message: 'Google Calendar is not connected. Connect it before this action can execute.',
        request_id: input.requestId,
      });
    }

    let approvalRecord: ActionApprovalRecord;
    try {
      approvalRecord = this.approvals.consume(input.approvalId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, input.payload as unknown as Record<string, unknown>, input.requestId);
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'APPROVAL_VALIDATION_FAILED';
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool:execution_failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'DENIED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, approvalId: input.approvalId },
      });
      throw error;
    }
    void approvalRecord;

    try {
      const created = await createCalendarEvent(accessToken, input.payload, this.fetchFn, input.requestId);
      const completedAt = getCurrentISOString();

      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool:execution_succeeded',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'SUCCESS',
        request_id: input.requestId,
        details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, externalEventId: created.externalId },
      });

      const scheduledFor = formatScheduledFor(input.payload.start, input.payload.timezone);
      const memoryRecord = this.memory.proposeMemory('USER', input.principalId, {
        subject: 'Calendar Event',
        predicate: 'scheduled',
        value: `Scheduled ${input.payload.summary} for ${scheduledFor}.`,
      });
      this.memory.activateMemory(memoryRecord.id);

      return {
        executionId,
        toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
        status: 'SUCCESS',
        externalId: created.externalId,
        externalUrl: created.externalUrl,
        startedAt,
        completedAt,
      };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'GOOGLE_CALENDAR_EXECUTION_FAILED';
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool:execution_failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID },
      });
      throw error;
    }
  }
}
