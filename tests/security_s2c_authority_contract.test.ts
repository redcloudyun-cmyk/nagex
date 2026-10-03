// Security Gate S2C — source contract that keeps the outbound-recipient boundary from regressing.
// Behavior is certified by security_s2c_outbound_recipient_authority; this only pins the structure it depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const rel = (f: string): string => path.relative(process.cwd(), f).replace(/\\/g, '/');

describe('S2C — outbound recipient authority contract', () => {
  it('no route can invoke a channel provider: only the services and the notification engine call sendMessage/postMessage', () => {
    const callers = walk(path.resolve('src'))
      .filter((f) => /\.(sendMessage|postMessage)\(/.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !/integrations\/(telegram|slack)\/(telegram|slack)\.client\.ts$/.test(f))
      .sort();
    assert.deepEqual(callers, [
      'src/integrations/slack/slack.service.ts',
      'src/integrations/telegram/telegram.service.ts',
      'src/notifications/notification.engine.ts',
    ]);
  });

  it('the send routes derive the destination through the service from the signed-in caller; a body chat/channel is only an assertion', () => {
    for (const [file, call, label] of [
      ['src/http/routes/telegram.routes.ts', 'telegramApiService.sendToOwnChannel(', 'Telegram'],
      ['src/http/routes/slack.routes.ts', 'slackApiService.sendToOwnChannel(', 'Slack'],
    ] as const) {
      const src = read(file);
      const block = src.slice(src.indexOf(`/${label.toLowerCase()}/send'`), src.indexOf(`/${label.toLowerCase()}/send'`) + 3000);
      assert.match(block, /callerIdentity\(headers\)/, `${file}: identity comes from the session`);
      assert.ok(block.includes(call), `${file}: delivery goes through ${call}`);
      assert.match(block, /ownChannelSendError\(result/, `${file}: a non-success is thrown, never returned as success`);
      assert.match(block, /asserted/, `${file}: the body value is named an assertion`);
      assert.equal(/Client\.(sendMessage|postMessage)\(/.test(block), false, `${file}: no direct provider call`);
    }
  });

  it('the services check authority BEFORE the provider and only trust ownership-proven links', () => {
    for (const [file, provider, order] of [
      ['src/integrations/telegram/telegram.service.ts', 'this.options.botClient.sendMessage({ chatId: target.telegramUserId', ['NOT_LINKED', 'LINK_NOT_VERIFIED', 'DESTINATION_NOT_OWNED', 'DESTINATION_AMBIGUOUS']],
      ['src/integrations/slack/slack.service.ts', 'this.options.slackClient.postMessage({ channel: target.slackUserId', ['NOT_LINKED', 'LINK_NOT_VERIFIED', 'DESTINATION_NOT_OWNED', 'DESTINATION_AMBIGUOUS', 'WORKSPACE_MISMATCH']],
    ] as const) {
      const src = read(file);
      const start = src.indexOf('public async sendToOwnChannel(');
      assert.ok(start > 0, `${file}: sendToOwnChannel exists`);
      const body = src.slice(start, src.indexOf('\n  }\n', start));
      const providerAt = body.indexOf(provider);
      assert.ok(providerAt > 0, `${file}: the provider is called with the DERIVED destination`);
      for (const code of order) assert.ok(body.indexOf(`'${code}'`) > 0 && body.indexOf(`'${code}'`) < providerAt, `${file}: ${code} is decided before the provider`);
      assert.match(body, /listVerifiedForPrincipal\(/);
      assert.equal(/details:[^\n]*\btext\b/.test(body), false, `${file}: message text is never audited`);
      assert.match(body, /status: 'FAILED'/);
    }
    // links are marked as proven only by the S2B redemption
    assert.match(read('src/integrations/telegram/telegram.service.ts'), /msg\.from!\.username, 'CHANNEL_CHALLENGE'\)/);
    assert.match(read('src/integrations/slack/slack.service.ts'), /teamId, undefined, 'CHANNEL_CHALLENGE'\)/);
  });

  it('the notification route can reach only dispatchForCaller; nothing under src/http calls the internal dispatch', () => {
    const route = read('src/http/routes/notifications.routes.ts');
    assert.match(route, /notificationEngine\.dispatchForCaller\(/);
    assert.equal(/notificationEngine\.dispatch\(/.test(route), false);
    assert.match(route, /assertedPrincipalId: body\?\.principalId/);
    assert.match(route, /assertedTenantId: body\?\.tenantId/);
    for (const f of walk(path.resolve('src/http'))) {
      assert.equal(/(notificationEngine|notificationApiService)\.dispatch\(/.test(fs.readFileSync(f, 'utf8')), false, `${rel(f)} must not call the internal dispatch`);
    }
    const engine = read('src/notifications/notification.engine.ts');
    const caller = engine.slice(engine.indexOf('public async dispatchForCaller('));
    const refusal = caller.indexOf("code: 'NOTIFICATION_RECIPIENT_NOT_AUTHORIZED'");
    const delivery = caller.indexOf("this.deliver({");
    assert.ok(refusal > 0 && delivery > refusal, 'the recipient check precedes any delivery');
    assert.match(caller, /'PROVEN_LINKS_ONLY'/);
    assert.match(engine, /public async dispatch\(opts: DispatchNotificationOptions\)[^]*?'ANY_LINK'/);
  });

  it('the adapters never fabricate success: no-credential, rejection and network failure are failures, and no error object is logged', () => {
    for (const [file, noCred] of [
      ['src/integrations/telegram/telegram.client.ts', "if (!this.token) return { ok: false, reason: 'NO_PROVIDER_CREDENTIAL' };"],
      ['src/integrations/slack/slack.client.ts', "if (!this.token) return { ok: false, reason: 'NO_PROVIDER_CREDENTIAL' };"],
    ] as const) {
      const src = read(file);
      assert.ok(src.includes(noCred), `${file}: a missing credential is a failure`);
      assert.match(src, /NETWORK_FAILURE/);
      assert.match(src, /PROVIDER_REJECTION/);
      assert.equal(/Math\.random/.test(src), false, `${file}: no fabricated message id`);
      assert.equal(/console\.(error|log|warn)/.test(src), false, `${file}: an error object (whose request URL carries the token) is never logged`);
    }
  });

  it('the identity stores expose only proven links as outbound destinations', () => {
    for (const file of ['src/integrations/telegram/telegram-identity.store.ts', 'src/integrations/slack/slack-identity.store.ts']) {
      const src = read(file);
      assert.match(src, /listVerifiedForPrincipal\(/);
      assert.match(src, /ownershipProof === 'CHANNEL_CHALLENGE'/);
    }
  });
});
