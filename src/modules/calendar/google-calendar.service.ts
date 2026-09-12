import { NagexError } from '../../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../../common/utils.js';
import { AuditLogger } from '../../governance/audit.logger.js';
import { ActionApprovalStore, type ActionApprovalRecord } from '../../governance/action-approval.store.js';
import { ExecutionStore } from '../../governance/execution.store.js';
import { MemoryEngine } from '../../context/memory.engine.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  respondToCalendarEvent,
  queryFreeBusy,
  computeFreeSlots,
  type CalendarEventPayload,
  type UpdateCalendarEventPayload,
  type CalendarRsvpResponseStatus,
  type FreeBusyInterval,
} from './calendar.client.js';
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import type { GoogleOAuthTokenStore } from '../../integrations/google/token.store.js';

export const GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID = 'google_calendar.create_event';
// E2E completion (MASTER.md Section 14.5, item 05): update / cancel / RSVP,
// reusing the exact same approval-gated pattern as create_event and Gmail —
// no separate approval architecture, no change to create_event's behavior.
export const GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID = 'google_calendar.update_event';
export const GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID = 'google_calendar.cancel_event';
export const GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID = 'google_calendar.respond_to_event';

const WRITE_TOOL_IDS = new Set([GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID]);

export interface UpdateEventApprovalPayload extends UpdateCalendarEventPayload {}

export interface CancelEventApprovalPayload {
  calendarId: string;
  eventId: string;
  // A frozen snapshot of what is being cancelled — required so the approval
  // card can show a human what they are about to cancel, not just an opaque
  // eventId (mirrors gmail.service.ts freezing `subject`/`to` for review).
  summary: string;
}

export interface RespondToEventApprovalPayload {
  calendarId: string;
  eventId: string;
  responseStatus: CalendarRsvpResponseStatus;
  summary: string;
}

const RSVP_STATUSES = new Set<CalendarRsvpResponseStatus>(['accepted', 'declined', 'tentative']);

function assertValidUpdatePayload(payload: unknown, requestId: string): asserts payload is UpdateEventApprovalPayload {
  const p = payload as Partial<UpdateEventApprovalPayload> | null;
  const structurallyValid = Boolean(
    p &&
    typeof p.calendarId === 'string' && p.calendarId &&
    typeof p.eventId === 'string' && p.eventId &&
    (p.summary === undefined || typeof p.summary === 'string') &&
    (p.description === undefined || typeof p.description === 'string') &&
    (p.start === undefined || typeof p.start === 'string') &&
    (p.end === undefined || typeof p.end === 'string') &&
    (p.timezone === undefined || typeof p.timezone === 'string') &&
    (p.attendees === undefined || (Array.isArray(p.attendees) && p.attendees.every((email) => typeof email === 'string'))),
  );
  if (!structurallyValid) {
    throw new NagexError({ code: 'INVALID_CALENDAR_UPDATE_PAYLOAD', category: 'VALIDATION', message: 'A calendar update payload must include calendarId and eventId, and any of summary/description/start/end/timezone/attendees to change.', request_id: requestId });
  }
  const valid = p as UpdateEventApprovalPayload;
  const hasAnyUpdate = valid.summary !== undefined || valid.description !== undefined || valid.start !== undefined || valid.end !== undefined || valid.attendees !== undefined;
  if (!hasAnyUpdate) {
    throw new NagexError({ code: 'CALENDAR_UPDATE_EMPTY', category: 'VALIDATION', message: 'At least one field to update (summary, description, start, end, or attendees) must be provided.', request_id: requestId });
  }
  if ((valid.start !== undefined || valid.end !== undefined) && valid.timezone === undefined) {
    throw new NagexError({ code: 'CALENDAR_UPDATE_TIMEZONE_REQUIRED', category: 'VALIDATION', message: 'timezone is required when changing start or end.', request_id: requestId });
  }
  if (valid.start !== undefined && !isValidIsoDateTime(valid.start)) {
    throw new NagexError({ code: 'INVALID_CALENDAR_EVENT_DATETIME', category: 'VALIDATION', message: 'start must be a valid date-time string.', request_id: requestId });
  }
  if (valid.end !== undefined && !isValidIsoDateTime(valid.end)) {
    throw new NagexError({ code: 'INVALID_CALENDAR_EVENT_DATETIME', category: 'VALIDATION', message: 'end must be a valid date-time string.', request_id: requestId });
  }
  if (valid.timezone !== undefined && !isValidTimezone(valid.timezone)) {
    throw new NagexError({ code: 'INVALID_CALENDAR_EVENT_TIMEZONE', category: 'VALIDATION', message: `"${valid.timezone}" is not a recognized IANA timezone.`, request_id: requestId });
  }
}

function assertValidCancelPayload(payload: unknown, requestId: string): asserts payload is CancelEventApprovalPayload {
  const p = payload as Partial<CancelEventApprovalPayload> | null;
  const valid = Boolean(p && typeof p.calendarId === 'string' && p.calendarId && typeof p.eventId === 'string' && p.eventId && typeof p.summary === 'string' && p.summary.trim());
  if (!valid) {
    throw new NagexError({ code: 'INVALID_CALENDAR_CANCEL_PAYLOAD', category: 'VALIDATION', message: 'A calendar cancel payload must include calendarId, eventId, and a summary snapshot for review.', request_id: requestId });
  }
}

function assertValidRespondPayload(payload: unknown, requestId: string): asserts payload is RespondToEventApprovalPayload {
  const p = payload as Partial<RespondToEventApprovalPayload> | null;
  const valid = Boolean(
    p && typeof p.calendarId === 'string' && p.calendarId && typeof p.eventId === 'string' && p.eventId &&
    typeof p.responseStatus === 'string' && RSVP_STATUSES.has(p.responseStatus as CalendarRsvpResponseStatus) &&
    typeof p.summary === 'string' && p.summary.trim(),
  );
  if (!valid) {
    throw new NagexError({ code: 'INVALID_CALENDAR_RESPOND_PAYLOAD', category: 'VALIDATION', message: 'A calendar RSVP payload must include calendarId, eventId, responseStatus (accepted/declined/tentative), and a summary snapshot for review.', request_id: requestId });
  }
}

export interface NormalizedExecutionResult {
  executionId: string;
  toolId: string;
  status: 'SUCCEEDED';
  externalId: string;
  externalUrl: string;
  startedAt: string;
  completedAt: string;
}

type FetchFn = typeof fetch;

function isValidIsoDateTime(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Structural + semantic validation (malformed datetime, invalid timezone) —
// approvalId/OAuth/payload-hash gating happens in requestApproval/
// executeCreateEvent, which is where "fail closed" for tampering matters.
function assertValidPayload(payload: unknown, requestId: string): asserts payload is CalendarEventPayload {
  const p = payload as Partial<CalendarEventPayload> | null;
  const structurallyValid = Boolean(
    p &&
    typeof p.calendarId === 'string' && p.calendarId &&
    typeof p.summary === 'string' && p.summary.trim() &&
    typeof p.description === 'string' &&
    typeof p.start === 'string' && p.start &&
    typeof p.end === 'string' && p.end &&
    typeof p.timezone === 'string' && p.timezone &&
    Array.isArray(p.attendees) && p.attendees.every((email) => typeof email === 'string') &&
    (p.conferenceData === undefined || typeof p.conferenceData === 'boolean'),
  );
  if (!structurallyValid) {
    throw new NagexError({
      code: 'INVALID_CALENDAR_EVENT_PAYLOAD',
      category: 'VALIDATION',
      message: 'A calendar event approval payload must include calendarId, summary, description, start, end, timezone, and attendees (conferenceData is optional, defaulting to no meeting link).',
      request_id: requestId,
    });
  }
  const valid = p as CalendarEventPayload;
  if (!isValidIsoDateTime(valid.start) || !isValidIsoDateTime(valid.end)) {
    throw new NagexError({
      code: 'INVALID_CALENDAR_EVENT_DATETIME',
      category: 'VALIDATION',
      message: 'start and end must be valid date-time strings.',
      request_id: requestId,
    });
  }
  if (!isValidTimezone(valid.timezone)) {
    throw new NagexError({
      code: 'INVALID_CALENDAR_EVENT_TIMEZONE',
      category: 'VALIDATION',
      message: `"${valid.timezone}" is not a recognized IANA timezone.`,
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
    private readonly executions: ExecutionStore = new ExecutionStore(),
  ) {}

  public async getFreeSlots(input: {
    tenantId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    requestId: string;
  }): Promise<{ slots: FreeBusyInterval[]; busy: FreeBusyInterval[]; calendarId: string; timeMin: string; timeMax: string }> {
    const config = this.getConfig();
    const accessToken = config ? await this.tokenStore.getValidAccessToken(input.tenantId, config, this.fetchFn, input.requestId) : null;
    if (!accessToken) {
      throw new NagexError({
        code: 'GOOGLE_CALENDAR_DISCONNECTED',
        category: 'POLICY',
        message: 'Google Calendar is not connected. Connect it before querying free slots.',
        request_id: input.requestId,
      });
    }

    const calendarId = input.calendarId || 'primary';
    const busy = await queryFreeBusy(accessToken, { calendarId, timeMin: input.timeMin, timeMax: input.timeMax }, this.fetchFn, input.requestId);
    const slots = computeFreeSlots(busy, input.timeMin, input.timeMax);
    return { slots, busy, calendarId, timeMin: input.timeMin, timeMax: input.timeMax };
  }

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
      action: 'approval.requested',
      resource: { type: 'ActionApproval', id: record.approvalId },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, summary: input.payload.summary },
    });
    return record;
  }

  public getApproval(approvalId: string, tenantId: string, principalId: string): ActionApprovalRecord | undefined {
    return this.approvals.get(approvalId, tenantId, principalId);
  }

  public approve(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.approve(approvalId, tenantId, principalId, requestId);
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval.approved',
      resource: { type: 'ActionApproval', id: approvalId },
      result: 'SUCCESS',
      request_id: requestId,
    });
    return record;
  }

  public reject(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    const record = this.approvals.reject(approvalId, tenantId, principalId, requestId);
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: record.tenantId,
      action: 'approval.rejected',
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
      action: 'tool.execution.started',
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
        action: 'tool.execution.failed',
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

    // Consuming the approval (hash-checked, one-time-use) happens before the
    // real Google call, and atomically with respect to this event loop — no
    // await occurs between checking and marking it CONSUMED — so a replayed
    // or concurrent execute request can never reach Google twice.
    try {
      this.approvals.consume(input.approvalId, input.tenantId, input.principalId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, input.payload as unknown as Record<string, unknown>, input.requestId, executionId);
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'APPROVAL_VALIDATION_FAILED';
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'DENIED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, approvalId: input.approvalId },
      });
      throw error;
    }

    this.executions.start({
      executionId,
      toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
      approvalId: input.approvalId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      startedAt,
    });

    try {
      const created = await createCalendarEvent(accessToken, input.payload, this.fetchFn, input.requestId);
      const completedAt = getCurrentISOString();
      this.executions.succeed(executionId, { externalId: created.externalId, externalUrl: created.externalUrl, completedAt });

      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.succeeded',
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
        status: 'SUCCEEDED',
        externalId: created.externalId,
        externalUrl: created.externalUrl,
        startedAt,
        completedAt,
      };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'GOOGLE_CALENDAR_EXECUTION_FAILED';
      const completedAt = getCurrentISOString();
      this.executions.fail(executionId, { errorCode: code, completedAt });
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID },
      });
      throw error;
    }
  }

  // ── E2E completion: update / cancel / RSVP ──────────────────────────────
  // Reuses the exact same shared ActionApprovalStore/ExecutionStore singletons
  // as executeCreateEvent above (untouched) and Gmail — one generic write
  // path parameterized by toolId, payload validator, and the real API call.

  public requestUpdateEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    assertValidUpdatePayload(input.payload, input.requestId);
    return this.requestWriteApproval(GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, input, { eventId: input.payload.eventId });
  }

  public requestCancelEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    assertValidCancelPayload(input.payload, input.requestId);
    return this.requestWriteApproval(GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, input, { eventId: input.payload.eventId, summary: input.payload.summary });
  }

  public requestRespondToEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    assertValidRespondPayload(input.payload, input.requestId);
    return this.requestWriteApproval(GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID, input, { eventId: input.payload.eventId, responseStatus: input.payload.responseStatus });
  }

  private requestWriteApproval(toolId: string, input: { tenantId: string; principalId: string; payload: unknown; requestId: string }, auditDetails: Record<string, unknown>): ActionApprovalRecord {
    if (!WRITE_TOOL_IDS.has(toolId)) {
      throw new NagexError({ code: 'UNSUPPORTED_APPROVAL_TOOL', category: 'VALIDATION', message: `Google Calendar has no approval-gated action for toolId "${toolId}".`, request_id: input.requestId });
    }
    const record = this.approvals.request({ toolId, tenantId: input.tenantId, principalId: input.principalId, payload: input.payload as unknown as Record<string, unknown> });
    this.audit.logEvent({
      actor: { type: 'user', id: input.principalId },
      tenant_id: input.tenantId,
      action: 'approval.requested',
      resource: { type: 'ActionApproval', id: record.approvalId },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      details: { toolId, ...auditDetails },
    });
    return record;
  }

  public async executeUpdateEvent(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedExecutionResult> {
    return this.executeWrite(
      GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID,
      input,
      assertValidUpdatePayload,
      (accessToken, payload, requestId) => updateCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      (payload) => ({ subject: 'Calendar Event', predicate: 'updated', value: `Updated "${payload.summary || payload.eventId}" on the calendar.` }),
    );
  }

  public async executeCancelEvent(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedExecutionResult> {
    return this.executeWrite(
      GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID,
      input,
      assertValidCancelPayload,
      (accessToken, payload, requestId) => cancelCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      (payload) => ({ subject: 'Calendar Event', predicate: 'cancelled', value: `Cancelled "${payload.summary}".` }),
    );
  }

  public async executeRespondToEvent(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedExecutionResult> {
    return this.executeWrite(
      GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID,
      input,
      assertValidRespondPayload,
      (accessToken, payload, requestId) => respondToCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      (payload) => ({ subject: 'Calendar Event', predicate: 'responded', value: `Responded "${payload.responseStatus}" to "${payload.summary}".` }),
    );
  }

  private async executeWrite<P extends { eventId: string }>(
    toolId: string,
    input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string },
    validate: (payload: unknown, requestId: string) => asserts payload is P,
    call: (accessToken: string, payload: P, requestId: string) => Promise<{ externalId: string; externalUrl: string }>,
    describeMemory: (payload: P) => { subject: string; predicate: string; value: string },
  ): Promise<NormalizedExecutionResult> {
    validate(input.payload, input.requestId);
    const payload = input.payload as P;
    const startedAt = getCurrentISOString();
    const executionId = generateResourceId('exe');

    this.audit.logEvent({
      actor: { type: 'user', id: input.principalId },
      tenant_id: input.tenantId,
      action: 'tool.execution.started',
      resource: { type: 'ToolExecution', id: executionId },
      result: 'PENDING_APPROVAL',
      request_id: input.requestId,
      details: { toolId, approvalId: input.approvalId },
    });

    const config = this.getConfig();
    const accessToken = config ? await this.tokenStore.getValidAccessToken(input.tenantId, config, this.fetchFn, input.requestId) : null;
    if (!accessToken) {
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: 'GOOGLE_CALENDAR_DISCONNECTED',
        request_id: input.requestId,
        details: { toolId },
      });
      throw new NagexError({ code: 'GOOGLE_CALENDAR_DISCONNECTED', category: 'POLICY', message: 'Google Calendar is not connected. Connect it before this action can execute.', request_id: input.requestId });
    }

    try {
      this.approvals.consume(input.approvalId, input.tenantId, input.principalId, toolId, payload as unknown as Record<string, unknown>, input.requestId, executionId);
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'APPROVAL_VALIDATION_FAILED';
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'DENIED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId, approvalId: input.approvalId },
      });
      throw error;
    }

    this.executions.start({ executionId, toolId, approvalId: input.approvalId, tenantId: input.tenantId, principalId: input.principalId, startedAt });

    try {
      const result = await call(accessToken, payload, input.requestId);
      const completedAt = getCurrentISOString();
      this.executions.succeed(executionId, { externalId: result.externalId, externalUrl: result.externalUrl, completedAt });

      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.succeeded',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'SUCCESS',
        request_id: input.requestId,
        details: { toolId, externalEventId: result.externalId },
      });

      const memoryFields = describeMemory(payload);
      const memoryRecord = this.memory.proposeMemory('USER', input.principalId, memoryFields);
      this.memory.activateMemory(memoryRecord.id);

      return { executionId, toolId, status: 'SUCCEEDED', externalId: result.externalId, externalUrl: result.externalUrl, startedAt, completedAt };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'GOOGLE_CALENDAR_EXECUTION_FAILED';
      const completedAt = getCurrentISOString();
      this.executions.fail(executionId, { errorCode: code, completedAt });
      this.audit.logEvent({
        actor: { type: 'user', id: input.principalId },
        tenant_id: input.tenantId,
        action: 'tool.execution.failed',
        resource: { type: 'ToolExecution', id: executionId },
        result: 'FAILED',
        reason_code: code,
        request_id: input.requestId,
        details: { toolId },
      });
      throw error;
    }
  }
}
