// Security Gate S2A — Telegram / Slack webhook authenticity.
//
// Before S2A an anonymous HTTP request that merely CLAIMED to be Telegram or Slack entered trusted integration processing:
// identity lookup, a write into the linked user's conversation, memory retrieval and the model. These tests prove that a
// request that does not carry the server-configured secret / a valid signature stops at the boundary, with tripwires
// behind it that fail the test if anything past the boundary runs, and that a correctly authenticated request still
// flows through the unchanged pipeline.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramIdentityStore } from '../src/integrations/telegram/telegram-identity.store.js';
import { TelegramBotClient } from '../src/integrations/telegram/telegram.client.js';
import { TelegramService } from '../src/integrations/telegram/telegram.service.js';
import { SlackIdentityStore } from '../src/integrations/slack/slack-identity.store.js';
import { SlackClient } from '../src/integrations/slack/slack.client.js';
import { SlackService } from '../src/integrations/slack/slack.service.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { ConversationStore } from '../src/conversations/conversation.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { attachRawBody } from '../src/http/raw-body.js';
import { classifyRouteAccess } from '../src/http/route-access.js';
import { handleAsyncApiRequest, withTestServer, telegramService as globalTelegramService, slackService as globalSlackService } from '../src/server_web.js';
import {
  SignedRequestReplayGuard,
  verifySlackWebhook,
  verifyTelegramWebhook,
  SLACK_MAX_AGE_SECONDS,
} from '../src/integrations/webhook-auth.js';
import {
  BOTH_SECRETS, TEST_SLACK_SIGNING_SECRET, TEST_TELEGRAM_SECRET,
  signedSlackChallenge, signedSlackEvent, slackRequest, slackSignature, telegramHeaders, withWebhookSecrets,
} from './_s2a_webhooks.js';

const TG_URL = '/api/v1/integrations/telegram/webhook';
const SLACK_URL = '/api/v1/integrations/slack/events';
const VICTIM = { principalId: 'usr_s2a_victim', tenantId: 'ten_s2a_victim' };

interface Tripwires { model: number; plan: number; conversationWrites: number; memoryReads: number; identityLookups: number; outboundSends: number }

const mockAi = (t: Tripwires): any => ({
  statuses: () => [],
  chat: async (params: any) => { t.model++; return { status: 'SUCCESS', provider: 'mock', model: 'mock-model', latencyMs: 1, requestId: params.requestId, data: { message: `Echo: ${params.message}` } }; },
  plan: async (params: any) => { t.model++; return { status: 'PLAN_PREVIEW', provider: 'mock', model: 'mock-model', latencyMs: 1, requestId: params.requestId, data: { goal: 'g', summary: 's', reasoningSummary: 'r', steps: [{ step: 1, title: 'Step 1', reasoning: 'r', skill: 'general-assistant', tool: null, requiresApproval: false }] } }; },
});

function counters(): Tripwires { return { model: 0, plan: 0, conversationWrites: 0, memoryReads: 0, identityLookups: 0, outboundSends: 0 }; }
const zero = (t: Tripwires): void => assert.deepEqual(t, counters(), 'no identity lookup, memory read, conversation write, model/plan call or outbound send may happen');

function planResolverWithTripwire(t: Tripwires): PlanResolver {
  const resolver = new PlanResolver(skillRegistry, toolRegistry);
  const orig = resolver.resolve.bind(resolver);
  (resolver as any).resolve = (...args: any[]) => { t.plan++; return (orig as any)(...args); };
  return resolver;
}

function conversationStoreWithTripwire(dir: string, t: Tripwires): ConversationStore {
  const store = new ConversationStore({ dir: path.join(dir, 'conversations') });
  const orig = store.append.bind(store);
  (store as any).append = (...args: any[]) => { t.conversationWrites++; return (orig as any)(...args); };
  return store;
}

interface Harness<S> { service: S; t: Tripwires; conversations: ConversationStore; sessions: SessionStore }

function telegramHarness(): Harness<TelegramService> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-s2a-tg-'));
  const t = counters();
  const identityStore = new TelegramIdentityStore({ dir });
  identityStore.link('777001', VICTIM.principalId, VICTIM.tenantId, 'victim_tg');
  const origResolve = identityStore.resolve.bind(identityStore);
  (identityStore as any).resolve = (id: string) => { t.identityLookups++; return origResolve(id); };
  const botClient = new TelegramBotClient(null);
  const origSend = botClient.sendMessage.bind(botClient);
  (botClient as any).sendMessage = (o: any) => { t.outboundSends++; return origSend(o); };
  const sessions = new SessionStore({ dir: path.join(dir, 'sessions') });
  const conversations = conversationStoreWithTripwire(dir, t);
  const service = new TelegramService({
    botClient, identityStore, sessionStore: sessions, aiService: mockAi(t), planResolver: planResolverWithTripwire(t),
    getMemories: () => { t.memoryReads++; return []; }, auditLogger: new AuditLogger(), conversationStore: conversations,
  });
  return { service, t, conversations, sessions };
}

function slackHarness(): Harness<SlackService> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-s2a-slack-'));
  const t = counters();
  const identityStore = new SlackIdentityStore({ dir });
  identityStore.link('U_VICTIM', VICTIM.principalId, VICTIM.tenantId, 'T01', 'victim_slack');
  const origResolve = identityStore.resolve.bind(identityStore);
  (identityStore as any).resolve = (id: string) => { t.identityLookups++; return origResolve(id); };
  const slackClient = new SlackClient(null);
  const origPost = slackClient.postMessage.bind(slackClient);
  (slackClient as any).postMessage = (o: any) => { t.outboundSends++; return origPost(o); };
  const sessions = new SessionStore({ dir: path.join(dir, 'sessions') });
  const conversations = conversationStoreWithTripwire(dir, t);
  const service = new SlackService({
    slackClient, identityStore, sessionStore: sessions, aiService: mockAi(t), planResolver: planResolverWithTripwire(t),
    getMemories: () => { t.memoryReads++; return []; }, auditLogger: new AuditLogger(), conversationStore: conversations,
  });
  return { service, t, conversations, sessions };
}

const tgUpdate = (text = 'hello there'): Record<string, unknown> => ({
  update_id: 1,
  message: { message_id: 1, date: 1, chat: { id: 777001, type: 'private' }, from: { id: 777001, is_bot: false, first_name: 'Victim' }, text },
});
const slackMessage = (text = 'hello there'): Record<string, unknown> => ({ type: 'message', user: 'U_VICTIM', channel: 'C_ATTACKER', text, ts: '1.1' });

const callTelegram = (h: Harness<TelegramService>, body: Record<string, unknown> | null, headers: Record<string, string | string[] | undefined>) =>
  handleAsyncApiRequest('POST', TG_URL, body, headers, undefined, {}, undefined, undefined, undefined, h.service);
const callSlack = (h: Harness<SlackService>, body: Record<string, unknown> | null, headers: Record<string, string | string[] | undefined>) =>
  handleAsyncApiRequest('POST', SLACK_URL, body, headers, undefined, {}, undefined, undefined, undefined, undefined, h.service);

const errorCode = (res: { data: unknown }): string | undefined => (res.data as any)?.error?.code;
const quiet = (): (() => void) => { const orig = console.warn; console.warn = () => undefined; return () => { console.warn = orig; }; };

let restoreWarn: () => void;
beforeEach(() => { restoreWarn = quiet(); });
afterEach(() => restoreWarn());

describe('S2A — route classification', () => {
  it('both webhook routes are SIGNED_WEBHOOK, not anonymous-preserved', () => {
    assert.equal(classifyRouteAccess('POST', TG_URL)?.access, 'SIGNED_WEBHOOK');
    assert.equal(classifyRouteAccess('POST', SLACK_URL)?.access, 'SIGNED_WEBHOOK');
  });
});

describe('S2A — Telegram webhook authenticity', () => {
  it('VALID_SECRET → accepted and processed through the unchanged pipeline', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const res = await callTelegram(h, tgUpdate(), telegramHeaders());
      assert.equal(res.status, 200);
      assert.equal((res.data as any).handled, true);
      assert.equal(h.t.model, 1);
      assert.equal(h.t.conversationWrites, 2, 'USER and ASSISTANT messages');
      assert.equal(h.t.identityLookups, 1);
      assert.equal(h.t.outboundSends, 1);
    });
  });

  it('every unauthenticated variant is rejected with 401 before ANY trusted processing', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const wrongSameLength = 'x'.repeat(TEST_TELEGRAM_SECRET.length);
      const variants: Array<[string, Record<string, string | string[] | undefined>]> = [
        ['NO_SECRET_HEADER', {}],
        ['EMPTY_SECRET', { 'x-telegram-bot-api-secret-token': '' }],
        ['WRONG_SECRET (same length)', telegramHeaders(wrongSameLength)],
        ['WRONG_SECRET (different length)', telegramHeaders('short')],
        ['WRONG_SECRET (prefix of the real one)', telegramHeaders(TEST_TELEGRAM_SECRET.slice(0, -1))],
        ['WRONG_SECRET (real one plus a suffix)', telegramHeaders(TEST_TELEGRAM_SECRET + 'x')],
        ['MALFORMED (space)', telegramHeaders('has space')],
        ['MALFORMED (non-ASCII)', telegramHeaders('시크릿')],
        ['MALFORMED (too long)', telegramHeaders('a'.repeat(257))],
        ['AMBIGUOUS (two values)', { 'x-telegram-bot-api-secret-token': [TEST_TELEGRAM_SECRET, TEST_TELEGRAM_SECRET] }],
        ['AMBIGUOUS (two spellings of the header)', { 'x-telegram-bot-api-secret-token': TEST_TELEGRAM_SECRET, 'X-Telegram-Bot-Api-Secret-Token': TEST_TELEGRAM_SECRET }],
        ['SECRET ONLY IN A DIFFERENT HEADER', { 'x-nagex-webhook-secret': TEST_TELEGRAM_SECRET, authorization: `Bearer ${TEST_TELEGRAM_SECRET}` }],
        ['FORGED IDENTITY HEADERS ONLY', { 'x-principal-id': VICTIM.principalId, 'x-nagex-tenant': VICTIM.tenantId }],
        ['SLACK-STYLE SIGNATURE ONLY', { 'x-slack-signature': 'v0=' + 'a'.repeat(64), 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)) }],
      ];
      for (const [label, headers] of variants) {
        const h = telegramHarness();
        const res = await callTelegram(h, tgUpdate('forged text FORGED-TG'), headers);
        assert.equal(res.status, 401, label);
        assert.equal(errorCode(res), 'WEBHOOK_AUTHENTICATION_FAILED', label);
        zero(h.t);
        assert.equal(h.conversations.listSession(VICTIM.tenantId, VICTIM.principalId, 'any').length, 0, label);
      }
    });
  });

  it('the secret is never accepted from the body or the query string', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const body = { ...tgUpdate(), secret_token: TEST_TELEGRAM_SECRET, secretToken: TEST_TELEGRAM_SECRET };
      const res = await handleAsyncApiRequest('POST', TG_URL, body, {}, undefined, { secret_token: TEST_TELEGRAM_SECRET }, undefined, undefined, undefined, h.service);
      assert.equal(res.status, 401);
      zero(h.t);
    });
  });

  it('SERVER_SECRET_MISSING → fails closed (503), even for a request that carries a header, and nothing runs', async () => {
    for (const missing of [null, '', 'bad secret with spaces']) {
      await withWebhookSecrets({ telegram: missing, slack: TEST_SLACK_SIGNING_SECRET }, async () => {
        const h = telegramHarness();
        for (const headers of [telegramHeaders(), telegramHeaders('anything'), {}]) {
          const res = await callTelegram(h, tgUpdate(), headers);
          assert.equal(res.status, 503, `server secret ${JSON.stringify(missing)}`);
          assert.equal(errorCode(res), 'WEBHOOK_VERIFICATION_UNAVAILABLE');
        }
        zero(h.t);
      });
    }
  });

  it('a rejected response and the operator log never contain the configured secret, the supplied credential or the message text', async () => {
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const supplied = 'supplied-credential-VALUE';
      const res = await callTelegram(h, tgUpdate('PRIVATE-MESSAGE-TEXT'), telegramHeaders(supplied));
      const out = JSON.stringify(res) + lines.join('\n');
      for (const secretish of [TEST_TELEGRAM_SECRET, supplied, 'PRIVATE-MESSAGE-TEXT', TEST_SLACK_SIGNING_SECRET]) assert.equal(out.includes(secretish), false, `must not leak ${secretish}`);
    });
  });
});

describe('S2A — Slack events authenticity', () => {
  const now = (): number => Math.floor(Date.now() / 1000);

  it('VALID_SIGNATURE → accepted and processed (event and url_verification challenge)', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const ev = signedSlackEvent(slackMessage());
      const res = await callSlack(h, ev.body, ev.headers);
      assert.equal(res.status, 200);
      assert.equal((res.data as any).handled, true);
      assert.equal(h.t.model, 1);
      assert.equal(h.t.conversationWrites, 2);
      const ch = signedSlackChallenge('challenge-xyz-123');
      const chRes = await callSlack(h, ch.body, ch.headers);
      assert.equal(chRes.status, 200);
      assert.equal((chRes.data as any).challenge, 'challenge-xyz-123');
    });
  });

  it('every unauthenticated variant is rejected with 401 before ANY trusted processing (and the challenge is not echoed)', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const raw = JSON.stringify({ type: 'event_callback', event: slackMessage('forged text FORGED-SLACK') });
      const ts = now();
      const variants: Array<[string, SlackReq]> = [
        ['NO_SIGNATURE', slackRequest(raw, { omitSignature: true })],
        ['WRONG_SIGNATURE (valid shape)', slackRequest(raw, { signature: 'v0=' + 'a'.repeat(64) })],
        ['WRONG_SECRET (signed by someone else)', slackRequest(raw, { secret: 'attacker-chosen-signing-secret' })],
        ['MALFORMED_SIGNATURE (no v0= prefix)', slackRequest(raw, { signature: slackSignature(TEST_SLACK_SIGNING_SECRET, ts, raw).slice(3) })],
        ['MALFORMED_SIGNATURE (wrong version)', slackRequest(raw, { signature: slackSignature(TEST_SLACK_SIGNING_SECRET, ts, raw).replace('v0=', 'v1=') })],
        ['MALFORMED_SIGNATURE (short)', slackRequest(raw, { signature: 'v0=abcd' })],
        ['MALFORMED_SIGNATURE (non-hex)', slackRequest(raw, { signature: 'v0=' + 'z'.repeat(64) })],
        ['MISSING_TIMESTAMP', slackRequest(raw, { omitTimestamp: true })],
        ['MALFORMED_TIMESTAMP (letters)', slackRequest(raw, { timestamp: 'abc' })],
        ['MALFORMED_TIMESTAMP (negative)', slackRequest(raw, { timestamp: '-5' })],
        ['MALFORMED_TIMESTAMP (fraction)', slackRequest(raw, { timestamp: '1700000000.5' })],
        ['MALFORMED_TIMESTAMP (empty)', slackRequest(raw, { timestamp: '' })],
        ['MALFORMED_TIMESTAMP (huge)', slackRequest(raw, { timestamp: '9'.repeat(30) })],
        ['STALE_TIMESTAMP (correctly signed, 10 minutes old)', slackRequest(raw, { timestamp: ts - 600 })],
        ['STALE_TIMESTAMP (just outside the window)', slackRequest(raw, { timestamp: ts - SLACK_MAX_AGE_SECONDS - 5 })],
        ['FUTURE_TIMESTAMP (correctly signed, 10 minutes ahead)', slackRequest(raw, { timestamp: ts + 600 })],
        ['MODIFIED_BODY (signed one sender, delivered another)', slackRequest(raw, { deliveredRaw: raw.replace('U_VICTIM', 'U_OTHER') })],
        ['MODIFIED_BODY (one byte appended)', slackRequest(raw, { deliveredRaw: raw.replace(/\}$/, ' }') })],
      ];
      for (const [label, req] of variants) {
        const h = slackHarness();
        const res = await callSlack(h, req.body, req.headers);
        assert.equal(res.status, 401, label);
        assert.equal(errorCode(res), 'WEBHOOK_AUTHENTICATION_FAILED', label);
        assert.equal('challenge' in ((res.data as object) ?? {}), false, label);
        zero(h.t);
        assert.equal(h.conversations.listSession(VICTIM.tenantId, VICTIM.principalId, 'any').length, 0, label);
      }
    });
  });

  it('an unsigned url_verification challenge is not echoed', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const res = await callSlack(h, { type: 'url_verification', challenge: 'UNSIGNED-CHALLENGE' }, {});
      assert.equal(res.status, 401);
      assert.equal(JSON.stringify(res.data).includes('UNSIGNED-CHALLENGE'), false);
    });
  });

  it('duplicate / ambiguous signature or timestamp headers are rejected', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const req = signedSlackEvent(slackMessage());
      const sig = req.headers['x-slack-signature'];
      const tsv = req.headers['x-slack-request-timestamp'];
      for (const headers of [
        { ...req.headers, 'x-slack-signature': [sig, sig] },
        { ...req.headers, 'X-Slack-Signature': sig },
        { ...req.headers, 'x-slack-request-timestamp': [tsv, tsv] },
      ] as Array<Record<string, string | string[]>>) {
        const h = slackHarness();
        const res = await callSlack(h, req.body, headers);
        assert.equal(res.status, 401);
        zero(h.t);
      }
    });
  });

  it('the signature covers the AUTHENTIC raw bytes: a signed body with unusual whitespace is accepted, and a body without raw bytes is refused', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      // pretty-printed, key order and whitespace that JSON.stringify(JSON.parse(raw)) would NOT reproduce
      const raw = '{\n  "type"  :  "event_callback",\n  "event_id": "Ev_ws_1",\n  "event": { "type":"message","user":"U_VICTIM","channel":"C1","text":"hello  with  spaces","ts":"1.1" }\n}';
      assert.notEqual(JSON.stringify(JSON.parse(raw)), raw);
      const h = slackHarness();
      const req = slackRequest(raw);
      const ok = await callSlack(h, req.body, req.headers);
      assert.equal(ok.status, 200, 'verified over the raw bytes, not a re-serialisation');
      assert.equal(h.t.model, 1);

      // the same valid headers but no raw buffer registered (a hand-built body): unverifiable → refused
      const h2 = slackHarness();
      const req2 = slackRequest(JSON.stringify({ type: 'event_callback', event_id: 'Ev_ws_2', event: slackMessage() }));
      const bare = JSON.parse(req2.raw) as Record<string, unknown>;   // a fresh object: no raw bytes attached
      const refused = await callSlack(h2, bare, req2.headers);
      assert.equal(refused.status, 401);
      zero(h2.t);
      // and it does not matter that JSON.stringify(bare) would reproduce the signed bytes here
      assert.equal(JSON.stringify(bare), req2.raw);
      assert.equal(await callSlack(h2, null, req2.headers).then((r) => r.status), 401);
      assert.equal(await callSlack(h2, attachRawBody({}, Buffer.from('{}')), req2.headers).then((r) => r.status), 401, 'raw bytes that differ from the signed bytes');
    });
  });

  it('just inside the replay window is accepted', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const inside = signedSlackEvent(slackMessage());
      const insideReq = slackRequest(JSON.stringify({ type: 'event_callback', event_id: 'Ev_edge', event: slackMessage() }), { timestamp: now() - (SLACK_MAX_AGE_SECONDS - 1) });
      assert.equal((await callSlack(h, insideReq.body, insideReq.headers)).status, 200);
      assert.equal((await callSlack(h, inside.body, inside.headers)).status, 200);
    });
  });

  it('a verified delivery is processed once: an exact replay is acknowledged but not processed again', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const req = signedSlackEvent(slackMessage('process me once'));
      const first = await callSlack(h, req.body, req.headers);
      assert.equal(first.status, 200);
      assert.equal((first.data as any).handled, true);
      const afterFirst = { ...h.t };
      const replay = await callSlack(h, req.body, req.headers);
      assert.equal(replay.status, 200);
      assert.equal((replay.data as any).handled, false);
      assert.equal((replay.data as any).duplicate, true);
      assert.deepEqual(h.t, afterFirst, 'the replay caused no further model call, write or send');
    });
  });

  it('SERVER_SIGNING_SECRET_MISSING → fails closed (503) for events AND the challenge, nothing runs', async () => {
    for (const missing of [null, '']) {
      await withWebhookSecrets({ telegram: TEST_TELEGRAM_SECRET, slack: missing }, async () => {
        const h = slackHarness();
        const req = signedSlackEvent(slackMessage());          // perfectly signed by SOME secret
        const res = await callSlack(h, req.body, req.headers);
        assert.equal(res.status, 503);
        assert.equal(errorCode(res), 'WEBHOOK_VERIFICATION_UNAVAILABLE');
        const ch = signedSlackChallenge('NO-ECHO-WITHOUT-SECRET');
        const chRes = await callSlack(h, ch.body, ch.headers);
        assert.equal(chRes.status, 503);
        assert.equal(JSON.stringify(chRes.data).includes('NO-ECHO-WITHOUT-SECRET'), false);
        zero(h.t);
      });
    }
  });

  it('a rejected response and the operator log never contain the signing secret, the signature or the message text', async () => {
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const req = slackRequest(JSON.stringify({ type: 'event_callback', event: slackMessage('PRIVATE-SLACK-TEXT') }), { secret: 'not-the-secret' });
      const res = await callSlack(h, req.body, req.headers);
      const out = JSON.stringify(res) + lines.join('\n');
      for (const secretish of [TEST_SLACK_SIGNING_SECRET, req.headers['x-slack-signature'], 'PRIVATE-SLACK-TEXT']) assert.equal(out.includes(secretish), false);
    });
  });
});

type SlackReq = ReturnType<typeof slackRequest>;

describe('S2A — verifier unit behavior (webhook-auth)', () => {
  const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;
  const reasons = (v: any): string | true => (v.ok ? true : v.reason);

  it('Telegram reason codes', () => {
    const e = env({ TELEGRAM_WEBHOOK_SECRET: 'abc_DEF-123' });
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': 'abc_DEF-123' }, e)), true);
    assert.equal(reasons(verifyTelegramWebhook({}, e)), 'CREDENTIAL_MISSING');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': '' }, e)), 'CREDENTIAL_MISSING');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': 'abc DEF' }, e)), 'CREDENTIAL_MALFORMED');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': 'abc_DEF-124' }, e)), 'CREDENTIAL_MISMATCH');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': ['a', 'b'] }, e)), 'CREDENTIAL_AMBIGUOUS');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': 'abc_DEF-123' }, env({}))), 'SECRET_NOT_CONFIGURED');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': 'abc_DEF-123' }, env({ TELEGRAM_WEBHOOK_SECRET: '' }))), 'SECRET_NOT_CONFIGURED');
    assert.equal(reasons(verifyTelegramWebhook({ 'x-telegram-bot-api-secret-token': 'abc_DEF-123' }, env({ TELEGRAM_WEBHOOK_SECRET: 'has space' }))), 'SECRET_MISCONFIGURED');
    assert.equal(verifyTelegramWebhook({}, env({})).ok === false && (verifyTelegramWebhook({}, env({})) as any).status, 503);
  });

  it('Slack reason codes at a fixed clock', () => {
    const secret = 'unit-signing-secret';
    const e = env({ SLACK_SIGNING_SECRET: secret });
    const nowMs = 1_800_000_000_000;
    const ts = String(nowMs / 1000);
    const raw = Buffer.from('{"a":1}');
    const good = { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, raw) };
    assert.equal(reasons(verifySlackWebhook(good, raw, { env: e, nowMs })), true);
    assert.equal(reasons(verifySlackWebhook({ 'x-slack-signature': good['x-slack-signature'] }, raw, { env: e, nowMs })), 'TIMESTAMP_MISSING');
    assert.equal(reasons(verifySlackWebhook({ 'x-slack-request-timestamp': ts }, raw, { env: e, nowMs })), 'SIGNATURE_MISSING');
    assert.equal(reasons(verifySlackWebhook({ ...good, 'x-slack-request-timestamp': 'x' }, raw, { env: e, nowMs })), 'TIMESTAMP_MALFORMED');
    assert.equal(reasons(verifySlackWebhook({ ...good, 'x-slack-signature': 'nope' }, raw, { env: e, nowMs })), 'SIGNATURE_MALFORMED');
    assert.equal(reasons(verifySlackWebhook(good, raw, { env: e, nowMs: nowMs + 301_000 })), 'TIMESTAMP_STALE');
    assert.equal(reasons(verifySlackWebhook(good, raw, { env: e, nowMs: nowMs - 301_000 })), 'TIMESTAMP_STALE');
    assert.equal(reasons(verifySlackWebhook(good, raw, { env: e, nowMs: nowMs + 300_000 })), true, 'exactly at the limit is inside');
    assert.equal(reasons(verifySlackWebhook(good, Buffer.from('{"a":2}'), { env: e, nowMs })), 'SIGNATURE_MISMATCH');
    assert.equal(reasons(verifySlackWebhook(good, undefined, { env: e, nowMs })), 'BODY_UNAVAILABLE');
    assert.equal(reasons(verifySlackWebhook(good, raw, { env: env({}), nowMs })), 'SECRET_NOT_CONFIGURED');
    assert.equal(reasons(verifySlackWebhook(good, raw, { env: env({ SLACK_SIGNING_SECRET: 'other' }), nowMs })), 'SIGNATURE_MISMATCH');
    // case of the hex digest is not significant to the HMAC
    assert.equal(reasons(verifySlackWebhook({ ...good, 'x-slack-signature': 'v0=' + good['x-slack-signature'].slice(3).toUpperCase() }, raw, { env: e, nowMs })), true);
  });

  it('the replay guard is bounded and expires entries with the window', () => {
    const g = new SignedRequestReplayGuard(1000, 3);
    assert.equal(g.checkAndRemember('a', 0), false);
    assert.equal(g.checkAndRemember('a', 500), true);
    assert.equal(g.checkAndRemember('a', 2000), false, 'expired entries are forgotten');
    g.checkAndRemember('b', 2001); g.checkAndRemember('c', 2002); g.checkAndRemember('d', 2003);   // capacity 3 → oldest evicted
    assert.equal(g.checkAndRemember('d', 2004), true);
  });
});

// ── Over the real HTTP server: the raw bytes the platform sent are what is verified ──
describe('S2A — real HTTP request path', () => {
  it('forged webhook requests (the original P0) are refused and reach no trusted processing; authentic ones do', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      let tgCalls = 0; let slackCalls = 0;
      const origTg = globalTelegramService.processUpdate.bind(globalTelegramService);
      const origSlack = globalSlackService.processEvent.bind(globalSlackService);
      (globalTelegramService as any).processUpdate = async (...a: any[]) => { tgCalls++; return origTg(...(a as [any])); };
      (globalSlackService as any).processEvent = async (...a: any[]) => { slackCalls++; return origSlack(...(a as [any])); };
      try {
        await withTestServer(async (origin) => {
          const post = (p: string, body: string, headers: Record<string, string>) => fetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

          // anonymous, forged, no credentials at all
          const tgForged = await post(TG_URL, JSON.stringify(tgUpdate('FORGED')), {});
          assert.equal(tgForged.status, 401);
          const slForged = await post(SLACK_URL, JSON.stringify({ type: 'event_callback', event: slackMessage('FORGED') }), {});
          assert.equal(slForged.status, 401);
          const slChallenge = await post(SLACK_URL, JSON.stringify({ type: 'url_verification', challenge: 'HTTP-UNSIGNED' }), {});
          assert.equal(slChallenge.status, 401);
          assert.equal((await slChallenge.text()).includes('HTTP-UNSIGNED'), false);
          // wrong credentials
          assert.equal((await post(TG_URL, JSON.stringify(tgUpdate()), telegramHeaders('wrong'))).status, 401);
          const raw = JSON.stringify({ type: 'event_callback', event: slackMessage() });
          const ts = Math.floor(Date.now() / 1000);
          assert.equal((await post(SLACK_URL, raw, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSignature('wrong', ts, raw) })).status, 401);
          // body modified after signing (over the wire)
          const signed = slackSignature(TEST_SLACK_SIGNING_SECRET, ts, raw);
          assert.equal((await post(SLACK_URL, raw.replace('U_VICTIM', 'U_EVIL'), { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signed })).status, 401);
          // stale
          const old = ts - 3600;
          assert.equal((await post(SLACK_URL, raw, { 'x-slack-request-timestamp': String(old), 'x-slack-signature': slackSignature(TEST_SLACK_SIGNING_SECRET, old, raw) })).status, 401);
          // not JSON at all, signed or not
          assert.equal((await post(SLACK_URL, 'not json', {})).status, 401);
          assert.equal((await fetch(origin + TG_URL, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(tgUpdate()) })).status, 401);
          // identity headers / cookies are not webhook credentials
          assert.equal((await post(TG_URL, JSON.stringify(tgUpdate()), { 'x-principal-id': VICTIM.principalId, 'x-nagex-tenant': VICTIM.tenantId, cookie: 'nagex_session=sess_forged' })).status, 401);
          assert.equal(tgCalls + slackCalls, 0, 'no refused request reached trusted integration processing');

          // authentic Slack request with whitespace a re-serialisation would not reproduce → reaches processing
          const pretty = '{\n  "type": "event_callback",\n  "event_id": "Ev_http_1",\n  "event": {"type":"message","user":"U_NOBODY","channel":"C1","text":"","ts":"1.1"}\n}';
          const prettyTs = Math.floor(Date.now() / 1000);
          const okSlack = await post(SLACK_URL, pretty, { 'x-slack-request-timestamp': String(prettyTs), 'x-slack-signature': slackSignature(TEST_SLACK_SIGNING_SECRET, prettyTs, pretty) });
          assert.equal(okSlack.status, 200);
          assert.equal(slackCalls, 1, 'verified over the raw bytes the sender signed');
          // authentic challenge
          const chRaw = JSON.stringify({ type: 'url_verification', challenge: 'HTTP-SIGNED-OK' });
          const chTs = Math.floor(Date.now() / 1000);
          const ch = await post(SLACK_URL, chRaw, { 'x-slack-request-timestamp': String(chTs), 'x-slack-signature': slackSignature(TEST_SLACK_SIGNING_SECRET, chTs, chRaw) });
          assert.equal(ch.status, 200);
          assert.equal(((await ch.json()) as any).challenge, 'HTTP-SIGNED-OK');
          // authentic Telegram message with an empty text is accepted and handled as "nothing to do" (no model)
          const okTg = await post(TG_URL, JSON.stringify({ update_id: 5, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'x' }, text: '   ' } }), telegramHeaders());
          assert.equal(okTg.status, 200);
          assert.equal(tgCalls, 1);
        });
      } finally {
        (globalTelegramService as any).processUpdate = origTg;
        (globalSlackService as any).processEvent = origSlack;
      }
    });
  });

  it('without server-side secrets every webhook request is refused (fail closed) over HTTP', async () => {
    await withWebhookSecrets({ telegram: null, slack: null }, async () => {
      await withTestServer(async (origin) => {
        const t = await fetch(origin + TG_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...telegramHeaders() }, body: JSON.stringify(tgUpdate()) });
        assert.equal(t.status, 503);
        const raw = JSON.stringify({ type: 'url_verification', challenge: 'X' });
        const ts = Math.floor(Date.now() / 1000);
        const s = await fetch(origin + SLACK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSignature(TEST_SLACK_SIGNING_SECRET, ts, raw) }, body: raw });
        assert.equal(s.status, 503);
      });
    });
  });
});
