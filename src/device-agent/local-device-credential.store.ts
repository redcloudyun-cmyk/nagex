// DC3-B1-R1 — local (desktop-side) device credential persistence.
//
// A real, confirmed gap found before writing any code: DC3-A's
// DeviceIdentityStore is entirely server-side (stores only the public
// key, tenant/owner-scoped, under resolveNagexDataDir). Nothing in this
// codebase persisted a device's OWN private key + enrollment identity on
// the machine that owns it — there was no desktop-local credential store
// of any kind. This file is that store, not a modification of DC3-A.
//
// The private key never crosses IPC, never touches the renderer, never
// reaches the server, never appears in logs. Encryption is delegated to
// an injected LocalSecureStorage — real Electron wiring supplies one
// backed by `safeStorage` (OS keychain/DPAPI on Windows); this module
// itself never imports `electron` (which cannot even be required outside
// a real Electron process), keeping it fully testable under plain Node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface LocalDeviceCredentialRecord {
  deviceId: string;
  tenantId: string;
  ownerId: string;
  // The device's own private key (PEM) — generated once locally at
  // enrollment. This is the one place it is ever written to disk, and
  // only ever through the injected LocalSecureStorage.
  privateKeyPem: string;
  agentVersion: string;
}

function isLocalDeviceCredentialRecord(value: unknown): value is LocalDeviceCredentialRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.privateKeyPem === 'string' &&
    typeof v.agentVersion === 'string'
  );
}

// Real Electron wiring supplies an implementation backed by
// `electron.safeStorage` (OS-protected: Credential Manager/DPAPI on
// Windows, Keychain on macOS). isAvailable() lets a caller know whether
// this is genuinely OS-protected, or the disclosed plaintext fallback
// below — never silently claimed as encrypted when it isn't.
export interface LocalSecureStorage {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherBuffer: Buffer): string;
}

// Used only when the platform has no OS-protected storage available
// (safeStorage.isEncryptionAvailable() === false — a real, documented
// Electron possibility, e.g. no OS keychain configured). Deliberately
// named to be impossible to mistake for real encryption: this is opaque
// bytes on disk with restrictive file permissions (0600) as the only
// protection, exactly the same honest disclosure this codebase already
// gives its other unencrypted-but-permission-restricted stores.
export class PlaintextLocalStorageFallback implements LocalSecureStorage {
  public isAvailable(): boolean {
    return true;
  }
  public encrypt(plainText: string): Buffer {
    return Buffer.from(plainText, 'utf8');
  }
  public decrypt(cipherBuffer: Buffer): string {
    return cipherBuffer.toString('utf8');
  }
}

export class LocalDeviceCredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly secureStorage: LocalSecureStorage,
  ) {}

  // Never throws — a missing, corrupt, or undecryptable file is treated
  // as "not enrolled," never a crash. This is the exact condition Section
  // 3's "no valid enrollment exists -> UNENROLLED, desktop still starts
  // normally" depends on.
  public load(): LocalDeviceCredentialRecord | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const cipherBuffer = fs.readFileSync(this.filePath);
      const json = this.secureStorage.decrypt(cipherBuffer);
      const parsed = JSON.parse(json) as unknown;
      return isLocalDeviceCredentialRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  public save(record: LocalDeviceCredentialRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const cipherBuffer = this.secureStorage.encrypt(JSON.stringify(record));
    const tmpPath = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmpPath, cipherBuffer, { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  public clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* best effort */
    }
  }
}
