// S2A — TEST-ONLY helpers for the channel-webhook authenticity boundary.
//
// Production verifies Telegram's secret-token header and Slack's request signature against secrets from server
// configuration. A test that needs a webhook to be ACCEPTED therefore configures those secrets in the environment and
// signs the request exactly as the platform does; nothing here is reachable from production code.
import crypto from 'node:crypto';
import { attachRawBody } from '../src/http/raw-body.js';
import { SLACK_SIGNING_SECRET_ENV, TELEGRAM_WEBHOOK_SECRET_ENV } from '../src/integrations/webhook-auth.js';

export const TEST_TELEGRAM_SECRET = 'tg_test_secret-AbCdEf0123456789';
export const TEST_SLACK_SIGNING_SECRET = 'slack_test_signing_secret_0123456789abcdef';

// Runs `fn` with the webhook secrets configured (or deliberately absent), then restores the environment.
export async function withWebhookSecrets<T>(secrets: { telegram?: string | null; slack?: string | null }, fn: () => Promise<T>): Promise<T> {
  const prevTg = process.env[TELEGRAM_WEBHOOK_SECRET_ENV];
  const prevSlack = process.env[SLACK_SIGNING_SECRET_ENV];
  const set = (name: string, v: string | null | undefined): void => { if (v === null || v === undefined) delete process.env[name]; else process.env[name] = v; };
  set(TELEGRAM_WEBHOOK_SECRET_ENV, secrets.telegram);
  set(SLACK_SIGNING_SECRET_ENV, secrets.slack);
  try { return await fn(); } finally { set(TELEGRAM_WEBHOOK_SECRET_ENV, prevTg); set(SLACK_SIGNING_SECRET_ENV, prevSlack); }
}

export const BOTH_SECRETS = { telegram: TEST_TELEGRAM_SECRET, slack: TEST_SLACK_SIGNING_SECRET };

export function telegramHeaders(secret: string = TEST_TELEGRAM_SECRET): Record<string, string> {
  return { 'x-telegram-bot-api-secret-token': secret };
}

export function slackSignature(secret: string, timestamp: string | number, rawBody: string | Buffer): string {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
}

export interface SlackSignedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  raw: string;
}

// Builds a request the way Slack sends it: the signature covers `raw`, the parsed body is what the HTTP layer would hand
// the route, and the raw buffer is registered for the verifier (as the HTTP layer does).
export function slackRequest(raw: string, opts: { secret?: string; timestamp?: string | number; signature?: string; omitSignature?: boolean; omitTimestamp?: boolean; deliveredRaw?: string } = {}): SlackSignedRequest {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (!opts.omitTimestamp) headers['x-slack-request-timestamp'] = String(ts);
  if (!opts.omitSignature) headers['x-slack-signature'] = opts.signature ?? slackSignature(opts.secret ?? TEST_SLACK_SIGNING_SECRET, ts, raw);
  const delivered = opts.deliveredRaw ?? raw;
  const body = JSON.parse(delivered) as Record<string, unknown>;
  attachRawBody(body, Buffer.from(delivered, 'utf8'));
  return { body, headers, raw: delivered };
}

let counter = 0;
export function signedSlackEvent(event: Record<string, unknown>, extra: { team_id?: string } = {}): SlackSignedRequest {
  // a unique event id keeps two otherwise-identical test deliveries from being treated as a replay
  return slackRequest(JSON.stringify({ type: 'event_callback', event_id: `Ev_${Date.now()}_${++counter}`, ...extra, event }));
}

export function signedSlackChallenge(challenge: string): SlackSignedRequest {
  return slackRequest(JSON.stringify({ type: 'url_verification', challenge }));
}
