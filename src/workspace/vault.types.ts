// R18 — Vault Domain Types
export type VaultItemType =
  | 'FILE'
  | 'IMAGE'
  | 'DOCUMENT'
  | 'LINK'
  | 'CREATED_OUTPUT'
  | 'REFERENCE_ASSET'
  | 'SAVED_ANALYSIS';

export interface VaultItem {
  vaultItemId: string;
  userId: string;
  tenantId: string;
  workspaceId: string;
  type: VaultItemType;
  title: string;
  mimeType: string;
  storageRef: string;
  source: string;
  sourceRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SaveVaultItemParams {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  type: VaultItemType;
  title: string;
  mimeType?: string;
  storageRef: string;
  source?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}
