// DC3-B1 — the shared wire protocol between the Local Device Agent client
// and the server-side transport endpoint. Layers strictly ON TOP of DC3-A's
// existing, unchanged DeviceSignedEnvelope — commandType/executionSessionId/
// data travel inside `payload`, which DeviceTransportSecurity.verify()
// already hashes and (transitively, via the signature) authenticates. No
// change to DeviceSignedEnvelope, canonicalEnvelopeSigningBytes, or
// hashCanonicalPayload was needed or made.
//
// Section 9's command allowlist is enforced structurally here: this union
// IS the allowlist. CLICK/TYPE/KEYPRESS/OPEN_APP/shell/PowerShell/arbitrary
// process launch do not exist in this type at all — they belong to a later
// slice, once execution architecture is proven.
//
// R23.6M Phase C adds exactly the three mobile-message commands deferred
// since Phase B1 — never a generic device-action vocabulary. Each one maps
// to exactly one MobileMessageRunService method and nothing else:
//   MOBILE_MESSAGE_PREPARE -> prepareForExecution() (read-only; no
//     approval consumption, no send)
//   MOBILE_MESSAGE_EXECUTE -> executeApproved() (the one moment the
//     approval is consumed; the device is not yet told to actually invoke
//     SmsManager until this returns success)
//   MOBILE_MESSAGE_STATUS  -> reportSendResult()/reportDeliveryConfirmed()
//     (the device's own honest report of what SmsManager actually did —
//     never inferred from EXECUTE having returned OK)
export type DeviceAgentCommandType =
  | 'CONNECT' | 'DISCONNECT' | 'HEARTBEAT' | 'PING' | 'SESSION_OPEN' | 'SESSION_CLOSE' | 'CANCEL' | 'STATUS' | 'ACK'
  | 'MOBILE_MESSAGE_PREPARE' | 'MOBILE_MESSAGE_EXECUTE' | 'MOBILE_MESSAGE_STATUS'
  | 'MESSAGING_HANDOFF_AUTHORIZE' | 'MESSAGING_HANDOFF_STARTED' | 'MESSAGING_HANDOFF_UNAVAILABLE'
  | 'ACCESSIBILITY_EXECUTE_PLAN';

const VALID_COMMAND_TYPES: ReadonlySet<string> = new Set<DeviceAgentCommandType>([
  'CONNECT', 'DISCONNECT', 'HEARTBEAT', 'PING', 'SESSION_OPEN', 'SESSION_CLOSE', 'CANCEL', 'STATUS', 'ACK',
  'MOBILE_MESSAGE_PREPARE', 'MOBILE_MESSAGE_EXECUTE', 'MOBILE_MESSAGE_STATUS',
  'MESSAGING_HANDOFF_AUTHORIZE', 'MESSAGING_HANDOFF_STARTED', 'MESSAGING_HANDOFF_UNAVAILABLE',
  'ACCESSIBILITY_EXECUTE_PLAN',
]);

// Section 3 — "receive bounded command envelope... verify server-issued
// command context... acknowledge." Rather than building real
// request-holding blocking long-poll machinery (a real dependency/timeout-
// management cost not justified for a foundation slice), a pending
// server-queued command piggybacks on the agent's own regular HEARTBEAT
// response — a short-poll variant that still gets a bounded-latency,
// outbound-only, zero-new-dependency delivery path. The agent verifies
// this actually matches its own identity before acting on it.
export interface DevicePendingCommand {
  commandId: string;
  commandType: DeviceAgentCommandType;
  deviceId: string;
  tenantId: string;
  ownerId: string;
  executionSessionId: string | null;
  data: Record<string, unknown>;
  queuedAt: string;
}

export interface DeviceAgentCommandPayload {
  commandType: DeviceAgentCommandType;
  // Only meaningful for SESSION_CLOSE/CANCEL/STATUS — null for
  // CONNECT/HEARTBEAT/PING/SESSION_OPEN, which don't yet reference one.
  executionSessionId: string | null;
  data: Record<string, unknown>;
}

export function isDeviceAgentCommandPayload(value: unknown): value is DeviceAgentCommandPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.commandType !== 'string' || !VALID_COMMAND_TYPES.has(v.commandType)) return false;
  if (v.executionSessionId !== null && typeof v.executionSessionId !== 'string') return false;
  if (!v.data || typeof v.data !== 'object' || Array.isArray(v.data)) return false;
  return true;
}
