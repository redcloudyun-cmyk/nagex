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
import type { AutonomyLevelPreference, QuickWakePreferences } from '../../identity/identity.types.js';
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

export const handleSettingsRoutes: AsyncRouteRegistrar<SettingsRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const isQuickWake = pathname === '/api/v1/quickwake/config';
  const isAutonomy = pathname === '/api/v1/autonomy/config';
  if (!isQuickWake && !isAutonomy) return undefined;
  if (method !== 'GET' && method !== 'POST') return undefined;

  const userId = authenticatedUserId(headers, deps);
  if (!userId) return UNAUTHORIZED;

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
