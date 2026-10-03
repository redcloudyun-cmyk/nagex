// Security Gate S2A — source contract that keeps the webhook authenticity boundary from regressing.
// Behavior is certified by security_s2a_webhook_authenticity; this only pins the structure it depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

describe('S2A — webhook authenticity contract', () => {
  it('the Telegram route verifies the secret before the update reaches the service', () => {
    const src = read('src/http/routes/telegram.routes.ts');
    const verify = src.indexOf('verifyTelegramWebhook(headers)');
    const process = src.indexOf('telegramApiService.processUpdate(');
    assert.ok(verify > 0 && process > 0);
    assert.ok(verify < process, 'verification precedes processing');
    assert.match(src, /if \(!verdict\.ok\) return webhookRejection\('telegram'/);
  });

  it('the Slack route verifies the signature before the challenge is echoed and before the event reaches the service', () => {
    const src = read('src/http/routes/slack.routes.ts');
    const verify = src.indexOf('verifySlackWebhook(headers, getRawBody(body))');
    const challenge = src.indexOf('challenge: payload.challenge');
    const process = src.indexOf('slackApiService.processEvent(');
    assert.ok(verify > 0 && challenge > 0 && process > 0);
    assert.ok(verify < challenge && verify < process, 'verification precedes the challenge echo and processing');
    assert.match(src, /if \(!verdict\.ok\) return webhookRejection\('slack'/);
  });

  it('only the two webhook routes may hand a channel update/event to the services', () => {
    const callers = walk(path.resolve('src'))
      .filter((f) => /\.(processUpdate|processEvent)\(/.test(fs.readFileSync(f, 'utf8')) && !/integrations[\\/](telegram|slack)[\\/]/.test(f))
      .map((f) => path.basename(f))
      .sort();
    assert.deepEqual(callers, ['slack.routes.ts', 'telegram.routes.ts']);
  });

  it('the verifier takes secrets only from server configuration, compares in constant time and never re-serialises a body', () => {
    const src = read('src/integrations/webhook-auth.ts');
    assert.match(src, /timingSafeEqual/);
    assert.equal(/JSON\.stringify\s*\(\s*(body|payload)/.test(src), false, 'the signed bytes are the raw buffer, never JSON.stringify(body)');
    assert.match(src, /TELEGRAM_WEBHOOK_SECRET/);
    assert.match(src, /SLACK_SIGNING_SECRET/);
    // a missing secret is a refusal, never a bypass
    assert.match(src, /if \(!configured\) return reject\('SECRET_NOT_CONFIGURED', 503\)/);
    assert.match(src, /if \(!secret\) return reject\('SECRET_NOT_CONFIGURED', 503\)/);
  });

  it('the HTTP layer gives a SIGNED_WEBHOOK route the original bytes, and the access policy classifies exactly the two routes', () => {
    const server = read('src/server_web.ts');
    assert.match(server, /classifyRouteAccess\(method, pathname\)\?\.access === 'SIGNED_WEBHOOK'/);
    assert.match(server, /attachRawBody\(parsedBody, rawBuffer\)/);
    const access = read('src/http/route-access.ts');
    const signed = access.split('\n').filter((l) => l.includes("'SIGNED_WEBHOOK',"));
    assert.equal(signed.length, 2);
    const preservedWebhooks = access.split('\n').filter((l) => l.includes("'ANONYMOUS_PRESERVED',") && (l.includes('telegram\\/webhook') || l.includes('slack\\/events')));
    assert.deepEqual(preservedWebhooks, [], 'a webhook route must not be listed as merely anonymous');
  });
});
