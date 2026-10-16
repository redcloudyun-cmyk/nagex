// Google image generation behind the NAgex image port, against a local stand-in for the Generative Language API.
//
// Nothing here reaches Google. A pass proves NAgex builds the right request (model-specific path, key in a header and never in the URL,
// honest aspect ratio), reads both answer shapes, stores the real bytes with their real type, and turns every failure into a truthful,
// distinct error. It does NOT prove that Google accepts the request: a live run needs an image-capable quota on the key (see the sprint evidence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleImageAdapter } from '../src/creation/providers/adapters/google-image-adapter.js';
import { OpenAIImageAdapter } from '../src/creation/providers/adapters/openai-image-adapter.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { ImageExecutor } from '../src/creation/executors/image-executor.js';
import { ImageStore } from '../src/creation/image.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';

// a real 1x1 PNG and a recognisable JPEG-ish payload (the adapter must not assume PNG)
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not-really-a-jpeg-but-bytes-differ')]);
const KEY = 'AIzaSyFAKE-KEY-FOR-TEST-ONLY-0123456789';

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: any }

async function fakeGoogle(handler: (seen: Seen, res: http.ServerResponse) => void | Promise<void>) {
  const calls: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
      const seen: Seen = { method: req.method, url: req.url, headers: req.headers, body };
      calls.push(seen);
      await handler(seen, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
  return { baseUrl, calls, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const geminiAnswer = (bytes: Buffer, mimeType: string) => ({
  candidates: [{ content: { parts: [{ text: 'Here is your image.' }, { inlineData: { mimeType, data: bytes.toString('base64') } }] }, finishReason: 'STOP' }],
  modelVersion: 'gemini-2.5-flash-image',
});

const spec = (extra: Record<string, unknown> = {}) => ({ creationKind: 'IMAGE', subject: 'A red bicycle leaning on a brick wall', requestId: 'req_g1', ...extra }) as any;

test('gemini image model: generateContent request, key in a header only, real bytes and the real mime type back', async () => {
  const fake = await fakeGoogle((_seen, res) => json(res, 200, geminiAnswer(JPEG_BYTES, 'image/jpeg')));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl });
    const result = await adapter.generateImage(spec({ aspectRatio: '16:9', style: 'watercolor' }));

    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(result.output?.imageBuffer, JPEG_BYTES);
    assert.equal(result.output?.mimeType, 'image/jpeg', 'the type the provider reported, not an assumed PNG');
    assert.equal(result.metadata.providerId, 'google');
    assert.equal(result.metadata.engineOrModel, 'gemini-2.5-flash-image');

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1beta/models/gemini-2.5-flash-image:generateContent');
    assert.equal(call.headers['x-goog-api-key'], KEY);
    assert.ok(!String(call.url).includes('key='), 'the key must never be in the URL');
    assert.ok(!String(call.url).includes(KEY));
    assert.match(call.body.contents[0].parts[0].text, /red bicycle/);
    assert.match(call.body.contents[0].parts[0].text, /Style: watercolor/);
    assert.equal(call.body.generationConfig.imageConfig.aspectRatio, '16:9');
    assert.ok(call.body.generationConfig.responseModalities.includes('IMAGE'));
  } finally {
    await fake.close();
  }
});

test('imagen model uses :predict and reads bytesBase64Encoded', async () => {
  const fake = await fakeGoogle((_seen, res) => json(res, 200, { predictions: [{ bytesBase64Encoded: PNG_1X1.toString('base64'), mimeType: 'image/png' }] }));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl, modelId: 'imagen-4.0-generate-001' });
    const result = await adapter.generateImage(spec({ aspectRatio: '9:16' }));
    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(result.output?.imageBuffer, PNG_1X1);
    assert.equal(fake.calls[0].url, '/v1beta/models/imagen-4.0-generate-001:predict');
    assert.equal(fake.calls[0].body.parameters.aspectRatio, '9:16');
    assert.equal(fake.calls[0].body.parameters.sampleCount, 1);
    assert.equal(fake.calls[0].headers['x-goog-api-key'], KEY);
  } finally {
    await fake.close();
  }
});

test('quota exhaustion (429) is a quota error, not a generic failure, and says what happened', async () => {
  const fake = await fakeGoogle((_seen, res) => json(res, 429, {
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generate_content_free_tier_requests' },
  }));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl });
    const result = await adapter.generateImage(spec());
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'PROVIDER_QUOTA_EXCEEDED');
    assert.match(result.errorMessage || '', /quota/i);
    assert.ok(!(result.errorMessage || '').includes('free_tier_requests'), 'only the first line of the provider text is carried');
    assert.ok(!(result.errorMessage || '').includes(KEY));
    assert.equal(result.output, undefined, 'no image on a quota failure');
  } finally {
    await fake.close();
  }
});

test('a rejected credential (403) and an unknown model (404) have their own codes and never echo the key', async () => {
  let status = 403;
  const fake = await fakeGoogle((_seen, res) => json(res, status, { error: { status: status === 403 ? 'PERMISSION_DENIED' : 'NOT_FOUND', message: `denied for ${KEY}`.replace(KEY, '[redacted-by-provider]') } }));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl });
    const denied = await adapter.generateImage(spec());
    assert.equal(denied.status, 'FAILED');
    assert.equal(denied.errorCode, 'PROVIDER_AUTH_FAILED');
    status = 404;
    const missing = await adapter.generateImage(spec());
    assert.equal(missing.errorCode, 'PROVIDER_MODEL_NOT_FOUND');
    assert.match(missing.errorMessage || '', /gemini-2\.5-flash-image/);
    for (const r of [denied, missing]) assert.ok(!JSON.stringify(r).includes(KEY), 'no result may contain the key');
  } finally {
    await fake.close();
  }
});

test('an answer with words and no image is a failure that says so (no invented image)', async () => {
  const fake = await fakeGoogle((_seen, res) => json(res, 200, { candidates: [{ content: { parts: [{ text: 'I need to know which bicycle you mean.' }] }, finishReason: 'STOP' }] }));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl });
    const result = await adapter.generateImage(spec());
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'EMPTY_PROVIDER_RESULT');
    assert.match(result.errorMessage || '', /text instead of an image/);
    assert.equal(result.output, undefined);
  } finally {
    await fake.close();
  }
});

test('a safety block - in the prompt feedback or as the finish reason - is CONTENT_REJECTED', async () => {
  let mode: 'prompt' | 'finish' = 'prompt';
  const fake = await fakeGoogle((_seen, res) => json(res, 200, mode === 'prompt'
    ? { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }
    : { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl });
    assert.equal((await adapter.generateImage(spec())).errorCode, 'CONTENT_REJECTED');
    mode = 'finish';
    assert.equal((await adapter.generateImage(spec())).errorCode, 'CONTENT_REJECTED');
  } finally {
    await fake.close();
  }
});

test('a provider that never answers times out with TIMEOUT instead of hanging', async () => {
  const fake = await fakeGoogle(() => { /* never answers */ });
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl, timeoutMs: 150 });
    const startedAt = Date.now();
    const result = await adapter.generateImage(spec());
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'TIMEOUT');
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await fake.close();
  }
});

test('capabilities state only what is implemented, per model family', () => {
  const gemini = new GoogleImageAdapter({ apiKey: KEY }).getCapabilities();
  assert.equal(gemini.textToImage, true);
  assert.equal(gemini.imageToImage, false);
  assert.equal(gemini.editingInpainting, false);
  assert.equal(gemini.referenceImageConditioning, false);
  assert.equal(gemini.transparentBackground, false);
  assert.equal(gemini.maxReferenceImages, 0);
  assert.ok(gemini.supportedAspectRatios.includes('3:2'));
  const imagen = new GoogleImageAdapter({ apiKey: KEY, modelId: 'imagen-3.0-generate-002' }).getCapabilities();
  assert.ok(!imagen.supportedAspectRatios.includes('3:2'), 'Imagen has no 3:2');
  assert.equal(imagen.textRendering, false);
});

test('an aspect ratio the model cannot produce is refused, not silently changed', async () => {
  const fake = await fakeGoogle((_seen, res) => json(res, 200, { predictions: [{ bytesBase64Encoded: PNG_1X1.toString('base64') }] }));
  try {
    const adapter = new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl, modelId: 'imagen-3.0-generate-002' });
    const result = await adapter.generateImage(spec({ aspectRatio: '3:2' }));
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'UNSUPPORTED_ASPECT_RATIO');
    assert.equal(fake.calls.length, 0, 'nothing is sent to the provider for a request it cannot honour');
  } finally {
    await fake.close();
  }
});

test('no key -> UNCONFIGURED and UNAVAILABLE, nothing is sent; an empty subject is an invalid spec', async () => {
  const saved = { a: process.env.NAGEX_GOOGLE_API_KEY, b: process.env.GOOGLE_API_KEY, c: process.env.GEMINI_API_KEY };
  delete process.env.NAGEX_GOOGLE_API_KEY; delete process.env.GOOGLE_API_KEY; delete process.env.GEMINI_API_KEY;
  const fake = await fakeGoogle((_seen, res) => json(res, 200, {}));
  try {
    const adapter = new GoogleImageAdapter({ baseUrl: fake.baseUrl });
    assert.equal(adapter.getStatus(), 'UNCONFIGURED');
    const result = await adapter.generateImage(spec());
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.errorCode, 'PROVIDER_UNCONFIGURED');
    assert.equal(fake.calls.length, 0);
    const invalid = await new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl }).generateImage(spec({ subject: '   ' }));
    assert.equal(invalid.errorCode, 'INVALID_SPEC');
  } finally {
    if (saved.a !== undefined) process.env.NAGEX_GOOGLE_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.GOOGLE_API_KEY = saved.b;
    if (saved.c !== undefined) process.env.GEMINI_API_KEY = saved.c;
    await fake.close();
  }
});

test('the model id comes from NAGEX_IMAGE_GOOGLE_MODEL, then falls back to gemini-2.5-flash-image', () => {
  const saved = process.env.NAGEX_IMAGE_GOOGLE_MODEL;
  try {
    delete process.env.NAGEX_IMAGE_GOOGLE_MODEL;
    assert.equal((new GoogleImageAdapter({ apiKey: KEY }) as any).modelId, 'gemini-2.5-flash-image');
    process.env.NAGEX_IMAGE_GOOGLE_MODEL = 'gemini-3-pro-image-preview';
    assert.equal((new GoogleImageAdapter({ apiKey: KEY }) as any).modelId, 'gemini-3-pro-image-preview');
    assert.equal((new GoogleImageAdapter({ apiKey: KEY, modelId: 'explicit' }) as any).modelId, 'explicit');
  } finally {
    if (saved === undefined) delete process.env.NAGEX_IMAGE_GOOGLE_MODEL; else process.env.NAGEX_IMAGE_GOOGLE_MODEL = saved;
  }
});

test('router: with no OpenAI credential the first configured provider is Google; with one, OpenAI keeps priority', () => {
  const saved = process.env.NAGEX_OPENAI_API_KEY; const savedO = process.env.OPENAI_API_KEY;
  try {
    delete process.env.NAGEX_OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    const router = new CreationProviderRouter();
    router.registerImageProvider(new OpenAIImageAdapter());
    router.registerImageProvider(new GoogleImageAdapter({ apiKey: KEY }));
    assert.equal(router.selectImageProvider(spec(), {}).selectedProvider.providerId, 'google');

    const both = new CreationProviderRouter();
    both.registerImageProvider(new OpenAIImageAdapter({ apiKey: 'sk-test' }));
    both.registerImageProvider(new GoogleImageAdapter({ apiKey: KEY }));
    assert.equal(both.selectImageProvider(spec(), {}).selectedProvider.providerId, 'openai');
    assert.equal(both.selectImageProvider(spec(), { requestedProviderId: 'google' }).selectedProvider.providerId, 'google');

    // a transparent background is something this adapter does not do: the router must not hand it the request
    const onlyGoogle = new CreationProviderRouter();
    onlyGoogle.registerImageProvider(new GoogleImageAdapter({ apiKey: KEY }));
    assert.throws(() => onlyGoogle.selectImageProvider(spec({ constraints: { transparentBackground: true } }), {}));
  } finally {
    if (saved !== undefined) process.env.NAGEX_OPENAI_API_KEY = saved;
    if (savedO !== undefined) process.env.OPENAI_API_KEY = savedO;
  }
});

test('real executor path: bytes are stored as received, metadata and history are kept, and a variation builds on the first image', async () => {
  let n = 0;
  const fake = await fakeGoogle((_seen, res) => { n += 1; json(res, 200, geminiAnswer(n === 1 ? PNG_1X1 : JPEG_BYTES, n === 1 ? 'image/png' : 'image/jpeg')); });
  try {
    const providerRouter = new CreationProviderRouter();
    providerRouter.registerImageProvider(new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl }));
    const imageStore = new ImageStore();
    const executor = new ImageExecutor({ imageStore, artifactStore: new ArtifactStore(), providerRouter, auditLogger: new AuditLogger() });
    const owner = { tenantId: 'ten_gimg', ownerId: 'usr_gimg' };

    const first = await executor.execute({ creationKind: 'IMAGE', prompt: 'A red bicycle on a brick wall', ...owner, requestId: 'req_gimg_1', options: { aspectRatio: '16:9' } } as any);
    assert.equal(first.status, 'SUCCESS', JSON.stringify(first));
    const record = imageStore.get(first.creationId, owner.tenantId, owner.ownerId);
    assert.ok(record, 'the image record exists for its owner');
    assert.equal(record!.mimeType, 'image/png');
    assert.equal(record!.providerExecutionMetadata.providerId, 'google');
    assert.equal(record!.providerExecutionMetadata.engineOrModel, 'gemini-2.5-flash-image');
    assert.deepEqual(imageStore.getBinary(record!.binaryStoragePath), PNG_1X1, 'the stored bytes are exactly what the provider returned');
    assert.equal(imageStore.get(first.creationId, 'ten_other', owner.ownerId), null, 'another tenant cannot read it');
    assert.equal(imageStore.get(first.creationId, owner.tenantId, 'usr_other'), null, 'another user cannot read it');

    const second = await executor.executeRevision({ parentImageId: first.creationId, ...owner, requestId: 'req_gimg_2', instruction: 'make it blue' } as any);
    assert.equal(second.status, 'SUCCESS', JSON.stringify(second));
    assert.match(fake.calls[1].body.contents[0].parts[0].text, /blue/, 'the instruction reaches the provider');
    const lineage = imageStore.getLineage(first.creationId, owner.tenantId, owner.ownerId);
    assert.equal(lineage.length, 2);
    assert.equal(lineage[1].mimeType, 'image/jpeg');
    assert.equal(imageStore.list(owner.tenantId, owner.ownerId).length, 2, 'both images are in the history');
  } finally {
    await fake.close();
  }
});

test('real executor path: a quota failure is FAILED with the quota code, stores nothing, and records no image', async () => {
  const fake = await fakeGoogle((_seen, res) => json(res, 429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }));
  try {
    const providerRouter = new CreationProviderRouter();
    providerRouter.registerImageProvider(new GoogleImageAdapter({ apiKey: KEY, baseUrl: fake.baseUrl }));
    const imageStore = new ImageStore();
    const artifactStore = new ArtifactStore();
    const executor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger: new AuditLogger() });
    const owner = { tenantId: 'ten_gimg_q', ownerId: 'usr_gimg_q' };
    const result = await executor.execute({ creationKind: 'IMAGE', prompt: 'A lighthouse at dawn', ...owner, requestId: 'req_gimg_q' } as any);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'PROVIDER_QUOTA_EXCEEDED');
    assert.equal(imageStore.list(owner.tenantId, owner.ownerId).length, 0, 'a failed generation leaves no image behind');
  } finally {
    await fake.close();
  }
});
