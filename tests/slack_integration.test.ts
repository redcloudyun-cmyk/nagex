import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackIdentityStore } from '../src/integrations/slack/slack-identity.store.js';
import { SlackClient, type SlackEventPayload } from '../src/integrations/slack/slack.client.js';
import { SlackService } from '../src/integrations/slack/slack.service.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { authAs } from './_s1_session_auth.js';
import { BOTH_SECRETS, signedSlackChallenge, signedSlackEvent, withWebhookSecrets } from './_s2a_webhooks.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-slack-test-'));
}

test('SlackIdentityStore links identities and persists across restarts', () => {
  const dir = tempDir();
  const store1 = new SlackIdentityStore({ dir });

  // Default fallback resolution for unlinked ID
  const unlinked = store1.resolve('U12345');
  assert.equal(unlinked.principalId, 'usr_slack_U12345');
  assert.equal(unlinked.tenantId, 'ten_slack_U12345', 'S1: an unlinked Slack user is an isolated tenant, never the default tenant');

  // Explicit link
  const record = store1.link('U12345', 'usr_admin_001', 'ten_custom_01', 'T999', 'slack_jane');
  assert.equal(record.slackUserId, 'U12345');
  assert.equal(record.principalId, 'usr_admin_001');
  assert.equal(record.tenantId, 'ten_custom_01');
  assert.equal(record.slackTeamId, 'T999');
  assert.equal(record.username, 'slack_jane');

  // Resolved now maps to linked identity
  const resolved = store1.resolve('U12345');
  assert.equal(resolved.principalId, 'usr_admin_001');
  assert.equal(resolved.tenantId, 'ten_custom_01');

  // Persisted across new store instance
  const store2 = new SlackIdentityStore({ dir });
  const loaded = store2.get('U12345');
  assert.ok(loaded);
  assert.equal(loaded?.principalId, 'usr_admin_001');
  assert.equal(loaded?.username, 'slack_jane');
  assert.equal(store2.list().length, 1);
});

test('SlackClient handles unconfigured mock postMessage and getStatus', async () => {
  const client = new SlackClient(null);
  assert.equal(client.isConfigured(), false);

  const status = client.getStatus();
  assert.equal(status.configured, false);

  const res = await client.postMessage({ channel: 'C12345', text: 'Hello Slack' });
  assert.equal(res.ok, true);
  assert.ok(typeof res.ts === 'string');
});

test('SlackService handles url_verification challenge and processes message updates to MainSession', async () => {
  const dir = tempDir();
  const identityStore = new SlackIdentityStore({ dir });
  identityStore.link('U98765', 'usr_jane_001', 'ten_jane_01', 'T01', 'jane_slack');

  const sessionStore = new SessionStore({ dir: path.join(dir, 'sessions') });
  const slackClient = new SlackClient(null);
  const auditLogger = new AuditLogger();
  const planResolver = new PlanResolver(skillRegistry, toolRegistry);

  const mockAiService: any = {
    statuses: () => [],
    chat: async (params: any) => ({
      status: 'SUCCESS',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 10,
      requestId: params.requestId,
      data: { message: `Echoing Slack: ${params.message}` },
    }),
    plan: async (params: any) => ({
      status: 'PLAN_PREVIEW',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 15,
      requestId: params.requestId,
      data: {
        goal: 'Send team announcement',
        summary: 'Preparing Slack announcement',
        reasoningSummary: 'Draft and post message to team channel',
        suggested_skills: ['slack-assistant'],
        steps: [
          {
            step: 1,
            title: 'Post message to channel',
            reasoning: 'Send Slack announcement',
            skill: 'slack-assistant',
            tool: 'slack.bot',
            requiresApproval: true,
          },
        ],
      },
    }),
  };

  const service = new SlackService({
    slackClient,
    identityStore,
    sessionStore,
    aiService: mockAiService,
    planResolver,
    getMemories: () => [],
    auditLogger,
  });

  // Test URL verification challenge
  const challengePayload: SlackEventPayload = {
    type: 'url_verification',
    challenge: '3eZBrAqOperationalChallengeToken',
  };
  const challengeRes = await service.processEvent(challengePayload);
  assert.ok(challengeRes);
  assert.equal(challengeRes.challenge, '3eZBrAqOperationalChallengeToken');

  // Test message event callback
  const eventPayload: SlackEventPayload = {
    type: 'event_callback',
    team_id: 'T01',
    event: {
      type: 'message',
      user: 'U98765',
      channel: 'C99999',
      text: 'Hello from Slack!',
      ts: '1700000000.000100',
    },
  };

  const result = await service.processEvent(eventPayload);
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.principalId, 'usr_jane_001');
  assert.equal(result.channel, 'C99999');
  assert.equal(result.planGenerated, false);
  assert.equal(result.responseText, 'Echoing Slack: Hello from Slack!');

  // Verify MainSession was created / accessed
  const mainSession = sessionStore.getOrCreateMain('ten_jane_01', 'usr_jane_001');
  assert.equal(mainSession.sessionId, result.sessionId);

  // Test action intent trigger -> plan generated
  const actionPayload: SlackEventPayload = {
    type: 'event_callback',
    team_id: 'T01',
    event: {
      type: 'message',
      user: 'U98765',
      channel: 'C99999',
      text: 'Send team announcement email',
      ts: '1700000000.000200',
    },
  };

  const actionResult = await service.processEvent(actionPayload);
  assert.ok(actionResult);
  assert.equal(actionResult.planGenerated, true);
  assert.ok(actionResult.responseText.includes('NAgex Action Plan'));
});

test('Slack API endpoints in server_web.ts respond correctly', async () => {
  const mockAiService: any = {
    statuses: () => [],
    chat: async (params: any) => ({
      status: 'SUCCESS',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 10,
      requestId: params.requestId,
      data: { message: `Echo: ${params.message}` },
    }),
    plan: async (params: any) => ({
      status: 'PLAN_PREVIEW',
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 15,
      requestId: params.requestId,
      data: {
        goal: 'Mock goal',
        summary: 'Mock summary',
        reasoningSummary: 'Mock reasoning',
        steps: [{ step: 1, title: 'Step 1', reasoning: 'R1', skill: 'general-assistant', tool: null, requiresApproval: false }],
      },
    }),
  };

  const dir = tempDir();
  const identityStore = new SlackIdentityStore({ dir });
  const customSlackService = new SlackService({
    slackClient: new SlackClient(null),
    identityStore,
    sessionStore: new SessionStore({ dir: path.join(dir, 'sessions') }),
    aiService: mockAiService,
    planResolver: new PlanResolver(skillRegistry, toolRegistry),
    getMemories: () => [],
    auditLogger: new AuditLogger(),
  });

  const statusRes = await handleAsyncApiRequest('GET', '/api/v1/integrations/slack/status', null, {}, mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService);
  assert.equal(statusRes.status, 200);
  assert.equal((statusRes.data as any).configured, false);

  // S2B: a client-supplied Slack id (with or without a principal/tenant) is NOT accepted; ownership is proven FROM Slack.
  const refusedLink = await handleAsyncApiRequest('POST', '/api/v1/integrations/slack/identity/link', {
    slackUserId: 'U555123',
    principalId: 'usr_someone_else',
    tenantId: 'ten_someone_else',
    username: 'slack_link_user',
  }, authAs('ten_slack_link_test', 'usr_slack_link_test'), mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService);
  assert.equal(refusedLink.status, 400);
  assert.equal((refusedLink.data as any).error.code, 'CHANNEL_LINK_PROOF_REQUIRED');
  assert.equal(identityStore.list().length, 0, 'a refused link wrote nothing');
  const linkChallengeRes = await handleAsyncApiRequest('POST', '/api/v1/integrations/slack/identity/link/challenge', {}, authAs('ten_slack_link_test', 'usr_slack_link_test'), mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService);
  assert.equal(linkChallengeRes.status, 201);
  const linkCode = (linkChallengeRes.data as any).challenge as string;
  const proof = signedSlackEvent({ type: 'message', channel_type: 'im', user: 'U555123', channel: 'D555123', text: `link ${linkCode}`, ts: '1700000000.000100' }, { team_id: 'T_LINK' });
  const proofRes = await withWebhookSecrets(BOTH_SECRETS, () => handleAsyncApiRequest('POST', '/api/v1/integrations/slack/events', proof.body, proof.headers, mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService));
  assert.equal(proofRes.status, 200);
  assert.equal((proofRes.data as any).result.linkOutcome, 'LINKED');
  const linked = identityStore.get('U555123');
  assert.equal(linked?.slackUserId, 'U555123');
  assert.equal(linked?.principalId, 'usr_slack_link_test', 'bound to the principal that issued the challenge, never to a body-supplied one');
  assert.equal(linked?.tenantId, 'ten_slack_link_test');
  assert.equal(linked?.slackTeamId, 'T_LINK', 'the workspace is taken from the signed event');
  const anonLink = await handleAsyncApiRequest('POST', '/api/v1/integrations/slack/identity/link', { slackUserId: 'U999', principalId: 'usr_x', tenantId: 'ten_x' }, {}, mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService);
  assert.equal(anonLink.status, 401, 'S1: anonymous callers cannot link a channel identity');

  const listRes = await handleAsyncApiRequest('GET', '/api/v1/integrations/slack/identities', null, authAs('ten_slack_link_test', 'usr_slack_link_test'), mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService);
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray((listRes.data as any).identities));
  assert.ok((listRes.data as any).identities.length >= 1);

  const sendRes = await handleAsyncApiRequest('POST', '/api/v1/integrations/slack/send', {
    channel: 'C555123',
    text: 'Test direct Slack message',
  }, authAs('ten_slack_link_test', 'usr_slack_link_test'), mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService);
  assert.equal(sendRes.status, 200);
  assert.equal((sendRes.data as any).success.ok, true);

  // Test URL Verification challenge endpoint
  // S2A: Slack events are accepted only with a valid signature over the raw body (and an unsigned request is refused).
  const unsignedChallenge = await withWebhookSecrets(BOTH_SECRETS, () => handleAsyncApiRequest('POST', '/api/v1/integrations/slack/events', { type: 'url_verification', challenge: 'testChallengeToken123' }, {}, mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService));
  assert.equal(unsignedChallenge.status, 401, 'S2A: an unsigned challenge is refused');
  const signedChallenge = signedSlackChallenge('testChallengeToken123');
  const challengeRes = await withWebhookSecrets(BOTH_SECRETS, () => handleAsyncApiRequest('POST', '/api/v1/integrations/slack/events', signedChallenge.body, signedChallenge.headers, mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService));
  assert.equal(challengeRes.status, 200);
  assert.equal((challengeRes.data as any).challenge, 'testChallengeToken123');

  // Test Event callback endpoint
  const signedEvent = signedSlackEvent({
    type: 'message',
    user: 'U555123',
    channel: 'C555123',
    text: 'Ping via Slack events endpoint',
    ts: '1700000001.000100',
  });
  const eventRes = await withWebhookSecrets(BOTH_SECRETS, () => handleAsyncApiRequest('POST', '/api/v1/integrations/slack/events', signedEvent.body, signedEvent.headers, mockAiService, {}, undefined, undefined, undefined, undefined, customSlackService));
  assert.equal(eventRes.status, 200);
  assert.equal((eventRes.data as any).status, 'ok');
  assert.equal((eventRes.data as any).handled, true);
});
