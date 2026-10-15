import { CapabilityDefinition } from './capability.types.js';

export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();
  // Per-user entries (MCP tools the owner enabled). Kept apart from the canonical set so they never appear in list():
  // another user's tool ids are not disclosed by a catalog, and they can be added and removed at runtime.
  private readonly dynamicDefinitions = new Map<string, CapabilityDefinition>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const defaults: CapabilityDefinition[] = [
      // Calendar
      { id: 'google_calendar.create_event', provider: 'GOOGLE_CALENDAR', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'google_calendar.update_event', provider: 'GOOGLE_CALENDAR', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'google_calendar.cancel_event', provider: 'GOOGLE_CALENDAR', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'google_calendar.respond_to_event', provider: 'GOOGLE_CALENDAR', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'google_calendar.free_slots', provider: 'GOOGLE_CALENDAR', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      // Reads the signed-in user's real upcoming events (titles, times, attendees); never writes.
      { id: 'google_calendar.list_events', provider: 'GOOGLE_CALENDAR', risk: 'READ_ONLY', approval: 'NONE', enabled: true },

      // Gmail
      { id: 'gmail.search', provider: 'GMAIL', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'gmail.read_thread', provider: 'GMAIL', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'gmail.send_email', provider: 'GMAIL', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'gmail.reply', provider: 'GMAIL', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'gmail.create_draft', provider: 'GMAIL', risk: 'LOW', approval: 'CONDITIONAL', enabled: true },

      // GitHub (built-in connection). Read-only: nothing here writes to GitHub. Any future write capability must be
      // registered as CONSEQUENTIAL with approval REQUIRED and execute through the Broker's approval continuation.
      { id: 'github.list_repos', provider: 'GITHUB', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'github.list_directory', provider: 'GITHUB', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'github.read_file', provider: 'GITHUB', risk: 'READ_ONLY', approval: 'NONE', enabled: true },

      // Browser
      { id: 'browser.open', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.close', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.navigate', provider: 'BROWSER', risk: 'LOW', approval: 'NONE', enabled: true },
      { id: 'browser.tabs', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.snapshot', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.structured_snapshot', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.find', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.extract', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.back', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.forward', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.reload', provider: 'BROWSER', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'browser.click', provider: 'BROWSER', risk: 'DYNAMIC', approval: 'CONDITIONAL', enabled: true },

      // Device Control (DC1) — the single coarse entry point for the
      // bounded visual-execution loop. DYNAMIC/CONDITIONAL mirrors
      // browser.click: most steps execute without a pause, but the loop
      // can escalate mid-run (a CLICK step classified consequential) and
      // must be able to pause for approval — never a hard REQUIRED gate on
      // the whole capability, which would block even read-only OBSERVE-only
      // runs.
      { id: 'device.browser.execute', provider: 'DEVICE', risk: 'DYNAMIC', approval: 'CONDITIONAL', enabled: true },

      // Desktop Control (DC3-B2) — isolated-Win32-desktop background
      // execution. DYNAMIC/CONDITIONAL mirrors device.browser.execute:
      // OBSERVE runs without a pause, mutations (OPEN_APP/CLOSE_APP/
      // SET_VALUE/INVOKE/TOGGLE/SELECT/SCROLL) propose and freeze an
      // approval before ever reaching the isolated desktop.
      { id: 'device.desktop.execute', provider: 'DEVICE_DESKTOP', risk: 'DYNAMIC', approval: 'CONDITIONAL', enabled: true },

      // Vault save (D-9) - the person's own Vault. Not external, but persistent and chosen by an agent, so it is an approval-gated action: the first call only asks, the write happens
      // after a separate Approve, bound to the exact draft. The generic "save note" (inline Save button, capture prefix) is a different, unchanged path.
      { id: 'vault.save_note', provider: 'VAULT', risk: 'LOW', approval: 'REQUIRED', enabled: true },

      // Web Search (R22.4) — Evidence-first research foundation
      { id: 'web.search', provider: 'WEB_SEARCH', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
    ];

    for (const def of defaults) {
      this.definitions.set(def.id, def);
    }
  }

  public get(capabilityId: string): CapabilityDefinition | undefined {
    return this.definitions.get(capabilityId) ?? this.dynamicDefinitions.get(capabilityId);
  }

  public has(capabilityId: string): boolean {
    return this.definitions.has(capabilityId) || this.dynamicDefinitions.has(capabilityId);
  }

  // A dynamic definition can never replace a canonical one, and only the MCP provider may register dynamically.
  public registerDynamic(definition: CapabilityDefinition): void {
    if (definition.provider !== 'MCP' || !definition.id.startsWith('mcp.') || this.definitions.has(definition.id)) {
      throw new Error(`Capability "${definition.id}" cannot be registered dynamically.`);
    }
    this.dynamicDefinitions.set(definition.id, definition);
  }

  public unregisterDynamic(capabilityId: string): void {
    this.dynamicDefinitions.delete(capabilityId);
  }

  public list(): CapabilityDefinition[] {
    return Array.from(this.definitions.values());
  }

  public setEnabled(capabilityId: string, enabled: boolean): boolean {
    const def = this.definitions.get(capabilityId);
    if (!def) return false;
    def.enabled = enabled;
    return true;
  }
}

export const capabilityRegistry = new CapabilityRegistry();
