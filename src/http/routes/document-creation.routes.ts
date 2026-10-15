import type { CreationRuntime } from '../../creation/creation-runtime.js';
import type { DocumentExecutor } from '../../creation/executors/document-executor.js';
import type { DocumentStore } from '../../creation/document.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { NagexError } from '../../common/errors.js';
import { detectRequestLanguage } from '../../common/request-language.js';
import { buildDocx, DOCX_MIME, docxFileName } from '../../creation/docx/docx-writer.js';
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

    // The stored content is Markdown and the file export is DOCX. A PDF/HTML document that is really Markdown would be a false deliverable, so it is refused instead of silently relabelled.
    if (body?.format !== undefined && body.format !== 'MARKDOWN' && body.format !== 'DOCX') {
      return { status: 400, data: { error: 'FORMAT_UNSUPPORTED', message: `The ${String(body.format).slice(0, 12)} format is not available. Documents are created as Markdown text and can be downloaded as DOCX.`, request_id: requestId } };
    }

    // an explicit locale wins; otherwise the document follows the language the person wrote the request in (a Korean request gets a Korean document)
    const locale = body?.locale === 'ko' || body?.locale === 'en' ? body.locale : (detectRequestLanguage(prompt) === 'ko' ? 'ko' : 'en');
    const result = await creationRuntime.create({
      creationKind: 'DOCUMENT',
      prompt,
      options: {
        documentKind: typeof body?.documentKind === 'string' ? body.documentKind : 'REPORT',
        style: typeof body?.style === 'string' ? body.style : undefined,
        targetAudience: typeof body?.targetAudience === 'string' ? body.targetAudience : undefined,
        locale,
        format: 'MARKDOWN',
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
      locale: body?.locale === 'ko' || detectRequestLanguage(instruction) === 'ko' ? 'ko' : undefined,
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

  // A real .docx of the person's own document, built from the stored Markdown (no second copy is stored). Unknown id, malformed id, foreign tenant and foreign owner are indistinguishable.
  const downloadMatch = pathname.match(/^\/api\/v1\/creations\/documents\/(doc_[0-9a-f]{24})\/download$/);
  if (downloadMatch && method === 'GET') {
    const record = documentStore.get(downloadMatch[1], tenantId, principalId);
    if (!record || !record.content.trim()) {
      return { status: 404, data: { error: 'DOCUMENT_NOT_FOUND', message: 'Document not found.', request_id: requestId } };
    }
    const bytes = buildDocx({ title: record.title, markdown: record.content, locale: record.locale === 'ko' ? 'ko' : 'en' });
    return {
      status: 200,
      data: bytes,
      contentType: DOCX_MIME,
      isBinary: true,
      headers: {
        'Content-Disposition': `attachment; filename="document.docx"; filename*=UTF-8''${encodeURIComponent(docxFileName(record.title))}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    };
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
