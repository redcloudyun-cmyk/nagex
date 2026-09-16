// R10.2-D Increment 2 — Quick Wake + Autonomy settings routes, extracted
// verbatim from server_web.ts's handleApiRequest. Both configs are plain
// in-memory mutable state (no persistence, no approval, no tenant scoping)
// — unchanged from the original; this extraction only relocates them.
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

const quickWakeConfig = {
  floating_button: true,
  quick_settings_tile: true,
  lock_screen_shortcut: true,
  voice_wake: false,
  double_tap_shortcut: true,
  headset_button: false,
  accessibility_shortcut: false,
  fingerprint_button: { supported: false, label: 'Not supported on this device' },
};

const autonomyConfig = {
  level: 'L2',
  description: 'Level 2 — Low-risk Actions with Human Approval Gate for Consequential Operations',
};

export const handleSettingsRoutes: SyncRouteRegistrar<Record<string, never>> = (method, pathname, body): ApiResult | undefined => {
  if (pathname === '/api/v1/quickwake/config' && method === 'GET') return { status: 200, data: quickWakeConfig };
  if (pathname === '/api/v1/quickwake/config' && method === 'POST') {
    if (body) Object.assign(quickWakeConfig, body);
    return { status: 200, data: quickWakeConfig };
  }

  if (pathname === '/api/v1/autonomy/config' && method === 'GET') return { status: 200, data: autonomyConfig };
  if (pathname === '/api/v1/autonomy/config' && method === 'POST') {
    if (body?.level) autonomyConfig.level = body.level as string;
    return { status: 200, data: autonomyConfig };
  }

  return undefined;
};
