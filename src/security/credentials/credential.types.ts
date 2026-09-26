export type CredentialStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'UNAVAILABLE';

export interface CredentialReference {
  credentialRef: string;
  tenantId: string;
  principalId: string;
  provider: string;
  credentialType: string;
  scopes: string[];
  status: CredentialStatus;
  createdAt: string;
  expiresAt: string | null;
  allowedOrigins?: string[];
  allowedCapabilities?: string[];
}

export interface CredentialUseRequest {
  credentialRef: string;
  tenantId: string;
  principalId: string;
  provider: string;
  requiredScopes: string[];
  purpose: string;
  requestId: string;
  capabilityId?: string;
  origin?: string;
}

export interface CredentialLease {
  leaseId: string;
  credentialRef: string;
  provider: string;
  expiresAt: string;
  scopes: string[];
  capabilityId?: string;
  origin?: string;
}

export interface CredentialInjectionContext<TSecret> {
  lease: CredentialLease;
  secret: TSecret;
}

export type CredentialSecretResolver<TSecret> = (
  reference: CredentialReference,
  request: CredentialUseRequest,
) => Promise<TSecret | null>;
