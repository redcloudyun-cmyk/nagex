import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type {
  CredentialInjectionContext,
  CredentialLease,
  CredentialReference,
  CredentialSecretResolver,
  CredentialUseRequest,
} from './credential.types.js';

function uniqueScopes(scopes: string[]): string[] {
  return [...new Set(scopes.filter((scope) => typeof scope === 'string' && scope.trim()).map((scope) => scope.trim()))].sort();
}

function cloneReference(reference: CredentialReference): CredentialReference {
  return {
    ...reference,
    scopes: [...reference.scopes],
    allowedOrigins: reference.allowedOrigins ? [...reference.allowedOrigins] : undefined,
    allowedCapabilities: reference.allowedCapabilities ? [...reference.allowedCapabilities] : undefined,
  };
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return origin.trim().replace(/\/$/, '').toLowerCase();
  }
}

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].sort();
}

export class CredentialBrokerService {
  private readonly references = new Map<string, CredentialReference>();

  constructor(
    private readonly audit: AuditLogger,
    private readonly now: () => number = Date.now,
  ) {}

  public registerReference(input: Omit<CredentialReference, 'credentialRef' | 'createdAt' | 'scopes'> & { scopes: string[] }): CredentialReference {
    if (!input.tenantId || !input.principalId || !input.provider || !input.credentialType) {
      throw new NagexError({
        code: 'CREDENTIAL_REFERENCE_INVALID',
        category: 'VALIDATION',
        message: 'Credential tenant, principal, provider, and type are required.',
      });
    }

    const reference: CredentialReference = {
      ...input,
      credentialRef: `cred_${crypto.randomUUID()}`,
      scopes: uniqueScopes(input.scopes),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: input.expiresAt ?? null,
      allowedOrigins: uniqueStrings(input.allowedOrigins)?.map(normalizeOrigin),
      allowedCapabilities: uniqueStrings(input.allowedCapabilities),
    };

    this.references.set(reference.credentialRef, reference);
    this.audit.logEvent({
      actor: { type: 'user', id: reference.principalId },
      tenant_id: reference.tenantId,
      action: 'credential.registered',
      resource: { type: 'CredentialReference', id: reference.credentialRef },
      result: 'SUCCESS',
      request_id: `req_credential_register_${crypto.randomUUID()}`,
      details: {
        provider: reference.provider,
        credentialType: reference.credentialType,
        scopes: reference.scopes,
        status: reference.status,
        allowedOrigins: reference.allowedOrigins,
        allowedCapabilities: reference.allowedCapabilities,
      },
    });
    return cloneReference(reference);
  }

  public getReference(credentialRef: string, tenantId: string, principalId: string): CredentialReference | undefined {
    const reference = this.references.get(credentialRef);
    if (!reference || reference.tenantId !== tenantId || reference.principalId !== principalId) return undefined;
    return cloneReference(reference);
  }

  public revokeReference(credentialRef: string, tenantId: string, principalId: string, requestId: string): CredentialReference {
    const reference = this.requireOwnedReference(credentialRef, tenantId, principalId, requestId);
    reference.status = 'REVOKED';
    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'credential.revoked',
      resource: { type: 'CredentialReference', id: credentialRef },
      result: 'SUCCESS',
      request_id: requestId,
      details: { provider: reference.provider, credentialType: reference.credentialType },
    });
    return cloneReference(reference);
  }

  public async withCredential<TSecret, TResult>(
    request: CredentialUseRequest,
    resolveSecret: CredentialSecretResolver<TSecret>,
    use: (context: CredentialInjectionContext<TSecret>) => Promise<TResult>,
  ): Promise<TResult> {
    const reference = this.authorize(request);
    this.audit.logEvent({
      actor: { type: 'user', id: request.principalId },
      tenant_id: request.tenantId,
      action: 'credential.use_allowed',
      resource: { type: 'CredentialReference', id: reference.credentialRef },
      result: 'SUCCESS',
      request_id: request.requestId,
      details: {
        provider: reference.provider,
        credentialType: reference.credentialType,
        scopes: request.requiredScopes,
        capabilityId: request.capabilityId,
        purpose: request.purpose,
      },
    });

    const secret = await resolveSecret(reference, request);
    if (secret === null || secret === undefined) {
      this.audit.logEvent({
        actor: { type: 'user', id: request.principalId },
        tenant_id: request.tenantId,
        action: 'credential.use_denied',
        resource: { type: 'CredentialReference', id: reference.credentialRef },
        result: 'DENIED',
        reason_code: 'CREDENTIAL_UNAVAILABLE',
        request_id: request.requestId,
        details: { provider: reference.provider, capabilityId: request.capabilityId },
      });
      throw new NagexError({
        code: 'CREDENTIAL_UNAVAILABLE',
        category: 'AUTHENTICATION',
        message: 'The requested credential is unavailable.',
        request_id: request.requestId,
      });
    }

    const lease: CredentialLease = {
      leaseId: `lease_${crypto.randomUUID()}`,
      credentialRef: reference.credentialRef,
      provider: reference.provider,
      expiresAt: new Date(this.now() + 60_000).toISOString(),
      scopes: [...request.requiredScopes],
      capabilityId: request.capabilityId,
      origin: request.origin ? normalizeOrigin(request.origin) : undefined,
    };

    // This is the only point where the secret is materialized. It is passed
    // directly to the privileged provider callback and is never stored in a
    // lease/reference/audit object or returned by the broker itself.
    return use({ lease, secret });
  }

  private authorize(request: CredentialUseRequest): CredentialReference {
    const reference = this.requireOwnedReference(request.credentialRef, request.tenantId, request.principalId, request.requestId);

    if (reference.provider !== request.provider) {
      return this.deny(request, reference, 'CREDENTIAL_PROVIDER_MISMATCH');
    }
    if (reference.status !== 'ACTIVE') {
      return this.deny(request, reference, reference.status === 'REVOKED' ? 'CREDENTIAL_REVOKED' : 'CREDENTIAL_UNAVAILABLE');
    }
    if (reference.expiresAt && new Date(reference.expiresAt).getTime() <= this.now()) {
      return this.deny(request, reference, 'CREDENTIAL_EXPIRED');
    }

    const granted = new Set(reference.scopes);
    if (uniqueScopes(request.requiredScopes).some((scope) => !granted.has(scope))) {
      return this.deny(request, reference, 'CREDENTIAL_SCOPE_MISSING');
    }

    if (reference.allowedCapabilities && reference.allowedCapabilities.length > 0) {
      if (!request.capabilityId || !reference.allowedCapabilities.includes(request.capabilityId)) {
        return this.deny(request, reference, 'CREDENTIAL_CAPABILITY_NOT_ALLOWED');
      }
    }

    if (reference.allowedOrigins && reference.allowedOrigins.length > 0) {
      if (!request.origin || !reference.allowedOrigins.includes(normalizeOrigin(request.origin))) {
        return this.deny(request, reference, 'CREDENTIAL_ORIGIN_NOT_ALLOWED');
      }
    }

    return reference;
  }

  private requireOwnedReference(credentialRef: string, tenantId: string, principalId: string, requestId: string): CredentialReference {
    const reference = this.references.get(credentialRef);
    if (!reference || reference.tenantId !== tenantId || reference.principalId !== principalId) {
      throw new NagexError({
        code: 'CREDENTIAL_NOT_FOUND',
        category: 'NOT_FOUND',
        message: 'Credential not found.',
        request_id: requestId,
      });
    }
    return reference;
  }

  private deny(request: CredentialUseRequest, reference: CredentialReference, code: string): never {
    this.audit.logEvent({
      actor: { type: 'user', id: request.principalId },
      tenant_id: request.tenantId,
      action: 'credential.use_denied',
      resource: { type: 'CredentialReference', id: reference.credentialRef },
      result: 'DENIED',
      reason_code: code,
      request_id: request.requestId,
      details: { provider: request.provider, capabilityId: request.capabilityId },
    });
    throw new NagexError({
      code,
      category: 'AUTHORIZATION',
      message: 'Credential use is not authorized.',
      request_id: request.requestId,
    });
  }
}
