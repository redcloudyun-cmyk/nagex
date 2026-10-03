import type { CreationRuntime } from '../../creation/creation-runtime.js';
import type { DocumentExecutor } from '../../creation/executors/document-executor.js';
import type { DocumentStore } from '../../creation/document.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { NagexError } from '../../common/errors.js';
import { callerIdentity, tryGetCallerIdentity } from '../request-identity.js';

export interface DocumentCreationRouteDeps {
  creationRuntime: CreationRuntime;
  documentExecutor: DocumentExecutor;
  documentStore: DocumentStore;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export const handleDocumentCreationRoutes: AsyncRouteRegistrar<DocumentCreationRouteDeps> = async (
  method,
  pathname,
  body,
  headers,
  _query,
  deps
): Promise<ApiResult | undefined> => {
  const { creationRuntime, documentExecutor, documentStore } = deps;
  const caller = tryGetCallerIdentity(headers);
  // No authenticated caller: this registrar handles nothing. (route-access.ts has already answered 401
  // for every route that requires one, so only public routes can reach a later registrar.)
  if (!caller) return undefined;
  const tenantId = caller.tenantId;
  const principalId = caller.principalId;
  const headerRequestId = getHeaderValue(headers, 'x-request-id');
  const requestId = headerRequestId || `req_doc_${Date.now()}`;

  if (pathname === '/api/v1/creations/documents' && method === 'POST') {
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return {
        status: 400,
        data: { error: 'INVALID_PROMPT', message: 'Document creation prompt is required.', request_id: requestId },
      };
    }

    const locale = body?.locale === 'ko' ? 'ko' : 'en';
    const result = await creationRuntime.create({
      creationKind: 'DOCUMENT',
      prompt,
      options: {
        documentKind: typeof body?.documentKind === 'string' ? body.documentKind : 'REPORT',
        style: typeof body?.style === 'string' ? body.style : undefined,
        targetAudience: typeof body?.targetAudience === 'string' ? body.targetAudience : undefined,
        locale,
        format: body?.format === 'HTML' || body?.format === 'PDF' ? body.format : 'MARKDOWN',
        routingMode: typeof body?.routingMode === 'string' ? (body.routingMode as any) : undefined,
      },
      tenantId,
      ownerId: principalId,
      requestId,
    });

    if (result.status !== 'SUCCESS') {
      const statusCode = result.errorCode === 'UNAVAILABLE' ? 503 : 500;
      return {
        status: statusCode,
        data: {
          error: result.errorCode || 'CREATION_FAILED',
          message: result.errorMessage || 'Document creation failed.',
          request_id: requestId,
        },
      };
    }

    return { status: 201, data: result };
  }

  if (pathname.startsWith('/api/v1/creations/documents/') && pathname.endsWith('/revisions') && method === 'POST') {
    const documentId = pathname.slice('/api/v1/creations/documents/'.length, pathname.length - '/revisions'.length);
    const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction) {
      return {
        status: 400,
        data: { error: 'INVALID_INSTRUCTION', message: 'Revision instruction is required.', request_id: requestId },
      };
    }

    const result = await documentExecutor.executeRevision({
      parentDocumentId: documentId,
      instruction,
      tenantId,
      ownerId: principalId,
      requestId,
      locale: body?.locale === 'ko' ? 'ko' : undefined,
      routingMode: body?.routingMode,
    });

    if (result.status !== 'SUCCESS') {
      const statusCode = result.errorCode === 'DOCUMENT_NOT_FOUND' ? 404 : 500;
      return {
        status: statusCode,
        data: {
          error: result.errorCode || 'REVISION_FAILED',
          message: result.errorMessage || 'Document revision failed.',
          request_id: requestId,
        },
      };
    }

    return { status: 201, data: result };
  }

  if (pathname.startsWith('/api/v1/creations/documents/') && method === 'GET') {
    const documentId = pathname.slice('/api/v1/creations/documents/'.length);
    const document = documentStore.get(documentId, tenantId, principalId);
    if (!document) {
      return { status: 404, data: { error: 'DOCUMENT_NOT_FOUND', message: `Document ${documentId} not found.`, request_id: requestId } };
    }

    const revisions = documentStore.getRevisions(document.parentDocumentId || document.documentId, tenantId, principalId);
    return { status: 200, data: { document, revisions } };
  }

  return undefined;
};
