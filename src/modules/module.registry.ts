// P06 — Module Registry
import type { ModuleDefinition } from './module.types.js';

export class ModuleRegistry {
  private readonly definitions = new Map<string, ModuleDefinition>();
  private readonly capabilityToModule = new Map<string, string>();
  private readonly aliasToModule = new Map<string, string>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const defaults: ModuleDefinition[] = [
      {
        moduleId: 'module.calendar',
        name: 'Google Calendar Module',
        version: '1.0.0',
        category: 'Productivity',
        description: 'Manages calendar events, scheduling, and availability checks.',
        capabilities: [
          'google_calendar.create_event',
          'google_calendar.update_event',
          'google_calendar.cancel_event',
          'google_calendar.respond_to_event',
          'google_calendar.free_slots',
        ],
        requiredPermissions: ['calendar:read', 'calendar:write'],
        enabledByDefault: true,
      },
      {
        moduleId: 'module.gmail',
        name: 'Gmail Module',
        version: '1.0.0',
        category: 'Communication',
        description: 'Manages email search, reading, sending, replying, and drafting.',
        capabilities: [
          'gmail.search',
          'gmail.read_thread',
          'gmail.send_email',
          'gmail.reply',
          'gmail.create_draft',
        ],
        requiredPermissions: ['gmail:read', 'gmail:send', 'gmail:draft'],
        enabledByDefault: true,
      },
      {
        moduleId: 'module.browser',
        name: 'Browser Agent Module',
        version: '1.0.0',
        category: 'Automation',
        description: 'Automates browser sessions, page navigation, snapshotting, extraction, and interactions.',
        capabilities: [
          'browser.open',
          'browser.close',
          'browser.navigate',
          'browser.tabs',
          'browser.snapshot',
          'browser.structured_snapshot',
          'browser.find',
          'browser.extract',
          'browser.back',
          'browser.forward',
          'browser.reload',
          'browser.click',
        ],
        requiredPermissions: ['browser:automate'],
        enabledByDefault: true,
      },
    ];

    const defaultAliases: Record<string, string[]> = {
      'module.calendar': [
        'calendar.create_event',
        'calendar.update_event',
        'calendar.cancel_event',
        'calendar.respond_to_event',
        'calendar.free_slots',
        'google_calendar.freebusy',
        'calendar.create',
        'calendar.schedule',
      ],
      'module.gmail': [
        'gmail.send',
        'gmail.reply_email',
        'gmail.draft',
        'gmail.read',
        'gmail.search_email',
      ],
      'module.browser': [
        'browser.session.open',
        'browser.session.close',
        'browser.page.navigate',
        'browser.tabs.list',
        'browser.page.snapshot',
        'browser.page.find',
        'browser.page.extract',
        'browser.page.back',
        'browser.page.forward',
        'browser.page.reload',
        'browser.page.click',
        'browser.screenshot',
        'browser.scroll',
        'browser.wait',
        'browser.type',
        'browser.select',
      ],
    };

    for (const def of defaults) {
      this.register(def, defaultAliases[def.moduleId]);
    }
  }

  public register(def: ModuleDefinition, aliases: string[] = []): void {
    if (this.definitions.has(def.moduleId)) {
      throw new Error(`Duplicate module registration: ${def.moduleId}`);
    }

    // Check capability collisions across modules
    for (const cap of def.capabilities) {
      const existingModule = this.capabilityToModule.get(cap);
      if (existingModule && existingModule !== def.moduleId) {
        throw new Error(
          `Duplicate module capability claim: capability "${cap}" already claimed by module "${existingModule}".`
        );
      }
    }

    this.definitions.set(def.moduleId, { ...def, capabilities: [...def.capabilities], requiredPermissions: [...def.requiredPermissions] });

    for (const cap of def.capabilities) {
      this.capabilityToModule.set(cap, def.moduleId);
    }

    for (const alias of aliases) {
      this.aliasToModule.set(alias, def.moduleId);
    }
  }

  public get(moduleId: string): ModuleDefinition | undefined {
    return this.definitions.get(moduleId);
  }

  public has(moduleId: string): boolean {
    return this.definitions.has(moduleId);
  }

  public list(): ModuleDefinition[] {
    return Array.from(this.definitions.values());
  }

  public getByCapability(capabilityId: string): ModuleDefinition | undefined {
    const moduleId = this.capabilityToModule.get(capabilityId) || this.aliasToModule.get(capabilityId);
    if (!moduleId) return undefined;
    return this.definitions.get(moduleId);
  }
}

export const canonicalModuleRegistry = new ModuleRegistry();
