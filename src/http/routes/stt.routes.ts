import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';

// ADR-0013 — NAgex provides no server-hosted speech-to-text.
//
// Speech is converted to text on the user's device (a platform recognizer the platform verifies as on-device), or by a
// third-party speech service only after provider-specific informed consent given on that device. NAgex servers receive
// text, not audio. This route is kept only so that an older cached web client gets a truthful answer instead of a 404;
// it never reads, stores or processes the request body and starts no process.
//
// Pre-existing server resources (binaries, models) are intentionally left in place until a safe migration is agreed.

function error(status: number, reason: string, message?: string): ApiResult {
  return { status, data: message ? { ok: false, reason, message } : { ok: false, reason } };
}

export const handleSttRoutes: AsyncRouteRegistrar<Record<string, never>> = async (method, pathname, _body, headers) => {
  if (method !== 'POST' || pathname !== '/api/v1/stt/transcribe') return undefined;
  if (!tryGetCallerIdentity(headers)) return error(401, 'AUTHENTICATION_REQUIRED');
  return error(410, 'SERVER_STT_DISABLED', 'NAgex does not transcribe audio on its servers. Use on-device voice input or type your request.');
};
