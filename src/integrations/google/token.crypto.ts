import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;

// Versioned envelope persisted verbatim as the token file's JSON content.
export interface EncryptedEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string; // base64
  tag: string; // base64 (GCM authentication tag)
  ciphertext: string; // base64
}

// Accepts NAGEX_TOKEN_ENCRYPTION_KEY as base64 (e.g. `openssl rand -base64 32`)
// or 64-char hex, and validates it decodes to exactly 32 bytes (AES-256).
// Returns null (never throws) on anything else, so callers can fail closed to
// "persistence disabled" rather than crash on a bad key.
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.NAGEX_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  try {
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

export function encryptJson(key: Buffer, value: unknown): EncryptedEnvelope {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// Throws (GCM authentication failure, or an unsupported/mismatched algorithm)
// if `key` is wrong or the envelope was tampered with — callers must treat
// any thrown error as "cannot decrypt" and fail closed.
export function decryptJson<T>(key: Buffer, envelope: EncryptedEnvelope): T {
  if (envelope.algorithm !== ALGORITHM) {
    throw new Error(`unsupported encryption algorithm: ${String(envelope.algorithm)}`);
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
