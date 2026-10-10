// R24.6B — Quick Wake + Autonomy preference routes.
//
// Previously (R10.2-D) both were module-level, process-global, unauthenticated
// in-memory objects (R24.6A: shared by every user/tenant, lost on restart,
// unvalidated). They are now per-user preferences, owned by the existing
// durable IdentityStore profile record (no separate settings store), and
// every read/write requires a real authenticated session — the user/tenant
// come ONLY from the session, never from client-supplied headers or body.
//
// Truthfulness: nothing in the runtime consumes either value today (verified
// R24.6B: no reader of quick-wake toggles anywhere; the agent runtime's
// autonomy_level comes from agent/tenant configuration, and approval gates
// apply regardless of this preference). The responses therefore carry
// runtime_effect: 'NONE' so every client can say so instead of implying the
// setting changes behavior.
import type { IdentityStore } from '../../identity/identity.store.js';
import type { AmbientSourceConsentPreference, AutonomyLevelPreference, QuickWakePreferences, UserPreferences } from '../../identity/identity.types.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';

export interface SettingsRouteDeps {
  identityStore: IdentityStore;
  sessionStore: SessionStore;
}

const QUICK_WAKE_KEYS = ['floating_button', 'quick_settings_tile', 'lock_screen_shortcut', 'voice_wake', 'double_tap_shortcut'] as const;
const QUICK_WAKE_DEFAULTS: QuickWakePreferences = {
  floating_button: true,
  quick_settings_tile: true,
  lock_screen_shortcut: true,
  voice_wake: false,
  double_tap_shortcut: true,
};

const AUTONOMY_LEVELS: Record<AutonomyLevelPreference, string> = {
  L0: 'Level 0 — Always ask before making any change',
  L1: 'Level 1 — Read and suggest only',
  L2: 'Level 2 — Low-risk Actions with Human Approval Gate for Consequential Operations',
  L3: 'Level 3 — Run previously reviewed routines',
};
const DEFAULT_AUTONOMY_LEVEL: AutonomyLevelPreference = 'L2';
const DEFAULT_SETTINGS = {
  notifications: { web: true, desktop: false, dailyBrief: true, proactive: true },
  privacy: { includeMemoryInSearch: true, includeVaultInSearch: true, shareDiagnostics: false },
  ambientMonitoring: { enabled: false, dailyBrief: false, proactiveSuggestions: false, sourceConsents: {} },
  deviceSettings: { allowNewDeviceEnrollment: true, requireTrustedDevices: true },
  connectionSettings: { autoReconnect: false, showUnavailableProviders: true },
} as const;

const UNAUTHORIZED: ApiResult = { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to view or change these settings.' } } };

function badRequest(code: string, message: string): ApiResult {
  return { status: 400, data: { error: { code, message } } };
}

function authenticatedUserId(headers: Record<string, string | string[] | undefined>, deps: SettingsRouteDeps): string | null {
  return resolveAuthenticatedIdentity(headers, deps)?.userId ?? null;
}

function quickWakeView(userId: string, deps: SettingsRouteDeps): Record<string, unknown> {
  const stored = deps.identityStore.getPreferences(userId).quickWake ?? {};
  return {
    ...QUICK_WAKE_DEFAULTS,
    ...stored,
    // Static capability fact (no fingerprint integration exists), not a stored/writable value.
    fingerprint_button: { supported: false, label: 'Not supported on this device' },
    runtime_effect: 'NONE',
  };
}

function autonomyView(userId: string, deps: SettingsRouteDeps): Record<string, unknown> {
  const level = deps.identityStore.getPreferences(userId).autonomyLevel ?? DEFAULT_AUTONOMY_LEVEL;
  return { level, description: AUTONOMY_LEVELS[level], runtime_effect: 'NONE' };
}

function coerceBooleanPatch(input: unknown, allowed: readonly string[]): Record<string, boolean> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const patch: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key) || typeof value !== 'boolean') return null;
    patch[key] = value;
  }
  return patch;
}

function settingsView(userId: string, deps: SettingsRouteDeps): Record<string, unknown> {
  const profile = deps.identityStore.getProfile(userId);
  const prefs = deps.identityStore.getPreferences(userId);
  return {
    profile: {
      displayName: profile?.displayName ?? 'User',
      avatarUrl: profile?.avatarUrl ?? null,
      locale: profile?.locale ?? 'en',
      timezone: profile?.timezone ?? 'UTC',
      updatedAt: profile?.updatedAt ?? null,
    },
    quickWake: quickWakeView(userId, deps),
    autonomy: autonomyView(userId, deps),
    memory: { runtime_effect: 'PREFERENCE_ONLY', controlsAvailable: true },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(prefs.notifications ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(prefs.privacy ?? {}) },
    ambientMonitoring: {
      ...DEFAULT_SETTINGS.ambientMonitoring,
      ...(prefs.ambientMonitoring ?? {}),
      sourceConsents: prefs.ambientMonitoring?.sourceConsents ?? {},
    },
    deviceSettings: { ...DEFAULT_SETTINGS.deviceSettings, ...(prefs.deviceSettings ?? {}) },
    connectionSettings: { ...DEFAULT_SETTINGS.connectionSettings, ...(prefs.connectionSettings ?? {}) },
    runtime_effect: 'PERSISTED_PROFILE_PREFERENCES',
  };
}

function consentKey(input: Pick<AmbientSourceConsentPreference, 'sourceType' | 'provider' | 'accountRef'>): string {
  return `${input.sourceType}:${input.provider}:${input.accountRef}`;
}

export const handleSettingsRoutes: AsyncRouteRegistrar<SettingsRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const isSettings = pathname === '/api/v1/settings';
  const isAmbientConsent = pathname === '/api/v1/settings/ambient-consent';
  const isQuickWake = pathname === '/api/v1/quickwake/config';
  const isAutonomy = pathname === '/api/v1/autonomy/config';
  if (!isSettings && !isAmbientConsent && !isQuickWake && !isAutonomy) return undefined;
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH') return undefined;

  const userId = authenticatedUserId(headers, deps);
  if (!userId) return UNAUTHORIZED;

  if (isSettings && method === 'GET') return { status: 200, data: settingsView(userId, deps) };
  if (isSettings && (method === 'POST' || method === 'PATCH')) {
    const profilePatch: Record<string, unknown> = {};
    if (typeof body?.displayName === 'string') profilePatch.displayName = body.displayName;
    if (body?.avatarUrl === null || typeof body?.avatarUrl === 'string') profilePatch.avatarUrl = body.avatarUrl;
    if (typeof body?.locale === 'string') profilePatch.locale = body.locale;
    if (typeof body?.timezone === 'string') profilePatch.timezone = body.timezone;
    if (Object.keys(profilePatch).length) deps.identityStore.updateProfile(userId, profilePatch);

    const prefPatch: Partial<UserPreferences> = {};
    const notifications = coerceBooleanPatch(body?.notifications, ['web', 'desktop', 'dailyBrief', 'proactive']);
    const privacy = coerceBooleanPatch(body?.privacy, ['includeMemoryInSearch', 'includeVaultInSearch', 'shareDiagnostics']);
    const ambient = coerceBooleanPatch(body?.ambientMonitoring, ['enabled', 'dailyBrief', 'proactiveSuggestions']);
    const deviceSettings = coerceBooleanPatch(body?.deviceSettings, ['allowNewDeviceEnrollment', 'requireTrustedDevices']);
    const connectionSettings = coerceBooleanPatch(body?.connectionSettings, ['autoReconnect', 'showUnavailableProviders']);
    if (body?.notifications !== undefined && !notifications) return badRequest('SETTINGS_INVALID_NOTIFICATIONS', 'Notification settings must be boolean fields.');
    if (body?.privacy !== undefined && !privacy) return badRequest('SETTINGS_INVALID_PRIVACY', 'Privacy settings must be boolean fields.');
    if (body?.ambientMonitoring !== undefined && !ambient) return badRequest('SETTINGS_INVALID_AMBIENT', 'Ambient settings must be boolean fields.');
    if (body?.deviceSettings !== undefined && !deviceSettings) return badRequest('SETTINGS_INVALID_DEVICE', 'Device settings must be boolean fields.');
    if (body?.connectionSettings !== undefined && !connectionSettings) return badRequest('SETTINGS_INVALID_CONNECTION', 'Connection settings must be boolean fields.');
    if (notifications) prefPatch.notifications = notifications;
    if (privacy) prefPatch.privacy = privacy;
    if (ambient) prefPatch.ambientMonitoring = ambient;
    if (deviceSettings) prefPatch.deviceSettings = deviceSettings;
    if (connectionSettings) prefPatch.connectionSettings = connectionSettings;
    if (Object.keys(prefPatch).length) deps.identityStore.updatePreferences(userId, prefPatch);
    return { status: 200, data: settingsView(userId, deps) };
  }

  if (isAmbientConsent && method === 'GET') {
    const consents = deps.identityStore.getPreferences(userId).ambientMonitoring?.sourceConsents ?? {};
    return { status: 200, data: { consents: Object.values(consents), total: Object.keys(consents).length } };
  }
  if (isAmbientConsent && (method === 'POST' || method === 'PATCH')) {
    const sourceType = typeof body?.sourceType === 'string' ? body.sourceType.trim() : '';
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const accountRef = typeof body?.accountRef === 'string' ? body.accountRef.trim() : '';
    if (!sourceType || !provider || !accountRef) return badRequest('AMBIENT_CONSENT_SOURCE_REQUIRED', 'sourceType, provider, and accountRef are required.');
    const now = new Date().toISOString();
    const existing = deps.identityStore.getPreferences(userId).ambientMonitoring?.sourceConsents?.[consentKey({ sourceType, provider, accountRef })];
    const revoked = body?.revoke === true;
    const consent: AmbientSourceConsentPreference = {
      sourceType,
      provider,
      accountRef,
      connected: body?.connected === true,
      observeAllowed: revoked ? false : body?.observeAllowed === true,
      backgroundAllowed: revoked ? false : body?.backgroundAllowed === true,
      contentReadAllowed: revoked ? false : body?.contentReadAllowed === true,
      attachmentAllowed: revoked ? false : body?.attachmentAllowed === true,
      proactiveUseAllowed: revoked ? false : body?.proactiveUseAllowed === true,
      draftAllowed: revoked ? false : body?.draftAllowed === true,
      executeAllowed: revoked ? false : body?.executeAllowed === true,
      scope: typeof body?.scope === 'string' ? body.scope : existing?.scope ?? 'USER_SELECTED',
      purpose: typeof body?.purpose === 'string' ? body.purpose : existing?.purpose ?? 'PROACTIVE_ASSISTANCE',
      retention: typeof body?.retention === 'string' ? body.retention : existing?.retention ?? 'EPHEMERAL',
      grantedAt: existing?.grantedAt ?? now,
      updatedAt: now,
      revokedAt: revoked ? now : null,
    };
    deps.identityStore.updatePreferences(userId, { ambientMonitoring: { sourceConsents: { [consentKey(consent)]: consent } } });
    return { status: 200, data: { consent } };
  }

  if (isQuickWake && method === 'GET') return { status: 200, data: quickWakeView(userId, deps) };
  if (isQuickWake && method === 'POST') {
    const patch: Partial<QuickWakePreferences> = {};
    const entries = Object.entries(body ?? {});
    if (entries.length === 0) return badRequest('QUICKWAKE_EMPTY_UPDATE', 'Provide at least one Quick Wake option.');
    for (const [key, value] of entries) {
      if (!(QUICK_WAKE_KEYS as readonly string[]).includes(key)) return badRequest('QUICKWAKE_UNKNOWN_OPTION', `Unknown Quick Wake option "${key}".`);
      if (typeof value !== 'boolean') return badRequest('QUICKWAKE_INVALID_VALUE', `Quick Wake option "${key}" must be true or false.`);
      patch[key as keyof QuickWakePreferences] = value;
    }
    deps.identityStore.updatePreferences(userId, { quickWake: patch });
    return { status: 200, data: quickWakeView(userId, deps) };
  }

  if (isAutonomy && method === 'GET') return { status: 200, data: autonomyView(userId, deps) };
  if (isAutonomy && method === 'POST') {
    const level = body?.level;
    if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(AUTONOMY_LEVELS, level)) {
      return badRequest('AUTONOMY_INVALID_LEVEL', 'level must be one of L0, L1, L2, L3.');
    }
    deps.identityStore.updatePreferences(userId, { autonomyLevel: level as AutonomyLevelPreference });
    return { status: 200, data: autonomyView(userId, deps) };
  }

  return undefined;
};
