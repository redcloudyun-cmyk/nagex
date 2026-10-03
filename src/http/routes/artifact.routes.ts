import crypto from 'node:crypto';
import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import { toArtifactUxProjection } from '../../artifacts/artifact.types.js';
import type { ArtifactContextResolver } from '../../artifacts/artifact-context.resolver.js';
import type { AiService } from '../../model-gateway/ai-service.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { NagexError } from '../../common/errors.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

// R24.7B — Canvas Ask dependencies. Optional so the pre-existing read routes
// (and test harnesses that only supply an ArtifactStore) keep working
// unchanged; the Ask route itself fails closed when any of them is missing.
export interface ArtifactAskDeps {
  contextResolver: ArtifactContextResolver;
  aiService: AiService;
  auditLogger: AuditLogger;
  sessionStore: SessionStore;
  identityStore: IdentityStore;
}

export interface ArtifactRouteDeps {
  artifactStore: ArtifactStore;
  ask?: ArtifactAskDeps;
}

export const ARTIFACT_ASK_MAX_QUESTION_CHARS = 2000;

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export const handleArtifactRoutes: AsyncRouteRegistrar<ArtifactRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  // R24.7B — POST /api/v1/artifacts/:artifactId/ask. Authenticated session ONLY:
  // none of the legacy header/default-principal fallbacks below applies here.
  if (method === 'POST' && pathname.startsWith('/api/v1/artifacts/') && pathname.endsWith('/ask')) {
    const artifactId = pathname.slice('/api/v1/artifacts/'.length, pathname.length - '/ask'.length);
    if (!artifactId || artifactId.includes('/')) return undefined;
    return handleArtifactAsk(artifactId, body, headers, deps.ask);
  }

  const tenantId = String(headers['x-nagex-tenant'] || 'ten_production_01');
  const ownerId = String(headers['x-principal-id'] || 'usr_admin_001');
  if (pathname === '/api/v1/artifacts' && method === 'GET') {
    return { status: 200, data: { artifacts: deps.artifactStore.list(tenantId, ownerId, Number(query.limit) || 20) } };
  }
  if (pathname.startsWith('/api/v1/artifacts/') && method === 'GET') {
    const artifactId = pathname.slice('/api/v1/artifacts/'.length);
    const artifact = deps.artifactStore.get(artifactId, tenantId, ownerId);
    // R24.7B — `projection` is the same ArtifactUxProjection Home's Recent
    // Creations uses, so a Canvas route (#canvas?artifactId=…) can reopen ANY
    // owned artifact on reload without depending on Home's top-5 list.
    return artifact ? { status: 200, data: { artifact, projection: toArtifactUxProjection(artifact) } } : { status: 404, data: { error: 'ARTIFACT_NOT_FOUND' } };
  }
  return undefined;
};

type AskOutcome = 'ANSWERED' | 'NOT_FOUND' | 'UNSUPPORTED' | 'CONTEXT_UNAVAILABLE' | 'INVALID_QUESTION' | 'MODEL_FAILURE' | 'EMPTY_ANSWER';

async function handleArtifactAsk(
  artifactId: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string | string[] | undefined>,
  ask: ArtifactAskDeps | undefined
): Promise<ApiResult> {
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_ask_${crypto.randomUUID()}`;
  if (!ask) {
    return { status: 503, data: { error: 'ARTIFACT_ASK_UNAVAILABLE', message: 'Asking about an artifact is not available on this server.', request_id: requestId } };
  }

  // Identity comes from the server-side session record ONLY (R24.6C resolver).
  // X-Principal-Id / X-NAgex-Tenant, the body and the query are never consulted,
  // and an anonymous caller never falls back to the default principal.
  const identity = resolveAuthenticatedIdentity(headers, { sessionStore: ask.sessionStore, identityStore: ask.identityStore });
  if (!identity) {
    return { status: 401, data: { error: 'AUTHENTICATION_REQUIRED', message: 'Sign in to ask about this artifact.', request_id: requestId } };
  }

  const audit = (outcome: AskOutcome, extra: Record<string, unknown> = {}): void => {
    // Safe metadata only: never the question, never artifact content.
    ask.auditLogger.logEvent({
      actor: { type: 'user', id: identity.principalId },
      tenant_id: identity.tenantId,
      action: 'artifact.ask',
      resource: { type: 'Artifact', id: artifactId },
      result: outcome === 'ANSWERED' ? 'SUCCESS' : outcome === 'NOT_FOUND' ? 'DENIED' : 'FAILED',
      reason_code: outcome,
      request_id: requestId,
      details: { outcome, ...extra },
    });
  };

  // Only `question` is read from the body. Any client-supplied content, owner,
  // tenant, sourceId, revision or grounding state is ignored by construction.
  const rawQuestion = body && typeof body.question === 'string' ? body.question.trim() : '';
  if (!rawQuestion || rawQuestion.length > ARTIFACT_ASK_MAX_QUESTION_CHARS) {
    audit('INVALID_QUESTION');
    return {
      status: 400,
      data: { error: 'INVALID_QUESTION', message: `A question of 1–${ARTIFACT_ASK_MAX_QUESTION_CHARS} characters is required.`, request_id: requestId },
    };
  }
  const locale: 'en' | 'ko' | undefined = body && body.locale === 'ko' ? 'ko' : body && body.locale === 'en' ? 'en' : undefined;

  const resolved = ask.contextResolver.resolve(artifactId, identity.tenantId, identity.principalId);
  if (resolved.status === 'NOT_FOUND') {
    // Uniform: unknown id, another user's artifact and another tenant's artifact are indistinguishable.
    audit('NOT_FOUND');
    return { status: 404, data: { error: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.', request_id: requestId } };
  }
  if (resolved.status === 'UNSUPPORTED') {
    audit('UNSUPPORTED', { artifactType: resolved.artifactType, reason: resolved.reason });
    return {
      status: 422,
      data: { error: 'ARTIFACT_ASK_UNSUPPORTED', reason: resolved.reason, artifactType: resolved.artifactType, message: 'Asking about this artifact type is not supported yet.', request_id: requestId },
    };
  }
  if (resolved.status === 'CONTEXT_UNAVAILABLE') {
    audit('CONTEXT_UNAVAILABLE', { artifactType: resolved.artifactType });
    return {
      status: 409,
      data: { error: 'ARTIFACT_CONTEXT_UNAVAILABLE', artifactType: resolved.artifactType, message: 'The saved content of this artifact is not available right now.', request_id: requestId },
    };
  }

  const ctx = resolved.context;
  try {
    const outcome = await ask.aiService.artifactAsk({
      question: rawQuestion,
      artifactType: ctx.artifactType,
      title: ctx.title,
      content: ctx.content,
      revision: ctx.revision,
      truncated: ctx.truncated,
      contentChars: ctx.contentChars,
      contextChars: ctx.contextChars,
      basis: ctx.groundingBasis,
      locale,
      requestId,
    });
    const answer = typeof outcome.data.answer === 'string' ? outcome.data.answer.trim() : '';
    if (!answer) {
      audit('EMPTY_ANSWER', { artifactType: ctx.artifactType, provider: outcome.provider, model: outcome.model });
      return { status: 502, data: { error: 'ASK_EMPTY_ANSWER', message: 'NAgex could not produce an answer. Try again.', request_id: requestId } };
    }
    audit('ANSWERED', { artifactType: ctx.artifactType, revision: ctx.revision, truncated: ctx.truncated, provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs });
    return {
      status: 200,
      data: {
        answer,
        // Machine-readable grounding. `basis: 'ARTIFACT'` means "derived from this
        // saved artifact's text" — NOT verified against the outside world, hence
        // externalVerified is always false and no citations/paths are ever attached.
        grounding: {
          basis: 'ARTIFACT',
          scope: ctx.groundingBasis,
          artifactId: ctx.artifactId,
          artifactType: ctx.artifactType,
          revision: ctx.revision,
          contentHash: ctx.contentHash,
          truncated: ctx.truncated,
          contentChars: ctx.contentChars,
          contextChars: ctx.contextChars,
          contextLimit: ctx.contextLimit,
          externalVerified: false,
        },
        request_id: requestId,
      },
    };
  } catch (error) {
    const code = error instanceof NagexError ? error.code : 'INTERNAL_ERROR';
    audit('MODEL_FAILURE', { artifactType: ctx.artifactType, errorCode: code });
    const unavailable = code === 'NO_MODEL_PROVIDER_CONFIGURED';
    return {
      status: unavailable ? 503 : 502,
      data: {
        error: unavailable ? 'ASK_MODEL_UNAVAILABLE' : 'ASK_MODEL_FAILURE',
        message: unavailable ? 'NAgex cannot answer right now because no model is available.' : 'NAgex could not answer right now. Try again.',
        request_id: requestId,
      },
    };
  }
}
