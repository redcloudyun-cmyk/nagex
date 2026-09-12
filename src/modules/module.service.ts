// P06 — Module Service
import { NagexError } from '../common/errors.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import { ModuleRegistry, canonicalModuleRegistry } from './module.registry.js';
import { ModuleStateStore } from './module-state.store.js';
import type { ModuleRuntimeState, ModuleStatus } from './module.types.js';

export interface ProviderHealthChecker {
  getProviderStatus(providerName: string): ModuleStatus;
}

export class ModuleService {
  constructor(
    private readonly registry: ModuleRegistry = canonicalModuleRegistry,
    private readonly stateStore: ModuleStateStore = new ModuleStateStore(),
    private readonly auditLogger?: AuditLogger,
    private readonly healthChecker?: ProviderHealthChecker
  ) {}

  public listModules(tenantId: string): ModuleRuntimeState[] {
    const definitions = this.registry.list();
    return definitions.map((def) => this.toRuntimeState(tenantId, def));
  }

  public getModule(tenantId: string, moduleId: string): ModuleRuntimeState | null {
    const def = this.registry.get(moduleId);
    if (!def) return null;
    return this.toRuntimeState(tenantId, def);
  }

  public setModuleState(
    tenantId: string,
    moduleId: string,
    enabled: boolean,
    principalId: string = 'system'
  ): ModuleRuntimeState {
    const def = this.registry.get(moduleId);
    if (!def) {
      throw new NagexError({
        code: 'MODULE_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Module "${moduleId}" was not found.`,
        request_id: `req_mod_${Date.now()}`,
      });
    }

    this.stateStore.setState(tenantId, moduleId, enabled);

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: enabled ? 'module.enabled' : 'module.disabled',
        resource: { type: 'Module', id: moduleId },
        result: 'SUCCESS',
        request_id: `req_mod_${Date.now()}`,
        details: { moduleId, enabled },
      });
    }

    return this.toRuntimeState(tenantId, def);
  }

  public isCapabilityEnabled(tenantId: string, capabilityId: string): boolean {
    const def = this.registry.getByCapability(capabilityId);
    if (!def) {
      // Unmanaged capability is allowed by default
      return true;
    }
    const stateRecord = this.stateStore.getState(tenantId, def.moduleId);
    if (stateRecord !== null) {
      return stateRecord.enabled;
    }
    return def.enabledByDefault;
  }

  private toRuntimeState(tenantId: string, def: ReturnType<ModuleRegistry['get']> & {}): ModuleRuntimeState {
    const stateRecord = this.stateStore.getState(tenantId, def.moduleId);
    const enabled = stateRecord !== null ? stateRecord.enabled : def.enabledByDefault;

    let status: ModuleStatus = enabled ? 'AVAILABLE' : 'DISABLED';

    if (enabled && this.healthChecker) {
      const provider = this.getProviderNameForModule(def.moduleId);
      if (provider) {
        status = this.healthChecker.getProviderStatus(provider);
      }
    }

    return {
      moduleId: def.moduleId,
      tenantId,
      enabled,
      status,
      health: {
        ok: status === 'AVAILABLE' || status === 'DEGRADED',
        checkedAt: new Date().toISOString(),
      },
    };
  }

  private getProviderNameForModule(moduleId: string): string | null {
    if (moduleId === 'module.calendar') return 'GOOGLE_CALENDAR';
    if (moduleId === 'module.gmail') return 'GMAIL';
    if (moduleId === 'module.browser') return 'BROWSER';
    return null;
  }
}
