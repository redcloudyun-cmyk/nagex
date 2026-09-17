// R16 — short-lived, one-time SSO handshake state: OIDC state/nonce/PKCE
// code_verifier (§10/§55) and SAML AuthnRequest id + accepted response/
// assertion ids for replay protection (§54/§55). Same FileRecordStore +
// sha256-before-store pattern as tests/... no — as
// src/identity/identity.tokens.ts (this codebase's own template for
// "hashed, one-time, expiring" records), but deliberately a SEPARATE
// store rather than an extension of IdentityTokenStore: these records are
// not tied to an existing userId (issued before authentication completes)
// and are organization/provider-scoped rather than user-scoped.
import crypto from 'node:crypto';
import path from 'node:path';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { generateResourceId } from '../common/utils.js';

export interface OidcFlowStateRecord {
  flowStateId: string;
  organizationId: string;
  providerId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  samlAuthnRequestId?: string; // set only by createSamlFlowState — this same record type/store is reused for SAML's RelayState + InResponseTo tracking rather than a parallel duplicate store
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface SamlReplayRecord {
  replayId: string; // the SAML Response/Assertion ID being tracked
  organizationId: string;
  providerId: string;
  createdAt: string;
  expiresAt: string;
}

function isOidcFlowStateRecord(value: unknown): value is OidcFlowStateRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.flowStateId === 'string' && typeof v.state === 'string' && typeof v.nonce === 'string' && typeof v.expiresAt === 'string';
}

function isSamlReplayRecord(value: unknown): value is SamlReplayRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.replayId === 'string' && typeof v.expiresAt === 'string';
}

const DEFAULT_OIDC_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the redirect round trip
const DEFAULT_SAML_REPLAY_TTL_MS = 24 * 60 * 60 * 1000; // remember accepted assertion ids for 24h

export class SsoFlowStore {
  private readonly flowStates: FileRecordStore<OidcFlowStateRecord>;
  private readonly samlReplays: FileRecordStore<SamlReplayRecord>;
  private readonly now: () => number;

  constructor(options: { dir?: string; env?: NodeJS.ProcessEnv; now?: () => number } = {}) {
    const baseDir = options.dir ?? resolveNagexDataDir('sso-flow', 'NAGEX_SSO_FLOW_DIR', options.env);
    this.flowStates = new FileRecordStore<OidcFlowStateRecord>(path.join(baseDir, 'oidc-flow-states'), isOidcFlowStateRecord);
    this.samlReplays = new FileRecordStore<SamlReplayRecord>(path.join(baseDir, 'saml-replays'), isSamlReplayRecord);
    this.now = options.now ?? Date.now;
  }

  // R16 SAML — a RelayState value (reusing the `state` field) plus the
  // AuthnRequest id (needed to validate InResponseTo on the ACS callback)
  // is persisted up front, in ONE write, rather than created-then-mutated
  // — FileRecordStore has no in-memory mirror at this layer, so a
  // caller-side mutation of the object returned by createOidcFlowState()
  // would never actually persist and would be silently lost by the time
  // consumeOidcFlowState() re-reads from disk.
  public createSamlFlowState(organizationId: string, providerId: string, acsUrl: string, authnRequestId: string, ttlMs = DEFAULT_OIDC_FLOW_TTL_MS): OidcFlowStateRecord {
    const record: OidcFlowStateRecord = {
      flowStateId: generateResourceId('flw'),
      organizationId,
      providerId,
      state: crypto.randomBytes(24).toString('hex'),
      nonce: crypto.randomBytes(24).toString('hex'),
      codeVerifier: '',
      redirectUri: acsUrl,
      samlAuthnRequestId: authnRequestId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
      consumedAt: null,
    };
    this.flowStates.write(record.flowStateId, record);
    return record;
  }

  public createOidcFlowState(organizationId: string, providerId: string, redirectUri: string, ttlMs = DEFAULT_OIDC_FLOW_TTL_MS): OidcFlowStateRecord {
    const record: OidcFlowStateRecord = {
      flowStateId: generateResourceId('flw'),
      organizationId,
      providerId,
      state: crypto.randomBytes(24).toString('hex'),
      nonce: crypto.randomBytes(24).toString('hex'),
      codeVerifier: crypto.randomBytes(32).toString('base64url'),
      redirectUri,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
      consumedAt: null,
    };
    this.flowStates.write(record.flowStateId, record);
    return record;
  }

  // R16 §10/§55 — state is one-time: a matching record is returned at
  // most once, and only if unconsumed and unexpired. Marks it consumed
  // immediately (even on a validation failure downstream) so a replayed
  // callback with the same ?state= can never succeed twice.
  public consumeOidcFlowState(state: string): OidcFlowStateRecord | null {
    const record = this.flowStates.readAll().find((r) => r.state === state);
    if (!record) return null;
    if (record.consumedAt) return null;
    if (new Date(record.expiresAt).getTime() <= this.now()) return null;
    record.consumedAt = new Date(this.now()).toISOString();
    this.flowStates.write(record.flowStateId, record);
    return record;
  }

  // R16 §54 — SAML replay protection: an assertion/response id, once
  // accepted, can never be accepted again within the retention window.
  // Returns true (and records it) only the first time; every subsequent
  // call for the same id returns false.
  public recordSamlResponseIdIfNew(organizationId: string, providerId: string, responseId: string, ttlMs = DEFAULT_SAML_REPLAY_TTL_MS): boolean {
    const existing = this.samlReplays.read(responseId);
    if (existing && new Date(existing.expiresAt).getTime() > this.now()) return false;
    this.samlReplays.write(responseId, {
      replayId: responseId,
      organizationId,
      providerId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
    });
    return true;
  }
}
