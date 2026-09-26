import type { AuditLogger } from '../../governance/audit.logger.js';
import type { GoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import type { GoogleOAuthTokenStore } from '../../integrations/google/token.store.js';
import { CredentialBrokerService } from './credential-broker.service.js';
import type { CredentialReference } from './credential.types.js';

type FetchFn = typeof fetch;

export interface GoogleCredentialUseInput {
  tenantId: string;
  principalId: string;
  requiredScopes: string[];
  purpose: string;
  requestId: string;
  capabilityId?: string;
}

export class GoogleCredentialAccessService {
  private readonly credentialRefsByOwner = new Map<string, string>();

  constructor(
    private readonly tokenStore: GoogleOAuthTokenStore,
    private readonly broker: CredentialBrokerService,
    private readonly audit: AuditLogger,
    private readonly getConfig: (env?: NodeJS.ProcessEnv) => GoogleOAuthConfig | null,
    private readonly fetchFn: FetchFn,
  ) {}

  public async withAccessToken<TResult>(
    input: GoogleCredentialUseInput,
    use: (accessToken: string) => Promise<TResult>,
  ): Promise<TResult | null> {
    const config = this.getConfig();
    if (!config) return null;

    const reference = this.ensureReference(input.tenantId, input.principalId);
    if (!reference) return null;

    return this.broker.withCredential(
      {
        credentialRef: reference.credentialRef,
        tenantId: input.tenantId,
        principalId: input.principalId,
        provider: 'GOOGLE',
        requiredScopes: input.requiredScopes,
        purpose: input.purpose,
        requestId: input.requestId,
        capabilityId: input.capabilityId,
      },
      async () => this.tokenStore.getValidAccessTokenForPrincipal(
        input.tenantId,
        input.principalId,
        config,
        this.fetchFn,
        input.requestId,
      ),
      async ({ secret }) => use(secret),
    );
  }

  private ensureReference(tenantId: string, principalId: string): CredentialReference | null {
    const owner = `${tenantId}::${principalId}`;
    const existingRef = this.credentialRefsByOwner.get(owner);
    if (existingRef) {
      const existing = this.broker.getReference(existingRef, tenantId, principalId);
      if (existing) return existing;
      this.credentialRefsByOwner.delete(owner);
    }

    const status = this.tokenStore.getStatusForPrincipal(tenantId, principalId);
    if (!status.connected) return null;

    const reference = this.broker.registerReference({
      tenantId,
      principalId,
      provider: 'GOOGLE',
      credentialType: 'OAUTH',
      scopes: status.scopes,
      status: 'ACTIVE',
      // Access-token expiry is not credential expiry: the privileged token
      // store may refresh it with a refresh token during secret resolution.
      expiresAt: null,
    });
    this.credentialRefsByOwner.set(owner, reference.credentialRef);

    this.audit.logEvent({
      actor: { type: 'user', id: principalId },
      tenant_id: tenantId,
      action: 'credential.google_reference_bound',
      resource: { type: 'CredentialReference', id: reference.credentialRef },
      result: 'SUCCESS',
      request_id: `req_google_credential_bind_${Date.now()}`,
      details: { provider: 'GOOGLE', scopes: reference.scopes },
    });

    return reference;
  }
}
