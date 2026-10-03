// Security Gate S2C — outbound channel & notification RECIPIENT authority.
//
// After S2B the system knows which Telegram/Slack account really belongs to which NAgex principal. S2C makes that the only
// outbound authority: a signed-in caller can send to, and notify, ITSELF — never an arbitrary chat/channel and never another
// principal or tenant — and a send that did not happen is never reported as delivered. Before S2C any signed-in user could use the
// server bot credential to post to any chat/channel, and `notifications/dispatch` took the recipient from the request body.
// These tests drive the real route/service/engine entry points with a recording fake provider behind them (nothing real is ever
// contacted) and count provider invocations, notification writes and fan-out for every rejected request.
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
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';
import { BOTH_SECRETS, signedSlackEvent, telegramHeaders, withWebhookSecrets } from './_s2a_webhooks.js';

const TG_SEND = '/api/v1/integrations/telegram/send';
const SL_SEND = '/api/v1/integrations/slack/send';
const DISPATCH = '/api/v1/notifications/dispatch';
const TG_TOKEN = 'tg-bot-token-SECRET-VALUE-123456';
const SLACK_TOKEN = 'xoxb-slack-bot-token-SECRET-VALUE';

const ALICE = { principalId: 'usr_s2c_alice', tenantId: 'ten_s2c_alice' };
const BOB = { principalId: 'usr_s2c_bob', tenantId: 'ten_s2c_bob' };
type Who = typeof ALICE;
const as = (w: Who) => authAs(w.tenantId, w.principalId);
const errorCode = (res: { data: unknown }): string | undefined => (res.data as any)?.error?.code;

// ── a recording fake provider: nothing real is ever contacted ──
type ProviderMode = 'ok' | 'reject' | 'network' | 'badjson';
function fakeProvider() {
  const p = { mode: 'ok' as ProviderMode, calls: [] as Array<{ target: string; text: string; auth: string | undefined }>, fetchFn: undefined as unknown as typeof fetch };
  p.fetchFn = (async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    const body = JSON.parse(init?.body ?? '{}');
    p.calls.push({ target: String(body.chat_id ?? body.channel), text: String(body.text), auth: init?.headers?.Authorization });
    if (p.mode === 'network') throw new TypeError(`fetch failed for ${TG_TOKEN}`);
    if (p.mode === 'badjson') return new Response('<html>bad gateway</html>', { status: 502 });
    if (p.mode === 'reject') return new Response(JSON.stringify({ ok: false, description: 'chat not found', error: 'channel_not_found' }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 11 }, ts: '1700000000.000300' }), { status: 200 });
  }) as unknown as typeof fetch;
  return p;
}

function instrumentAudit() {
  const events: string[] = [];
  const auditLogger = new AuditLogger();
  const orig = auditLogger.logEvent.bind(auditLogger);
  (auditLogger as any).logEvent = (e: any) => { events.push(JSON.stringify(e)); return orig(e); };
  return { auditLogger, events };
}
const mockAi: any = { statuses: () => [] };
const tmp = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `nagex-s2c-${label}-`));

function telegramHarness(token: string | null = TG_TOKEN) {
  const dir = tmp('tg');
  const provider = fakeProvider();
  const { auditLogger, events } = instrumentAudit();
  const identityStore = new TelegramIdentityStore({ dir });
  const service = new TelegramService({
    botClient: new TelegramBotClient(token, provider.fetchFn), identityStore, sessionStore: new SessionStore({ dir: path.join(dir, 's') }),
    aiService: mockAi, planResolver: new PlanResolver(skillRegistry, toolRegistry), getMemories: () => [], auditLogger,
  });
  return { dir, provider, identityStore, service, events };
}
function slackHarness(token: string | null = SLACK_TOKEN) {
  const dir = tmp('slack');
  const provider = fakeProvider();
  const { auditLogger, events } = instrumentAudit();
  const identityStore = new SlackIdentityStore({ dir });
  const service = new SlackService({
    slackClient: new SlackClient(token, provider.fetchFn), identityStore, sessionStore: new SessionStore({ dir: path.join(dir, 's') }),
    aiService: mockAi, planResolver: new PlanResolver(skillRegistry, toolRegistry), getMemories: () => [], auditLogger,
  });
  return { dir, provider, identityStore, service, events };
}
type TgH = ReturnType<typeof telegramHarness>;
type SlH = ReturnType<typeof slackHarness>;

const tgSend = (h: TgH, who: Who | null, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
  handleAsyncApiRequest('POST', TG_SEND, body, who ? as(who) : extraHeaders, mockAi, {}, undefined, undefined, undefined, h.service);
const slSend = (h: SlH, who: Who | null, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
  handleAsyncApiRequest('POST', SL_SEND, body, who ? as(who) : extraHeaders, mockAi, {}, undefined, undefined, undefined, undefined, h.service);
const verifiedTg = (h: TgH, id: string, who: Who) => h.identityStore.link(id, who.principalId, who.tenantId, `u${id}`, 'CHANNEL_CHALLENGE');
const verifiedSl = (h: SlH, id: string, who: Who, team = 'T_ONE') => h.identityStore.link(id, who.principalId, who.tenantId, team, `u${id}`, 'CHANNEL_CHALLENGE');

let outputs: string[] = [];
const restore: Array<() => void> = [];
beforeEach(() => {
  outputs = [];
  for (const m of ['log', 'warn', 'error', 'info'] as const) {
    const orig = console[m];
    console[m] = (...a: unknown[]) => { outputs.push(a.map(String).join(' ')); };
    restore.push(() => { console[m] = orig; });
  }
});
afterEach(() => { while (restore.length) restore.pop()!(); });

const noSuccessBody = (res: { data: unknown }, label: string): void => {
  assert.equal('success' in ((res.data as object) ?? {}), false, `${label}: a refusal/failure carries no success`);
  assert.equal('destination' in ((res.data as object) ?? {}), false, `${label}: nor a destination`);
};

describe('S2C — Telegram send is SELF-DELIVERY ONLY', () => {
  it('A: a caller with an own verified link sends to the destination the SERVER derived (no chatId, or an equal assertion)', async () => {
    const h = telegramHarness();
    verifiedTg(h, '1001', ALICE);
    const bare = await tgSend(h, ALICE, { text: 'hello me' });
    assert.equal(bare.status, 200);
    assert.deepEqual((bare.data as any).success, { ok: true });
    assert.equal((bare.data as any).destination, 'OWN_VERIFIED_TELEGRAM');
    const asString = await tgSend(h, ALICE, { chatId: '1001', text: 'again' });
    const asNumber = await tgSend(h, ALICE, { chatId: 1001, text: 'and again' });
    assert.equal(asString.status, 200); assert.equal(asNumber.status, 200);
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['1001', '1001', '1001']);
    assert.ok(h.events.some((e) => e.includes('channel:telegram_message_sent')));
  });

  it('B: a chatId that is not the caller\'s own verified destination is refused before the provider is invoked', async () => {
    const h = telegramHarness();
    verifiedTg(h, '1001', ALICE);
    for (const chatId of ['999000', '-1001234567890', 999000, '1001 ', '01001', '1001;2002']) {
      const res = await tgSend(h, ALICE, { chatId, text: 'not mine' });
      assert.equal(res.status, chatId === '1001 ' ? 200 : 403, String(chatId));   // surrounding whitespace is trimmed, nothing else is normalised
      if (res.status === 403) { assert.equal(errorCode(res), 'CHANNEL_DESTINATION_NOT_AUTHORIZED'); noSuccessBody(res, String(chatId)); }
    }
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['1001'], 'only the trimmed own id was ever sent to');
    assert.ok(h.events.some((e) => e.includes('channel:telegram_send_denied') && e.includes('DESTINATION_NOT_OWNED')));
  });

  it('C: another user\'s verified destination is refused, with no side effect on the other user', async () => {
    const h = telegramHarness();
    verifiedTg(h, '1001', ALICE); verifiedTg(h, '2002', BOB);
    const res = await tgSend(h, ALICE, { chatId: '2002', text: 'phish' });
    assert.equal(res.status, 403);
    assert.equal(errorCode(res), 'CHANNEL_DESTINATION_NOT_AUTHORIZED');
    noSuccessBody(res, 'cross-user');
    assert.equal(h.provider.calls.length, 0);
    // BOB sending his own is fine, and ALICE cannot reach BOB through a smuggled alternative field either
    assert.equal((await tgSend(h, BOB, { text: 'mine' })).status, 200);
    const smuggled = await tgSend(h, ALICE, { text: 'hi', to: '2002', chat_id: '2002', recipient: '2002', telegramUserId: '2002', principalId: BOB.principalId, tenantId: BOB.tenantId });
    assert.equal(smuggled.status, 200);
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['2002', '1001'], 'BOB got only his own message; ALICE\'s smuggled fields were ignored');
  });

  it('D: no verified link is refused explicitly (no link, or only a link that predates S2B)', async () => {
    const h = telegramHarness();
    const none = await tgSend(h, ALICE, { text: 'x' });
    assert.equal(none.status, 409);
    assert.equal(errorCode(none), 'CHANNEL_NOT_LINKED');
    // a link that was never ownership-proven (it predates S2B) is not a trusted destination
    h.identityStore.link('3003', ALICE.principalId, ALICE.tenantId, 'legacy');
    const legacy = await tgSend(h, ALICE, { text: 'x' });
    assert.equal(legacy.status, 409);
    assert.equal(errorCode(legacy), 'CHANNEL_LINK_NOT_VERIFIED');
    const legacyAsserted = await tgSend(h, ALICE, { chatId: '3003', text: 'x' });
    assert.equal(errorCode(legacyAsserted), 'CHANNEL_LINK_NOT_VERIFIED');
    assert.equal(h.provider.calls.length, 0);
    noSuccessBody(none, 'no link'); noSuccessBody(legacy, 'legacy link');
  });

  it('E: a link in another tenant is not the caller\'s (the same principal id in a different tenant has no destination)', async () => {
    const h = telegramHarness();
    verifiedTg(h, '1001', ALICE);
    const otherTenant = { principalId: ALICE.principalId, tenantId: 'ten_s2c_other' };
    const res = await tgSend(h, otherTenant, { chatId: '1001', text: 'x' });
    assert.equal(res.status, 409);
    assert.equal(errorCode(res), 'CHANNEL_NOT_LINKED');
    assert.equal(h.provider.calls.length, 0);
  });

  it('several verified links with no assertion are ambiguous (refused); an assertion selects among the caller\'s OWN', async () => {
    const h = telegramHarness();
    verifiedTg(h, '1001', ALICE); verifiedTg(h, '1002', ALICE);
    const ambiguous = await tgSend(h, ALICE, { text: 'x' });
    assert.equal(ambiguous.status, 400);
    assert.equal(errorCode(ambiguous), 'CHANNEL_DESTINATION_AMBIGUOUS');
    assert.equal(h.provider.calls.length, 0);
    assert.equal((await tgSend(h, ALICE, { chatId: '1002', text: 'second' })).status, 200);
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['1002']);
  });

  it('F: a missing bot credential is a truthful failure, never a success', async () => {
    const h = telegramHarness(null);
    verifiedTg(h, '1001', ALICE);
    const res = await tgSend(h, ALICE, { text: 'x' });
    assert.equal(res.status, 502);
    assert.equal(errorCode(res), 'CHANNEL_PROVIDER_NOT_CONFIGURED');
    noSuccessBody(res, 'no credential');
    assert.equal(h.provider.calls.length, 0);
    assert.ok(h.events.some((e) => e.includes('channel:telegram_send_failed') && e.includes('NO_PROVIDER_CREDENTIAL')));
    assert.equal(h.events.some((e) => e.includes('channel:telegram_message_sent')), false, 'no success is audited');
  });

  it('G: a provider rejection and a network failure are failures, never a success; the token never leaks', async () => {
    for (const [mode, code] of [['reject', 'CHANNEL_PROVIDER_REJECTED'], ['badjson', 'CHANNEL_PROVIDER_REJECTED'], ['network', 'CHANNEL_PROVIDER_UNREACHABLE']] as const) {
      const h = telegramHarness();
      verifiedTg(h, '1001', ALICE);
      h.provider.mode = mode;
      const res = await tgSend(h, ALICE, { text: 'x' });
      assert.equal(res.status, 502, mode);
      assert.equal(errorCode(res), code, mode);
      noSuccessBody(res, mode);
      assert.equal(h.provider.calls.length, 1, `${mode}: the provider was reached exactly once (after every authority check)`);
      const everything = JSON.stringify(res) + h.events.join('\n') + outputs.join('\n');
      assert.equal(everything.includes(TG_TOKEN), false, `${mode}: bot token must not appear in a response, audit event or log`);
      assert.equal(h.events.some((e) => e.includes('channel:telegram_message_sent')), false, `${mode}: no success audited`);
    }
  });

  it('S1: anonymous and header-forged callers are refused before anything runs; payload validation precedes the provider', async () => {
    const h = telegramHarness();
    verifiedTg(h, '1001', ALICE);
    assert.equal((await tgSend(h, null, { text: 'x' })).status, 401);
    assert.equal((await tgSend(h, null, { chatId: '1001', text: 'x' }, { 'x-principal-id': ALICE.principalId, 'x-nagex-tenant': ALICE.tenantId, 'x-user-id': ALICE.principalId })).status, 401);
    assert.equal((await tgSend(h, ALICE, { chatId: { id: 1 }, text: 'x' })).status, 400);
    assert.equal((await tgSend(h, ALICE, { text: '   ' })).status, 400);
    assert.equal((await tgSend(h, ALICE, {})).status, 400);
    assert.equal(h.provider.calls.length, 0);
  });

  it('the destination really is the one the S2B proof flow created (end to end through the webhook)', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const challenge = await handleAsyncApiRequest('POST', '/api/v1/integrations/telegram/identity/link/challenge', {}, as(ALICE), mockAi, {}, undefined, undefined, undefined, h.service);
      const code = (challenge.data as any).challenge as string;
      const proof = await handleAsyncApiRequest('POST', '/api/v1/integrations/telegram/webhook', { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 4004, type: 'private' }, from: { id: 4004, is_bot: false, first_name: 'A' }, text: `/start ${code}` } }, telegramHeaders(), mockAi, {}, undefined, undefined, undefined, h.service);
      assert.equal((proof.data as any).result.linkOutcome, 'LINKED');
      assert.equal(h.identityStore.get('4004')?.ownershipProof, 'CHANNEL_CHALLENGE');
      h.provider.calls.length = 0;                       // (the link confirmation reply is not under test)
      const sent = await tgSend(h, ALICE, { text: 'after proof' });
      assert.equal(sent.status, 200);
      assert.deepEqual(h.provider.calls.map((c) => c.target), ['4004']);
    });
  });
});

describe('S2C — Slack send is SELF-DELIVERY ONLY, bound to the verified workspace', () => {
  it('A: a caller with an own verified link sends to the destination the SERVER derived (no channel, or an equal assertion + workspace)', async () => {
    const h = slackHarness();
    verifiedSl(h, 'U_A1', ALICE, 'T_ONE');
    assert.equal((await slSend(h, ALICE, { text: 'hello me' })).status, 200);
    assert.equal((await slSend(h, ALICE, { channel: 'U_A1', text: 'again' })).status, 200);
    const full = await slSend(h, ALICE, { channel: 'U_A1', slackTeamId: 'T_ONE', text: 'asserted', threadTs: '1700000000.000100' });
    assert.equal(full.status, 200);
    assert.equal((full.data as any).destination, 'OWN_VERIFIED_SLACK');
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['U_A1', 'U_A1', 'U_A1']);
  });

  it('B: a channel that is not the caller\'s own verified destination (public channel, another DM, a channel id) is refused before the provider', async () => {
    const h = slackHarness();
    verifiedSl(h, 'U_A1', ALICE);
    for (const channel of ['C_ARBITRARY', 'G_PRIVATE', 'D_SOMEONE', 'U_OTHER', '#general', 'U_A1,U_B1']) {
      const res = await slSend(h, ALICE, { channel, text: 'not mine' });
      assert.equal(res.status, 403, channel);
      assert.equal(errorCode(res), 'CHANNEL_DESTINATION_NOT_AUTHORIZED', channel);
      noSuccessBody(res, channel);
    }
    assert.equal(h.provider.calls.length, 0);
  });

  it('C: another user\'s verified destination is refused', async () => {
    const h = slackHarness();
    verifiedSl(h, 'U_A1', ALICE); verifiedSl(h, 'U_B1', BOB);
    const res = await slSend(h, ALICE, { channel: 'U_B1', text: 'phish' });
    assert.equal(res.status, 403);
    assert.equal(h.provider.calls.length, 0);
    const smuggled = await slSend(h, ALICE, { text: 'hi', to: 'U_B1', user: 'U_B1', slackUserId: 'U_B1', principalId: BOB.principalId });
    assert.equal(smuggled.status, 200);
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['U_A1']);
  });

  it('D: no verified link is refused explicitly (none, or a link that predates S2B / carries no workspace)', async () => {
    const h = slackHarness();
    assert.equal(errorCode(await slSend(h, ALICE, { text: 'x' })), 'CHANNEL_NOT_LINKED');
    h.identityStore.link('U_OLD', ALICE.principalId, ALICE.tenantId, 'T_ONE');                       // predates S2B: no proof
    assert.equal(errorCode(await slSend(h, ALICE, { text: 'x' })), 'CHANNEL_LINK_NOT_VERIFIED');
    assert.equal(errorCode(await slSend(h, ALICE, { channel: 'U_OLD', text: 'x' })), 'CHANNEL_LINK_NOT_VERIFIED');
    h.identityStore.link('U_NOTEAM', ALICE.principalId, ALICE.tenantId, undefined, undefined, 'CHANNEL_CHALLENGE');   // proven but no workspace
    assert.equal(errorCode(await slSend(h, ALICE, { channel: 'U_NOTEAM', text: 'x' })), 'CHANNEL_LINK_NOT_VERIFIED');
    assert.equal(h.provider.calls.length, 0);
  });

  it('E: tenant mismatch is refused (the same principal id in another tenant has no destination)', async () => {
    const h = slackHarness();
    verifiedSl(h, 'U_A1', ALICE);
    const res = await slSend(h, { principalId: ALICE.principalId, tenantId: 'ten_s2c_other' }, { channel: 'U_A1', text: 'x' });
    assert.equal(res.status, 409);
    assert.equal(errorCode(res), 'CHANNEL_NOT_LINKED');
    assert.equal(h.provider.calls.length, 0);
  });

  it('workspace binding: an asserted workspace, or the bot\'s configured workspace, that differs from the verified link is refused; no cross-workspace fallback', async () => {
    const h = slackHarness();
    verifiedSl(h, 'U_A1', ALICE, 'T_ONE');
    const wrongAsserted = await slSend(h, ALICE, { channel: 'U_A1', slackTeamId: 'T_OTHER', text: 'x' });
    assert.equal(wrongAsserted.status, 403);
    assert.equal(errorCode(wrongAsserted), 'CHANNEL_WORKSPACE_MISMATCH');
    const prev = process.env.SLACK_TEAM_ID;
    try {
      process.env.SLACK_TEAM_ID = 'T_BOT_WORKSPACE';          // the bot belongs to another workspace than the proven link
      const botMismatch = await slSend(h, ALICE, { text: 'x' });
      assert.equal(errorCode(botMismatch), 'CHANNEL_WORKSPACE_MISMATCH');
      process.env.SLACK_TEAM_ID = 'T_ONE';
      assert.equal((await slSend(h, ALICE, { text: 'x' })).status, 200);
    } finally {
      if (prev === undefined) delete process.env.SLACK_TEAM_ID; else process.env.SLACK_TEAM_ID = prev;
    }
    // two verified links in two workspaces: the workspace asserted for a user must be the one that user was proven in
    verifiedSl(h, 'U_A2', ALICE, 'T_TWO');
    h.provider.calls.length = 0;
    assert.equal(errorCode(await slSend(h, ALICE, { text: 'x' })), 'CHANNEL_DESTINATION_AMBIGUOUS');
    assert.equal(errorCode(await slSend(h, ALICE, { channel: 'U_A2', slackTeamId: 'T_ONE', text: 'x' })), 'CHANNEL_WORKSPACE_MISMATCH');
    assert.equal((await slSend(h, ALICE, { channel: 'U_A2', slackTeamId: 'T_TWO', text: 'x' })).status, 200);
    assert.deepEqual(h.provider.calls.map((c) => c.target), ['U_A2']);
  });

  it('F: a missing bot credential is a truthful failure, never a success', async () => {
    const h = slackHarness(null);
    verifiedSl(h, 'U_A1', ALICE);
    const res = await slSend(h, ALICE, { text: 'x' });
    assert.equal(res.status, 502);
    assert.equal(errorCode(res), 'CHANNEL_PROVIDER_NOT_CONFIGURED');
    noSuccessBody(res, 'no credential');
    assert.equal(h.provider.calls.length, 0);
    assert.equal(h.events.some((e) => e.includes('channel:slack_message_sent')), false);
  });

  it('G: a provider rejection and a network failure are failures, never a success; the token never leaks', async () => {
    for (const [mode, code] of [['reject', 'CHANNEL_PROVIDER_REJECTED'], ['badjson', 'CHANNEL_PROVIDER_REJECTED'], ['network', 'CHANNEL_PROVIDER_UNREACHABLE']] as const) {
      const h = slackHarness();
      verifiedSl(h, 'U_A1', ALICE);
      h.provider.mode = mode;
      const res = await slSend(h, ALICE, { text: 'x' });
      assert.equal(res.status, 502, mode);
      assert.equal(errorCode(res), code, mode);
      noSuccessBody(res, mode);
      const everything = JSON.stringify(res) + h.events.join('\n') + outputs.join('\n');
      assert.equal(everything.includes(SLACK_TOKEN), false, `${mode}: bot token must not leak`);
      assert.equal(everything.includes(h.provider.calls[0]?.auth ?? '@@none@@'), false);
    }
  });

  it('S1: anonymous and header-forged callers are refused; payload validation precedes the provider', async () => {
    const h = slackHarness();
    verifiedSl(h, 'U_A1', ALICE);
    assert.equal((await slSend(h, null, { text: 'x' })).status, 401);
    assert.equal((await slSend(h, null, { channel: 'U_A1', text: 'x' }, { 'x-principal-id': ALICE.principalId, 'x-nagex-tenant': ALICE.tenantId })).status, 401);
    assert.equal((await slSend(h, ALICE, { channel: 12345, text: 'x' })).status, 400);
    assert.equal((await slSend(h, ALICE, { slackTeamId: { a: 1 }, text: 'x' })).status, 400);
    assert.equal((await slSend(h, ALICE, { text: '' })).status, 400);
    assert.equal(h.provider.calls.length, 0);
  });

  it('the destination really is the one the S2B proof flow created, in the workspace the event named', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const code = ((await handleAsyncApiRequest('POST', '/api/v1/integrations/slack/identity/link/challenge', {}, as(ALICE), mockAi, {}, undefined, undefined, undefined, undefined, h.service)).data as any).challenge as string;
      const ev = signedSlackEvent({ type: 'message', channel_type: 'im', user: 'U_PROVEN', channel: 'D1', text: `link ${code}`, ts: '1.1' }, { team_id: 'T_PROVEN' });
      const proof = await handleAsyncApiRequest('POST', '/api/v1/integrations/slack/events', ev.body, ev.headers, mockAi, {}, undefined, undefined, undefined, undefined, h.service);
      assert.equal((proof.data as any).result.linkOutcome, 'LINKED');
      assert.deepEqual([h.identityStore.get('U_PROVEN')?.ownershipProof, h.identityStore.get('U_PROVEN')?.slackTeamId], ['CHANNEL_CHALLENGE', 'T_PROVEN']);
      h.provider.calls.length = 0;
      assert.equal((await slSend(h, ALICE, { slackTeamId: 'T_PROVEN', text: 'after proof' })).status, 200);
      assert.deepEqual(h.provider.calls.map((c) => c.target), ['U_PROVEN']);
    });
  });
});

// ── notifications ──
function notificationHarness() {
  const dir = tmp('notif');
  const tg = fakeProvider();
  const sl = fakeProvider();
  const { auditLogger, events } = instrumentAudit();
  const store = new NotificationStore({ dir: path.join(dir, 'n') });
  const tgIdentity = new TelegramIdentityStore({ dir: path.join(dir, 'tg') });
  const slIdentity = new SlackIdentityStore({ dir: path.join(dir, 'sl') });
  const engine = new NotificationEngine({
    store, auditLogger, telegramIdentityStore: tgIdentity, slackIdentityStore: slIdentity,
    telegramBotClient: new TelegramBotClient(TG_TOKEN, tg.fetchFn), slackClient: new SlackClient(SLACK_TOKEN, sl.fetchFn),
  });
  return { dir, tg, sl, store, tgIdentity, slIdentity, engine, events };
}
type NH = ReturnType<typeof notificationHarness>;
const dispatch = (h: NH, who: Who | null, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
  handleAsyncApiRequest('POST', DISPATCH, body, who ? as(who) : extraHeaders, mockAi, {}, undefined, undefined, undefined, undefined, undefined, h.engine);
const feed = (h: NH, who: Who) => h.store.list(who.tenantId, who.principalId);
const providerCalls = (h: NH): number => h.tg.calls.length + h.sl.calls.length;
const note = { type: 'SYSTEM_ALERT', title: 'S2C title', body: 'S2C body' };

describe('S2C — notification dispatch: the recipient is the authenticated caller', () => {
  it('A/B/C: a self dispatch succeeds, with no principal/tenant, or with ones equal to the caller (a redundant assertion)', async () => {
    const h = notificationHarness();
    for (const extra of [{}, { principalId: ALICE.principalId }, { tenantId: ALICE.tenantId }, { principalId: ALICE.principalId, tenantId: ALICE.tenantId }, { principalId: '', tenantId: '  ' }, { principalId: null }]) {
      const res = await dispatch(h, ALICE, { ...note, ...extra });
      assert.equal(res.status, 201, JSON.stringify(extra));
      assert.equal((res.data as any).principalId, ALICE.principalId);
      assert.equal((res.data as any).tenantId, ALICE.tenantId);
    }
    assert.equal(feed(h, ALICE).length, 6);
    assert.equal(feed(h, BOB).length, 0);
  });

  it('D/E/F: another principal, another tenant, or both is refused with ZERO notification write', async () => {
    const h = notificationHarness();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['another principal', { principalId: BOB.principalId }],
      ['another tenant', { tenantId: BOB.tenantId }],
      ['another principal in another tenant', { principalId: BOB.principalId, tenantId: BOB.tenantId }],
      ['another principal in the caller\'s tenant', { principalId: BOB.principalId, tenantId: ALICE.tenantId }],
      ['the caller\'s own id in another tenant', { principalId: ALICE.principalId, tenantId: BOB.tenantId }],
      ['non-string principal', { principalId: 12345 }],
      ['object tenant', { tenantId: { id: BOB.tenantId } }],
      ['array principal', { principalId: [ALICE.principalId] }],
    ];
    for (const [label, extra] of cases) {
      const res = await dispatch(h, ALICE, { ...note, ...extra });
      assert.equal(res.status, 403, label);
      assert.equal(errorCode(res), 'NOTIFICATION_RECIPIENT_NOT_AUTHORIZED', label);
    }
    assert.equal(feed(h, ALICE).length, 0, 'nothing was written for the caller either');
    assert.equal(feed(h, BOB).length, 0, 'CROSS_USER_NOTIFICATION_WRITE=0');
    assert.deepEqual(h.store.list('ten_s2c_other', ALICE.principalId), []);
    assert.equal(h.events.filter((e) => e.includes('notification:dispatch_denied')).length, cases.length);
    assert.equal(h.events.some((e) => e.includes('notification:dispatched')), false, 'no success is audited');
  });

  it('G: a rejected dispatch causes ZERO Telegram/Slack fan-out, even when the target has verified AND legacy links', async () => {
    const h = notificationHarness();
    h.tgIdentity.link('2002', BOB.principalId, BOB.tenantId, 'bob', 'CHANNEL_CHALLENGE');
    h.slIdentity.link('U_B1', BOB.principalId, BOB.tenantId, 'T_ONE', 'bob', 'CHANNEL_CHALLENGE');
    h.tgIdentity.link('2003', ALICE.principalId, ALICE.tenantId, 'alice-legacy');
    for (const extra of [{ principalId: BOB.principalId, tenantId: BOB.tenantId }, { principalId: BOB.principalId }, { tenantId: BOB.tenantId }]) {
      assert.equal((await dispatch(h, ALICE, { ...note, ...extra })).status, 403);
    }
    assert.equal(providerCalls(h), 0, 'OUTBOUND_PROVIDER_INVOCATION=0, CROSS_USER_CHANNEL_SEND=0, CROSS_TENANT_CHANNEL_SEND=0');
    assert.equal(feed(h, BOB).length, 0);
  });

  it('a user-originated dispatch fans out only to the CALLER\'s own ownership-proven links', async () => {
    const h = notificationHarness();
    h.tgIdentity.link('1001', ALICE.principalId, ALICE.tenantId, 'a', 'CHANNEL_CHALLENGE');
    h.slIdentity.link('U_A1', ALICE.principalId, ALICE.tenantId, 'T_ONE', 'a', 'CHANNEL_CHALLENGE');
    h.tgIdentity.link('2002', BOB.principalId, BOB.tenantId, 'b', 'CHANNEL_CHALLENGE');
    const res = await dispatch(h, ALICE, note);
    assert.equal(res.status, 201);
    assert.deepEqual(h.tg.calls.map((c) => c.target), ['1001']);
    assert.deepEqual(h.sl.calls.map((c) => c.target), ['U_A1']);
    const deliveries = (res.data as any).channelDeliveries as Array<{ channel: string; status: string; targetId?: string }>;
    assert.deepEqual(deliveries.filter((d) => d.channel !== 'WEB').map((d) => `${d.channel}:${d.status}:${d.targetId}`).sort(), ['SLACK:DELIVERED:U_A1', 'TELEGRAM:DELIVERED:1001']);
  });

  it('a link that predates S2B (never proven) receives no user-originated content: the web notification is written, the channel is not used', async () => {
    const h = notificationHarness();
    h.tgIdentity.link('9009', ALICE.principalId, ALICE.tenantId, 'hijackable-legacy');
    h.slIdentity.link('U_LEGACY', ALICE.principalId, ALICE.tenantId, 'T_ONE', 'legacy');
    const res = await dispatch(h, ALICE, note);
    assert.equal(res.status, 201);
    assert.equal(providerCalls(h), 0);
    assert.deepEqual(((res.data as any).channelDeliveries as Array<{ channel: string }>).map((d) => d.channel), ['WEB']);
    assert.equal(feed(h, ALICE).length, 1);
  });

  it('a channel failure is recorded truthfully on the notification (FAILED with its reason), never DELIVERED', async () => {
    const h = notificationHarness();
    h.tgIdentity.link('1001', ALICE.principalId, ALICE.tenantId, 'a', 'CHANNEL_CHALLENGE');
    h.tg.mode = 'reject';
    const res = await dispatch(h, ALICE, note);
    const tgDelivery = ((res.data as any).channelDeliveries as Array<{ channel: string; status: string; error?: string }>).find((d) => d.channel === 'TELEGRAM');
    assert.equal(tgDelivery?.status, 'FAILED');
    assert.equal(tgDelivery?.error, 'PROVIDER_REJECTION');
    // and a bot with NO credential never reports delivery either
    const dir = tmp('nocred');
    const engine = new NotificationEngine({ store: new NotificationStore({ dir }), auditLogger: new AuditLogger(), telegramIdentityStore: h.tgIdentity, telegramBotClient: new TelegramBotClient(null) });
    const rec = await engine.dispatch({ tenantId: ALICE.tenantId, principalId: ALICE.principalId, type: 'SYSTEM_ALERT', title: 't', body: 'b' });
    assert.equal(rec.channelDeliveries.find((d) => d.channel === 'TELEGRAM')?.status, 'FAILED');
    assert.equal(rec.channelDeliveries.find((d) => d.channel === 'TELEGRAM')?.error, 'NO_PROVIDER_CREDENTIAL');
  });

  it('INTERNAL server dispatch is unchanged: trusted code names the recipient, and its linked channels (including pre-S2B links) still get delivery', async () => {
    const h = notificationHarness();
    h.tgIdentity.link('2002', BOB.principalId, BOB.tenantId, 'bob-legacy');                      // legacy link: internal delivery is untouched
    h.slIdentity.link('U_B1', BOB.principalId, BOB.tenantId, 'T_ONE', 'bob', 'CHANNEL_CHALLENGE');
    const rec = await h.engine.dispatch({ tenantId: BOB.tenantId, principalId: BOB.principalId, type: 'TASK_COMPLETED', title: 'Daily brief', body: 'ready' });
    assert.equal(rec.principalId, BOB.principalId);
    assert.deepEqual(feed(h, BOB).map((n) => n.title), ['Daily brief']);
    assert.deepEqual(h.tg.calls.map((c) => c.target), ['2002']);
    assert.deepEqual(h.sl.calls.map((c) => c.target), ['U_B1']);
    // dedupe still works for internal runners
    const a = await h.engine.dispatch({ tenantId: BOB.tenantId, principalId: BOB.principalId, type: 'TASK_COMPLETED', title: 'once', body: 'x', dedupeKey: 'task:run:done' });
    const b = await h.engine.dispatch({ tenantId: BOB.tenantId, principalId: BOB.principalId, type: 'TASK_COMPLETED', title: 'once', body: 'x', dedupeKey: 'task:run:done' });
    assert.equal(a.id, b.id);
  });

  it('there is no HTTP way to reach internal dispatch: no header, flag or body field changes the recipient', async () => {
    const h = notificationHarness();
    const res = await dispatch(h, ALICE, { ...note, principalId: BOB.principalId, internal: true, system: true, source: 'daily-brief', __internal: true }, {});
    assert.equal(res.status, 403);
    const viaHeaders = await handleAsyncApiRequest('POST', DISPATCH, { ...note, principalId: BOB.principalId }, { ...as(ALICE), 'x-nagex-internal': '1', 'x-internal-dispatch': 'true', 'x-system': '1' }, mockAi, {}, undefined, undefined, undefined, undefined, undefined, h.engine);
    assert.equal(viaHeaders.status, 403);
    assert.equal(feed(h, BOB).length, 0);
    assert.equal(providerCalls(h), 0);
  });

  it('S1: anonymous and header-forged dispatch is refused; validation still precedes any write', async () => {
    const h = notificationHarness();
    assert.equal((await dispatch(h, null, note)).status, 401);
    assert.equal((await dispatch(h, null, { ...note, principalId: BOB.principalId }, { 'x-principal-id': BOB.principalId, 'x-nagex-tenant': BOB.tenantId })).status, 401);
    assert.equal((await dispatch(h, ALICE, { type: 'SYSTEM_ALERT', title: 'no body' })).status, 400);
    assert.equal(feed(h, ALICE).length + feed(h, BOB).length, 0);
  });

  it('over the real application wiring a foreign recipient is refused and a self dispatch works', async () => {
    const server = await import('../src/server_web.js');
    const user = authAs('ten_s2c_http_a', 'usr_s2c_http_a');
    const victim = authAs('ten_s2c_http_b', 'usr_s2c_http_b');
    await server.withTestServer(async (origin) => {
      const post = (headers: Record<string, string>, body: unknown) => fetch(origin + DISPATCH, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const refused = await post({ cookie: user.cookie }, { ...note, body: 'S2C-HTTP-INJECTED', principalId: 'usr_s2c_http_b', tenantId: 'ten_s2c_http_b' });
      assert.equal(refused.status, 403);
      const ok = await post({ cookie: user.cookie }, { ...note, body: 'S2C-HTTP-SELF' });
      assert.equal(ok.status, 201);
      const victimFeed = JSON.stringify(await (await fetch(origin + '/api/v1/notifications', { headers: { cookie: victim.cookie } })).json());
      assert.equal(victimFeed.includes('S2C-HTTP-INJECTED'), false);
      assert.equal(victimFeed.includes('S2C-HTTP-SELF'), false);
      const ownFeed = JSON.stringify(await (await fetch(origin + '/api/v1/notifications', { headers: { cookie: user.cookie } })).json());
      assert.equal(ownFeed.includes('S2C-HTTP-SELF'), true);
      assert.equal(ownFeed.includes('S2C-HTTP-INJECTED'), false);
    });
  });
});
