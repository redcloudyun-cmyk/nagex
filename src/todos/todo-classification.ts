// Which follow-ups are TODOs (NAgex can do them on the person's choice) and which are only recommendations. The decision is the router's own - the same one a typed request gets - so a TODO
// can never promise a path that does not exist: if the words would not reach creation, research or the plan -> approval engine, it is a recommendation and is shown without a button.
import { decideRouting } from '../workspace/input-router.js';
import type { TodoKind } from './todo.types.js';

export interface FollowUpClass {
  executable: boolean;
  kind?: TodoKind;
  /** the router's own answer, for the audit trail and for tests */
  route: string;
}

export function classifyFollowUp(prompt: string, options: { sourceDocument?: boolean } = {}): FollowUpClass {
  const decision = decideRouting(prompt, { ...(options.sourceDocument ? { sourceDocument: true } : {}) });
  const route = decision.kind + (decision.targetArtifactType ? `/${decision.targetArtifactType}` : '');
  if (decision.executionNegated) return { executable: false, route };
  // a request that would only be answered with a question is not something to start with one click
  const needsMoreFromThePerson = decision.ambiguity.level === 'HIGH';
  if (decision.kind === 'CREATE_ARTIFACT' && !needsMoreFromThePerson) {
    const kind: TodoKind | undefined = decision.targetArtifactType === 'DOCUMENT' ? 'CREATE_DOCUMENT' : decision.targetArtifactType === 'PRESENTATION' ? 'CREATE_PRESENTATION' : decision.targetArtifactType === 'IMAGE' ? 'CREATE_IMAGE' : undefined;
    return kind ? { executable: true, kind, route } : { executable: false, route };
  }
  if (decision.kind === 'RESEARCH' && !needsMoreFromThePerson) return { executable: true, kind: 'RESEARCH', route };
  if (decision.kind === 'ACTION_PLAN' && decision.supported && !needsMoreFromThePerson) return { executable: true, kind: 'ACTION', route };
  return { executable: false, route };
}

// The person asked for a to-do list / next steps. A plain question is never turned into a task list.
const TODO_REQUEST = /(할\s*일|투두|to-?\s?do\b|todo\b|next\s+steps?|next\s+actions?|action\s+items?|액션\s*아이템|follow-?\s?ups?|checklist|체크\s*리스트|다음\s*(단계|행동|작업|할\s*일)|그\s*다음에?\s*뭐|무엇부터|뭐부터|해야\s*(할|하는|될)\s*(일|것|작업)|what\s+should\s+i\s+do\s+next)/i;

export function wantsTodoList(message: string): boolean {
  return TODO_REQUEST.test(String(message ?? '').normalize('NFC'));
}
