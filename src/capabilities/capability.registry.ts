import { CapabilityDefinition } from './capability.types.js';

export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();

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

      // Gmail
      { id: 'gmail.search', provider: 'GMAIL', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'gmail.read_thread', provider: 'GMAIL', risk: 'READ_ONLY', approval: 'NONE', enabled: true },
      { id: 'gmail.send_email', provider: 'GMAIL', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'gmail.reply', provider: 'GMAIL', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true },
      { id: 'gmail.create_draft', provider: 'GMAIL', risk: 'LOW', approval: 'CONDITIONAL', enabled: true },

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
    ];

    for (const def of defaults) {
      this.definitions.set(def.id, def);
    }
  }

  public get(capabilityId: string): CapabilityDefinition | undefined {
    return this.definitions.get(capabilityId);
  }

  public has(capabilityId: string): boolean {
    return this.definitions.has(capabilityId);
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
