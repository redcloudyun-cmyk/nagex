// Security Gate S2A — authenticity of inbound channel webhooks (Telegram, Slack).
//
// AUTHENTICITY BEFORE TRUST. A webhook request is not an authenticated caller; it is an HTTP request that claims to come
// from Telegram or Slack. Nothing in it (sender id, chat, team, text) may reach identity lookup, conversation or memory
// writes, the model, or any tool until the request proves it came from the platform:
//
//   Telegram  the secret_token configured through setWebhook is echoed by Telegram in X-Telegram-Bot-Api-Secret-Token.
//   Slack     X-Slack-Signature = v0=HMAC-SHA256(signing secret, "v0:" + X-Slack-Request-Timestamp + ":" + RAW body),
//             and the timestamp must be recent (replay-age bound).
//
// The secrets come ONLY from server configuration (TELEGRAM_WEBHOOK_SECRET, SLACK_SIGNING_SECRET — the same environment
// mechanism as TELEGRAM_BOT_TOKEN / SLACK_BOT_TOKEN). Fail closed: a missing or unusable secret never means "verification
// off"; every request is refused until the operator configures it. Secrets are compared in constant time, are never put in
// a response and never logged; a rejection is reported to the caller as one generic error and to the operator as a reason
// code only.
import crypto from 'node:crypto';
import type { ApiResult } from '../http/http-types.js';

type Headers = Record<string, string | string[] | undefined>;

export const TELEGRAM_WEBHOOK_SECRET_ENV = 'TELEGRAM_WEBHOOK_SECRET';
export const SLACK_SIGNING_SECRET_ENV = 'SLACK_SIGNING_SECRET';
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';
export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
// Slack's documented replay window.
export const SLACK_MAX_AGE_SECONDS = 300;

// Telegram's own constraint on secret_token: 1-256 characters of A-Z a-z 0-9 _ -
const TELEGRAM_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SLACK_TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const SLACK_SIGNATURE_PATTERN = /^v0=[0-9a-fA-F]{64}$/;

export type WebhookRejectReason =
  | 'SECRET_NOT_CONFIGURED'
  | 'SECRET_MISCONFIGURED'
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_MALFORMED'
  | 'CREDENTIAL_AMBIGUOUS'
  | 'CREDENTIAL_MISMATCH'
  | 'TIMESTAMP_MISSING'
  | 'TIMESTAMP_MALFORMED'
  | 'TIMESTAMP_STALE'
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_MISMATCH'
  | 'BODY_UNAVAILABLE';

export type WebhookVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: WebhookRejectReason };

const reject = (reason: WebhookRejectReason, status: 401 | 503 = 401): WebhookVerdict => ({ ok: false, status, reason });

// Case-insensitive single-valued header lookup. Two spellings of the same header, or an array value, are ambiguous.
function singleHeader(headers: Headers, name: string): { state: 'missing' } | { state: 'ambiguous' } | { state: 'ok'; value: string } {
  const found: Array<string | string[] | undefined> = [];
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) found.push(headers[key]);
  if (found.length === 0) return { state: 'missing' };
  if (found.length > 1) return { state: 'ambiguous' };
  const value = found[0];
  if (value === undefined) return { state: 'missing' };
  if (Array.isArray(value)) return value.length === 1 ? { state: 'ok', value: value[0] } : { state: 'ambiguous' };
  return { state: 'ok', value };
}

// Constant-time comparison independent of the operands' lengths (both sides are hashed to a fixed width first).
function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyTelegramWebhook(headers: Headers, env: NodeJS.ProcessEnv = process.env): WebhookVerdict {
  const configured = env[TELEGRAM_WEBHOOK_SECRET_ENV];
  if (!configured) return reject('SECRET_NOT_CONFIGURED', 503);
  if (!TELEGRAM_SECRET_PATTERN.test(configured)) return reject('SECRET_MISCONFIGURED', 503);

  const header = singleHeader(headers, TELEGRAM_SECRET_HEADER);
  if (header.state === 'missing') return reject('CREDENTIAL_MISSING');
  if (header.state === 'ambiguous') return reject('CREDENTIAL_AMBIGUOUS');
  if (!TELEGRAM_SECRET_PATTERN.test(header.value)) return reject(header.value === '' ? 'CREDENTIAL_MISSING' : 'CREDENTIAL_MALFORMED');
  return constantTimeEquals(header.value, configured) ? { ok: true } : reject('CREDENTIAL_MISMATCH');
}

// Replay guard for requests that PASSED signature verification: the same signed delivery is processed once. A bounded,
// in-process cache (entries expire with the replay window). It never admits anything — it only refuses a repeat — so it
// is not part of the authenticity decision, and an attacker cannot fill it without a valid signature.
export class SignedRequestReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number = SLACK_MAX_AGE_SECONDS * 1000, private readonly maxEntries: number = 10_000) {}

  // true when this signature was already accepted inside the window.
  public checkAndRemember(signature: string, now: number = Date.now()): boolean {
    for (const [sig, at] of this.seen) {
      if (now - at <= this.ttlMs) break;
      this.seen.delete(sig);
    }
    if (this.seen.has(signature)) return true;
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(signature, now);
    return false;
  }
}

export interface SlackVerifyOptions {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  maxAgeSeconds?: number;
}

export function verifySlackWebhook(headers: Headers, rawBody: Buffer | undefined, options: SlackVerifyOptions = {}): WebhookVerdict & { signature?: string } {
  const env = options.env ?? process.env;
  const secret = env[SLACK_SIGNING_SECRET_ENV];
  if (!secret) return reject('SECRET_NOT_CONFIGURED', 503);

  const ts = singleHeader(headers, SLACK_TIMESTAMP_HEADER);
  if (ts.state === 'missing') return reject('TIMESTAMP_MISSING');
  if (ts.state === 'ambiguous' || !SLACK_TIMESTAMP_PATTERN.test(ts.value)) return reject('TIMESTAMP_MALFORMED');
  const sig = singleHeader(headers, SLACK_SIGNATURE_HEADER);
  if (sig.state === 'missing') return reject('SIGNATURE_MISSING');
  if (sig.state === 'ambiguous' || !SLACK_SIGNATURE_PATTERN.test(sig.value)) return reject('SIGNATURE_MALFORMED');

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(ts.value)) > (options.maxAgeSeconds ?? SLACK_MAX_AGE_SECONDS)) return reject('TIMESTAMP_STALE');

  // The signature covers the exact bytes Slack sent. Without them nothing can be verified, so refuse.
  if (!rawBody) return reject('BODY_UNAVAILABLE');
  const expected = crypto.createHmac('sha256', secret).update(`v0:${ts.value}:`, 'utf8').update(rawBody).digest();
  const provided = Buffer.from(sig.value.slice(3), 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return reject('SIGNATURE_MISMATCH');
  return { ok: true, signature: sig.value.toLowerCase() };
}

// ── Rejection → HTTP result ──
// One generic body per status: the caller learns nothing about which check failed. The operator-facing reason is logged
// (throttled per integration+reason so a flood cannot flood the log); neither secrets nor request content are ever included.
const lastLogged = new Map<string, number>();
const LOG_INTERVAL_MS = 60_000;

export function webhookRejection(integration: 'telegram' | 'slack', verdict: Extract<WebhookVerdict, { ok: false }>, requestId: string, nowMs: number = Date.now()): ApiResult {
  const key = `${integration}:${verdict.reason}`;
  if (nowMs - (lastLogged.get(key) ?? 0) >= LOG_INTERVAL_MS) {
    lastLogged.set(key, nowMs);
    console.warn(JSON.stringify({ event: 'channel_webhook_rejected', integration, reason: verdict.reason, status: verdict.status }));
  }
  if (verdict.status === 503) {
    return { status: 503, data: { error: { code: 'WEBHOOK_VERIFICATION_UNAVAILABLE', category: 'PROVIDER', message: 'Webhook verification is not configured on this server.', request_id: requestId } } };
  }
  return { status: 401, data: { error: { code: 'WEBHOOK_AUTHENTICATION_FAILED', category: 'AUTHENTICATION', message: 'Webhook authentication failed.', request_id: requestId } } };
}
