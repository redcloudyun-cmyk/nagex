// Security Gate S2B — source contract that keeps the channel-identity ownership boundary from regressing.
// Behavior is certified by security_s2b_channel_identity_ownership; this only pins the structure it depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8').replace(/\r\n/g, '\n');

describe('S2B — channel identity ownership contract', () => {
  it('no HTTP route can link or list a channel identity from client input', () => {
    for (const file of ['src/http/routes/telegram.routes.ts', 'src/http/routes/slack.routes.ts']) {
      const src = read(file);
      assert.equal(/IdentityStore\.link\(/.test(src), false, `${file}: a route must never call identityStore.link()`);
      assert.equal(/IdentityStore\.list\(\)/.test(src), false, `${file}: the listing is scoped to the caller`);
      assert.match(src, /CHANNEL_LINK_PROOF_REQUIRED/);
      assert.match(src, /identity\/link\/challenge/);
      assert.match(src, /createLinkChallenge\(principalId, tenantId\)/);
      // the challenge issuer takes the principal/tenant from the session, never the body
      const challengeBlock = src.slice(src.indexOf('identity/link/challenge'), src.indexOf("identity/link' && method"));
      assert.match(challengeBlock, /callerIdentity\(headers\)/);
      assert.equal(/body\??\./.test(challengeBlock), false, 'the challenge route never reads the request body');
    }
  });

  it('the services handle a link attempt before identity resolution, conversation, memory or the model, and consume+link share one synchronous step', () => {
    for (const [file, resolveCall, store] of [
      ['src/integrations/telegram/telegram.service.ts', 'identityStore.resolve(tgUserId)', 'telegram'],
      ['src/integrations/slack/slack.service.ts', 'identityStore.resolve(slackUserId', 'slack'],
    ] as const) {
      const src = read(file);
      const attempt = src.indexOf(`parseChannelLinkCommand('${store}'`);
      assert.ok(attempt > 0, `${file}: parses the link command`);
      assert.ok(attempt < src.indexOf(resolveCall), `${file}: before identity resolution`);
      assert.ok(attempt < src.indexOf('conversationStore.append'), `${file}: before any conversation write`);
      assert.ok(attempt < src.indexOf('.getMemories('), `${file}: before any memory read`);
      assert.ok(attempt < src.indexOf('aiService.'), `${file}: before the model`);
      const redeem = src.slice(src.indexOf('private async redeemLinkChallenge'));
      const body = redeem.slice(0, redeem.indexOf('\n  }\n'));
      const firstAwait = body.indexOf('await this.');   // the only awaits are the outbound reply
      assert.ok(body.indexOf('challenges.consume(') > 0 && body.indexOf('identityStore.link(') > 0);
      assert.ok(body.indexOf('challenges.consume(') < firstAwait && body.indexOf('identityStore.link(') < firstAwait, `${file}: consume and link happen before the first await (no TOCTOU window)`);
      // the code never reaches a log or audit field
      assert.equal(/details:[^\n]*\bcode\b/.test(body), false);
      assert.equal(/console\./.test(body), false);
    }
  });

  it('the challenge store uses a CSPRNG, keeps only digests, and never logs', () => {
    const src = read('src/integrations/channel-link-challenge.store.ts');
    assert.match(src, /crypto\.randomBytes\(12\)/);
    assert.match(src, /createHash\('sha256'\)/);
    assert.equal(/console\./.test(src), false);
    assert.equal(/Math\.random/.test(src), false);
    assert.match(src, /public consume\(/);
  });

  it('the identity stores never overwrite a link held by another principal', () => {
    for (const file of ['src/integrations/telegram/telegram-identity.store.ts', 'src/integrations/slack/slack-identity.store.ts']) {
      const src = read(file);
      assert.match(src, /CHANNEL_IDENTITY_ALREADY_LINKED/);
      assert.match(src, /listForPrincipal\(/);
      assert.match(src, /unlinkForPrincipal\(/);
    }
    assert.match(read('src/integrations/slack/slack-identity.store.ts'), /workspaceMismatch/);
  });

  it('the application gives both channels the same challenge store', () => {
    const src = read('src/app/create-nagex-application.ts');
    assert.equal(src.split('challengeStore: channelLinkChallengeStore').length - 1, 2);
    assert.equal(src.split('new ChannelLinkChallengeStore(').length - 1, 1);
  });

  it('the shipped UI no longer asks for an external account id', () => {
    const ui = read('public/app.js');
    assert.equal(/linkTelegramIdentity|linkSlackIdentity/.test(ui), false);
    assert.equal(/Enter your (Telegram|Slack) user ID/.test(ui), false);
    assert.match(ui, /requestChannelLinkCode/);
  });
});
