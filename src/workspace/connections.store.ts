// R18 — Connected Apps Store
import crypto from 'node:crypto';
import type { AppConnectionRecord, ConnectionProvider, UpdateConnectionParams } from './connections.types.js';

export class ConnectionStore {
  private readonly connections: Map<string, AppConnectionRecord> = new Map();

  private makeKey(tenantId: string, userId: string, provider: ConnectionProvider): string {
    return `${tenantId}:${userId}:${provider}`;
  }

  public getOrCreateConnection(tenantId: string, userId: string, provider: ConnectionProvider): AppConnectionRecord {
    const key = this.makeKey(tenantId, userId, provider);
    const existing = this.connections.get(key);
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: AppConnectionRecord = {
      connectionId: `conn_${crypto.randomUUID()}`,
      tenantId,
      userId,
      provider,
      status: 'DISCONNECTED',
      createdAt: now,
      updatedAt: now,
    };

    this.connections.set(key, record);
    return record;
  }

  public updateConnection(params: UpdateConnectionParams): AppConnectionRecord {
    const record = this.getOrCreateConnection(params.tenantId, params.userId, params.provider);
    const now = new Date().toISOString();

    if (params.status) record.status = params.status;
    if (params.accountEmail !== undefined) record.accountEmail = params.accountEmail;
    if (params.accountName !== undefined) record.accountName = params.accountName;
    if (params.syncCursor !== undefined) record.syncCursor = params.syncCursor;
    if (params.lastError !== undefined) record.lastError = params.lastError;
    record.updatedAt = now;

    return record;
  }

  public disconnect(tenantId: string, userId: string, provider: ConnectionProvider): AppConnectionRecord {
    const record = this.getOrCreateConnection(tenantId, userId, provider);
    const now = new Date().toISOString();

    record.status = 'DISCONNECTED';
    record.syncStatus = 'IDLE';
    record.syncCursor = undefined;
    record.lastError = undefined;
    record.updatedAt = now;

    return record;
  }

  public listConnections(tenantId: string, userId: string): AppConnectionRecord[] {
    const providers: ConnectionProvider[] = ['google', 'microsoft', 'slack', 'telegram'];
    return providers.map((p) => this.getOrCreateConnection(tenantId, userId, p));
  }
}
