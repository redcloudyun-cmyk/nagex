// Phase 03 — Module Contracts.
//
// Calendar has two disjoint real consumers with no method overlap:
// CapabilityBroker only ever requests approvals / reads free-busy slots;
// CandidateActionResolver only ever advances an already-requested approval
// to real execution. A single giant GoogleCalendarServiceInterface would
// hide that these are genuinely separate responsibilities, so this file
// defines two narrow ports instead of one union.
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';

// Mirrors modules/calendar/calendar.client.ts's FreeBusyInterval —
// inlined rather than imported: contracts never import from integrations/.
export interface CalendarFreeBusyInterval {
  start: string;
  end: string;
}

// Mirrors modules/calendar/google-calendar.service.ts's NormalizedExecutionResult —
// inlined rather than imported from the concrete service file, so this
// contract does not depend on the implementation it exists to abstract.
export interface CalendarExecutionResult {
  executionId: string;
  toolId: string;
  status: 'SUCCEEDED';
  externalId: string;
  externalUrl: string;
  startedAt: string;
  completedAt: string;
}

export interface CalendarApprovalRequestInput {
  tenantId: string;
  principalId: string;
  payload: unknown;
  requestId: string;
}

// Consumed by CapabilityBroker (capability-broker.ts): requests approval
// for a Calendar write, and reads free/busy slots (a read-only capability
// that needs no approval). Never calls executeCreateEvent/getApproval —
// see CalendarExecutionPort below for that disjoint shape.
export interface CalendarApprovalRequesterPort {
  getFreeSlots(input: {
    tenantId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    requestId: string;
  }): Promise<{
    slots: CalendarFreeBusyInterval[];
    busy: CalendarFreeBusyInterval[];
    calendarId: string;
    timeMin: string;
    timeMax: string;
  }>;
  requestCreateEventApproval(input: CalendarApprovalRequestInput): ActionApprovalRecord;
  requestUpdateEventApproval(input: CalendarApprovalRequestInput): ActionApprovalRecord;
  requestCancelEventApproval(input: CalendarApprovalRequestInput): ActionApprovalRecord;
  requestRespondToEventApproval(input: CalendarApprovalRequestInput): ActionApprovalRecord;
}

// Consumed by CandidateActionResolver (action-resolver.ts): requests
// approval for the one Calendar candidate action it supports (create
// event), then advances that approval to real execution. Only one method
// overlaps with CalendarApprovalRequesterPort above (requestCreateEventApproval)
// — action-resolver.ts never calls requestUpdateEventApproval/
// requestCancelEventApproval/requestRespondToEventApproval/getFreeSlots,
// so those stay out of this narrower, consumer-driven shape.
export interface CalendarExecutionPort {
  requestCreateEventApproval(input: CalendarApprovalRequestInput): ActionApprovalRecord;
  executeCreateEvent(input: {
    approvalId: string;
    payload: unknown;
    tenantId: string;
    principalId: string;
    requestId: string;
  }): Promise<CalendarExecutionResult>;
  getApproval(approvalId: string): ActionApprovalRecord | undefined;
}
