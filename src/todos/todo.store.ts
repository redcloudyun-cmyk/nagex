import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { TODO_ID_PATTERN, type TodoRecord } from './todo.types.js';

function isTodoRecord(value: unknown): value is TodoRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.todoId === 'string' && TODO_ID_PATTERN.test(v.todoId) && typeof v.tenantId === 'string' && typeof v.ownerId === 'string'
    && typeof v.title === 'string' && typeof v.prompt === 'string' && typeof v.state === 'string' && typeof v.createdAt === 'string';
}

/** Owner-scoped: a wrong tenant, a wrong owner, a malformed and an unknown id are all "not found". */
export class TodoStore {
  private readonly store: FileRecordStore<TodoRecord>;

  constructor(options?: { dir?: string }) {
    this.store = new FileRecordStore<TodoRecord>(options?.dir ?? resolveNagexDataDir('todos', 'NAGEX_TODOS_DIR'), isTodoRecord);
  }

  public save(record: TodoRecord): TodoRecord {
    this.store.write(record.todoId, record);
    return record;
  }

  public get(todoId: string, tenantId: string, ownerId: string): TodoRecord | null {
    if (!TODO_ID_PATTERN.test(todoId)) return null;
    const record = this.store.read(todoId);
    return record && record.tenantId === tenantId && record.ownerId === ownerId ? record : null;
  }

  public list(tenantId: string, ownerId: string, limit = 50): TodoRecord[] {
    return this.store.readAll()
      .filter((record) => record.tenantId === tenantId && record.ownerId === ownerId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(0, limit));
  }
}
