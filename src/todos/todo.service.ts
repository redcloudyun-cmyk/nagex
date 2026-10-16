import crypto from 'node:crypto';
import type { ArtifactStore } from '../artifacts/artifact.store.js';
import { detectRequestLanguage } from '../common/request-language.js';
import { classifyFollowUp, wantsTodoList } from './todo-classification.js';
import type { TodoStore } from './todo.store.js';
import { toView, type FollowUpSuggestions, type TodoRecord, type TodoState, type TodoView } from './todo.types.js';

// What the existing task engine says about a task (the plan -> approval -> run path). Injected, so this module owns no second engine and no second approval.
export interface TaskOutcome {
  status: 'RUNNING' | 'WAITING_APPROVAL' | 'SUCCEEDED' | 'FAILED' | string;
  errorCode: string | null;
  result: unknown;
}
export type ReadTaskOutcome = (tenantId: string, ownerId: string, taskId: string) => TaskOutcome | null | undefined;

export interface FollowUpProposer {
  proposeFollowUps(input: { message: string; answer?: string; requestId?: string; clock?: { nowMs: number; timezone: string; timezoneSource?: string } }): Promise<{ data: { todos: Array<{ title: string; prompt: string }>; recommendations: string[] } }>;
}

export interface TodoServiceDeps {
  store: TodoStore;
  artifactStore: ArtifactStore;
  readTask: ReadTaskOutcome;
  proposer?: FollowUpProposer;
  now?: () => number;
  audit?: (event: { action: string; todoId: string; tenantId: string; ownerId: string; details?: Record<string, unknown> }) => void;
}

export type TodoError = 'NOT_FOUND' | 'NOT_STARTABLE' | 'INVALID_LINK' | 'FOLLOW_UPS_UNAVAILABLE';
export class TodoServiceError extends Error {
  constructor(public readonly code: TodoError, message: string) { super(message); }
}

// A started TODO that never reached a task or an artifact (a plan was prepared and left alone) is not "in progress" forever: after this long it is offered again.
const ABANDONED_AFTER_MS = 30 * 60_000;

const hash = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
const documentIdOf = (openTarget: string): string | undefined => /\/api\/v1\/creations\/documents\/(doc_[0-9a-f]{24})$/.exec(openTarget)?.[1];

export class TodoService {
  private readonly now: () => number;

  constructor(private readonly deps: TodoServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  // ---- offering ---------------------------------------------------------------------------------------------------------------------------------------------

  /** After a report was written: the one follow-up that follows from it for certain - a deck from that very document. Deterministic, no model. */
  public suggestForArtifact(identity: { tenantId: string; ownerId: string }, artifactId: string): FollowUpSuggestions {
    const artifact = this.deps.artifactStore.get(artifactId, identity.tenantId, identity.ownerId);
    if (!artifact) throw new TodoServiceError('NOT_FOUND', 'Artifact not found.');
    if (artifact.type !== 'DOCUMENT') return { todos: [], recommendations: [], reason: 'NOT_A_DOCUMENT' };
    const language = detectRequestLanguage(artifact.title) === 'ko' ? 'ko' : 'en';
    const candidate = language === 'ko'
      ? { title: '이 보고서로 발표자료(PPTX) 만들기', prompt: '이 보고서로 발표자료 8장을 만들어줘.' }
      : { title: 'Turn this report into a PowerPoint deck', prompt: 'Make an 8-slide deck from this report.' };
    const documentId = documentIdOf(artifact.openTarget);
    // the follow-up must be something the router really sends to the deck path with that document as its source
    const classified = classifyFollowUp(candidate.prompt, { sourceDocument: true });
    if (!classified.executable || classified.kind !== 'CREATE_PRESENTATION') return { todos: [], recommendations: [], reason: 'NOTHING_TO_OFFER' };
    const todoId = `todo_${hash(identity.tenantId, identity.ownerId, 'artifact', artifactId, classified.kind)}`;
    const existing = this.deps.store.get(todoId, identity.tenantId, identity.ownerId);
    const record = existing ?? this.deps.store.save({
      todoId, tenantId: identity.tenantId, ownerId: identity.ownerId, title: candidate.title, prompt: candidate.prompt, kind: classified.kind,
      origin: 'ARTIFACT', sourceArtifactId: artifactId, ...(documentId ? { sourceDocumentId: documentId } : {}),
      state: 'PROPOSED', links: {}, createdAt: this.iso(), updatedAt: this.iso(),
    });
    return { todos: [toView(this.refresh(record))], recommendations: [] };
  }

  /** Only when the person asked for a to-do list or next steps: the model proposes, the router decides what is executable. A plain question never gets a task list. */
  public async suggestFromConversation(identity: { tenantId: string; ownerId: string }, input: { message: string; answer?: string; clock?: { nowMs: number; timezone: string; timezoneSource?: string } }): Promise<FollowUpSuggestions> {
    if (!wantsTodoList(input.message)) return { todos: [], recommendations: [], reason: 'NOT_REQUESTED' };
    if (!this.deps.proposer) throw new TodoServiceError('FOLLOW_UPS_UNAVAILABLE', 'No model is available to propose next actions.');
    let proposed: { todos: Array<{ title: string; prompt: string }>; recommendations: string[] };
    try {
      proposed = (await this.deps.proposer.proposeFollowUps({ message: input.message, answer: input.answer, clock: input.clock })).data;
    } catch {
      throw new TodoServiceError('FOLLOW_UPS_UNAVAILABLE', 'The next actions could not be prepared right now.');
    }
    const todos: TodoView[] = [];
    const recommendations = [...proposed.recommendations];
    for (const item of proposed.todos) {
      const classified = classifyFollowUp(item.prompt);
      if (!classified.executable || !classified.kind) { recommendations.push(item.title); continue; }
      const todoId = `todo_${hash(identity.tenantId, identity.ownerId, 'conversation', input.message, item.prompt.toLowerCase())}`;
      const existing = this.deps.store.get(todoId, identity.tenantId, identity.ownerId);
      const record = existing ?? this.deps.store.save({
        todoId, tenantId: identity.tenantId, ownerId: identity.ownerId, title: item.title, prompt: item.prompt, kind: classified.kind,
        origin: 'CONVERSATION', state: 'PROPOSED', links: {}, createdAt: this.iso(), updatedAt: this.iso(),
      });
      todos.push(toView(this.refresh(record)));
    }
    const unique = [...new Set(recommendations)].slice(0, 5);
    return { todos, recommendations: unique, ...(todos.length === 0 && unique.length === 0 ? { reason: 'NOTHING_TO_OFFER' as const } : {}) };
  }

  // ---- choosing and running -----------------------------------------------------------------------------------------------------------------------------

  /** The person chose this TODO. Returns the exact request to run (through the normal request path, so every approval and permission check applies). */
  public start(identity: { tenantId: string; ownerId: string }, todoId: string): { todo: TodoView; prompt: string; source: { artifactId?: string; documentId?: string } } {
    const record = this.load(identity, todoId);
    const current = this.refresh(record);
    if (current.state !== 'PROPOSED' && current.state !== 'FAILED') throw new TodoServiceError('NOT_STARTABLE', `This next action is already ${current.state}.`);
    // a failed one may be tried again: its old outcome is cleared, never reused
    const started: TodoRecord = { ...current, state: 'IN_PROGRESS', links: {}, detail: undefined, startedAt: this.iso(), settledAt: undefined, updatedAt: this.iso() };
    this.deps.store.save(started);
    this.deps.audit?.({ action: 'todo.started', todoId, tenantId: identity.tenantId, ownerId: identity.ownerId, details: { kind: started.kind } });
    return { todo: toView(started), prompt: started.prompt, source: { artifactId: started.sourceArtifactId, documentId: started.sourceDocumentId } };
  }

  /**
   * What the run produced, as the client saw it - verified here: an artifact must exist, be the owner's and be newer than the start; a task must exist and be the owner's. "Completed" is never taken from
   * the client: it is read from the artifact or the task's own run. A failure may be reported (it claims nothing good); a success may not.
   */
  public link(identity: { tenantId: string; ownerId: string }, todoId: string, body: { taskId?: string; artifactId?: string; failure?: { code?: string } }): TodoView {
    const record = this.load(identity, todoId);
    if (record.state !== 'IN_PROGRESS' && record.state !== 'APPROVAL_REQUIRED') throw new TodoServiceError('INVALID_LINK', 'This next action is not running.');
    let next: TodoRecord = record;
    if (body.artifactId) {
      const artifact = this.deps.artifactStore.get(body.artifactId, identity.tenantId, identity.ownerId);
      const startedAt = record.startedAt ? Date.parse(record.startedAt) : 0;
      if (!artifact || Date.parse(artifact.createdAt) < startedAt - 2000) throw new TodoServiceError('INVALID_LINK', 'That result does not belong to this next action.');
      next = { ...record, links: { ...record.links, artifactId: body.artifactId } };
    } else if (body.taskId) {
      if (!this.deps.readTask(identity.tenantId, identity.ownerId, body.taskId)) throw new TodoServiceError('INVALID_LINK', 'That task does not belong to this next action.');
      next = { ...record, links: { ...record.links, taskId: body.taskId } };
    } else if (body.failure) {
      const code = String(body.failure.code ?? 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 48) || 'REQUEST_FAILED';
      next = { ...record, state: 'FAILED', detail: { code }, settledAt: this.iso(), updatedAt: this.iso() };
    } else {
      throw new TodoServiceError('INVALID_LINK', 'Nothing to link.');
    }
    this.deps.store.save({ ...next, updatedAt: this.iso() });
    this.deps.audit?.({ action: 'todo.linked', todoId, tenantId: identity.tenantId, ownerId: identity.ownerId, details: { taskId: body.taskId, artifactId: body.artifactId, failure: body.failure?.code } });
    return toView(this.refresh(this.load(identity, todoId)));
  }

  public list(identity: { tenantId: string; ownerId: string }, options: { sourceArtifactId?: string; limit?: number } = {}): TodoView[] {
    return this.deps.store.list(identity.tenantId, identity.ownerId, 200)
      .filter((record) => !options.sourceArtifactId || record.sourceArtifactId === options.sourceArtifactId)
      .slice(0, options.limit ?? 50)
      .map((record) => toView(this.refresh(record)));
  }

  // ---- state is read, never claimed ---------------------------------------------------------------------------------------------------------------------

  private load(identity: { tenantId: string; ownerId: string }, todoId: string): TodoRecord {
    const record = this.deps.store.get(todoId, identity.tenantId, identity.ownerId);
    if (!record) throw new TodoServiceError('NOT_FOUND', 'Next action not found.');
    return record;
  }

  /** The state of a TODO, derived from the artifact or the task run it is linked to. */
  private refresh(record: TodoRecord): TodoRecord {
    const derived = this.derive(record);
    if (derived.state === record.state && derived.detail?.code === record.detail?.code && derived.startedAt === record.startedAt) return record;
    const saved: TodoRecord = { ...derived, updatedAt: this.iso(), ...(derived.state === 'COMPLETED' || derived.state === 'FAILED' ? { settledAt: derived.settledAt ?? this.iso() } : {}) };
    this.deps.store.save(saved);
    return saved;
  }

  private derive(record: TodoRecord): TodoRecord {
    if (record.state === 'PROPOSED') return record;
    if (record.links.artifactId) {
      const artifact = this.deps.artifactStore.get(record.links.artifactId, record.tenantId, record.ownerId);
      return artifact ? { ...record, state: 'COMPLETED', detail: { code: 'CREATED' } } : { ...record, state: 'FAILED', detail: { code: 'RESULT_MISSING' } };
    }
    if (record.links.taskId) {
      const outcome = this.deps.readTask(record.tenantId, record.ownerId, record.links.taskId);
      if (!outcome) return { ...record, state: 'FAILED', detail: { code: 'TASK_MISSING' } };
      return this.fromTask(record, outcome);
    }
    // a failure the client reported is final until the person chooses it again
    if (record.state === 'FAILED' || record.state === 'COMPLETED') return record;
    // started, but no task and no result yet: waiting for the person's own next step (a prepared plan needs their "request approval"), until it is clearly abandoned
    if (record.state === 'IN_PROGRESS' && record.startedAt && this.now() - Date.parse(record.startedAt) > ABANDONED_AFTER_MS) {
      return { ...record, state: 'PROPOSED', detail: undefined, startedAt: undefined, settledAt: undefined };
    }
    return record;
  }

  private fromTask(record: TodoRecord, outcome: TaskOutcome): TodoRecord {
    const set = (state: TodoState, code: string): TodoRecord => ({ ...record, state, detail: { code } });
    if (outcome.status === 'WAITING_APPROVAL') return set('APPROVAL_REQUIRED', 'APPROVAL_PENDING');
    if (outcome.status === 'RUNNING') return set('IN_PROGRESS', 'RUNNING');
    if (outcome.status === 'CANCELLED') return set('FAILED', 'CANCELLED');
    if (outcome.status === 'FAILED') {
      const code = outcome.errorCode === 'APPROVAL_REJECTED' ? 'DECLINED' : outcome.errorCode === 'APPROVAL_EXPIRED' ? 'EXPIRED' : outcome.errorCode || 'RUN_FAILED';
      return set('FAILED', code);
    }
    if (outcome.status === 'SUCCEEDED') return this.fromResult(record, outcome.result);
    return set('IN_PROGRESS', 'RUNNING');
  }

  // A finished run counts as done only when something was really executed: a reviewed plan alone is not. A calendar change is done when NAgex read it back; a tool's answer without a read-back is said to be only that.
  private fromResult(record: TodoRecord, result: unknown): TodoRecord {
    const set = (state: TodoState, code: string): TodoRecord => ({ ...record, state, detail: { code } });
    const body = result && typeof result === 'object' ? result as { kind?: string; steps?: unknown[]; completedSteps?: unknown[] } : {};
    if (body.kind === 'PLAN_PREVIEW') return set('IN_PROGRESS', 'PLAN_ONLY');
    const steps = (Array.isArray(body.steps) ? body.steps : Array.isArray(body.completedSteps) ? body.completedSteps : []) as Array<{ capabilityId?: string; result?: { outcome?: string; verification?: { outcome?: string; status?: string } } }>;
    const calendar = steps.find((s) => /^google_calendar\.(create_event|update_event|cancel_event|respond_to_event)$/.test(String(s?.capabilityId ?? '')));
    if (calendar) {
      const verdict = calendar.result?.verification?.outcome;
      if (verdict === 'VERIFIED') return set('COMPLETED', 'VERIFIED');
      if (verdict === 'MISMATCH') return set('FAILED', 'MISMATCH');
      return set('FAILED', 'NOT_CONFIRMED');
    }
    const vault = steps.find((s) => s?.result?.outcome === 'SAVED_TO_VAULT');
    if (vault) return vault.result?.verification?.status === 'VERIFIED' ? set('COMPLETED', 'VERIFIED') : set('FAILED', 'NOT_CONFIRMED');
    if (steps.length === 0) return set('IN_PROGRESS', 'PLAN_ONLY');
    return set('COMPLETED', 'RESPONDED');
  }
}
