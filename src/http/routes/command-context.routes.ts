import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { MultimodalCommandService } from '../../commands/multimodal-command.service.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { getSessionIdFromHeaders } from './auth.routes.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface CommandContextRouteDeps {
  commandService: MultimodalCommandService;
  sessionStore: SessionStore;
}

export const handleCommandContextRoutes: AsyncRouteRegistrar<CommandContextRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (pathname !== '/api/v1/command-contexts/submit' || method !== 'POST') return undefined;
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_cmdctx_${crypto.randomUUID()}`;
  const sessionId = getSessionIdFromHeaders(headers);
  const session = sessionId ? deps.sessionStore.getSession(sessionId) : null;
  if (!session) {
    throw new NagexError({ code: 'COMMAND_CONTEXT_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to submit an executable command.', request_id: requestId });
  }
  const result = await deps.commandService.submit({
    tenantId: session.tenantId,
    principalId: session.principalId,
    text: typeof body?.text === 'string' ? body.text : '',
    inputModality: typeof body?.inputModality === 'string' ? body.inputModality as never : 'TEXT',
    originDeviceId: typeof body?.originDeviceId === 'string' ? body.originDeviceId : null,
    originDeviceType: typeof body?.originDeviceType === 'string' ? body.originDeviceType : null,
    originSurface: typeof body?.originSurface === 'string' ? body.originSurface : 'HOME',
    inputArtifacts: Array.isArray(body?.inputArtifacts) ? body.inputArtifacts : [],
    foregroundApp: typeof body?.foregroundApp === 'string' ? body.foregroundApp : null,
    activeWindow: typeof body?.activeWindow === 'string' ? body.activeWindow : null,
    selectedText: typeof body?.selectedText === 'string' ? body.selectedText : null,
    screenContext: body?.screenContext && typeof body.screenContext === 'object' ? body.screenContext as Record<string, unknown> : null,
    audioTranscript: typeof body?.audioTranscript === 'string' ? body.audioTranscript : null,
    preferredExecutionDeviceId: typeof body?.preferredExecutionDeviceId === 'string' ? body.preferredExecutionDeviceId : null,
    requestId,
  });
  return { status: result.handled ? 201 : 202, data: result };
};
