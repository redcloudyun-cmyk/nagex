// Owner-bound encrypted OAuth credential vault primitive for MCP.
// Prepared for a future transactional durable backend. This in-memory class is
// intentionally NOT a production persistence claim. Only encrypted envelopes
// may be exported to a persistence layer; tokens are never exposed by list().
import crypto from 'node:crypto';
import { decryptJson, encryptJson, loadEncryptionKey, type EncryptedEnvelope } from '../integrations/google/token.crypto.js';
import type { McpOAuthTokens } from './mcp-oauth-token.js';

export interface McpOAuthCredentialIdentity {
  tenantId: string;
  principalId: string;
  resource: string;
  issuer: string;
  clientId: string;
}

export interface McpOAuthStoredCredential {
  identity: McpOAuthCredentialIdentity;
  tokens: McpOAuthTokens;
  storedAt: number;
}

export interface SealedCredential {
  id: string;
  identity: McpOAuthCredentialIdentity;
  envelope: EncryptedEnvelope;
}

function keyFor(identity: McpOAuthCredentialIdentity): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    identity.tenantId, identity.principalId, identity.resource, identity.issuer, identity.clientId,
  ])).digest('hex');
}

function validIdentity(identity: McpOAuthCredentialIdentity): boolean {
  return !!identity && [identity.tenantId, identity.principalId, identity.resource, identity.issuer, identity.clientId]
    .every((v) => typeof v === 'string' && v.length > 0);
}

export class McpOAuthCredentialVault {
  private readonly key: Buffer;
  private readonly records = new Map<string, SealedCredential>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const key = loadEncryptionKey(env);
    if (!key) throw new Error('MCP_OAUTH_ENCRYPTION_REQUIRED');
    this.key = key;
  }

  public save(identity: McpOAuthCredentialIdentity, tokens: McpOAuthTokens, now: number = Date.now()): void {
    if (!validIdentity(identity) || tokens?.tokenType !== 'Bearer' || !tokens.accessToken) throw new Error('MCP_OAUTH_INVALID_CREDENTIAL');
    const id = keyFor(identity);
    // Encrypt identity *inside* the authenticated payload, so a substituted
    // envelope cannot be rebound to a different tenant or resource.
    const encrypted = encryptJson(this.key, { identity: { ...identity }, tokens: { ...tokens }, storedAt: now });
    this.records.set(id, { id, identity: { ...identity }, envelope: encrypted });
  }

  public load(identity: McpOAuthCredentialIdentity): McpOAuthStoredCredential | null {
    if (!validIdentity(identity)) return null;
    const record = this.records.get(keyFor(identity));
    if (!record) return null;
    let decoded: McpOAuthStoredCredential;
    try {
      decoded = decryptJson<McpOAuthStoredCredential>(this.key, record.envelope);
    } catch {
      throw new Error('MCP_OAUTH_CREDENTIAL_INTEGRITY_ERROR');
    }
    if (!decoded?.identity || keyFor(decoded.identity) !== record.id || keyFor(decoded.identity) !== keyFor(identity)) {
      throw new Error('MCP_OAUTH_CREDENTIAL_OWNER_MISMATCH');
    }
    return decoded;
  }

  // Transactional replacement of an encrypted snapshot. Verify every entry with
  // authenticated decryption BEFORE mutating the live map. A corrupted file or
  // wrong key never becomes an empty/partially-loaded "connected" state.
  public restoreSealedSnapshot(snapshot: unknown): void {
    if (!Array.isArray(snapshot) || snapshot.length > 10000) throw new Error('MCP_OAUTH_SNAPSHOT_INVALID');
    const checked = new Map<string, SealedCredential>();
    for (const raw of snapshot) {
      if (!raw || typeof raw !== 'object') throw new Error('MCP_OAUTH_SNAPSHOT_INVALID');
      const record = raw as SealedCredential;
      if (!validIdentity(record.identity) || record.id !== keyFor(record.identity) || checked.has(record.id) ||
          !record.envelope || record.envelope.version !== 1 || record.envelope.algorithm !== 'aes-256-gcm') {
        throw new Error('MCP_OAUTH_SNAPSHOT_INVALID');
      }
      let decoded: McpOAuthStoredCredential;
      try { decoded = decryptJson<McpOAuthStoredCredential>(this.key, record.envelope); }
      catch { throw new Error('MCP_OAUTH_CREDENTIAL_INTEGRITY_ERROR'); }
      if (!decoded?.identity || !validIdentity(decoded.identity) || keyFor(decoded.identity) !== record.id ||
          decoded.tokens?.tokenType !== 'Bearer' || !decoded.tokens.accessToken) {
        throw new Error('MCP_OAUTH_CREDENTIAL_INTEGRITY_ERROR');
      }
      checked.set(record.id, { id: record.id, identity: { ...record.identity }, envelope: { ...record.envelope } });
    }
    this.records.clear();
    for (const [id, record] of checked) this.records.set(id, record);
  }

  public remove(identity: McpOAuthCredentialIdentity): boolean {
    return validIdentity(identity) ? this.records.delete(keyFor(identity)) : false;
  }

  // This snapshot contains only encrypted envelopes plus non-secret owner keys.
  // The caller must provide atomic, access-controlled persistence if durable storage is needed.
  public sealedSnapshot(): ReadonlyArray<SealedCredential> {
    return [...this.records.values()].map((record) => ({
      id: record.id, identity: { ...record.identity }, envelope: { ...record.envelope },
    }));
  }
}
