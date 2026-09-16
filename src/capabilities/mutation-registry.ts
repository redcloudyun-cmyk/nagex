// R10.2-B — canonical, provider-agnostic types for the Google mutation
// registry (DEBT-0001). Deliberately zero-dependency on src/modules/
// calendar or src/modules/gmail internals: this file only defines the
// SHAPE every registered mutation capability must declare, and a tiny
// helper to assemble a de-duplicated registry from per-module definition
// lists. The actual definitions (with their capability-specific payload
// validators) live inside each owning module — see
// src/modules/calendar/google-calendar.service.ts's CALENDAR_MUTATION_DEFINITIONS
// and src/modules/gmail/gmail.service.ts's GMAIL_MUTATION_DEFINITIONS — and
// are assembled into one registry by src/capabilities/google-mutation-registry.ts,
// which imports them only through each module's public index.ts (never a
// deep internal file), per this repo's existing architecture boundary
// (tests/google_modules_boundary.test.ts).
import { NagexError } from '../common/errors.js';

export type MutationProvider = 'GOOGLE';
export type MutationService = 'GMAIL' | 'CALENDAR';

// A declarative safety contract every registered external mutation must
// state up front — mirrors docs/NAGEX_DEVELOPMENT_SAFETY_HARNESS.md §3.2's
// CapabilitySafetyContract shape.
export interface MutationCapabilityDefinition<TPayload = unknown> {
  toolId: string;
  provider: MutationProvider;
  service: MutationService;
  mutation: true;
  approvalRequired: true;
  failureMode: 'FAIL_CLOSED';
  timeoutBehavior: 'ABORT';
  unknownStateBehavior: 'DENY';
  // The error code/message the pipeline throws when the provider isn't
  // connected — kept per-definition (not collapsed into one generic code)
  // so existing, already-tested consumer-facing error codes
  // (GOOGLE_CALENDAR_DISCONNECTED / GMAIL_DISCONNECTED) never change.
  disconnectedErrorCode: string;
  disconnectedMessage: string;
  // The audit-log detail key the pipeline records the provider's returned
  // externalId under on success. Kept per-definition (default 'externalId')
  // rather than collapsed into one universal key, because Calendar's
  // pre-existing audit contract used 'externalEventId' — changing an
  // already-shipped, externally-observable audit field name is exactly
  // the kind of silent behavior change this refactor must not introduce.
  successExternalIdAuditKey?: string;
  // Structural + semantic payload validation stays fully capability-
  // specific (§8) — the pipeline only ever calls this, never inspects or
  // re-implements payload rules itself.
  validatePayload(payload: unknown, requestId: string): TPayload;
}

// The identity + frozen payload a single execution attempt proves it has,
// before the pipeline allows any external mutation. Missing/absent
// tenantId, principalId, or approvalId must DENY (§7) — enforced by
// TypeScript's required fields plus the pipeline's own runtime checks.
export interface MutationExecutionContext<TPayload = unknown> {
  tenantId: string;
  principalId: string;
  toolId: string;
  approvalId: string;
  payload: TPayload;
  requestId: string;
}

// Combines definition lists from multiple modules into one registry map,
// keyed by toolId, and fails loudly (never silently) if two modules ever
// declare the same toolId twice — "no duplicate tool IDs" (§4).
export function buildMutationRegistry(
  definitionLists: MutationCapabilityDefinition[][],
): ReadonlyMap<string, MutationCapabilityDefinition> {
  const registry = new Map<string, MutationCapabilityDefinition>();
  for (const list of definitionLists) {
    for (const definition of list) {
      if (registry.has(definition.toolId)) {
        throw new Error(`Duplicate mutation capability toolId registered: "${definition.toolId}"`);
      }
      registry.set(definition.toolId, definition);
    }
  }
  return registry;
}

export function requireMutationDefinition(
  registry: ReadonlyMap<string, MutationCapabilityDefinition>,
  toolId: string,
  requestId: string,
): MutationCapabilityDefinition {
  const definition = registry.get(toolId);
  if (!definition) {
    throw new NagexError({
      code: 'UNKNOWN_MUTATION_CAPABILITY',
      category: 'VALIDATION',
      message: `No registered mutation capability for toolId "${toolId}".`,
      request_id: requestId,
    });
  }
  return definition;
}
