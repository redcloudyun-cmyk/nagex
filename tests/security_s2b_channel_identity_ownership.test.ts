// Security Gate S2B — channel identity OWNERSHIP.
//
// S2A proved a webhook REQUEST really comes from Telegram/Slack. S2B proves the person behind a Telegram/Slack account
// really is the NAgex principal it gets linked to. Before S2B any signed-in principal could submit any Telegram/Slack user
// id and have it bound to itself (and a second principal could silently take it over), after which the real owner's genuine
// messages were resolved to the attacker's account. These tests drive the real route + service entry points, with
// tripwires behind them, to prove: a client-supplied id never links; only a one-time challenge redeemed FROM the channel
// does, bound to the principal/tenant that issued it; every failed proof writes nothing; an existing link is never silently
// taken over; and a challenge can be spent once even under concurrency.
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
import { ChannelLinkChallengeStore, CHANNEL_LINK_TTL_MS, normalizeChallengeToken, parseChannelLinkCommand } from '../src/integrations/channel-link-challenge.store.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';
import { BOTH_SECRETS, TEST_SLACK_SIGNING_SECRET, TEST_TELEGRAM_SECRET, signedSlackEvent, slackRequest, slackSignature, telegramHeaders, withWebhookSecrets } from './_s2a_webhooks.js';

const TG_CHALLENGE = '/api/v1/integrations/telegram/identity/link/challenge';
const TG_LINK = '/api/v1/integrations/telegram/identity/link';
const TG_IDENTITIES = '/api/v1/integrations/telegram/identities';
const TG_UNLINK = '/api/v1/integrations/telegram/identity';
const TG_HOOK = '/api/v1/integrations/telegram/webhook';
const SL_CHALLENGE = '/api/v1/integrations/slack/identity/link/challenge';
const SL_LINK = '/api/v1/integrations/slack/identity/link';
const SL_IDENTITIES = '/api/v1/integrations/slack/identities';
const SL_UNLINK = '/api/v1/integrations/slack/identity';
const SL_HOOK = '/api/v1/integrations/slack/events';

const ALICE = { principalId: 'usr_s2b_alice', tenantId: 'ten_s2b_alice' };
const BOB = { principalId: 'usr_s2b_bob', tenantId: 'ten_s2b_bob' };
type Who = typeof ALICE;

interface Trip { model: number; conversationWrites: number; memoryReads: number; linkWrites: number; outboundSends: number }
const newTrip = (): Trip => ({ model: 0, conversationWrites: 0, memoryReads: 0, linkWrites: 0, outboundSends: 0 });
const mockAi = (t: Trip): any => ({
  statuses: () => [],
  chat: async (p: any) => { t.model++; return { status: 'SUCCESS', provider: 'mock', model: 'm', latencyMs: 1, requestId: p.requestId, data: { message: `Echo: ${p.message}` } }; },
  plan: async (p: any) => { t.model++; return { status: 'PLAN_PREVIEW', provider: 'mock', model: 'm', latencyMs: 1, requestId: p.requestId, data: { goal: 'g', summary: 's', reasoningSummary: 'r', steps: [] } }; },
});

function instrument(dir: string, t: Trip) {
  const audit: string[] = [];
  const auditLogger = new AuditLogger();
  const origLog = auditLogger.logEvent.bind(auditLogger);
  (auditLogger as any).logEvent = (e: any) => { audit.push(JSON.stringify(e)); return origLog(e); };
  const conversations = new ConversationStore({ dir: path.join(dir, 'conversations') });
  const origAppend = conversations.append.bind(conversations);
  (conversations as any).append = (...a: any[]) => { t.conversationWrites++; return (origAppend as any)(...a); };
  const resolver = new PlanResolver(skillRegistry, toolRegistry);
  return { audit, auditLogger, conversations, resolver, sessions: new SessionStore({ dir: path.join(dir, 'sessions') }), getMemories: () => { t.memoryReads++; return []; } };
}

function telegramHarness(clock?: { now: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-s2b-tg-'));
  const t = newTrip();
  const i = instrument(dir, t);
  const identityStore = new TelegramIdentityStore({ dir });
  const origLink = identityStore.link.bind(identityStore);
  (identityStore as any).link = (...a: any[]) => { t.linkWrites++; return (origLink as any)(...a); };
  const botClient = new TelegramBotClient(null);
  const origSend = botClient.sendMessage.bind(botClient);
  const replies: string[] = [];
  (botClient as any).sendMessage = (o: any) => { t.outboundSends++; replies.push(String(o.text)); return origSend(o); };
  const challengeStore = new ChannelLinkChallengeStore(clock ? { now: () => clock.now } : {});
  const service = new TelegramService({ botClient, identityStore, sessionStore: i.sessions, aiService: mockAi(t), planResolver: i.resolver, getMemories: i.getMemories, auditLogger: i.auditLogger, conversationStore: i.conversations, challengeStore });
  return { dir, t, service, identityStore, challengeStore, replies, ...i };
}

function slackHarness(clock?: { now: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-s2b-slack-'));
  const t = newTrip();
  const i = instrument(dir, t);
  const identityStore = new SlackIdentityStore({ dir });
  const origLink = identityStore.link.bind(identityStore);
  (identityStore as any).link = (...a: any[]) => { t.linkWrites++; return (origLink as any)(...a); };
  const slackClient = new SlackClient(null);
  const origPost = slackClient.postMessage.bind(slackClient);
  const replies: string[] = [];
  (slackClient as any).postMessage = (o: any) => { t.outboundSends++; replies.push(String(o.text)); return origPost(o); };
  const challengeStore = new ChannelLinkChallengeStore(clock ? { now: () => clock.now } : {});
  const service = new SlackService({ slackClient, identityStore, sessionStore: i.sessions, aiService: mockAi(t), planResolver: i.resolver, getMemories: i.getMemories, auditLogger: i.auditLogger, conversationStore: i.conversations, challengeStore });
  return { dir, t, service, identityStore, challengeStore, replies, ...i };
}
type TgH = ReturnType<typeof telegramHarness>;
type SlH = ReturnType<typeof slackHarness>;

const tgCall = (h: TgH, method: string, url: string, body: Record<string, unknown> | null, headers: Record<string, string | string[] | undefined>) =>
  handleAsyncApiRequest(method, url, body, headers, undefined, {}, undefined, undefined, undefined, h.service);
const slCall = (h: SlH, method: string, url: string, body: Record<string, unknown> | null, headers: Record<string, string | string[] | undefined>) =>
  handleAsyncApiRequest(method, url, body, headers, undefined, {}, undefined, undefined, undefined, undefined, h.service);

const as = (w: Who) => authAs(w.tenantId, w.principalId);
async function tgIssue(h: TgH, w: Who, body: Record<string, unknown> = {}): Promise<string> {
  const res = await tgCall(h, 'POST', TG_CHALLENGE, body, as(w));
  assert.equal(res.status, 201);
  return (res.data as any).challenge as string;
}
async function slIssue(h: SlH, w: Who, body: Record<string, unknown> = {}): Promise<string> {
  const res = await slCall(h, 'POST', SL_CHALLENGE, body, as(w));
  assert.equal(res.status, 201);
  return (res.data as any).challenge as string;
}

let updateId = 1000;
interface TgSend { from?: number; chat?: 'private' | 'group' | 'supergroup'; text: string; headers?: Record<string, string | string[] | undefined>; edited?: boolean; bot?: boolean }
const tgSend = (h: TgH, o: TgSend) => {
  const from = o.from ?? 424242;
  const msg = { message_id: 1, date: 1, chat: { id: o.chat && o.chat !== 'private' ? -from : from, type: o.chat ?? 'private' }, from: { id: from, is_bot: o.bot ?? false, first_name: 'Sender', username: `u${from}` }, text: o.text };
  return tgCall(h, 'POST', TG_HOOK, { update_id: ++updateId, ...(o.edited ? { edited_message: msg } : { message: msg }) }, o.headers ?? telegramHeaders());
};
interface SlSend { user?: string; team?: string | null; channelType?: string; text: string }
const slSend = (h: SlH, o: SlSend) => {
  const ev = signedSlackEvent({ type: 'message', channel_type: o.channelType ?? 'im', user: o.user ?? 'U_SENDER', channel: 'D_SENDER', text: o.text, ts: '1.1' }, o.team === null ? {} : { team_id: o.team ?? 'T_ONE' });
  return slCall(h, 'POST', SL_HOOK, ev.body, ev.headers);
};
const outcome = (res: { data: unknown }): string | undefined => (res.data as any)?.result?.linkOutcome;

const noLinkWritten = (t: Trip, label: string): void => assert.equal(t.linkWrites, 0, `${label}: no link was attempted/written`);
const noChatSideEffects = (t: Trip, label: string): void => {
  assert.equal(t.model, 0, `${label}: no model call`);
  assert.equal(t.conversationWrites, 0, `${label}: no conversation write`);
  assert.equal(t.memoryReads, 0, `${label}: no memory read`);
};

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

describe('S2B — a client-supplied channel identity is not proof', () => {
  it('the old link routes refuse every body (CLIENT_ID_ONLY) and write nothing, for both integrations', async () => {
    const tg = telegramHarness(); const sl = slackHarness();
    for (const body of [{ telegramUserId: '555' }, { telegramUserId: '555', principalId: BOB.principalId, tenantId: BOB.tenantId }, {}]) {
      const r = await tgCall(tg, 'POST', TG_LINK, body, as(ALICE));
      assert.equal(r.status, 400);
      assert.equal((r.data as any).error.code, 'CHANNEL_LINK_PROOF_REQUIRED');
    }
    for (const body of [{ slackUserId: 'U555', slackTeamId: 'T1' }, { slackUserId: 'U555', principalId: BOB.principalId, tenantId: BOB.tenantId }, {}]) {
      const r = await slCall(sl, 'POST', SL_LINK, body, as(ALICE));
      assert.equal(r.status, 400);
      assert.equal((r.data as any).error.code, 'CHANNEL_LINK_PROOF_REQUIRED');
    }
    assert.equal(tg.identityStore.list().length, 0);
    assert.equal(sl.identityStore.list().length, 0);
    noLinkWritten(tg.t, 'telegram'); noLinkWritten(sl.t, 'slack');
    // still session-only
    assert.equal((await tgCall(tg, 'POST', TG_LINK, { telegramUserId: '555' }, {})).status, 401);
    assert.equal((await slCall(sl, 'POST', SL_LINK, { slackUserId: 'U555' }, {})).status, 401);
  });

  it('the challenge route needs a session and ignores any identity named in the body', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      assert.equal((await tgCall(h, 'POST', TG_CHALLENGE, { telegramUserId: '777' }, {})).status, 401);
      // the body names the VICTIM's id and principal; none of it matters
      const code = await tgIssue(h, ALICE, { telegramUserId: '777', principalId: BOB.principalId, tenantId: BOB.tenantId });
      const res = await tgSend(h, { from: 888, text: `/start ${code}` });
      assert.equal(outcome(res), 'LINKED');
      assert.equal(h.identityStore.get('777'), undefined, 'the id named by the client was not linked');
      assert.equal(h.identityStore.get('888')?.principalId, ALICE.principalId, 'the proven sender was bound to the principal that issued the code');
      assert.equal(h.identityStore.get('888')?.tenantId, ALICE.tenantId);
    });
  });

  it('the challenge response is not cacheable and has the documented shape', async () => {
    const h = telegramHarness();
    const res = await tgCall(h, 'POST', TG_CHALLENGE, {}, as(ALICE));
    assert.equal(res.status, 201);
    assert.equal((res as any).headers['Cache-Control'], 'no-store');
    assert.match((res.data as any).challenge, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal((res.data as any).ttlSeconds, CHANNEL_LINK_TTL_MS / 1000);
    assert.equal((res.data as any).instructions.command, `/start ${(res.data as any).challenge}`);
  });
});

describe('S2B — Telegram ownership proof', () => {
  it('VALID_OWNERSHIP_PROOF → linked to the issuing principal and tenant; nothing else runs; the code is never stored or logged', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const code = await tgIssue(h, ALICE);
      const res = await tgSend(h, { from: 424242, text: `/start ${code}` });
      assert.equal(res.status, 200);
      assert.equal(outcome(res), 'LINKED');
      const link = h.identityStore.get('424242')!;
      assert.equal(link.principalId, ALICE.principalId);
      assert.equal(link.tenantId, ALICE.tenantId);
      assert.deepEqual(h.identityStore.resolve('424242'), { principalId: ALICE.principalId, tenantId: ALICE.tenantId });
      noChatSideEffects(h.t, 'link attempt');
      assert.equal(h.t.outboundSends, 1);
      assert.match(h.replies[0], /linked/i);
      // persisted
      assert.equal(new TelegramIdentityStore({ dir: h.dir }).get('424242')?.principalId, ALICE.principalId);
      // the code is nowhere
      const everything = [...h.audit, ...outputs, ...h.replies, JSON.stringify(h.conversations.listSession(ALICE.tenantId, ALICE.principalId, 'x'))].join('\n');
      assert.equal(everything.includes(code), false, 'the code is never logged, audited, replied or stored as a conversation');
      assert.equal(everything.includes(code.replace(/-/g, '')), false);
      assert.equal(everything.includes(TEST_TELEGRAM_SECRET), false);
      assert.equal(h.audit.some((a) => a.includes('channel:telegram_identity_linked')), true);
    });
  });

  it('the proven identity is then used for ordinary messages (the unchanged pipeline)', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      await tgSend(h, { from: 424242, text: `/start ${await tgIssue(h, ALICE)}` });
      const chat = await tgSend(h, { from: 424242, text: 'hello there' });
      assert.equal(chat.status, 200);
      assert.equal((chat.data as any).result.principalId, ALICE.principalId);
      assert.equal(h.t.model, 1);
    });
  });

  it('every failed proof is denied with the same reply and causes no link write, no principal/tenant change, no chat side effect', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const clock = { now: 1_000_000 };
      const h = telegramHarness(clock);
      // an existing, unrelated link that must never change
      h.identityStore.link('111', BOB.principalId, BOB.tenantId, 'bob_tg');
      h.t.linkWrites = 0;
      const before = JSON.stringify(h.identityStore.list());
      const good = await tgIssue(h, ALICE);
      const stale = await tgIssue(h, BOB);          // BOB's second request replaces nothing of ALICE's
      clock.now += CHANNEL_LINK_TTL_MS + 1;          // both are now expired
      const cases: Array<[string, TgSend]> = [
        ['UNKNOWN_CHALLENGE', { from: 424242, text: '/start ZZZZ-ZZZZ-ZZZZ' }],
        ['EXPIRED_CHALLENGE', { from: 424242, text: `/start ${good}` }],
        ['EXPIRED_CHALLENGE (other principal)', { from: 424242, text: `/start ${stale}` }],
        ['LINK COMMAND, CODE NEVER ISSUED', { from: 424242, text: '/link 0000-0000-0000' }],
      ];
      for (const [label, send] of cases) {
        const res = await tgSend(h, send);
        assert.equal(res.status, 200, label);
        assert.equal(outcome(res), 'DENIED', label);
        assert.match(h.replies[h.replies.length - 1], /invalid or has expired/, label);
      }
      noLinkWritten(h.t, 'failed proofs');
      noChatSideEffects(h.t, 'failed proofs');
      assert.equal(JSON.stringify(h.identityStore.list()), before, 'principal, tenant and link set are unchanged');
      assert.equal(JSON.stringify(new TelegramIdentityStore({ dir: h.dir }).list()), before, 'and nothing was written to disk');
      assert.equal(h.identityStore.get('424242'), undefined);
    });
  });

  it('REPLAYED_CHALLENGE → the second use (same or another sender) is denied and changes nothing', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const code = await tgIssue(h, ALICE);
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${code}` })), 'LINKED');
      h.t.linkWrites = 0;
      for (const from of [424242, 999001]) {
        const res = await tgSend(h, { from, text: `/start ${code}` });
        assert.equal(outcome(res), 'DENIED');
      }
      noLinkWritten(h.t, 'replay');
      assert.equal(h.identityStore.get('999001'), undefined);
      assert.equal(h.identityStore.get('424242')?.principalId, ALICE.principalId);
      // case and confusable characters normalise to the same (already spent) challenge
      assert.equal(outcome(await tgSend(h, { from: 999002, text: `/start ${code.toLowerCase()}` })), 'DENIED');
      assert.equal(h.identityStore.get('999002'), undefined);
    });
  });

  it('WRONG_PRINCIPAL → a code binds only to the principal that issued it, and cannot be redirected to another', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const aliceCode = await tgIssue(h, ALICE);
      const bobCode = await tgIssue(h, BOB);
      // BOB presents ALICE's code through the browser route: refused, nothing consumed
      const viaRoute = await tgCall(h, 'POST', TG_LINK, { telegramUserId: '424242', challenge: aliceCode }, as(BOB));
      assert.equal(viaRoute.status, 400);
      // whoever sends ALICE's code from the channel links THEIR OWN verified account to ALICE, never to BOB
      assert.equal(outcome(await tgSend(h, { from: 555001, text: `/start ${aliceCode}` })), 'LINKED');
      assert.equal(h.identityStore.get('555001')?.principalId, ALICE.principalId);
      assert.equal(h.identityStore.listForPrincipal(BOB.principalId, BOB.tenantId).length, 0);
      assert.equal(outcome(await tgSend(h, { from: 555002, text: `/start ${bobCode}` })), 'LINKED');
      assert.equal(h.identityStore.get('555002')?.principalId, BOB.principalId);
      assert.equal(h.identityStore.get('555002')?.tenantId, BOB.tenantId);
    });
  });

  it('WRONG_CHANNEL_IDENTITY → a code carrying another account id, an edited message, a group chat or a bot sender never links', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const cases: Array<[string, (code: string) => TgSend]> = [
        ['code followed by ANOTHER account id', (c) => ({ from: 424242, text: `/start ${c} 999777` })],
        ['code followed by prose', (c) => ({ from: 424242, text: `/link ${c} please` })],
        ['group chat', (c) => ({ from: 424242, chat: 'group', text: `/start ${c}` })],
        ['supergroup chat', (c) => ({ from: 424242, chat: 'supergroup', text: `/start ${c}` })],
        ['bot sender', (c) => ({ from: 424242, bot: true, text: `/start ${c}` })],
      ];
      for (const [label, build] of cases) {
        const h = telegramHarness();
        const code = await tgIssue(h, ALICE);
        const res = await tgSend(h, build(code));
        assert.equal(outcome(res), 'DENIED', label);
        noLinkWritten(h.t, label); noChatSideEffects(h.t, label);
        assert.equal(h.identityStore.list().length, 0, label);
        assert.equal(h.identityStore.get('999777'), undefined, label);
        // the exposed code was spent: it cannot be used afterwards from the right place either
        assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${code}` })), 'DENIED', `${label}: spent`);
        assert.equal(h.identityStore.list().length, 0, label);
        assert.equal(h.audit.concat(outputs).join('\n').includes(code), false, `${label}: code not logged`);
      }
      // an EDITED message is dropped entirely and the code stays redeemable from a normal message
      const h = telegramHarness();
      const code = await tgIssue(h, ALICE);
      const edited = await tgSend(h, { from: 424242, text: `/start ${code}`, edited: true });
      assert.equal((edited.data as any).handled, false);
      noLinkWritten(h.t, 'edited'); noChatSideEffects(h.t, 'edited');
      assert.equal(h.conversations.listSession(ALICE.tenantId, ALICE.principalId, 'x').length, 0);
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${code}` })), 'LINKED', 'the edit did not spend the code');
    });
  });

  it('ordinary chat that merely starts with "link" or "/start" is not a link attempt', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      for (const text of ['/start', '/link', 'link calendar', '/start now please', 'link ABCD-EFGH']) {
        const res = await tgSend(h, { from: 424242, text });
        assert.equal(outcome(res), undefined, text);
        assert.equal((res.data as any).handled, true, text);
      }
      assert.equal(h.t.model, 5, 'each went through the normal pipeline');
      noLinkWritten(h.t, 'chat');
    });
  });

  it('WRONG_INTEGRATION → a Telegram challenge is refused by Slack (and unspent), a Slack challenge by Telegram', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const tg = telegramHarness();
      const sl = slackHarness();
      // the two integrations share ONE challenge store in production; share it here so a cross-use is possible at all
      const shared = new ChannelLinkChallengeStore();
      const tgSvc = new TelegramService({ ...(tg.service as any).options, challengeStore: shared });
      const slSvc = new SlackService({ ...(sl.service as any).options, challengeStore: shared });
      const tgCode = tgSvc.createLinkChallenge(ALICE.principalId, ALICE.tenantId).token;
      const slCode = slSvc.createLinkChallenge(BOB.principalId, BOB.tenantId).token;
      const ev1 = signedSlackEvent({ type: 'message', channel_type: 'im', user: 'U_X', channel: 'D1', text: `link ${tgCode}`, ts: '1.1' }, { team_id: 'T1' });
      const r1 = await handleAsyncApiRequest('POST', SL_HOOK, ev1.body, ev1.headers, undefined, {}, undefined, undefined, undefined, undefined, slSvc);
      assert.equal(outcome(r1), 'DENIED');
      const r2 = await handleAsyncApiRequest('POST', TG_HOOK, { update_id: ++updateId, message: { message_id: 1, date: 1, chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: false, first_name: 'x' }, text: `/start ${slCode}` } }, telegramHeaders(), undefined, {}, undefined, undefined, undefined, tgSvc);
      assert.equal(outcome(r2), 'DENIED');
      assert.equal(sl.identityStore.list().length + tg.identityStore.list().length, 0);
      // neither challenge was spent by the wrong bot
      const ok1 = await handleAsyncApiRequest('POST', TG_HOOK, { update_id: ++updateId, message: { message_id: 2, date: 1, chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: false, first_name: 'x' }, text: `/start ${tgCode}` } }, telegramHeaders(), undefined, {}, undefined, undefined, undefined, tgSvc);
      assert.equal(outcome(ok1), 'LINKED');
    });
  });

  it('NO_SILENT_REBIND → an identity linked to one principal cannot be taken over by another; unlinking is explicit and only by the owner', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${await tgIssue(h, ALICE)}` })), 'LINKED');
      const before = JSON.stringify(h.identityStore.get('424242'));
      h.t.outboundSends = 0;
      // BOB (a different principal) holds a valid code and proves control of the SAME Telegram account
      const res = await tgSend(h, { from: 424242, text: `/start ${await tgIssue(h, BOB)}` });
      assert.equal(outcome(res), 'DENIED');
      assert.match(h.replies[h.replies.length - 1], /already linked/i);
      assert.equal(JSON.stringify(h.identityStore.get('424242')), before, 'ALICE still holds the identity, untouched');
      assert.equal(h.identityStore.listForPrincipal(BOB.principalId, BOB.tenantId).length, 0);
      assert.equal(h.audit.some((a) => a.includes('ALREADY_LINKED')), true);
      // the store API itself refuses a silent overwrite too
      assert.throws(() => h.identityStore.link('424242', BOB.principalId, BOB.tenantId), (e: any) => e.code === 'CHANNEL_IDENTITY_ALREADY_LINKED');
      assert.equal(h.identityStore.link('424242', ALICE.principalId, ALICE.tenantId).principalId, ALICE.principalId, 'same principal may refresh');
      // BOB cannot unlink ALICE's identity; ALICE can
      assert.equal(((await tgCall(h, 'DELETE', TG_UNLINK, null, as(BOB))).data as any).unlinked, 0);
      assert.equal(h.identityStore.get('424242')?.principalId, ALICE.principalId);
      assert.equal(((await tgCall(h, 'DELETE', TG_UNLINK, null, as(ALICE))).data as any).unlinked, 1);
      assert.equal(h.identityStore.get('424242'), undefined);
      // after the explicit unlink BOB can prove control and link
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${await tgIssue(h, BOB)}` })), 'LINKED');
      assert.equal(h.identityStore.get('424242')?.principalId, BOB.principalId);
    });
  });

  it('a principal sees only its own links', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      await tgSend(h, { from: 424242, text: `/start ${await tgIssue(h, ALICE)}` });
      await tgSend(h, { from: 424243, text: `/start ${await tgIssue(h, BOB)}` });
      const alice = (await tgCall(h, 'GET', TG_IDENTITIES, null, as(ALICE))).data as any;
      const bob = (await tgCall(h, 'GET', TG_IDENTITIES, null, as(BOB))).data as any;
      assert.deepEqual(alice.identities.map((i: any) => i.telegramUserId), ['424242']);
      assert.deepEqual(bob.identities.map((i: any) => i.telegramUserId), ['424243']);
      assert.equal((await tgCall(h, 'GET', TG_IDENTITIES, null, {})).status, 401);
    });
  });

  it('one challenge per principal at a time: a new request replaces the old one', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const first = await tgIssue(h, ALICE);
      const second = await tgIssue(h, ALICE);
      assert.notEqual(first, second);
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${first}` })), 'DENIED');
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${second}` })), 'LINKED');
    });
  });

  it('S2A still holds: a forged or secret-less webhook cannot redeem a challenge, and does not spend it', async () => {
    const h = telegramHarness();
    const code = await withWebhookSecrets(BOTH_SECRETS, () => tgIssue(h, ALICE));
    // no secret header
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const forged = await tgSend(h, { from: 424242, text: `/start ${code}`, headers: {} });
      assert.equal(forged.status, 401);
      const wrong = await tgSend(h, { from: 424242, text: `/start ${code}`, headers: telegramHeaders('wrong-secret') });
      assert.equal(wrong.status, 401);
    });
    // server secret missing → fail closed
    await withWebhookSecrets({ telegram: null, slack: null }, async () => {
      const closed = await tgSend(h, { from: 424242, text: `/start ${code}` });
      assert.equal(closed.status, 503);
    });
    noLinkWritten(h.t, 'unauthenticated webhooks'); noChatSideEffects(h.t, 'unauthenticated webhooks');
    assert.equal(h.identityStore.list().length, 0);
    assert.equal(h.t.outboundSends, 0);
    // the challenge was NOT spent by the refused requests
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      assert.equal(outcome(await tgSend(h, { from: 424242, text: `/start ${code}` })), 'LINKED');
    });
  });

  it('SINGLE_USE under concurrency → two simultaneous redemptions of one challenge link exactly one account', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const code = await tgIssue(h, ALICE);
      const results = await Promise.all([
        tgSend(h, { from: 111111, text: `/start ${code}` }),
        tgSend(h, { from: 222222, text: `/start ${code}` }),
        tgSend(h, { from: 333333, text: `/start ${code}` }),
      ]);
      const outcomes = results.map(outcome).sort();
      assert.deepEqual(outcomes, ['DENIED', 'DENIED', 'LINKED']);
      assert.equal(h.identityStore.list().length, 1);
      assert.equal(h.t.linkWrites, 1);
    });
  });

  it('the unlinked-sender policy is unchanged: an authentic unlinked sender still gets an isolated identity and the normal pipeline', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = telegramHarness();
      const res = await tgSend(h, { from: 616161, text: 'hello there' });
      assert.equal((res.data as any).result.principalId, 'usr_telegram_616161');
      assert.equal(h.t.model, 1);
      assert.equal(h.identityStore.get('616161'), undefined);
    });
  });
});

describe('S2B — Slack ownership proof', () => {
  it('VALID_OWNERSHIP_PROOF → linked to the issuing principal and tenant, with the workspace taken from the signed event; the code is never stored or logged', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const code = await slIssue(h, ALICE);
      const res = await slSend(h, { user: 'U_A', team: 'T_ONE', text: `link ${code}` });
      assert.equal(res.status, 200);
      assert.equal(outcome(res), 'LINKED');
      const link = h.identityStore.get('U_A')!;
      assert.equal(link.principalId, ALICE.principalId);
      assert.equal(link.tenantId, ALICE.tenantId);
      assert.equal(link.slackTeamId, 'T_ONE');
      noChatSideEffects(h.t, 'link attempt');
      assert.match(h.replies[0], /linked/i);
      assert.equal(new SlackIdentityStore({ dir: h.dir }).get('U_A')?.principalId, ALICE.principalId);
      const everything = [...h.audit, ...outputs, ...h.replies, JSON.stringify(h.conversations.listSession(ALICE.tenantId, ALICE.principalId, 'x'))].join('\n');
      assert.equal(everything.includes(code), false);
      assert.equal(everything.includes(code.replace(/-/g, '')), false);
      assert.equal(everything.includes(TEST_SLACK_SIGNING_SECRET), false);
    });
  });

  it('the workspace is part of the identity: the same user id from a different workspace is not the linked person', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      await slSend(h, { user: 'U_A', team: 'T_ONE', text: `link ${await slIssue(h, ALICE)}` });
      const same = await slSend(h, { user: 'U_A', team: 'T_ONE', text: 'hello there' });
      assert.equal((same.data as any).result.principalId, ALICE.principalId);
      const other = await slSend(h, { user: 'U_A', team: 'T_OTHER', text: 'hello there' });
      assert.equal((other.data as any).result.principalId, 'usr_slack_U_A', 'isolated identity, not ALICE');
      assert.deepEqual(h.identityStore.resolve('U_A', 'T_OTHER'), { principalId: 'usr_slack_U_A', tenantId: 'ten_slack_U_A' });
    });
  });

  it('every failed proof is denied and causes no link write, no principal/tenant change, no chat side effect', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const clock = { now: 5_000_000 };
      const h = slackHarness(clock);
      h.identityStore.link('U_BOB', BOB.principalId, BOB.tenantId, 'T_ONE');
      h.t.linkWrites = 0;
      const before = JSON.stringify(h.identityStore.list());
      const good = await slIssue(h, ALICE);
      clock.now += CHANNEL_LINK_TTL_MS + 1;
      const cases: Array<[string, SlSend]> = [
        ['UNKNOWN_CHALLENGE', { text: 'link ZZZZ-ZZZZ-ZZZZ' }],
        ['EXPIRED_CHALLENGE', { text: `link ${good}` }],
      ];
      for (const [label, send] of cases) {
        const res = await slSend(h, send);
        assert.equal(outcome(res), 'DENIED', label);
        assert.match(h.replies[h.replies.length - 1], /invalid or has expired/, label);
      }
      noLinkWritten(h.t, 'failed proofs'); noChatSideEffects(h.t, 'failed proofs');
      assert.equal(JSON.stringify(h.identityStore.list()), before);
      assert.equal(JSON.stringify(new SlackIdentityStore({ dir: h.dir }).list()), before);
    });
  });

  it('REPLAYED_CHALLENGE → the second use (same or another Slack user) is denied and changes nothing', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const code = await slIssue(h, ALICE);
      assert.equal(outcome(await slSend(h, { user: 'U_A', text: `link ${code}` })), 'LINKED');
      h.t.linkWrites = 0;
      assert.equal(outcome(await slSend(h, { user: 'U_A', text: `link ${code}` })), 'DENIED');
      assert.equal(outcome(await slSend(h, { user: 'U_B', text: `LINK ${code.toLowerCase()}` })), 'DENIED');
      noLinkWritten(h.t, 'replay');
      assert.equal(h.identityStore.get('U_B'), undefined);
    });
  });

  it('WRONG_PRINCIPAL → a code binds only to the principal that issued it', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const aliceCode = await slIssue(h, ALICE);
      const viaRoute = await slCall(h, 'POST', SL_LINK, { slackUserId: 'U_X', slackTeamId: 'T_ONE', challenge: aliceCode }, as(BOB));
      assert.equal(viaRoute.status, 400);
      assert.equal(outcome(await slSend(h, { user: 'U_X', text: `link ${aliceCode}` })), 'LINKED');
      assert.equal(h.identityStore.get('U_X')?.principalId, ALICE.principalId);
      assert.equal(h.identityStore.listForPrincipal(BOB.principalId, BOB.tenantId).length, 0);
    });
  });

  it('WRONG_CHANNEL_IDENTITY → another id in the text, a non-DM channel, a missing workspace or a non-message never links (and the exposed code is spent)', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const cases: Array<[string, (c: string) => SlSend]> = [
        ['code followed by ANOTHER user id', (c) => ({ user: 'U_A', text: `link ${c} U_VICTIM` })],
        ['public channel', (c) => ({ user: 'U_A', channelType: 'channel', text: `link ${c}` })],
        ['private channel', (c) => ({ user: 'U_A', channelType: 'group', text: `link ${c}` })],
        ['no workspace id on the event', (c) => ({ user: 'U_A', team: null, text: `link ${c}` })],
      ];
      for (const [label, build] of cases) {
        const h = slackHarness();
        const code = await slIssue(h, ALICE);
        const res = await slSend(h, build(code));
        assert.equal(outcome(res), 'DENIED', label);
        noLinkWritten(h.t, label); noChatSideEffects(h.t, label);
        assert.equal(h.identityStore.list().length, 0, label);
        assert.equal(h.identityStore.get('U_VICTIM'), undefined, label);
        assert.equal(outcome(await slSend(h, { user: 'U_A', text: `link ${code}` })), 'DENIED', `${label}: spent`);
        assert.equal(h.audit.concat(outputs).join('\n').includes(code), false, `${label}: code not logged`);
      }
    });
  });

  it('ordinary chat that merely starts with "link" is not a link attempt', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      for (const text of ['link', 'link calendar', 'link ABCD-EFGH', 'please link ABCD-EFGH-JKMN']) {
        const res = await slSend(h, { text });
        assert.equal(outcome(res), undefined, text);
        assert.equal((res.data as any).handled, true, text);
      }
      assert.equal(h.t.model, 4);
      noLinkWritten(h.t, 'chat');
    });
  });

  it('WRONG_INTEGRATION → a Slack-issued code redeemed on Telegram is refused (covered with its twin in the Telegram suite); the challenge store enforces it', () => {
    const store = new ChannelLinkChallengeStore();
    const { token } = store.issue('slack', ALICE.principalId, ALICE.tenantId);
    assert.deepEqual(store.consume('telegram', token), { ok: false, reason: 'WRONG_INTEGRATION' });
    assert.equal(store.consume('slack', token).ok, true, 'refusal by the wrong integration does not spend it');
    assert.deepEqual(store.consume('slack', token), { ok: false, reason: 'CONSUMED' });
  });

  it('NO_SILENT_REBIND → a Slack identity linked to one principal cannot be taken over; unlink is explicit and owner-only', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      assert.equal(outcome(await slSend(h, { user: 'U_A', text: `link ${await slIssue(h, ALICE)}` })), 'LINKED');
      const before = JSON.stringify(h.identityStore.get('U_A'));
      const res = await slSend(h, { user: 'U_A', text: `link ${await slIssue(h, BOB)}` });
      assert.equal(outcome(res), 'DENIED');
      assert.match(h.replies[h.replies.length - 1], /already linked/i);
      assert.equal(JSON.stringify(h.identityStore.get('U_A')), before);
      assert.throws(() => h.identityStore.link('U_A', BOB.principalId, BOB.tenantId, 'T_ONE'), (e: any) => e.code === 'CHANNEL_IDENTITY_ALREADY_LINKED');
      assert.equal(((await slCall(h, 'DELETE', SL_UNLINK, null, as(BOB))).data as any).unlinked, 0);
      assert.equal(((await slCall(h, 'DELETE', SL_UNLINK, null, as(ALICE))).data as any).unlinked, 1);
      assert.equal(outcome(await slSend(h, { user: 'U_A', text: `link ${await slIssue(h, BOB)}` })), 'LINKED');
      assert.equal(h.identityStore.get('U_A')?.principalId, BOB.principalId);
      const mine = (await slCall(h, 'GET', SL_IDENTITIES, null, as(BOB))).data as any;
      assert.deepEqual(mine.identities.map((i: any) => i.slackUserId), ['U_A']);
      assert.deepEqual(((await slCall(h, 'GET', SL_IDENTITIES, null, as(ALICE))).data as any).identities, []);
    });
  });

  it('S2A still holds: a forged, wrongly signed, stale or secret-less event cannot redeem a challenge, and does not spend it', async () => {
    const h = slackHarness();
    const code = await withWebhookSecrets(BOTH_SECRETS, () => slIssue(h, ALICE));
    const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev_s2b_1', team_id: 'T_ONE', event: { type: 'message', channel_type: 'im', user: 'U_A', channel: 'D1', text: `link ${code}`, ts: '1.1' } });
    const now = Math.floor(Date.now() / 1000);
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      for (const req of [
        slackRequest(raw, { omitSignature: true }),
        slackRequest(raw, { secret: 'attacker-signing-secret' }),
        slackRequest(raw, { timestamp: now - 3600 }),
        slackRequest(raw, { deliveredRaw: raw.replace('U_A', 'U_EVIL') }),
      ]) {
        const res = await slCall(h, 'POST', SL_HOOK, req.body, req.headers);
        assert.equal(res.status, 401);
      }
    });
    await withWebhookSecrets({ telegram: null, slack: null }, async () => {
      const ok = slackRequest(raw);
      assert.equal((await slCall(h, 'POST', SL_HOOK, ok.body, ok.headers)).status, 503);
    });
    noLinkWritten(h.t, 'unauthenticated events'); noChatSideEffects(h.t, 'unauthenticated events');
    assert.equal(h.t.outboundSends, 0);
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const ok = slackRequest(raw.replace('Ev_s2b_1', 'Ev_s2b_2'));
      assert.equal(outcome(await slCall(h, 'POST', SL_HOOK, ok.body, ok.headers)), 'LINKED', 'the refused requests did not spend the challenge');
    });
    assert.equal(slackSignature(TEST_SLACK_SIGNING_SECRET, now, raw).startsWith('v0='), true);
  });

  it('SINGLE_USE under concurrency → simultaneous redemptions of one challenge link exactly one account', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const code = await slIssue(h, ALICE);
      const results = await Promise.all(['U_1', 'U_2', 'U_3'].map((u) => slSend(h, { user: u, text: `link ${code}` })));
      assert.deepEqual(results.map(outcome).sort(), ['DENIED', 'DENIED', 'LINKED']);
      assert.equal(h.identityStore.list().length, 1);
      assert.equal(h.t.linkWrites, 1);
    });
  });

  it('the unlinked-sender policy is unchanged: an authentic unlinked Slack sender still gets an isolated identity and the normal pipeline', async () => {
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      const h = slackHarness();
      const res = await slSend(h, { user: 'U_STRANGER', text: 'hello there' });
      assert.equal((res.data as any).result.principalId, 'usr_slack_U_STRANGER');
      assert.equal(h.t.model, 1);
    });
  });
});

describe('S2B — challenge store', () => {
  it('tokens are unpredictable, shaped for typing, short-lived, bound to one operation and stored only as digests', () => {
    let now = 1_000;
    const store = new ChannelLinkChallengeStore({ now: () => now });
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) tokens.add(store.issue('telegram', `usr_${i}`, 'ten').token);
    assert.equal(tokens.size, 200, 'no collisions');
    for (const t of tokens) assert.match(t, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // nothing in the store contains a token or its normalised form
    const internals = JSON.stringify([...(store as any).records.keys()]);
    for (const t of [...tokens].slice(0, 20)) { assert.equal(internals.includes(t), false); assert.equal(internals.includes(t.replace(/-/g, '')), false); }
    for (const k of (store as any).records.keys()) assert.match(k, /^[0-9a-f]{64}$/);
    const { token } = store.issue('slack', 'usr_x', 'ten_x');
    const ok = store.consume('slack', token);
    assert.deepEqual(ok, { ok: true, principalId: 'usr_x', tenantId: 'ten_x', operation: 'LINK_CHANNEL_IDENTITY' });
    const t2 = store.issue('slack', 'usr_y', 'ten_y').token;
    now += CHANNEL_LINK_TTL_MS;                     // exactly at expiry is expired
    assert.deepEqual(store.consume('slack', t2), { ok: false, reason: 'EXPIRED' });
    assert.deepEqual(store.consume('slack', 'AAAA-AAAA-AAAA'), { ok: false, reason: 'UNKNOWN' });
    assert.deepEqual(store.consume('slack', 'not a token'), { ok: false, reason: 'UNKNOWN' });
  });

  it('is bounded: expired entries are swept and the oldest are evicted at capacity', () => {
    let now = 0;
    const store = new ChannelLinkChallengeStore({ now: () => now, maxEntries: 3, ttlMs: 1000 });
    const first = store.issue('telegram', 'p1', 't').token;
    store.issue('telegram', 'p2', 't'); store.issue('telegram', 'p3', 't'); store.issue('telegram', 'p4', 't');
    assert.equal(store.size(), 3);
    assert.deepEqual(store.consume('telegram', first), { ok: false, reason: 'UNKNOWN' }, 'the oldest was evicted');
    now = 5000;
    store.issue('telegram', 'p5', 't');
    assert.equal(store.size(), 1, 'expired entries are swept');
  });

  it('normalises case and confusable characters, and parses only well-formed commands', () => {
    assert.equal(normalizeChallengeToken('abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
    assert.equal(normalizeChallengeToken('O0I1-L1O0-ABCD'), '00111100ABCD');
    assert.equal(normalizeChallengeToken('ABCD-EFGH'), null);
    assert.equal(normalizeChallengeToken('ABCDEFGHJKMN'), null);
    assert.equal(normalizeChallengeToken('ABCU-EFGH-JKMN'), null);
    assert.deepEqual(parseChannelLinkCommand('telegram', '/start@NagexBot ABCD-EFGH-JKMN'), { code: 'ABCD-EFGH-JKMN', trailing: '' });
    assert.deepEqual(parseChannelLinkCommand('telegram', '/link ABCD-EFGH-JKMN extra'), { code: 'ABCD-EFGH-JKMN', trailing: 'extra' });
    assert.equal(parseChannelLinkCommand('telegram', 'link ABCD-EFGH-JKMN'), null, 'Telegram needs the slash command');
    assert.equal(parseChannelLinkCommand('slack', '/start ABCD-EFGH-JKMN'), null, 'Slack uses the plain word');
    assert.equal(parseChannelLinkCommand('slack', 'Link abcd-efgh-jkmn')?.code, 'abcd-efgh-jkmn');
    assert.equal(parseChannelLinkCommand('slack', 'link calendar'), null);
  });
});

// ── The real application wiring over HTTP: one shared challenge store, real session cookies, real signed webhooks ──
describe('S2B — real HTTP request path', () => {
  it('a signed-in user links Telegram and Slack by proving ownership from the channel; the old route and a cross-use of codes do not link', async () => {
    const server = await import('../src/server_web.js');
    await withWebhookSecrets(BOTH_SECRETS, async () => {
      await server.withTestServer(async (origin) => {
        const user = authAs('ten_s2b_http', 'usr_s2b_http');
        const post = (p: string, body: unknown, headers: Record<string, string> = {}, raw?: string) => fetch(origin + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
        const tgId = String(7_000_000 + Math.floor(Math.random() * 1_000_000));
        const slUser = `U_HTTP_${tgId}`;

        // the old browser-declared link is refused over HTTP and writes nothing
        const old = await post(TG_LINK, { telegramUserId: tgId }, { cookie: user.cookie });
        assert.equal(old.status, 400);
        assert.equal(server.telegramIdentityStore.get(tgId), undefined);

        // a challenge needs a session
        assert.equal((await post(TG_CHALLENGE, {})).status, 401);
        const tgChallenge = ((await (await post(TG_CHALLENGE, {}, { cookie: user.cookie })).json()) as any).challenge as string;
        const slChallenge = ((await (await post(SL_CHALLENGE, {}, { cookie: user.cookie })).json()) as any).challenge as string;

        const slackDm = (text: string, eventId: string): Promise<Response> => {
          const raw = JSON.stringify({ type: 'event_callback', event_id: eventId, team_id: 'T_HTTP', event: { type: 'message', channel_type: 'im', user: slUser, channel: 'D1', text, ts: '1.1' } });
          const ts = Math.floor(Date.now() / 1000);
          return post(SL_HOOK, undefined, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSignature(TEST_SLACK_SIGNING_SECRET, ts, raw) }, raw);
        };
        const tgDm = (text: string): Promise<Response> => post(TG_HOOK, { update_id: ++updateId, message: { message_id: 1, date: 1, chat: { id: Number(tgId), type: 'private' }, from: { id: Number(tgId), is_bot: false, first_name: 'x' }, text } }, telegramHeaders());

        // a Telegram code sent to the Slack bot (and vice versa) is refused and not spent
        assert.equal(((await (await slackDm(`link ${tgChallenge}`, 'Ev_http_cross1')).json()) as any).result.linkOutcome, 'DENIED');
        assert.equal(((await (await tgDm(`/start ${slChallenge}`)).json()) as any).result.linkOutcome, 'DENIED');
        assert.equal(server.slackIdentityStore.get(slUser), undefined);
        assert.equal(server.telegramIdentityStore.get(tgId), undefined);

        // the right code from the right channel links, bound to the signed-in principal and its tenant
        assert.equal(((await (await tgDm(`/start ${tgChallenge}`)).json()) as any).result.linkOutcome, 'LINKED');
        assert.equal(((await (await slackDm(`link ${slChallenge}`, 'Ev_http_ok1')).json()) as any).result.linkOutcome, 'LINKED');
        assert.deepEqual([server.telegramIdentityStore.get(tgId)?.principalId, server.telegramIdentityStore.get(tgId)?.tenantId], ['usr_s2b_http', 'ten_s2b_http']);
        assert.deepEqual([server.slackIdentityStore.get(slUser)?.principalId, server.slackIdentityStore.get(slUser)?.slackTeamId], ['usr_s2b_http', 'T_HTTP']);
        const mine = (await (await fetch(origin + TG_IDENTITIES, { headers: { cookie: user.cookie } })).json()) as any;
        assert.deepEqual(mine.identities.map((i: any) => i.telegramUserId), [tgId]);

        // an unauthenticated webhook cannot redeem anything
        const unsigned = await post(TG_HOOK, { update_id: ++updateId, message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'x' }, text: `/start ${tgChallenge}` } });
        assert.equal(unsigned.status, 401);

        // clean up our own links
        assert.equal(((await (await fetch(origin + TG_UNLINK, { method: 'DELETE', headers: { cookie: user.cookie } })).json()) as any).unlinked, 1);
        assert.equal(((await (await fetch(origin + SL_UNLINK, { method: 'DELETE', headers: { cookie: user.cookie } })).json()) as any).unlinked, 1);
      });
    });
  });
});
