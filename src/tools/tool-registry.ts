export type SideEffectLevel = 'READ_ONLY' | 'REVERSIBLE_WRITE' | 'IRREVERSIBLE_WRITE';
export type ToolExecutionMode = 'live' | 'mock' | 'unavailable';
export type ToolConnectionStatus = 'connected' | 'disconnected' | 'unavailable';

export interface RegisteredTool {
  id: string;
  name: string;
  capability: string;
  connectionStatus: ToolConnectionStatus;
  sideEffectLevel: SideEffectLevel;
  requiresApproval: boolean;
  executionMode: ToolExecutionMode;
  aliases: readonly string[];
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

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
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

  public list(): readonly RegisteredTool[] {
    return this.tools;
  }

  public resolve(requestedTool: string | null): ToolResolution {
    if (!requestedTool?.trim()) {
      return { requestedTool: null, status: 'RESOLVED', resolvedToolId: null, resolvedToolName: null, capability: null, connectionStatus: null, sideEffectLevel: null, requiresApproval: false, executionMode: null, availability: 'NOT_REQUIRED' };
    }
    const tool = this.lookup.get(normalizeToolName(requestedTool));
    if (!tool) {
      return { requestedTool, status: 'UNRESOLVED', resolvedToolId: null, resolvedToolName: null, capability: null, connectionStatus: null, sideEffectLevel: null, requiresApproval: false, executionMode: null, availability: 'UNRESOLVED' };
    }
    const availability = tool.executionMode === 'mock'
      ? 'MOCK_ONLY'
      : tool.executionMode === 'unavailable' || tool.connectionStatus !== 'connected'
        ? 'UNAVAILABLE'
        : 'AVAILABLE';
    return {
      requestedTool,
      status: 'RESOLVED',
      resolvedToolId: tool.id,
      resolvedToolName: tool.name,
      capability: tool.capability,
      connectionStatus: tool.connectionStatus,
      sideEffectLevel: tool.sideEffectLevel,
      requiresApproval: tool.requiresApproval || tool.sideEffectLevel !== 'READ_ONLY',
      executionMode: tool.executionMode,
      availability,
    };
  }
}

export const toolRegistry = new ToolRegistry([
  { id: 'gmail.send_email', name: 'Gmail', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'mock', aliases: ['gmail.send', 'send gmail', 'gmail send email'] },
  { id: 'google_calendar.create_event', name: 'Google Calendar', capability: 'calendar.event.create', connectionStatus: 'connected', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: true, executionMode: 'mock', aliases: ['google calendar create event', 'calendar.create_event', 'create calendar event'] },
  { id: 'notion.create_page', name: 'Notion', capability: 'document.page.create', connectionStatus: 'unavailable', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: true, executionMode: 'unavailable', aliases: ['notion create page', 'create notion page'] },
  { id: 'memory.search', name: 'NAgex Memory', capability: 'memory.read', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: ['memory recall', 'search memory'] },
  { id: 'workspace.prepare_draft', name: 'Workspace Draft', capability: 'document.draft.prepare', connectionStatus: 'connected', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: ['prepare draft', 'draft document'] },
  { id: 'web.search', name: 'Web Search', capability: 'web.search', connectionStatus: 'unavailable', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'unavailable', aliases: ['internet search'] },
]);
