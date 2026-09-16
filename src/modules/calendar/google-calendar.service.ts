import { NagexError } from '../../common/errors.js';
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
  listUpcomingCalendarEvents,
  type CalendarEventPayload,
  type UpdateCalendarEventPayload,
  type CalendarRsvpResponseStatus,
  type FreeBusyInterval,
  type UpcomingCalendarEvent,
} from './calendar.client.js';
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import type { GoogleOAuthTokenStore } from '../../integrations/google/token.store.js';
import { GoogleCapabilityExecutionPipeline, type NormalizedMutationResult } from '../../capabilities/google-capability-execution-pipeline.js';
import type { MutationCapabilityDefinition } from '../../capabilities/mutation-registry.js';

export const GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID = 'google_calendar.create_event';
// E2E completion (MASTER.md Section 14.5, item 05): update / cancel / RSVP,
// reusing the exact same approval-gated pattern as create_event and Gmail —
// no separate approval architecture, no change to create_event's behavior.
export const GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID = 'google_calendar.update_event';
export const GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID = 'google_calendar.cancel_event';
export const GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID = 'google_calendar.respond_to_event';

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
const GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_QUERY = 'Google Calendar is not connected. Connect it before querying free slots.';
const GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_LIST = 'Google Calendar is not connected. Connect it before listing upcoming events.';
const GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_EXECUTE = 'Google Calendar is not connected. Connect it before this action can execute.';

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
// approvalId/OAuth/payload-hash gating happens inside the shared
// GoogleCapabilityExecutionPipeline (request/consume), which is where
// "fail closed" for tampering matters. Capability-specific validation
// rules stay capability-specific (R10.2-B §8) — never moved into the
// generic pipeline.
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

export type { NormalizedMutationResult as NormalizedExecutionResult };

type FetchFn = typeof fetch;

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

// R10.2-B (DEBT-0001) — the canonical, exported mutation-capability
// definitions for Calendar, assembled (alongside Gmail's) into one
// registry by src/capabilities/google-mutation-registry.ts. Kept here,
// not in the generic pipeline module, because the validators they
// reference are capability-specific (§8) and this module already owns
// the module-private payload types they close over.
export const CALENDAR_MUTATION_DEFINITIONS: MutationCapabilityDefinition[] = [
  {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, provider: 'GOOGLE', service: 'CALENDAR', mutation: true, approvalRequired: true,
    failureMode: 'FAIL_CLOSED', timeoutBehavior: 'ABORT', unknownStateBehavior: 'DENY',
    disconnectedErrorCode: 'GOOGLE_CALENDAR_DISCONNECTED', disconnectedMessage: GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_EXECUTE, successExternalIdAuditKey: 'externalEventId',
    validatePayload: (payload, requestId) => { assertValidPayload(payload, requestId); return payload; },
  },
  {
    toolId: GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, provider: 'GOOGLE', service: 'CALENDAR', mutation: true, approvalRequired: true,
    failureMode: 'FAIL_CLOSED', timeoutBehavior: 'ABORT', unknownStateBehavior: 'DENY',
    disconnectedErrorCode: 'GOOGLE_CALENDAR_DISCONNECTED', disconnectedMessage: GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_EXECUTE, successExternalIdAuditKey: 'externalEventId',
    validatePayload: (payload, requestId) => { assertValidUpdatePayload(payload, requestId); return payload; },
  },
  {
    toolId: GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, provider: 'GOOGLE', service: 'CALENDAR', mutation: true, approvalRequired: true,
    failureMode: 'FAIL_CLOSED', timeoutBehavior: 'ABORT', unknownStateBehavior: 'DENY',
    disconnectedErrorCode: 'GOOGLE_CALENDAR_DISCONNECTED', disconnectedMessage: GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_EXECUTE, successExternalIdAuditKey: 'externalEventId',
    validatePayload: (payload, requestId) => { assertValidCancelPayload(payload, requestId); return payload; },
  },
  {
    toolId: GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID, provider: 'GOOGLE', service: 'CALENDAR', mutation: true, approvalRequired: true,
    failureMode: 'FAIL_CLOSED', timeoutBehavior: 'ABORT', unknownStateBehavior: 'DENY',
    disconnectedErrorCode: 'GOOGLE_CALENDAR_DISCONNECTED', disconnectedMessage: GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_EXECUTE, successExternalIdAuditKey: 'externalEventId',
    validatePayload: (payload, requestId) => { assertValidRespondPayload(payload, requestId); return payload; },
  },
];

const CALENDAR_MUTATION_BY_TOOL_ID = new Map(CALENDAR_MUTATION_DEFINITIONS.map((d) => [d.toolId, d]));

export class GoogleCalendarService {
  private readonly pipeline: GoogleCapabilityExecutionPipeline;

  constructor(
    private readonly tokenStore: GoogleOAuthTokenStore,
    private readonly approvals: ActionApprovalStore,
    private readonly audit: AuditLogger,
    private readonly memory: MemoryEngine,
    private readonly fetchFn: FetchFn = fetch,
    private readonly getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfig | null = readGoogleOAuthConfig,
    private readonly executions: ExecutionStore = new ExecutionStore(),
  ) {
    this.pipeline = new GoogleCapabilityExecutionPipeline({
      tokenStore: this.tokenStore, approvals: this.approvals, audit: this.audit,
      executions: this.executions, getConfig: this.getConfig, fetchFn: this.fetchFn,
    });
  }

  public async getFreeSlots(input: {
    tenantId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    requestId: string;
  }): Promise<{ slots: FreeBusyInterval[]; busy: FreeBusyInterval[]; calendarId: string; timeMin: string; timeMax: string }> {
    const accessToken = await this.pipeline.resolveAccessToken(input.tenantId, input.requestId, 'GOOGLE_CALENDAR_DISCONNECTED', GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_QUERY);
    const calendarId = input.calendarId || 'primary';
    const busy = await queryFreeBusy(accessToken, { calendarId, timeMin: input.timeMin, timeMax: input.timeMax }, this.fetchFn, input.requestId);
    const slots = computeFreeSlots(busy, input.timeMin, input.timeMax);
    return { slots, busy, calendarId, timeMin: input.timeMin, timeMax: input.timeMax };
  }

  // Read-only — My Space's Calendar summary. Reuses the exact same
  // connect/token-resolution path as getFreeSlots above; never a new OAuth
  // mechanism, never a new token store, never a direct/bypassing Google
  // call from outside this module. Read capabilities never go through the
  // mutation pipeline's approval gate (R10.2-B §13).
  public async listUpcomingEvents(input: {
    tenantId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
    requestId: string;
  }): Promise<UpcomingCalendarEvent[]> {
    const accessToken = await this.pipeline.resolveAccessToken(input.tenantId, input.requestId, 'GOOGLE_CALENDAR_DISCONNECTED', GOOGLE_CALENDAR_DISCONNECTED_MESSAGE_LIST);
    const calendarId = input.calendarId || 'primary';
    return listUpcomingCalendarEvents(
      accessToken,
      { calendarId, timeMin: input.timeMin, timeMax: input.timeMax, maxResults: input.maxResults },
      this.fetchFn,
      input.requestId,
    );
  }

  public requestCreateEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    const definition = CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID)!;
    const payload = definition.validatePayload(input.payload, input.requestId) as CalendarEventPayload;
    return this.pipeline.requestApproval(definition, input.tenantId, input.principalId, payload as unknown as Record<string, unknown>, input.requestId, { summary: payload.summary });
  }

  public getApproval(approvalId: string, tenantId: string, principalId: string): ActionApprovalRecord | undefined {
    return this.pipeline.getApproval(approvalId, tenantId, principalId);
  }

  public approve(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    return this.pipeline.approve(approvalId, tenantId, principalId, requestId);
  }

  public reject(approvalId: string, tenantId: string, principalId: string, requestId: string): ActionApprovalRecord {
    return this.pipeline.reject(approvalId, tenantId, principalId, requestId);
  }

  public async executeCreateEvent(input: {
    approvalId: string;
    payload: unknown;
    tenantId: string;
    principalId: string;
    requestId: string;
  }): Promise<NormalizedMutationResult> {
    return this.pipeline.execute({
      definition: CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID)! as MutationCapabilityDefinition<CalendarEventPayload>,
      context: { tenantId: input.tenantId, principalId: input.principalId, toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, approvalId: input.approvalId, payload: input.payload, requestId: input.requestId },
      executeProvider: (accessToken, payload: CalendarEventPayload, requestId) => createCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      afterSuccess: (payload: CalendarEventPayload) => {
        const scheduledFor = formatScheduledFor(payload.start, payload.timezone);
        const memoryRecord = this.memory.proposeMemory('USER', input.tenantId, input.principalId, {
          subject: 'Calendar Event', predicate: 'scheduled', value: `Scheduled ${payload.summary} for ${scheduledFor}.`,
        });
        this.memory.activateMemory(memoryRecord.id, input.tenantId, input.principalId);
      },
    });
  }

  // ── E2E completion: update / cancel / RSVP ──────────────────────────────
  // Reuses the exact same shared pipeline/ActionApprovalStore/
  // ExecutionStore as executeCreateEvent above and Gmail — one canonical
  // write path parameterized by toolId/definition/executeProvider.

  public requestUpdateEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    const definition = CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID)!;
    const payload = definition.validatePayload(input.payload, input.requestId) as UpdateEventApprovalPayload;
    return this.pipeline.requestApproval(definition, input.tenantId, input.principalId, payload as unknown as Record<string, unknown>, input.requestId, { eventId: payload.eventId });
  }

  public requestCancelEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    const definition = CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID)!;
    const payload = definition.validatePayload(input.payload, input.requestId) as CancelEventApprovalPayload;
    return this.pipeline.requestApproval(definition, input.tenantId, input.principalId, payload as unknown as Record<string, unknown>, input.requestId, { eventId: payload.eventId, summary: payload.summary });
  }

  public requestRespondToEventApproval(input: { tenantId: string; principalId: string; payload: unknown; requestId: string }): ActionApprovalRecord {
    const definition = CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID)!;
    const payload = definition.validatePayload(input.payload, input.requestId) as RespondToEventApprovalPayload;
    return this.pipeline.requestApproval(definition, input.tenantId, input.principalId, payload as unknown as Record<string, unknown>, input.requestId, { eventId: payload.eventId, responseStatus: payload.responseStatus });
  }

  public async executeUpdateEvent(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedMutationResult> {
    return this.pipeline.execute({
      definition: CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID)! as MutationCapabilityDefinition<UpdateEventApprovalPayload>,
      context: { tenantId: input.tenantId, principalId: input.principalId, toolId: GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, approvalId: input.approvalId, payload: input.payload, requestId: input.requestId },
      executeProvider: (accessToken, payload: UpdateEventApprovalPayload, requestId) => updateCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      afterSuccess: (payload: UpdateEventApprovalPayload) => {
        const memoryRecord = this.memory.proposeMemory('USER', input.tenantId, input.principalId, { subject: 'Calendar Event', predicate: 'updated', value: `Updated "${payload.summary || payload.eventId}" on the calendar.` });
        this.memory.activateMemory(memoryRecord.id, input.tenantId, input.principalId);
      },
    });
  }

  public async executeCancelEvent(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedMutationResult> {
    return this.pipeline.execute({
      definition: CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID)! as MutationCapabilityDefinition<CancelEventApprovalPayload>,
      context: { tenantId: input.tenantId, principalId: input.principalId, toolId: GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, approvalId: input.approvalId, payload: input.payload, requestId: input.requestId },
      executeProvider: (accessToken, payload: CancelEventApprovalPayload, requestId) => cancelCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      afterSuccess: (payload: CancelEventApprovalPayload) => {
        const memoryRecord = this.memory.proposeMemory('USER', input.tenantId, input.principalId, { subject: 'Calendar Event', predicate: 'cancelled', value: `Cancelled "${payload.summary}".` });
        this.memory.activateMemory(memoryRecord.id, input.tenantId, input.principalId);
      },
    });
  }

  public async executeRespondToEvent(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<NormalizedMutationResult> {
    return this.pipeline.execute({
      definition: CALENDAR_MUTATION_BY_TOOL_ID.get(GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID)! as MutationCapabilityDefinition<RespondToEventApprovalPayload>,
      context: { tenantId: input.tenantId, principalId: input.principalId, toolId: GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID, approvalId: input.approvalId, payload: input.payload, requestId: input.requestId },
      executeProvider: (accessToken, payload: RespondToEventApprovalPayload, requestId) => respondToCalendarEvent(accessToken, payload, this.fetchFn, requestId),
      afterSuccess: (payload: RespondToEventApprovalPayload) => {
        const memoryRecord = this.memory.proposeMemory('USER', input.tenantId, input.principalId, { subject: 'Calendar Event', predicate: 'responded', value: `Responded "${payload.responseStatus}" to "${payload.summary}".` });
        this.memory.activateMemory(memoryRecord.id, input.tenantId, input.principalId);
      },
    });
  }
}
