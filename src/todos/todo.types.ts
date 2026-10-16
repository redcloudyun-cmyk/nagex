// A TODO is a follow-up the person can choose to have NAgex do. It is not a message and not a plan: it is a small record that points at the existing paths (creation, research, the
// plan -> approval -> run engine) and whose STATE is read from what those paths actually produced - never claimed by the screen.
//
//   PROPOSED           offered; nothing was started
//   IN_PROGRESS        the person chose it and NAgex is working on it (or a plan was prepared and is waiting for the person's own "request approval")
//   APPROVAL_REQUIRED  an approval is waiting; nothing outside NAgex has happened yet
//   COMPLETED          the thing exists / the action ran (detail says whether NAgex read it back: VERIFIED, or only the tool's answer: RESPONDED)
//   FAILED             it did not work out (detail says why: DECLINED, EXPIRED, NOT_CONFIRMED, MISMATCH, REQUEST_FAILED, ...)

export type TodoState = 'PROPOSED' | 'APPROVAL_REQUIRED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
export type TodoKind = 'CREATE_DOCUMENT' | 'CREATE_PRESENTATION' | 'CREATE_IMAGE' | 'RESEARCH' | 'ACTION';

export const TODO_ID_PATTERN = /^todo_[0-9a-f]{24}$/;

export interface TodoRecord {
  todoId: string;
  tenantId: string;
  ownerId: string;
  title: string;
  /** the complete request NAgex runs when the person chooses this TODO - the same words they could have typed */
  prompt: string;
  kind: TodoKind;
  origin: 'ARTIFACT' | 'CONVERSATION';
  /** the document this follow-up continues from (a deck from a report) */
  sourceArtifactId?: string;
  sourceDocumentId?: string;
  state: TodoState;
  links: { taskId?: string; artifactId?: string };
  detail?: { code: string };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  settledAt?: string;
}

/** What the client sees: no tenant or owner. */
export type TodoView = Omit<TodoRecord, 'tenantId' | 'ownerId'>;

export interface FollowUpSuggestions {
  /** things NAgex can do on the person's choice (each classified executable by the router) */
  todos: TodoView[];
  /** advice the person has to act on themselves, or that NAgex cannot do: shown, never clickable */
  recommendations: string[];
  /** why there are none, when there are none */
  reason?: 'NOT_REQUESTED' | 'NOTHING_TO_OFFER' | 'NOT_A_DOCUMENT';
}

export function toView(record: TodoRecord): TodoView {
  const { tenantId: _tenantId, ownerId: _ownerId, ...view } = record;
  return view;
}
