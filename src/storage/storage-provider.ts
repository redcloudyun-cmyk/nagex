export interface ObjectMetadata {
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  checksum: string; // SHA-256 hex digest
  uploadedAt: string;
}

export interface StorageHealthResult {
  configured: boolean;
  reachable: boolean;
  endpointReachable?: boolean;
  bucketAuthorized?: boolean;
  readable?: boolean;
  writable?: boolean;
  bucket?: string;
  region?: string;
  mode: 'LIVE' | 'DEVELOPMENT' | 'OFFLINE';
}

export interface StorageProvider {
  putObject(key: string, data: Buffer | Uint8Array, mimeType: string): Promise<ObjectMetadata>;
  getObject(key: string): Promise<{ data: Buffer; metadata: ObjectMetadata } | null>;
  deleteObject(key: string): Promise<boolean>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  getSignedUploadUrl?(key: string, mimeType: string, expiresInSeconds?: number): Promise<string>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  getProviderName(): 'local' | 's3';
  checkHealth?(): Promise<StorageHealthResult>;
}
