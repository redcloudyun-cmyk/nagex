import { FileRecordStore, resolveNagexDataDir } from './file-record.store.js';

export type ExecutionStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

export interface ExecutionRecord {
  executionId: string;
  toolId: string;
  approvalId: string | null;
  tenantId: string;
  principalId: string;
  status: ExecutionStatus;
  externalId: string | null;
  externalUrl: string | null;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export function isExecutionRecord(value: unknown): value is ExecutionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.executionId === 'string' &&
    typeof v.toolId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.status === 'string' &&
    typeof v.startedAt === 'string'
  );
}

export interface ExecutionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

// One JSON file per tool execution under NAGEX_EXECUTIONS_DIR (default
// /var/lib/nagex/executions, falling back to a per-user data dir). Plain
// JSON like the approval store — execution records never contain tokens.
export class ExecutionStore {
  private readonly fileStore: FileRecordStore<ExecutionRecord>;

  constructor(options: ExecutionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('executions', 'NAGEX_EXECUTIONS_DIR', env);
    this.fileStore = new FileRecordStore<ExecutionRecord>(dir, isExecutionRecord);
  }

  public start(record: Omit<ExecutionRecord, 'status' | 'externalId' | 'externalUrl' | 'completedAt' | 'errorCode'>): ExecutionRecord {
    const full: ExecutionRecord = {
      ...record,
      status: 'STARTED',
      externalId: null,
      externalUrl: null,
      completedAt: null,
      errorCode: null,
    };
    this.fileStore.write(full.executionId, full);
    return full;
  }

  public succeed(executionId: string, result: { externalId: string; externalUrl: string; completedAt: string }): void {
    const existing = this.fileStore.read(executionId);
    if (!existing) return;
    this.fileStore.write(executionId, { ...existing, status: 'SUCCEEDED', ...result });
  }

  public fail(executionId: string, error: { errorCode: string; completedAt: string }): void {
    const existing = this.fileStore.read(executionId);
    if (!existing) return;
    this.fileStore.write(executionId, { ...existing, status: 'FAILED', ...error });
  }

  public get(executionId: string): ExecutionRecord | null {
    return this.fileStore.read(executionId);
  }

  public list(): ExecutionRecord[] {
    return this.fileStore.readAll();
  }
}
