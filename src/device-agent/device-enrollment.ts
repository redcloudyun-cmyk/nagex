// Enrollment of this PC as a device of the signed-in person: the step that was missing between "the server can enroll a device" and "this machine is one".
//
//   1. a key pair is generated HERE (Ed25519); the private key is written only to this machine's credential store and never leaves it
//   2. the public key is sent to POST /api/v1/device-agent/enroll with the person's own session - the server takes tenant and owner from that session, never from this request
//   3. the identity the server returns, together with the private key, is saved as the device credential
//
// Nothing here grants any authority beyond "this machine is a registered device of this person": commands still need an approval, and a revoked device is no longer accepted by the server.
import crypto from 'node:crypto';
import type { LocalDeviceCredentialRecord, LocalDeviceCredentialStore } from './local-device-credential.store.js';

export interface EnrollThisDeviceOptions {
  serverBaseUrl: string;
  /** the person's signed-in session id (the value of the nagex_session cookie) */
  sessionId: string;
  credentialStore: LocalDeviceCredentialStore;
  agentVersion: string;
  /** what this device can really do right now (truthful; may be empty) */
  capabilityInventory: string[];
  /** a device that is already enrolled is kept unless this is set */
  replaceExisting?: boolean;
  fetchFn?: typeof fetch;
}

export type EnrollThisDeviceResult =
  | { enrolled: true; deviceId: string; tenantId: string; ownerId: string }
  | { enrolled: false; reason: 'ALREADY_ENROLLED' | 'NOT_SIGNED_IN' | 'SERVER_REFUSED' | 'SERVER_UNREACHABLE' | 'INVALID_RESPONSE'; httpStatus?: number };

export async function enrollThisDevice(options: EnrollThisDeviceOptions): Promise<EnrollThisDeviceResult> {
  if (options.credentialStore.load() && !options.replaceExisting) return { enrolled: false, reason: 'ALREADY_ENROLLED' };
  if (!options.sessionId.trim()) return { enrolled: false, reason: 'NOT_SIGNED_IN' };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${options.serverBaseUrl}/api/v1/device-agent/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.sessionId}` },
      body: JSON.stringify({ publicKey: publicKeyPem, agentVersion: options.agentVersion, capabilityInventory: options.capabilityInventory }),
    });
  } catch {
    return { enrolled: false, reason: 'SERVER_UNREACHABLE' };
  }
  if (response.status === 401 || response.status === 403) return { enrolled: false, reason: 'NOT_SIGNED_IN', httpStatus: response.status };
  if (!response.ok) return { enrolled: false, reason: 'SERVER_REFUSED', httpStatus: response.status };

  let device: Record<string, unknown>;
  try { device = (await response.json()) as Record<string, unknown>; } catch { return { enrolled: false, reason: 'INVALID_RESPONSE' }; }
  const deviceId = typeof device.deviceId === 'string' ? device.deviceId : '';
  const tenantId = typeof device.tenantId === 'string' ? device.tenantId : '';
  const ownerId = typeof device.ownerId === 'string' ? device.ownerId : '';
  if (!deviceId || !tenantId || !ownerId) return { enrolled: false, reason: 'INVALID_RESPONSE' };

  const record: LocalDeviceCredentialRecord = { deviceId, tenantId, ownerId, privateKeyPem, agentVersion: options.agentVersion };
  options.credentialStore.save(record);
  return { enrolled: true, deviceId, tenantId, ownerId };
}
