// Next actions (TODOs): offered after a report and when the person asks for next steps, chosen one at a time, run through the normal request path (so every approval and permission applies), and
// shown in the state the underlying task / artifact is really in. Another person's TODO, an unknown id and a malformed id are all "not found".
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';
import { resolveEffectiveTimeZone } from '../../common/time-context.js';
import { TodoServiceError, type TodoService } from '../../todos/todo.service.js';
import { TODO_ID_PATTERN } from '../../todos/todo.types.js';

export interface TodoRouteDeps {
  todoService?: TodoService;
  getProfileTimezone?: (principalId: string) => string | undefined;
  now?: () => number;
}

const ARTIFACT_ID = /^art_[0-9a-f]{24}$/;
const TASK_ID = /^(?:tsk|task)_[A-Za-z0-9_-]{6,80}$/;

function failure(error: unknown, requestId: string): ApiResult {
  if (error instanceof TodoServiceError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'NOT_STARTABLE' ? 409 : error.code === 'INVALID_LINK' ? 400 : 503;
    return { status, data: { error: { code: `TODO_${error.code}`, message: error.message, request_id: requestId } } };
  }
  throw error;
}

export const handleTodoRoutes: AsyncRouteRegistrar<TodoRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/api/v1/todos')) return undefined;
  const caller = tryGetCallerIdentity(headers);
  if (!caller) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to see your next actions.' } } };
  const requestId = (Array.isArray(headers['x-request-id']) ? headers['x-request-id'][0] : headers['x-request-id']) || `req_todo_${Date.now()}`;
  const service = deps.todoService;
  if (!service) return { status: 503, data: { error: { code: 'TODO_UNAVAILABLE', message: 'Next actions are not available right now.', request_id: requestId } } };
  const identity = { tenantId: caller.tenantId, ownerId: caller.principalId };

  if (pathname === '/api/v1/todos' && method === 'GET') {
    return { status: 200, data: { todos: service.list(identity) } };
  }

  if (pathname === '/api/v1/todos/suggest' && method === 'POST') {
    const input = (body ?? {}) as Record<string, unknown>;
    try {
      if (typeof input.artifactId === 'string' && input.artifactId) {
        if (!ARTIFACT_ID.test(input.artifactId)) return { status: 404, data: { error: { code: 'TODO_NOT_FOUND', message: 'Artifact not found.', request_id: requestId } } };
        return { status: 200, data: service.suggestForArtifact(identity, input.artifactId) };
      }
      const message = typeof input.message === 'string' ? input.message.trim().slice(0, 4000) : '';
      if (!message) return { status: 400, data: { error: { code: 'TODO_REQUEST_REQUIRED', message: 'An artifact or a message is required.', request_id: requestId } } };
      const answer = typeof input.answer === 'string' ? input.answer.slice(0, 8000) : undefined;
      const zone = resolveEffectiveTimeZone({ profileTimezone: deps.getProfileTimezone?.(caller.principalId), clientTimezone: typeof input.timezone === 'string' ? input.timezone : undefined });
      return { status: 200, data: await service.suggestFromConversation(identity, { message, answer, clock: { nowMs: (deps.now ?? Date.now)(), timezone: zone.timezone, timezoneSource: zone.source } }) };
    } catch (error) { return failure(error, requestId); }
  }

  const match = pathname.match(/^\/api\/v1\/todos\/([^/]+)\/(start|link)$/);
  if (match && method === 'POST') {
    const [, todoId, action] = match;
    if (!TODO_ID_PATTERN.test(todoId)) return { status: 404, data: { error: { code: 'TODO_NOT_FOUND', message: 'Next action not found.', request_id: requestId } } };
    try {
      if (action === 'start') return { status: 200, data: service.start(identity, todoId) };
      const input = (body ?? {}) as Record<string, unknown>;
      const taskId = typeof input.taskId === 'string' ? input.taskId : undefined;
      const artifactId = typeof input.artifactId === 'string' ? input.artifactId : undefined;
      if (taskId && !TASK_ID.test(taskId)) return { status: 400, data: { error: { code: 'TODO_INVALID_LINK', message: 'That is not a task id.', request_id: requestId } } };
      if (artifactId && !ARTIFACT_ID.test(artifactId)) return { status: 400, data: { error: { code: 'TODO_INVALID_LINK', message: 'That is not an artifact id.', request_id: requestId } } };
      const failureBody = input.failure && typeof input.failure === 'object' ? { code: String((input.failure as { code?: unknown }).code ?? '') } : undefined;
      return { status: 200, data: { todo: service.link(identity, todoId, { taskId, artifactId, failure: failureBody }) } };
    } catch (error) { return failure(error, requestId); }
  }

  return undefined;
};
