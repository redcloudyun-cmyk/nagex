// R24.7B — source/markup contract for read-only Canvas Ask. These assertions read
// production source; the behavior itself is certified by r24_7b_canvas_ask (server)
// and r24_7b_canvas_ask_browser (real Chromium, desktop + mobile).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `missing marker: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `missing end marker: ${to}`);
  return src.slice(a, b);
};

describe('R24.7B — Canvas Ask is read-only by construction (no mutation, no side channels)', () => {
  const route = slice(read('src/http/routes/artifact.routes.ts'), 'async function handleArtifactAsk', '\n}\n');
  const resolver = read('src/artifacts/artifact-context.resolver.ts');
  const aiAsk = slice(read('src/model-gateway/ai-service.ts'), 'public async artifactAsk(', 'public async research(');

  const FORBIDDEN_MUTATION = [/executeRevision/, /\.save\(/, /saveCompleted\(/, /\.remove\(/, /\.write\(/, /deleteCapture/, /createCapture/, /updateStatus/, /variation/i, /\/revisions/, /imageExecutor/, /creationRuntime/];
  const FORBIDDEN_SIDE_CHANNELS = [/convStore|conversationStore|ConversationStore|\.append\(/, /memoryExtractor|getRelevantMemories|MemoryEngine|memories/, /buildEvidencePack|evidencePack|webSearch|WebSearch/, /googleTokenStore|calendar|gmail|GmailService|connection/i, /approval|executeAction|capabilityBroker/i];

  it('the ask route, the context resolver and AiService.artifactAsk contain no mutation primitive', () => {
    for (const [name, src] of [['ask route', route], ['resolver', resolver], ['artifactAsk', aiAsk]] as const) {
      for (const pattern of FORBIDDEN_MUTATION) assert.doesNotMatch(src, pattern, `${name} must not match ${pattern}`);
    }
  });

  it('...and no side channel: no main-conversation write, memory, web search, connected-app or approval/execution path', () => {
    for (const [name, src] of [['ask route', route], ['resolver', resolver], ['artifactAsk', aiAsk]] as const) {
      for (const pattern of FORBIDDEN_SIDE_CHANNELS) assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), pattern, `${name} must not match ${pattern}`);
    }
  });

  it('identity comes only from the authenticated session record — never from legacy headers, defaults or the body', () => {
    assert.match(route, /resolveAuthenticatedIdentity\(headers/);
    const code = route.replace(/\/\/[^\n]*/g, ''); // comments may name the headers they refuse
    for (const forbidden of [/x-principal-id/i, /x-nagex-tenant/i, /usr_admin_001/, /ten_production_01/, /body\.(ownerId|tenantId|userId|principalId)/]) assert.doesNotMatch(code, forbidden);
    // the model is called with the SERVER-resolved context only
    assert.match(route, /content: ctx\.content/);
    assert.doesNotMatch(route, /body\??\.content|body\??\.artifactContent|body\??\.sourceId/);
  });

  it('uses the existing router (CHAT task kind) and registers no new router or task kind', () => {
    assert.match(aiAsk, /this\.router\.generate\(/);
    assert.match(aiAsk, /taskKind: 'CHAT'/);
    assert.doesNotMatch(aiAsk, /\btools\s*:|\bfunctions\s*:|tool_choice/);
    assert.doesNotMatch(read('src/model-gateway/model-routing.types.ts'), /ARTIFACT_ASK|ARTIFACT_QA/);
  });

  it('the Ask support rule has ONE source of truth that the projection exposes', () => {
    const types = read('src/artifacts/artifact.types.ts');
    assert.equal((types.match(/export function getArtifactAskSupport/g) || []).length, 1);
    assert.match(types, /ask: getArtifactAskSupport\(type\)/);
    assert.match(resolver, /getArtifactAskSupport\(record\.type\)/);
  });
});

describe('R24.7B — Canvas Ask client: one handler, one renderer, no alert, no duplicate state', () => {
  const view = read('public/personal-home-view.js');
  const html = read('public/index.html');

  it('exactly one submitCanvasAsk and one Ask renderer; neither uses alert()', () => {
    assert.equal((view.match(/window\.NAGEX\.submitCanvasAsk\s*=/g) || []).length, 1);
    assert.equal((view.match(/function renderAskState\(/g) || []).length, 1);
    const handler = slice(view, 'window.NAGEX.submitCanvasAsk =', 'window.NAGEX.dispatchArtifactOpen =');
    assert.doesNotMatch(handler, /alert\(/);
    assert.doesNotMatch(slice(view, 'function renderAskState(', 'function resetAskSurface('), /alert\(/);
  });

  it('the Ask support decision is read from the server projection; the client never branches on artifact type for Ask', () => {
    const askBlock = slice(view, '// --- R24.7B Canvas Ask', 'window.NAGEX.openArtifactInCanvas');
    assert.doesNotMatch(askBlock, /artifactType\s*===|upperType\s*===|type\s*===\s*'(IMAGE|RESEARCH|DOCUMENT|ANALYSIS)'/);
    assert.match(askBlock, /ask\.supported === false/);
  });

  it('only the question and UI language are sent; the active artifact is resolved per surface, not from a duplicate Ask store', () => {
    const handler = slice(view, 'window.NAGEX.submitCanvasAsk =', 'window.NAGEX.dispatchArtifactOpen =');
    assert.match(handler, /body: JSON\.stringify\(\{ question, locale: locale\(\) \}\)/);
    const resolve = slice(view, 'function activeArtifactForPrefix(', 'function askControls(');
    assert.match(resolve, /home-embedded-canvas/);
    assert.match(resolve, /_canvasState/);
    // Ask adds no persistent Canvas/Ask state object of its own beyond the per-surface request counter.
    assert.equal((view.match(/window\.NAGEX\._(ask|canvasAsk)\w*\s*=/g) || []).length, 0);
    assert.equal((view.match(/localStorage|sessionStorage/g) || []).length, 0);
  });

  it('model/server text is rendered through textContent only', () => {
    const rendering = slice(view, 'function renderReadOnlyText(', 'window.NAGEX.openArtifactInCanvas');
    const withoutClears = rendering.replace(/\.innerHTML = ''/g, '');
    assert.doesNotMatch(withoutClears, /innerHTML/);
  });

  it('every Ask surface has an answer region and calls the one shared handler', () => {
    for (const id of ['canvas-ask-answer', 'home-canvas-ask-answer', 'mh-canvas-ask-answer']) {
      assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
    }
    assert.equal((html.match(/onclick="window\.NAGEX\.submitCanvasAsk\(/g) || []).length, 3);
    for (const id of ['canvas-ask-answer', 'home-canvas-ask-answer', 'mh-canvas-ask-answer']) {
      assert.match(html, new RegExp(`id="${id}"[^>]*aria-live="polite"`));
    }
  });

  it('restore no longer depends on Home\'s top-5 list', () => {
    const restore = slice(view, 'window.NAGEX.restoreCanvasFromRoute =', 'window.NAGEX.submitCanvasAsk =');
    assert.match(restore, /\/api\/v1\/artifacts\//);
    assert.doesNotMatch(restore, /fetchHome|recentCreations|recentResults/);
  });

  it('Ask copy no longer promises mutation, and EN/KR Ask strings have identical key sets', () => {
    const i18n = read('public/i18n.js');
    assert.doesNotMatch(i18n, /Ask NAgex to change this|수정을 요청/);
    assert.doesNotMatch(html, /Ask NAgex to change this/);
    const copy = slice(view, 'const COPY = {', 'const STATE_LABELS');
    const [en, ko] = copy.split('    ko: {');
    const keys = (s: string) => [...s.matchAll(/\b(ask[A-Z]\w*|document[A-Z]\w*|artifactNotFound)\s*:/g)].map((m) => m[1]).sort();
    assert.ok(keys(en).length >= 18);
    assert.deepEqual(keys(en), keys(ko));
    assert.match(ko, /[가-힣]/);
  });
});
