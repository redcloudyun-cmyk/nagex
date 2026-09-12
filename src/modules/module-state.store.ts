// P06 — Module State Store
import { getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { isModuleRecord, type ModuleRecord } from './module.types.js';

export class ModuleStateStore {
  private readonly fileStore: FileRecordStore<ModuleRecord>;
  private readonly inMemoryMap = new Map<string, ModuleRecord>();

  constructor(
    dirName: string = 'module-state',
    envVarName: string = 'NAGEX_MODULE_STATE_DIR'
  ) {
    const dataDir = resolveNagexDataDir(dirName, envVarName);
    this.fileStore = new FileRecordStore<ModuleRecord>(dataDir, isModuleRecord);
    this.loadInitialState();
  }

  private loadInitialState(): void {
    const records = this.fileStore.readAll();
    for (const record of records) {
      this.inMemoryMap.set(record.id, record);
    }
  }

  public getState(tenantId: string, moduleId: string): ModuleRecord | null {
    const id = `${tenantId}:${moduleId}`;
    const cached = this.inMemoryMap.get(id);
    if (cached) return cached;
    const stored = this.fileStore.read(id);
    if (stored) {
      this.inMemoryMap.set(id, stored);
      return stored;
    }
    return null;
  }

  public setState(tenantId: string, moduleId: string, enabled: boolean): ModuleRecord {
    const id = `${tenantId}:${moduleId}`;
    const record: ModuleRecord = {
      id,
      tenantId,
      moduleId,
      enabled,
      updatedAt: getCurrentISOString(),
    };

    // Durable write BEFORE updating memory
    this.fileStore.writeOrThrow(id, record);

    // Only update in-memory state after successful durable write
    this.inMemoryMap.set(id, record);
    return record;
  }

  public listStatesForTenant(tenantId: string): ModuleRecord[] {
    const results: ModuleRecord[] = [];
    for (const record of this.inMemoryMap.values()) {
      if (record.tenantId === tenantId) {
        results.push(record);
      }
    }
    return results;
  }
}
