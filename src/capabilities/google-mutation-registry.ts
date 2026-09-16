// R10.2-B (DEBT-0001) — the one canonical registry of every Google
// mutation capability that exists in NAgex today. Assembled ONLY from
// each module's public index.ts (never a deep internal file), per this
// repo's existing architecture boundary — see
// tests/google_modules_boundary.test.ts and
// tests/google_capability_execution_pipeline.test.ts's static guard.
import { CALENDAR_MUTATION_DEFINITIONS } from '../modules/calendar/index.js';
import { GMAIL_MUTATION_DEFINITIONS } from '../modules/gmail/index.js';
import { buildMutationRegistry, type MutationCapabilityDefinition } from './mutation-registry.js';

export const GOOGLE_MUTATION_REGISTRY: ReadonlyMap<string, MutationCapabilityDefinition> = buildMutationRegistry([
  CALENDAR_MUTATION_DEFINITIONS,
  GMAIL_MUTATION_DEFINITIONS,
]);

export function listGoogleMutationToolIds(): string[] {
  return [...GOOGLE_MUTATION_REGISTRY.keys()];
}
