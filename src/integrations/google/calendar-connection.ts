// Google Calendar connection state — the single place that turns "what happened when we tried to use the user's
// Google connection" into a truthful, user-facing state.
//
//   NOT_CONNECTED   no connection for this tenant + user
//   CONNECTING      the user started authorization and it has not finished yet
//   CONNECTED       a usable grant exists (verifiedAt is set only when a real provider call just succeeded)
//   REAUTH_REQUIRED the connection exists but must be authorized again (revoked/expired grant, rejected token, missing scope)
//   ERROR           the connection is fine but Google failed (timeout, outage, rate limit, server fault) — retry, do not reconnect
//   UNAVAILABLE     this server cannot offer Google Calendar at all (OAuth client not configured)
//
// Identity is ALWAYS passed in by the caller from the server-verified session; this module never reads a default or
// client-supplied principal and a state is only ever computed for the tenant + user it was asked about.
import { NagexError } from '../../common/errors.js';
import type { UpcomingCalendarEvent } from '../../modules/calendar/index.js';
import { GOOGLE_CALENDAR_SCOPES, type GoogleOAuthConfig } from './oauth.client.js';
import type { GoogleOAuthTokenStore } from './token.store.js';

type FetchFn = typeof fetch;

export type CalendarConnectionState = 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'ERROR' | 'UNAVAILABLE';

export type CalendarConnectionReason =
  | 'NO_CONNECTION'
  | 'AUTHORIZATION_PENDING'
  | 'OAUTH_NOT_CONFIGURED'
  | 'MISSING_SCOPE'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED_NO_REFRESH'
  | 'TOKEN_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_API_DISABLED'
  | 'PROVIDER_FORBIDDEN'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

export const GOOGLE_CALENDAR_CONNECT_PATH = '/api/v1/oauth/google/start';

export interface CalendarConnectionStatus {
  provider: 'google_calendar';
  state: CalendarConnectionState;
  reason: CalendarConnectionReason | null;
  // true when trying again later can succeed without the user doing anything (timeouts, outages, rate limits)
  retryable: boolean;
  scopes: string[];
  missingScopes: string[];
  // Present only when the user can fix the state by (re)authorizing; never advertised when it would be a dead end.
  connectPath: string | null;
  // Set only when an authorized call to Google Calendar succeeded in producing this status.
  verifiedAt: string | null;
  message: string;
}

export interface CalendarFailure {
  state: Exclude<CalendarConnectionState, 'CONNECTED' | 'CONNECTING'>;
  reason: CalendarConnectionReason;
  retryable: boolean;
  missingScopes?: string[];
}

const MESSAGES: Record<CalendarConnectionReason | 'CONNECTED', string> = {
  CONNECTED: 'Google Calendar is connected.',
  NO_CONNECTION: 'Google Calendar is not connected.',
  AUTHORIZATION_PENDING: 'Google Calendar authorization is in progress.',
  OAUTH_NOT_CONFIGURED: 'Google Calendar is not available on this server.',
  MISSING_SCOPE: 'Google Calendar access was not fully granted. Reconnect and allow calendar access.',
  TOKEN_REVOKED: 'Google access was revoked or has expired. Reconnect Google Calendar.',
  TOKEN_EXPIRED_NO_REFRESH: 'Google access has expired. Reconnect Google Calendar.',
  TOKEN_REJECTED: 'Google rejected the saved access. Reconnect Google Calendar.',
  PROVIDER_TIMEOUT: 'Google Calendar did not respond in time. Try again.',
  PROVIDER_UNREACHABLE: 'Google Calendar could not be reached. Try again.',
  PROVIDER_RATE_LIMITED: 'Google Calendar is limiting requests right now. Try again shortly.',
  PROVIDER_API_DISABLED: 'The Google Calendar API is not enabled for this NAgex deployment.',
  PROVIDER_FORBIDDEN: 'Google Calendar refused this request.',
  PROVIDER_ERROR: 'Google Calendar returned an error. Try again.',
  INTERNAL_ERROR: 'NAgex could not read Google Calendar because of an internal error.',
};

const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficient_scope']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const API_DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED', 'API_KEY_SERVICE_BLOCKED']);

function reasons(error: NagexError): string[] {
  const value = error.details?.reasons;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// Maps whatever a Google Calendar read threw to ONE truthful failure state. Unknown errors are INTERNAL_ERROR, never
// "disconnected": claiming the user must reconnect when NAgex itself failed would be a false statement.
export function classifyCalendarFailure(error: unknown): CalendarFailure {
  if (!(error instanceof NagexError)) return { state: 'ERROR', reason: 'INTERNAL_ERROR', retryable: true };
  const code = error.code;
  if (code === 'GOOGLE_CALENDAR_DISCONNECTED') return { state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false };
  if (code === 'GOOGLE_CALENDAR_UNAVAILABLE') return { state: 'UNAVAILABLE', reason: 'OAUTH_NOT_CONFIGURED', retryable: false };
  if (code === 'GOOGLE_CALENDAR_REAUTH_REQUIRED') {
    const reason = error.details?.reason;
    const missing = Array.isArray(error.details?.missingScopes) ? (error.details?.missingScopes as string[]) : undefined;
    if (reason === 'MISSING_SCOPE') return { state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE', retryable: false, missingScopes: missing };
    if (reason === 'TOKEN_EXPIRED_NO_REFRESH' || reason === 'TOKEN_REJECTED') return { state: 'REAUTH_REQUIRED', reason, retryable: false };
    return { state: 'REAUTH_REQUIRED', reason: 'TOKEN_REVOKED', retryable: false };
  }
  if (code === 'GOOGLE_CALENDAR_TIMEOUT' || code === 'GOOGLE_OAUTH_TIMEOUT') return { state: 'ERROR', reason: 'PROVIDER_TIMEOUT', retryable: true };
  if (code === 'GOOGLE_CALENDAR_NETWORK_ERROR' || code === 'GOOGLE_OAUTH_NETWORK_ERROR') return { state: 'ERROR', reason: 'PROVIDER_UNREACHABLE', retryable: true };
  if (code === 'GOOGLE_OAUTH_PROVIDER_ERROR') return { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true };
  const http = /^GOOGLE_CALENDAR_HTTP_(\d{3})$/.exec(code);
  if (http) {
    const status = Number(http[1]);
    const why = reasons(error);
    if (status === 401) return { state: 'REAUTH_REQUIRED', reason: 'TOKEN_REJECTED', retryable: false };
    if (status === 403) {
      if (why.some((r) => SCOPE_REASONS.has(r))) return { state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE', retryable: false };
      if (why.some((r) => RATE_REASONS.has(r))) return { state: 'ERROR', reason: 'PROVIDER_RATE_LIMITED', retryable: true };
      if (why.some((r) => API_DISABLED_REASONS.has(r))) return { state: 'ERROR', reason: 'PROVIDER_API_DISABLED', retryable: false };
      return { state: 'ERROR', reason: 'PROVIDER_FORBIDDEN', retryable: false };
    }
    if (status === 429) return { state: 'ERROR', reason: 'PROVIDER_RATE_LIMITED', retryable: true };
    if (status >= 500) return { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true };
    return { state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: false };
  }
  return { state: 'ERROR', reason: 'INTERNAL_ERROR', retryable: true };
}

export function calendarStatusFromFailure(failure: CalendarFailure, scopes: string[] = []): CalendarConnectionStatus {
  const canReconnect = failure.state === 'NOT_CONNECTED' || failure.state === 'REAUTH_REQUIRED';
  return {
    provider: 'google_calendar',
    state: failure.state,
    reason: failure.reason,
    retryable: failure.retryable,
    scopes,
    missingScopes: failure.missingScopes ?? [],
    connectPath: canReconnect ? GOOGLE_CALENDAR_CONNECT_PATH : null,
    verifiedAt: null,
    message: MESSAGES[failure.reason],
  };
}

export interface CalendarEventsReader {
  listUpcomingEvents(input: {
    tenantId: string;
    principalId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
    requestId: string;
  }): Promise<UpcomingCalendarEvent[]>;
}

export interface GoogleCalendarConnectionDeps {
  tokenStore: GoogleOAuthTokenStore;
  getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfig | null;
  fetchFn: FetchFn;
  calendar: CalendarEventsReader;
  // true only for the same tenant + user that started a still-valid authorization
  hasPendingAuthorization: (tenantId: string, principalId: string) => boolean;
  now?: () => Date;
}

export interface CalendarIdentity {
  tenantId: string;
  principalId: string;
  requestId: string;
}

export interface CalendarReadResult {
  connection: CalendarConnectionStatus;
  events: UpcomingCalendarEvent[];
}

export class GoogleCalendarConnectionService {
  constructor(private readonly deps: GoogleCalendarConnectionDeps) {}

  // Cheap status: no call to Google Calendar. It reports CONNECTED only for a usable, correctly scoped grant, and
  // leaves verifiedAt null because nothing was verified against Google. Pass verify to prove it with a real read.
  public async getStatus(identity: CalendarIdentity, options: { verify?: boolean } = {}): Promise<CalendarConnectionStatus> {
    const { tenantId, principalId } = identity;
    if (!tenantId || !principalId) return calendarStatusFromFailure({ state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false });
    const stored = this.deps.tokenStore.getStatusForPrincipal(tenantId, principalId);
    const pending = this.deps.hasPendingAuthorization(tenantId, principalId);

    if (!this.deps.getConfig()) {
      return calendarStatusFromFailure({ state: 'UNAVAILABLE', reason: 'OAUTH_NOT_CONFIGURED', retryable: false }, stored.scopes);
    }
    if (stored.authState === 'NONE') {
      return pending ? this.connecting(stored.scopes) : calendarStatusFromFailure({ state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false });
    }
    if (stored.authState === 'REAUTH_REQUIRED') {
      if (pending) return this.connecting(stored.scopes);
      return calendarStatusFromFailure({ state: 'REAUTH_REQUIRED', reason: stored.reauthReason ?? 'TOKEN_REVOKED', retryable: false }, stored.scopes);
    }
    const missingScopes = GOOGLE_CALENDAR_SCOPES.filter((scope) => !stored.scopes.includes(scope));
    if (missingScopes.length > 0) {
      if (pending) return this.connecting(stored.scopes);
      return calendarStatusFromFailure({ state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE', retryable: false, missingScopes }, stored.scopes);
    }

    if (options.verify) return (await this.readEvents(identity, { ...this.nextDay(), maxResults: 1 })).connection;

    // Local check only: make sure the saved grant can still produce an access token (refreshing it if needed).
    const config = this.deps.getConfig();
    if (!config) return calendarStatusFromFailure({ state: 'UNAVAILABLE', reason: 'OAUTH_NOT_CONFIGURED', retryable: false }, stored.scopes);
    const acquired = await this.deps.tokenStore.acquireAccessTokenForPrincipal(tenantId, principalId, config, this.deps.fetchFn, identity.requestId);
    if (!acquired.ok) {
      if (acquired.reason === 'NOT_CONNECTED') return calendarStatusFromFailure({ state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false });
      if (acquired.reason === 'REAUTH_REQUIRED') {
        return pending ? this.connecting(stored.scopes) : calendarStatusFromFailure({ state: 'REAUTH_REQUIRED', reason: acquired.reauthReason ?? 'TOKEN_REVOKED', retryable: false }, stored.scopes);
      }
      if (acquired.reason === 'PROVIDER_TIMEOUT') return calendarStatusFromFailure({ state: 'ERROR', reason: 'PROVIDER_TIMEOUT', retryable: true }, stored.scopes);
      if (acquired.reason === 'PROVIDER_ERROR') return calendarStatusFromFailure({ state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true }, stored.scopes);
      return calendarStatusFromFailure({ state: 'ERROR', reason: 'INTERNAL_ERROR', retryable: true }, stored.scopes);
    }
    return { provider: 'google_calendar', state: 'CONNECTED', reason: null, retryable: false, scopes: stored.scopes, missingScopes: [], connectPath: null, verifiedAt: null, message: MESSAGES.CONNECTED };
  }

  // Reads the user's real events through GoogleCalendarService.listUpcomingEvents (the existing credential-brokered,
  // principal-bound path). CONNECTED + verifiedAt only after Google actually answered an authorized request.
  public async readEvents(
    identity: CalendarIdentity,
    window: { timeMin: string; timeMax: string; maxResults?: number },
  ): Promise<CalendarReadResult> {
    const { tenantId, principalId, requestId } = identity;
    if (!tenantId || !principalId) {
      return { connection: calendarStatusFromFailure({ state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', retryable: false }), events: [] };
    }
    try {
      const events = await this.deps.calendar.listUpcomingEvents({ tenantId, principalId, timeMin: window.timeMin, timeMax: window.timeMax, maxResults: window.maxResults, requestId });
      const stored = this.deps.tokenStore.getStatusForPrincipal(tenantId, principalId);
      return {
        connection: { provider: 'google_calendar', state: 'CONNECTED', reason: null, retryable: false, scopes: stored.scopes, missingScopes: [], connectPath: null, verifiedAt: (this.deps.now?.() ?? new Date()).toISOString(), message: MESSAGES.CONNECTED },
        events,
      };
    } catch (error) {
      const failure = classifyCalendarFailure(error);
      // Google itself rejected the saved access token: remember that, so the next status does not claim CONNECTED.
      if (failure.state === 'REAUTH_REQUIRED' && failure.reason === 'TOKEN_REJECTED') {
        this.deps.tokenStore.markReauthRequiredForPrincipal(tenantId, principalId, 'TOKEN_REJECTED');
      }
      const stored = this.deps.tokenStore.getStatusForPrincipal(tenantId, principalId);
      if (this.deps.hasPendingAuthorization(tenantId, principalId) && (failure.state === 'NOT_CONNECTED' || failure.state === 'REAUTH_REQUIRED')) {
        return { connection: this.connecting(stored.scopes), events: [] };
      }
      return { connection: calendarStatusFromFailure(failure, stored.scopes), events: [] };
    }
  }

  private connecting(scopes: string[]): CalendarConnectionStatus {
    return { provider: 'google_calendar', state: 'CONNECTING', reason: 'AUTHORIZATION_PENDING', retryable: false, scopes, missingScopes: [], connectPath: null, verifiedAt: null, message: MESSAGES.AUTHORIZATION_PENDING };
  }

  private nextDay(): { timeMin: string; timeMax: string } {
    const now = this.deps.now?.() ?? new Date();
    return { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 24 * 3600 * 1000).toISOString() };
  }
}

// Legacy consumers (daily brief, My Space, personal assistant) only separate "the user has to (re)connect Google Calendar"
// from "something went wrong". Both a missing and a no-longer-valid connection need the same user action.
export function isCalendarNeedsConnection(error: unknown): boolean {
  const state = classifyCalendarFailure(error).state;
  return state === 'NOT_CONNECTED' || state === 'REAUTH_REQUIRED' || state === 'UNAVAILABLE';
}
