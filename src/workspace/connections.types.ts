// R18 — Connected Apps & Integration Status Types
export type ConnectionProvider = 'google' | 'microsoft' | 'slack' | 'telegram';
export type ConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'NEEDS_REAUTHENTICATION' | 'ERROR';

export interface AppConnectionRecord {
  connectionId: string;
  tenantId: string;
  userId: string;
  provider: ConnectionProvider;
  status: ConnectionStatus;
  accountEmail?: string;
  accountName?: string;
  lastSyncAt?: string;
  syncStatus?: 'IDLE' | 'SYNCING' | 'SUCCESS' | 'FAILED';
  syncCursor?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateConnectionParams {
  tenantId: string;
  userId: string;
  provider: ConnectionProvider;
  status?: ConnectionStatus;
  accountEmail?: string;
  accountName?: string;
  syncCursor?: string;
  lastError?: string;
}
