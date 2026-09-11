import { googleTokenStore, DEFAULT_GOOGLE_TENANT_ID } from '../integrations/google/token.store.js';
import { GMAIL_SCOPES } from '../integrations/google/oauth.client.js';
import { isBrowserRuntimeAvailableSync } from '../modules/browser/index.js';

export type SideEffectLevel = 'READ_ONLY' | 'REVERSIBLE_WRITE' | 'IRREVERSIBLE_WRITE';
export type ToolExecutionMode = 'live' | 'mock' | 'unavailable';
export type ToolConnectionStatus = 'connected' | 'disconnected' | 'unavailable';

export interface LiveToolStatus {
  connectionStatus: ToolConnectionStatus;
  executionMode: ToolExecutionMode;
}

export interface RegisteredTool {
  id: string;
  name: string;
  capability: string;
  connectionStatus: ToolConnectionStatus;
  sideEffectLevel: SideEffectLevel;
  requiresApproval: boolean;
  executionMode: ToolExecutionMode;
  aliases: readonly string[];
  // When present, overrides the static connectionStatus/executionMode above at
  // resolve() time. Lets tools whose availability depends on runtime state
  // (e.g. an OAuth connection) report their real status instead of a fixed
  // value baked in at registry construction — required so "live" is never
  // reported from env/config presence alone.
  getLiveStatus?: () => LiveToolStatus;
}

export interface ToolResolution {
  requestedTool: string | null;
  status: 'RESOLVED' | 'UNRESOLVED';
  resolvedToolId: string | null;
  resolvedToolName: string | null;
  capability: string | null;
  connectionStatus: ToolConnectionStatus | null;
  sideEffectLevel: SideEffectLevel | null;
  requiresApproval: boolean;
  executionMode: ToolExecutionMode | null;
  availability: 'AVAILABLE' | 'MOCK_ONLY' | 'UNAVAILABLE' | 'UNRESOLVED' | 'NOT_REQUIRED';
}

export interface PublicToolDescriptor {
  id: string;
  name: string;
  capability: string;
  connectionStatus: ToolConnectionStatus;
  sideEffectLevel: SideEffectLevel;
  requiresApproval: boolean;
  executionMode: ToolExecutionMode;
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

function resolveLiveFields(tool: RegisteredTool): { connectionStatus: ToolConnectionStatus; executionMode: ToolExecutionMode } {
  const live = tool.getLiveStatus?.();
  return {
    connectionStatus: live?.connectionStatus ?? tool.connectionStatus,
    executionMode: live?.executionMode ?? tool.executionMode,
  };
}

function computeAvailability(connectionStatus: ToolConnectionStatus, executionMode: ToolExecutionMode): ToolResolution['availability'] {
  if (executionMode === 'mock') return 'MOCK_ONLY';
  if (executionMode === 'unavailable' || connectionStatus !== 'connected') return 'UNAVAILABLE';
  return 'AVAILABLE';
}

export class ToolRegistry {
  private readonly tools: RegisteredTool[];
  private readonly lookup = new Map<string, RegisteredTool>();

  constructor(tools: RegisteredTool[]) {
    this.tools = tools.map((tool) => Object.freeze({ ...tool, aliases: [...tool.aliases] }));
    for (const tool of this.tools) {
      for (const candidate of [tool.id, tool.name, ...tool.aliases]) {
        const key = normalizeToolName(candidate);
        const existing = this.lookup.get(key);
        if (existing && existing.id !== tool.id) throw new Error(`Duplicate tool registry alias: ${candidate}`);
        this.lookup.set(key, tool);
      }
    }
  }

  public list(): readonly PublicToolDescriptor[] {
    return this.tools.map((tool) => {
      const { connectionStatus, executionMode } = resolveLiveFields(tool);
      return {
        id: tool.id,
        name: tool.name,
        capability: tool.capability,
        connectionStatus,
        sideEffectLevel: tool.sideEffectLevel,
        requiresApproval: tool.requiresApproval,
        executionMode,
      };
    });
  }

  public resolve(requestedTool: string | null): ToolResolution {
    if (!requestedTool?.trim()) {
      return { requestedTool: null, status: 'RESOLVED', resolvedToolId: null, resolvedToolName: null, capability: null, connectionStatus: null, sideEffectLevel: null, requiresApproval: false, executionMode: null, availability: 'NOT_REQUIRED' };
    }
    const tool = this.lookup.get(normalizeToolName(requestedTool));
    if (!tool) {
      return { requestedTool, status: 'UNRESOLVED', resolvedToolId: null, resolvedToolName: null, capability: null, connectionStatus: null, sideEffectLevel: null, requiresApproval: false, executionMode: null, availability: 'UNRESOLVED' };
    }
    const { connectionStatus, executionMode } = resolveLiveFields(tool);
    const availability = computeAvailability(connectionStatus, executionMode);
    return {
      requestedTool,
      status: 'RESOLVED',
      resolvedToolId: tool.id,
      resolvedToolName: tool.name,
      capability: tool.capability,
      connectionStatus,
      sideEffectLevel: tool.sideEffectLevel,
      requiresApproval: tool.requiresApproval || tool.sideEffectLevel !== 'READ_ONLY',
      executionMode,
      availability,
    };
  }
}

function googleCalendarLiveStatus(): LiveToolStatus {
  const connected = googleTokenStore.isConnected(DEFAULT_GOOGLE_TENANT_ID);
  return connected ? { connectionStatus: 'connected', executionMode: 'live' } : { connectionStatus: 'disconnected', executionMode: 'unavailable' };
}

// Gmail is LIVE only once the shared Google connection actually carries the
// gmail.modify scope — an account connected before Gmail scopes existed
// (Calendar-only) must reconnect once; "connected" alone is not enough,
// unlike Calendar, which only ever asked for its own scopes.
function gmailLiveStatus(): LiveToolStatus {
  const status = googleTokenStore.getStatus(DEFAULT_GOOGLE_TENANT_ID);
  const hasGmailScope = status.connected && status.scopes.includes(GMAIL_SCOPES[0]);
  return hasGmailScope ? { connectionStatus: 'connected', executionMode: 'live' } : { connectionStatus: 'disconnected', executionMode: 'unavailable' };
}

// Live = the Chromium binary Playwright expects is actually present on
// disk (checked once, cheaply, synchronously — see
// isBrowserRuntimeAvailableSync). Never reports live from configuration or
// intent alone.
function browserRuntimeLiveStatus(): LiveToolStatus {
  return isBrowserRuntimeAvailableSync() ? { connectionStatus: 'connected', executionMode: 'live' } : { connectionStatus: 'disconnected', executionMode: 'unavailable' };
}

export const toolRegistry = new ToolRegistry([
  {
    id: 'gmail.send_email',
    name: 'Gmail Send',
    capability: 'email.send',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'IRREVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    // 'gmail' (bare) is kept for backward compatibility — the model has
    // historically referred to this tool simply as "Gmail".
    aliases: ['gmail', 'gmail.send', 'send gmail', 'gmail send email', 'send email'],
    getLiveStatus: gmailLiveStatus,
  },
  {
    id: 'gmail.reply',
    name: 'Gmail Reply',
    capability: 'email.reply',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'IRREVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    aliases: ['reply gmail', 'gmail reply', 'reply to email'],
    getLiveStatus: gmailLiveStatus,
  },
  {
    id: 'gmail.create_draft',
    name: 'Gmail Draft',
    capability: 'email.draft.create',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'REVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    aliases: ['create gmail draft', 'draft email in gmail', 'gmail draft'],
    getLiveStatus: gmailLiveStatus,
  },
  {
    id: 'gmail.search',
    name: 'Gmail Search',
    capability: 'email.search',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'READ_ONLY',
    requiresApproval: false,
    executionMode: 'unavailable',
    aliases: ['search gmail', 'search email', 'gmail search'],
    getLiveStatus: gmailLiveStatus,
  },
  {
    id: 'gmail.read_thread',
    name: 'Gmail Read Thread',
    capability: 'email.thread.read',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'READ_ONLY',
    requiresApproval: false,
    executionMode: 'unavailable',
    aliases: ['read gmail thread', 'read email thread', 'gmail read thread'],
    getLiveStatus: gmailLiveStatus,
  },
  {
    id: 'google_calendar.create_event',
    name: 'Google Calendar',
    capability: 'calendar.event.create',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'REVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    aliases: ['google calendar create event', 'calendar.create_event', 'create calendar event', 'google calendar'],
    getLiveStatus: googleCalendarLiveStatus,
  },
  {
    // H01 — canonicalized to match CapabilityRegistry/Capability Broker's
    // dispatch id exactly (google_calendar.free_slots), so
    // ResolvedPlanStep.resolvedToolId is directly usable as
    // CapabilityRequest.capabilityId with no Task-specific translation.
    // The old id is kept as an alias for backward compatibility with any
    // caller (model output, a saved plan) still using the old phrasing.
    id: 'google_calendar.free_slots',
    name: 'Google Calendar Availability',
    capability: 'calendar.freebusy.query',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'READ_ONLY',
    requiresApproval: false,
    executionMode: 'unavailable',
    aliases: ['google_calendar.find_free_slots', 'find free slots', 'check availability', 'google_calendar.freebusy', 'calendar availability'],
    getLiveStatus: googleCalendarLiveStatus,
  },
  {
    id: 'google_calendar.update_event',
    name: 'Google Calendar Update',
    capability: 'calendar.event.update',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'REVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    aliases: ['update calendar event', 'reschedule event', 'reschedule meeting', 'edit calendar event'],
    getLiveStatus: googleCalendarLiveStatus,
  },
  {
    id: 'google_calendar.cancel_event',
    name: 'Google Calendar Cancel',
    capability: 'calendar.event.cancel',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'IRREVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    aliases: ['cancel calendar event', 'delete calendar event', 'cancel meeting'],
    getLiveStatus: googleCalendarLiveStatus,
  },
  {
    id: 'google_calendar.respond_to_event',
    name: 'Google Calendar RSVP',
    capability: 'calendar.event.respond',
    connectionStatus: 'disconnected',
    sideEffectLevel: 'REVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'unavailable',
    aliases: ['respond to calendar invite', 'rsvp', 'accept calendar invite', 'decline calendar invite'],
    getLiveStatus: googleCalendarLiveStatus,
  },
  { id: 'notion.create_page', name: 'Notion', capability: 'document.page.create', connectionStatus: 'unavailable', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: true, executionMode: 'unavailable', aliases: ['notion create page', 'create notion page'] },
  { id: 'memory.search', name: 'NAgex Memory', capability: 'memory.read', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: ['memory recall', 'search memory'] },
  { id: 'workspace.prepare_draft', name: 'Workspace Draft', capability: 'document.draft.prepare', connectionStatus: 'connected', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: ['prepare draft', 'draft document'] },
  { id: 'web.search', name: 'Web Search', capability: 'web.search', connectionStatus: 'unavailable', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['internet search'] },

  // Browser Agent MVP (MASTER.md Section 14.5 item 06). open/navigate/
  // tabs/snapshot/screenshot/scroll/wait never touch anything outside the
  // NAgex-controlled browser profile — READ_ONLY, no approval.
  { id: 'browser.open', name: 'Browser Open', capability: 'browser.session.open', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['open browser', 'open a browser session'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.navigate', name: 'Browser Navigate', capability: 'browser.page.navigate', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['navigate browser', 'open website', 'go to website', 'open the website'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.tabs', name: 'Browser Tabs', capability: 'browser.tabs.list', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['list browser tabs', 'browser tabs'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.snapshot', name: 'Browser Snapshot', capability: 'browser.page.snapshot', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['read page', 'read the page', 'browser snapshot'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.screenshot', name: 'Browser Screenshot', capability: 'browser.page.screenshot', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['screenshot the page', 'browser screenshot'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.scroll', name: 'Browser Scroll', capability: 'browser.page.scroll', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['scroll the page', 'browser scroll'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.wait', name: 'Browser Wait', capability: 'browser.page.wait', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['wait on the page', 'browser wait'], getLiveStatus: browserRuntimeLiveStatus },
  // type/select only ever change LOCAL, reversible page/form state — they
  // never submit or send anything by themselves (the click that follows
  // is what does, and IS approval-gated below) — so, like the read-only
  // tools above, they never require approval in this system's vocabulary.
  { id: 'browser.type', name: 'Browser Type', capability: 'browser.form.type', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['type in browser', 'fill field', 'browser type'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.select', name: 'Browser Select', capability: 'browser.form.select', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['select in browser', 'choose option', 'browser select'], getLiveStatus: browserRuntimeLiveStatus },
  // click is genuinely context-dependent (navigation vs. consequential —
  // Submit/Buy/Pay/Delete/...); browser.service.ts classifies each click
  // dynamically from the real target element and only creates an approval
  // for a consequential one. REVERSIBLE_WRITE here is a conservative static
  // default so the Plan Resolution UI never shows a browser.click step as
  // execution-ready outright — the real per-click decision always happens
  // at execution time, never more permissively than that.
  { id: 'browser.click', name: 'Browser Click', capability: 'browser.page.click', connectionStatus: 'disconnected', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: false, executionMode: 'unavailable', aliases: ['click', 'click element', 'browser click'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.find', name: 'Browser Find', capability: 'browser.page.find', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['find in browser', 'find element', 'search page'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.extract', name: 'Browser Extract', capability: 'browser.page.extract', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['extract from browser', 'extract page text', 'extract links', 'scrape page'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.back', name: 'Browser Back', capability: 'browser.page.back', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['browser back', 'go back'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.forward', name: 'Browser Forward', capability: 'browser.page.forward', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['browser forward', 'go forward'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.reload', name: 'Browser Reload', capability: 'browser.page.reload', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['reload page', 'refresh browser'], getLiveStatus: browserRuntimeLiveStatus },
  { id: 'browser.close', name: 'Browser Close', capability: 'browser.session.close', connectionStatus: 'disconnected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['close browser', 'close browser session'], getLiveStatus: browserRuntimeLiveStatus },

  // Telegram Integration (MASTER.md Section 14.5 item 10)
  {
    id: 'telegram.bot',
    name: 'Telegram Integration',
    capability: 'messaging.chat.send',
    connectionStatus: 'connected',
    sideEffectLevel: 'REVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'live',
    aliases: ['telegram', 'telegram bot', 'send telegram message', 'telegram.bot'],
    getLiveStatus: () => ({
      connectionStatus: process.env.TELEGRAM_BOT_TOKEN ? 'connected' : 'disconnected',
      executionMode: process.env.TELEGRAM_BOT_TOKEN ? 'live' : 'mock',
    }),
  },

  // Slack Integration (MASTER.md Section 14.5 item 11)
  {
    id: 'slack.bot',
    name: 'Slack Integration',
    capability: 'messaging.channel.post',
    connectionStatus: 'connected',
    sideEffectLevel: 'REVERSIBLE_WRITE',
    requiresApproval: true,
    executionMode: 'live',
    aliases: ['slack', 'slack bot', 'post slack message', 'slack.bot', 'notify slack'],
    getLiveStatus: () => ({
      connectionStatus: process.env.SLACK_BOT_TOKEN ? 'connected' : 'disconnected',
      executionMode: process.env.SLACK_BOT_TOKEN ? 'live' : 'mock',
    }),
  },
]);
