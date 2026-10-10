import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { CommandContext } from './command-context.types.js';

function isCommandContext(value: unknown): value is CommandContext {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.commandId === 'string' &&
    typeof v.executionThreadId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.originSurface === 'string' &&
    typeof v.inputModality === 'string' &&
    Array.isArray(v.inputArtifacts) &&
    typeof v.rawUserIntent === 'string' &&
    typeof v.normalizedIntent === 'string' &&
    typeof v.confidence === 'number' &&
    typeof v.createdAt === 'string'
  );
}

export interface CommandContextStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class CommandContextStore {
  private readonly fileStore: FileRecordStore<CommandContext>;
  private readonly now: () => string;

  constructor(options: CommandContextStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('command-contexts', 'NAGEX_COMMAND_CONTEXTS_DIR', env);
    this.fileStore = new FileRecordStore<CommandContext>(dir, isCommandContext);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  public create(input: Omit<CommandContext, 'commandId' | 'executionThreadId' | 'createdAt'> & { commandId?: string; executionThreadId?: string }): CommandContext {
    const commandId = input.commandId ?? generateResourceId('cmd');
    const context: CommandContext = {
      ...input,
      commandId,
      executionThreadId: input.executionThreadId ?? commandId,
      createdAt: this.now(),
    };
    this.fileStore.writeOrThrow(context.commandId, context);
    return context;
  }

  public get(commandId: string, tenantId: string, principalId: string): CommandContext | null {
    const context = this.fileStore.read(commandId);
    if (!context || context.tenantId !== tenantId || context.principalId !== principalId) return null;
    return context;
  }

  public list(tenantId: string, principalId: string, limit = 50): CommandContext[] {
    return this.fileStore.readAll()
      .filter((context) => context.tenantId === tenantId && context.principalId === principalId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit));
  }
}
