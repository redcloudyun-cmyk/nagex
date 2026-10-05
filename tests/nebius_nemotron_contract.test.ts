// NAgex — source contract that keeps the Nebius / Nemotron integration inside the canonical model architecture.
// Behavior is certified by nebius_nemotron_provider and nebius_nemotron_routing; this pins the structure they depend on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const srcFiles = walk('src');
const rel = (f: string) => path.relative(process.cwd(), f).replace(/\\/g, '/');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Nebius / Nemotron — architecture contract', () => {
  it('the credential, the Token Factory URL and the provider configuration live only in providers.ts', () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/NEBIUS_API_KEY|tokenfactory\.nebius|NAGEX_NEBIUS_/.test(code) && rel(f) !== 'src/model-gateway/providers.ts') offenders.push(rel(f));
    }
    assert.deepEqual(offenders, []);
    const providers = stripComments(read('src/model-gateway/providers.ts'));
    assert.equal((providers.match(/process\.env/g) ?? []).length, 1, 'providers read the environment in one place (createProviders default argument)');
  });

  it('no route or feature module can supply or select the provider credential; nothing under src/http mentions Nebius', () => {
    for (const f of srcFiles.filter((x) => rel(x).startsWith('src/http/'))) {
      assert.equal(/nebius|nemotron/i.test(stripComments(fs.readFileSync(f, 'utf8'))), false, rel(f));
    }
    const ai = stripComments(read('src/model-gateway/ai-service.ts'));
    assert.equal(/nebius|nemotron/i.test(ai), false, 'AiService is provider-neutral: it only states a TaskKind');
  });

  it('feature code reaches the model only through the router: no module outside providers.ts builds a Nebius request', () => {
    for (const f of srcFiles) {
      if (rel(f) === 'src/model-gateway/providers.ts') continue;
      assert.equal(/chat\/completions/.test(stripComments(fs.readFileSync(f, 'utf8'))), false, rel(f));
    }
  });

  it('the preference table is routing data, consulted only by the policy comparator, never by an explicit override', () => {
    const policy = stripComments(read('src/model-gateway/model-routing-policy.ts'));
    assert.match(policy, /DEFAULT_TASK_PROVIDER_PREFERENCES[^=]*= \{\s*PLAN: \['nebius'\],\s*RESEARCH_SYNTHESIS: \['nebius'\],\s*MEETING_PREP: \['nebius'\],\s*\};/);
    assert.match(policy, /ignoreTaskScope: true/, 'only the explicit path skips the automatic task scope');
    const explicitBlock = policy.slice(policy.indexOf('// 1. Explicit Provider Override'), policy.indexOf('// 2. Auto Routing'));
    assert.equal(/compare\(|preferredProvidersFor\(/.test(explicitBlock), false, 'an explicit provider is never re-ranked by the preference');
    assert.match(policy, /\.sort\(\(a, b\) => this\.compare\(a, b, context, priorityIndexMap\)\)/);
  });

  it('hidden reasoning is reduced to a boolean in the adapter and never reaches the response text, the logs or the error', () => {
    const providers = stripComments(read('src/model-gateway/providers.ts'));
    const nebius = providers.slice(providers.indexOf('export class NebiusProvider'), providers.indexOf('function positiveInt'));
    const uses = nebius.match(/reasoning_content|\.reasoning\b/g) ?? [];
    assert.equal(uses.length, 2, 'the two reasoning fields are read exactly once, together');
    assert.match(nebius, /const reasoningField = \[message\.reasoning_content, message\.reasoning\]\.some\(/);
    assert.match(nebius, /this\.response\(stripped\.text,/, 'the answer is the stripped content only');
    const router = stripComments(read('src/model-gateway/unified-model-router.ts'));
    assert.equal(/reasoning_content|\.text\b.*logger|logger.*result\.text/.test(router), false);
    assert.equal(/authorization|bearer/i.test(router), false, 'the router never touches credentials');
    assert.match(read('src/model-gateway/model-provider.ts'), /NEVER carries provider reasoning text/);
  });

  it('retry is bounded (one retry; network/5xx only), every call has a timeout, and an unsafe base URL is refused', () => {
    const providers = stripComments(read('src/model-gateway/providers.ts'));
    assert.match(providers, /NEBIUS_MAX_RETRIES = 1;/);
    assert.match(providers, /attempt < NEBIUS_MAX_RETRIES && this\.isTransient\(error\)/);
    assert.match(providers, /error\.code === 'PROVIDER_NETWORK_ERROR'/);
    assert.equal(/PROVIDER_TIMEOUT|HTTP_429/.test(providers.slice(providers.indexOf('private isTransient'), providers.indexOf('public async generate(request: ModelRequest): Promise<ModelResponse> {\n    const { apiKey, model } = this.assertConfigured(request.requestId);\n    const startedAt = Date.now();\n    const body'))), false, 'timeouts and 429 are never retried');
    assert.match(providers, /setTimeout\(\(\) => controller\.abort\(\), this\.timeoutMs\)/);
    assert.match(providers, /url\.protocol !== 'https:' && !\(url\.protocol === 'http:' && loopback\)/);
    assert.match(providers, /if \(url\.username \|\| url\.password\) return null;/);
  });

  it('the failure vocabulary is fixed and the router records the safe reason, not a message', () => {
    const model = stripComments(read('src/model-gateway/model-provider.ts'));
    for (const reason of ['NO_PROVIDER_CREDENTIAL', 'RATE_LIMITED', 'PROVIDER_REJECTION', 'NETWORK_FAILURE', 'TIMEOUT', 'INVALID_RESPONSE', 'MODEL_UNAVAILABLE']) assert.ok(model.includes(`'${reason}'`), reason);
    const router = stripComments(read('src/model-gateway/unified-model-router.ts'));
    assert.match(router, /fallbackReason: preferredMissed \? this\.preferredMissReason/);
    assert.equal(/error\.message|normalized\.message/.test(router.slice(router.indexOf("this.logger.warn('model_request_failed'"), router.indexOf("throw new NagexError({\n      code: 'ALL_MODEL_PROVIDERS_FAILED'"))), false, 'the failure log carries no provider message');
  });

  it('the live certification is a separate, opt-in script (not part of the normal suite)', () => {
    const script = read('scripts/nebius-live-cert.mjs');
    assert.match(script, /NAGEX_LIVE_NEBIUS_CERT !== '1'/);
    assert.equal(script.split('\n').some((line) => /console\.(log|error|info|warn)/.test(line) && /process\.env|\$\{[^}]*(KEY|env)/i.test(line)), false, 'the script never prints the environment or the key');
    for (const f of walk('tests')) assert.equal(/api\.tokenfactory\.nebius\.com\/v1\/chat/.test(fs.readFileSync(f, 'utf8')) && /fetch\(\s*['"`]https:\/\/api\.tokenfactory/.test(fs.readFileSync(f, 'utf8')), false, `${rel(f)} must not call the real API`);
  });
});
