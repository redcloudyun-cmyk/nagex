// Resolves the connector catalog for ONE signed-in user: the static definitions plus each connector's REAL connection state, read at request time
// from the stores that own it. This service never stores or caches state and cannot mark anything connected on its own:
//   - a PLANNED / UNSUPPORTED connector is always UNAVAILABLE (nothing can be connected);
//   - a LIVE connector is only CONNECTED when its state source says so for THIS user (tenant + principal), and a source that fails is reported as
//     ERROR, never as connected and never as a silent "not connected".
import { CONNECTOR_CATALOG, CONNECTOR_CATEGORIES, type ConnectorAuthMethod, type ConnectorAvailability, type ConnectorCategory, type ConnectorDefinition, type LocalizedText } from './connector-catalog.js';

export type ConnectorConnectionState = 'CONNECTED' | 'NOT_CONNECTED' | 'CONNECTING' | 'REAUTH_REQUIRED' | 'SETUP_REQUIRED' | 'ERROR' | 'UNAVAILABLE';

export interface ConnectorConnection {
  state: ConnectorConnectionState;
  // Machine-readable reason for any state other than CONNECTED / NOT_CONNECTED (e.g. OAUTH_NOT_CONFIGURED, MISSING_SCOPE, COMING_LATER).
  reason: string | null;
  // The connected account's public name (GitHub login, Slack team), never a token or id that grants access.
  account: string | null;
  // How many connections back this card (custom MCP servers, linked chat accounts).
  count: number | null;
}

export interface ConnectorView {
  id: string;
  name: string;
  category: ConnectorCategory;
  icon: string;
  provider: string;
  authMethod: ConnectorAuthMethod;
  availability: ConnectorAvailability;
  capabilities: string[];
  description: LocalizedText;
  setup: LocalizedText | null;
  connection: ConnectorConnection;
}

export interface ConnectorCatalogView {
  categories: Array<{ id: ConnectorCategory; label: LocalizedText }>;
  connectors: ConnectorView[];
}

export interface ConnectorIdentity { tenantId: string; principalId: string }

export interface GoogleSourceStatus { state: 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'ERROR' | 'UNAVAILABLE'; reason: string | null; scopes: string[] }
export interface GitHubSourceStatus { state: 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'ERROR' | 'UNAVAILABLE'; reason: string | null; account: string | null }
export interface ChannelSourceStatus { configured: boolean; linked: number; account: string | null }
export interface McpSourceStatus { servers: Array<{ status: string }> }

// Each source is optional (a deployment may not wire it) and may throw; both cases are reported honestly.
export interface ConnectorStateSources {
  google?: (identity: ConnectorIdentity) => Promise<GoogleSourceStatus>;
  github?: (identity: ConnectorIdentity) => Promise<GitHubSourceStatus>;
  slack?: (identity: ConnectorIdentity) => Promise<ChannelSourceStatus> | ChannelSourceStatus;
  telegram?: (identity: ConnectorIdentity) => Promise<ChannelSourceStatus> | ChannelSourceStatus;
  mcp?: (identity: ConnectorIdentity) => Promise<McpSourceStatus> | McpSourceStatus;
}

const unavailable = (reason: string): ConnectorConnection => ({ state: 'UNAVAILABLE', reason, account: null, count: null });
const failed = (reason: string): ConnectorConnection => ({ state: 'ERROR', reason, account: null, count: null });

function mapOAuthState(state: GoogleSourceStatus['state'], reason: string | null): ConnectorConnection | null {
  if (state === 'UNAVAILABLE') return { state: 'SETUP_REQUIRED', reason: reason ?? 'OAUTH_NOT_CONFIGURED', account: null, count: null };
  if (state === 'NOT_CONNECTED') return { state: 'NOT_CONNECTED', reason: null, account: null, count: null };
  if (state === 'CONNECTING') return { state: 'CONNECTING', reason: null, account: null, count: null };
  if (state === 'REAUTH_REQUIRED') return { state: 'REAUTH_REQUIRED', reason: reason ?? 'TOKEN_REVOKED', account: null, count: null };
  if (state === 'ERROR') return failed(reason ?? 'PROVIDER_ERROR');
  return null; // CONNECTED: the caller adds its own proof (scope / account)
}

export class ConnectorCatalogService {
  constructor(private readonly sources: ConnectorStateSources, private readonly definitions: readonly ConnectorDefinition[] = CONNECTOR_CATALOG) {}

  public async resolve(identity: ConnectorIdentity): Promise<ConnectorCatalogView> {
    // Each source is read once per request, even when several connectors share it (Gmail + Calendar share the Google grant).
    const cache = new Map<string, Promise<unknown>>();
    const once = <T>(key: string, read: () => Promise<T> | T): Promise<T> => {
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(read));
      return cache.get(key) as Promise<T>;
    };
    const connectors = await Promise.all(this.definitions.map(async (definition) => ({
      id: definition.id, name: definition.name, category: definition.category, icon: definition.icon, provider: definition.provider, authMethod: definition.authMethod,
      availability: definition.availability, capabilities: [...definition.capabilities], description: definition.description, setup: definition.setup,
      connection: await this.connectionFor(definition, identity, once),
    })));
    return { categories: CONNECTOR_CATEGORIES.map((category) => ({ ...category })), connectors };
  }

  private async connectionFor(definition: ConnectorDefinition, identity: ConnectorIdentity, once: <T>(key: string, read: () => Promise<T> | T) => Promise<T>): Promise<ConnectorConnection> {
    if (definition.availability === 'PLANNED') return unavailable('COMING_LATER');
    if (definition.availability === 'UNSUPPORTED') return unavailable('NOT_SUPPORTED');
    const source = definition.stateSource;
    const reader = source ? this.sources[source] : undefined;
    if (!source || !reader) return unavailable('SOURCE_NOT_WIRED');
    try {
      if (source === 'google') {
        const status = await once('google', () => (reader as NonNullable<ConnectorStateSources['google']>)(identity));
        const mapped = mapOAuthState(status.state, status.reason);
        if (mapped) return mapped;
        // Connected to Google does not mean this app is usable: the grant must include the app's scope.
        if (definition.requiredScope && !status.scopes.includes(definition.requiredScope)) return { state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE', account: null, count: null };
        return { state: 'CONNECTED', reason: null, account: null, count: null };
      }
      if (source === 'github') {
        const status = await once('github', () => (reader as NonNullable<ConnectorStateSources['github']>)(identity));
        const mapped = mapOAuthState(status.state, status.reason);
        if (mapped) return mapped;
        return { state: 'CONNECTED', reason: null, account: status.account, count: null };
      }
      if (source === 'slack' || source === 'telegram') {
        const status = await once(source, () => (reader as NonNullable<ConnectorStateSources['slack']>)(identity));
        if (!status.configured) return { state: 'SETUP_REQUIRED', reason: 'NOT_CONFIGURED_ON_SERVER', account: null, count: null };
        if (status.linked < 1) return { state: 'NOT_CONNECTED', reason: null, account: null, count: 0 };
        return { state: 'CONNECTED', reason: null, account: status.account, count: status.linked };
      }
      if (source === 'mcp') {
        const status = await once('mcp', () => (reader as NonNullable<ConnectorStateSources['mcp']>)(identity));
        const total = status.servers.length;
        if (total === 0) return { state: 'NOT_CONNECTED', reason: null, account: null, count: 0 };
        const healthy = status.servers.filter((server) => server.status === 'CONNECTED').length;
        // Any server that needs the owner's attention is surfaced rather than hidden behind the healthy ones.
        if (status.servers.some((server) => server.status === 'AUTH_REQUIRED' || server.status === 'IDENTITY_MISMATCH')) return { state: 'REAUTH_REQUIRED', reason: status.servers.some((server) => server.status === 'IDENTITY_MISMATCH') ? 'SERVER_IDENTITY_CHANGED' : 'CREDENTIAL_REJECTED', account: null, count: total };
        if (healthy === 0) return { state: 'ERROR', reason: 'SERVER_UNREACHABLE', account: null, count: total };
        return { state: 'CONNECTED', reason: null, account: null, count: total };
      }
      return unavailable('SOURCE_NOT_WIRED');
    } catch {
      return failed('PROVIDER_ERROR');
    }
  }
}
