// Phase 03 — Module Contracts. Extended in P02a — Capability Broker
// Approved-Write Execution.
//
// Calendar has real consumers with only partial method overlap:
// CandidateActionResolver only ever advances an already-requested approval
// to real execution for create_event specifically (CalendarExecutionPort).
// CapabilityBroker requests approvals / reads free-busy slots
// (CalendarApprovalRequesterPort) AND, as of P02a, executes an
// already-approved write for all 4 write capabilities once a valid
// approvalId is supplied (CalendarWriteExecutionPort). A single giant
// GoogleCalendarServiceInterface would hide that these are genuinely
// separate, consumer-driven responsibilities, so this file defines narrow
// ports instead of one union — CapabilityBroker's actual dependency type
// is an intersection of two of them, not a new merged interface.
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

export interface CalendarWriteExecutionInput {
  approvalId: string;
  payload: unknown;
  tenantId: string;
  principalId: string;
  requestId: string;
}

// P02a — consumed by CapabilityBroker alongside CalendarApprovalRequesterPort
// (as an intersection type, never a merged interface) to execute an
// already-approved write once a valid approvalId is supplied. No
// getApproval method: the Broker never needs to separately fetch the
// approval record — each executeX method already internally validates and
// consumes it (tool binding, expiry, one-time-use, exact payload-hash
// match) via the same governed ActionApprovalStore path every other
// execute caller already goes through.
export interface CalendarWriteExecutionPort {
  executeCreateEvent(input: CalendarWriteExecutionInput): Promise<CalendarExecutionResult>;
  executeUpdateEvent(input: CalendarWriteExecutionInput): Promise<CalendarExecutionResult>;
  executeCancelEvent(input: CalendarWriteExecutionInput): Promise<CalendarExecutionResult>;
  executeRespondToEvent(input: CalendarWriteExecutionInput): Promise<CalendarExecutionResult>;
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
  getApproval(approvalId: string, tenantId: string, principalId: string): ActionApprovalRecord | undefined;
}
