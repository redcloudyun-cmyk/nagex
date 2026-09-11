// Phase 05 — Calendar Module Extraction.
//
// The only public surface external consumers may depend on. UpdateEventApprovalPayload,
// CancelEventApprovalPayload, RespondToEventApprovalPayload, CalendarRsvpResponseStatus,
// UpdateCalendarEventPayload, and the client's own FreeBusyInterval have zero external
// consumers (grep-verified) and stay module-private.
//
// queryFreeBusy/computeFreeSlots and the CalendarEventPayload type are exported here
// because they have real, pre-existing external consumers: server_web.ts's free-busy
// route calls queryFreeBusy/computeFreeSlots directly (bypassing the service), and
// action-resolver.ts (CandidateActionResolver) types its locally-built payload against
// CalendarEventPayload before handing it to CalendarExecutionPort.requestCreateEventApproval.
export { GoogleCalendarService } from './google-calendar.service.js';
export {
  GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID,
} from './google-calendar.service.js';
export { queryFreeBusy, computeFreeSlots } from './calendar.client.js';

export type { NormalizedExecutionResult } from './google-calendar.service.js';
export type { CalendarEventPayload } from './calendar.client.js';
