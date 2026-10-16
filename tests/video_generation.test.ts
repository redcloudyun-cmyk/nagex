// Video generation (Higgsfield REST adapter, Veo adapter, job service, routes) against loopback stand-ins written from the providers' public documentation.
//
// What a pass proves: NAgex prices before it sends, sends nothing until the exact request is approved, starts a paid job at most once, polls with bounds,
// accepts only a real MP4, stores it for its owner alone, and reports every failure as what it is. What it does NOT prove: that Higgsfield or Google answer
// like these stand-ins today, or what a real model draws - a live run needs credentials and spend that were not authorised (see the sprint evidence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { ImageStore } from '../src/creation/image.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { HiggsfieldVideoAdapter } from '../src/creation/providers/adapters/higgsfield-video-adapter.js';
import { VeoVideoAdapter } from '../src/creation/providers/adapters/veo-video-adapter.js';
import { VideoProviderError } from '../src/creation/providers/video-provider-error.js';
import { VideoStore } from '../src/creation/video.store.js';
import { VideoJobService } from '../src/creation/video-job.service.js';
import { validateMp4 } from '../src/creation/video-media.js';
import { handleVideoCreationRoutes, parseRange } from '../src/http/routes/video-creation.routes.js';
import { authAs } from './_s1_session_auth.js';
import { fakeHiggsfield, type FakeHiggsfieldOptions } from './_fake_higgsfield.js';
import { makeMp4 } from './_mp4_fixture.js';
import { decideRouting } from '../src/workspace/input-router.js';
import { CAPABILITY_BRIEF, capabilityBriefFor, capabilityBriefLines } from '../src/model-gateway/capability-brief.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { toArtifactUxProjection } from '../src/artifacts/artifact.types.js';

const TENANT = 'ten_video';
const OWNER = 'usr_video';
const OTHER = 'usr_video_other';
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// ── MP4 validation ──────────────────────────────────────────────────────────

test('MP4 check: accepts a structurally valid file and refuses empty, HTML, cut-off, non-MP4 and moov-less files', () => {
  const ok = validateMp4(makeMp4());
  assert.equal(ok.mimeType, 'video/mp4');
  assert.equal(ok.majorBrand, 'isom');
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => validateMp4(Buffer.alloc(0)), (e: any) => e.code === 'MEDIA_INVALID');
  assert.throws(() => validateMp4(Buffer.from('<html><body>403 Forbidden</body></html>'.padEnd(64, ' '))), (e: any) => e.code === 'MEDIA_INVALID');
  const whole = makeMp4();
  assert.throws(() => validateMp4(whole.subarray(0, whole.length - 100)), (e: any) => e.code === 'MEDIA_INVALID', 'a truncated download is not accepted');
  const notFtyp = Buffer.from(whole); notFtyp.write('free', 4, 'latin1');
  assert.throws(() => validateMp4(notFtyp), (e: any) => e.code === 'MEDIA_INVALID', 'first box must be ftyp');
  const noMoov = Buffer.from(whole); noMoov.write('skip', whole.indexOf('moov'), 'latin1');
  assert.throws(() => validateMp4(noMoov), (e: any) => e.code === 'MEDIA_INVALID', 'a file without a movie box is incomplete');
});

test('Range header parsing', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 }, 'an end past the file is clamped');
  assert.equal(parseRange('bytes=2000-', 1000), 'UNSATISFIABLE');
  assert.equal(parseRange('bytes=9-3', 1000), 'UNSATISFIABLE');
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
});

// ── Higgsfield adapter ─────────────────────────────────────────────────────

const spec = (extra: Record<string, unknown> = {}) => ({
  creationKind: 'VIDEO', title: 'Video: a fox', locale: 'en', tenantId: TENANT, ownerId: OWNER, requestId: 'req_v1',
  totalDurationSeconds: 5, aspectRatio: '16:9', narrativeSummary: 'A red fox runs across a snowy field at dawn',
  storyboard: [{ sceneId: 's1', objective: 'o', durationSeconds: 5, visualDescription: 'A red fox runs across a snowy field at dawn' }], ...extra,
}) as any;

async function higgs(options: FakeHiggsfieldOptions = {}) {
  const fake = await fakeHiggsfield(options);
  const adapter = new HiggsfieldVideoAdapter({ keyId: fake.keyId, keySecret: fake.keySecret, baseUrl: fake.baseUrl, allowLocalTestDestinations: true, requestTimeoutMs: 3000 });
  return { fake, adapter };
}

test('Higgsfield: estimate -> submit -> poll -> download follow the documented contract; the key is only in the Authorization header', async () => {
  const { fake, adapter } = await higgs({ usd: 0.21, credits: 3.4, inProgressPolls: 1 });
  try {
    assert.equal(adapter.getStatus(), 'AVAILABLE');
    const estimate = await adapter.estimateCost(spec());
    assert.deepEqual(estimate, { usd: 0.21, credits: 3.4, basis: 'PROVIDER_QUOTE' });
    assert.equal(fake.estimates[0].path, 'kling-video/v3.0/std/text-to-video');
    assert.equal(fake.estimates[0].body.prompt, 'A red fox runs across a snowy field at dawn');
    assert.equal(fake.estimates[0].body.duration, 5);
    assert.equal(fake.estimates[0].body.aspect_ratio, '16:9');

    const { providerRequestId } = await adapter.submitVideo(spec(), { idempotencyKey: 'nagex-vid_k1' });
    assert.match(providerRequestId, /^[0-9a-f-]{36}$/);
    assert.equal(fake.submits.length, 1);
    assert.equal(fake.submits[0].idempotencyKey, 'nagex-vid_k1');
    assert.equal(fake.submits[0].authorization, `Key ${fake.keyId}:${fake.keySecret}`);

    assert.deepEqual(await adapter.pollVideo(providerRequestId), { state: 'RUNNING' });
    const done = await adapter.pollVideo(providerRequestId);
    assert.equal(done.state, 'COMPLETED');
    assert.match(done.media!.url, /\/media\/video\.mp4$/);
    const file = await adapter.downloadVideo(done.media!);
    assert.equal(file.mimeType, 'video/mp4');
    assert.doesNotThrow(() => validateMp4(file.bytes));
  } finally { await fake.close(); }
});

test('Higgsfield: duration is clamped to what the model offers, and a status_url from the response is never followed with the credential', async () => {
  const { fake, adapter } = await higgs({ evilStatusUrl: true });
  try {
    await adapter.estimateCost(spec({ totalDurationSeconds: 99 }));
    assert.equal(fake.estimates[0].body.duration, 15);
    const { providerRequestId } = await adapter.submitVideo(spec({ totalDurationSeconds: 1 }), { idempotencyKey: 'k' });
    assert.equal(fake.submits[0].body.duration, 3);
    await adapter.pollVideo(providerRequestId);
    assert.equal(fake.evilHits, 0, 'the address in the response was not contacted');
    assert.equal(fake.statusPolls, 1, 'the status was read from the configured base URL');
  } finally { await fake.close(); }
});

test('Higgsfield: failed, nsfw, canceled, unknown and file-less states are reported as what they are', async () => {
  for (const [finalState, expected] of [['failed', 'FAILED'], ['nsfw', 'CONTENT_REJECTED']] as const) {
    const { fake, adapter } = await higgs({ inProgressPolls: 0, finalState, failureText: 'model crashed' });
    try {
      const { providerRequestId } = await adapter.submitVideo(spec(), { idempotencyKey: 'k' });
      const result = await adapter.pollVideo(providerRequestId);
      assert.equal(result.state, expected);
      if (finalState === 'failed') assert.match(result.errorMessage || '', /model crashed/);
      assert.equal(result.media, undefined);
    } finally { await fake.close(); }
  }
  const { fake, adapter } = await higgs({ queuedPolls: 1, inProgressPolls: 0 });
  try {
    const { providerRequestId } = await adapter.submitVideo(spec(), { idempotencyKey: 'k' });
    assert.equal((await adapter.cancelVideo!(providerRequestId)), 'CANCELLED');
    assert.equal((await adapter.pollVideo(providerRequestId)).state, 'CANCELLED');
  } finally { await fake.close(); }
});

test('Higgsfield: cancel is refused once processing has started', async () => {
  const { fake, adapter } = await higgs({ queuedPolls: 0, inProgressPolls: 2 });
  try {
    const { providerRequestId } = await adapter.submitVideo(spec(), { idempotencyKey: 'k' });
    await adapter.pollVideo(providerRequestId); // now in progress
    assert.equal(await adapter.cancelVideo!(providerRequestId), 'NOT_CANCELLABLE');
  } finally { await fake.close(); }
});

test('Higgsfield: HTTP errors map to distinct codes (401, 403 credits, 404, 422, 503 busy, 500)', async () => {
  const cases: Array<[number, string, boolean]> = [[403, 'PROVIDER_INSUFFICIENT_CREDITS', false], [404, 'PROVIDER_MODEL_NOT_FOUND', false], [422, 'PROVIDER_REJECTED_REQUEST', false], [503, 'PROVIDER_UNAVAILABLE_ERROR', true], [500, 'PROVIDER_UNAVAILABLE_ERROR', true]];
  for (const [status, code, retryable] of cases) {
    const { fake, adapter } = await higgs({ submitFailures: [status] });
    try {
      await assert.rejects(() => adapter.submitVideo(spec(), { idempotencyKey: 'k' }), (e: any) => e instanceof VideoProviderError && e.code === code && e.retryable === retryable && e.httpStatus === status, `HTTP ${status}`);
    } finally { await fake.close(); }
  }
  const { fake } = await higgs();
  try {
    const wrong = new HiggsfieldVideoAdapter({ keyId: 'nope', keySecret: 'nope', baseUrl: fake.baseUrl, allowLocalTestDestinations: true });
    await assert.rejects(() => wrong.estimateCost(spec()), (e: any) => e.code === 'PROVIDER_AUTH_FAILED' && !String(e.message).includes('nope'));
  } finally { await fake.close(); }
});

test('Higgsfield: unconfigured -> UNCONFIGURED and nothing is sent; an odd model family is ignored, not put in a URL', async () => {
  const saved = { a: process.env.NAGEX_HIGGSFIELD_KEY_ID, b: process.env.NAGEX_HIGGSFIELD_KEY_SECRET, c: process.env.HF_API_KEY_ID, d: process.env.HF_API_KEY_SECRET };
  for (const k of ['NAGEX_HIGGSFIELD_KEY_ID', 'NAGEX_HIGGSFIELD_KEY_SECRET', 'HF_API_KEY_ID', 'HF_API_KEY_SECRET']) delete process.env[k];
  try {
    const none = new HiggsfieldVideoAdapter({ baseUrl: 'http://127.0.0.1:1' });
    assert.equal(none.getStatus(), 'UNCONFIGURED');
    await assert.rejects(() => none.estimateCost(spec()), (e: any) => e.code === 'PROVIDER_UNCONFIGURED');
    const odd = new HiggsfieldVideoAdapter({ keyId: 'a', keySecret: 'b', modelFamily: '../../admin?x=1' });
    assert.equal(odd.modelFor(spec()), 'kling-video/v3.0/std/text-to-video');
  } finally {
    if (saved.a !== undefined) process.env.NAGEX_HIGGSFIELD_KEY_ID = saved.a;
    if (saved.b !== undefined) process.env.NAGEX_HIGGSFIELD_KEY_SECRET = saved.b;
    if (saved.c !== undefined) process.env.HF_API_KEY_ID = saved.c;
    if (saved.d !== undefined) process.env.HF_API_KEY_SECRET = saved.d;
  }
});

test('Higgsfield media download: not an MP4 / wrong host rules are enforced by the caller; a private address is refused when local hosts are not allowed', async () => {
  const { fake } = await higgs();
  try {
    const strict = new HiggsfieldVideoAdapter({ keyId: 'a', keySecret: 'b', baseUrl: fake.baseUrl, allowLocalTestDestinations: false });
    await assert.rejects(() => strict.downloadVideo({ url: `${fake.baseUrl}/media/video.mp4` }), (e: any) => e.code === 'MEDIA_DOWNLOAD_FAILED');
    await assert.rejects(() => strict.downloadVideo({ url: 'http://169.254.169.254/latest/meta-data' }), (e: any) => e.code === 'MEDIA_DOWNLOAD_FAILED');
    await assert.rejects(() => strict.downloadVideo({ url: 'file:///etc/passwd' }), (e: any) => e.code === 'MEDIA_DOWNLOAD_FAILED');
  } finally { await fake.close(); }
});

// ── Veo adapter ────────────────────────────────────────────────────────────

interface VeoCall { method?: string; url?: string; key?: string | string[]; body: any }
async function fakeVeo(handler: (call: VeoCall, res: http.ServerResponse, base: string) => void) {
  const calls: VeoCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ }
      const call = { method: req.method, url: req.url, key: req.headers['x-goog-api-key'], body };
      calls.push(call);
      handler(call, res, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { calls, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('Veo: not offered unless the operator enabled it; the price comes from the published table; request and poll follow the documented shape', async () => {
  const mp4 = makeMp4();
  let polls = 0;
  const veo = await fakeVeo((call, res, host) => {
    if (call.url?.endsWith(':predictLongRunning')) return send(res, 200, { name: 'models/veo-3.1-lite-generate-preview/operations/op123' });
    if (call.url?.includes('/operations/op123')) { polls += 1; return send(res, 200, polls < 2 ? { name: 'x', done: false } : { name: 'x', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${host}/v1beta/files/f1:download?alt=media` } }] } } }); }
    if (call.url?.includes('/files/f1:download')) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length }); return res.end(mp4); }
    send(res, 404, {});
  });
  try {
    const off = new VeoVideoAdapter({ apiKey: 'AIza-test', baseUrl: veo.base });
    assert.equal(off.getStatus(), 'UNCONFIGURED', 'a Gemini key alone does not mean Veo is usable');
    await assert.rejects(() => off.submitVideo(spec()), (e: any) => e.code === 'PROVIDER_UNCONFIGURED');
    assert.equal(veo.calls.length, 0);

    const adapter = new VeoVideoAdapter({ apiKey: 'AIza-test', enabled: true, baseUrl: veo.base, allowLocalTestDestinations: true });
    assert.equal(adapter.getStatus(), 'AVAILABLE');
    assert.deepEqual(await adapter.estimateCost(spec({ totalDurationSeconds: 8 })), { usd: 0.4, credits: null, basis: 'PRICE_TABLE' }, '8 s x $0.05 (lite, 720p)');
    assert.equal(veo.calls.length, 0, 'the estimate is computed, not requested');

    const { providerRequestId } = await adapter.submitVideo(spec({ totalDurationSeconds: 5 }));
    assert.equal(providerRequestId, 'models/veo-3.1-lite-generate-preview/operations/op123');
    const submit = veo.calls[0];
    assert.equal(submit.url, '/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning');
    assert.equal(submit.key, 'AIza-test');
    assert.ok(!submit.url!.includes('key='));
    assert.equal(submit.body.instances[0].prompt, 'A red fox runs across a snowy field at dawn');
    assert.deepEqual(submit.body.parameters, { aspectRatio: '16:9', durationSeconds: '4', resolution: '720p' }, '5 s is offered as the nearest allowed length');

    assert.deepEqual(await adapter.pollVideo(providerRequestId), { state: 'RUNNING' });
    const done = await adapter.pollVideo(providerRequestId);
    assert.equal(done.state, 'COMPLETED');
    const file = await adapter.downloadVideo(done.media!);
    assert.doesNotThrow(() => validateMp4(file.bytes));
    assert.equal(veo.calls.at(-1)!.key, 'AIza-test', 'the key goes to the Google API host that issued the address');
  } finally { await veo.close(); }
});

test('Veo: image-to-video sends the image inline; billing / quota / auth / safety are different errors; a foreign download host never receives the key', async () => {
  let mode = 'billing';
  const veo = await fakeVeo((call, res) => {
    if (call.url?.endsWith(':predictLongRunning')) {
      if (mode === 'billing') return send(res, 400, { error: { status: 'FAILED_PRECONDITION', message: 'Veo is only available on the paid tier. Please enable billing.' } });
      if (mode === 'quota') return send(res, 429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } });
      if (mode === 'auth') return send(res, 403, { error: { status: 'PERMISSION_DENIED', message: 'no access' } });
      return send(res, 200, { name: 'operations/opX' });
    }
    send(res, 200, { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['Safety filter'] } } });
  });
  try {
    const adapter = new VeoVideoAdapter({ apiKey: 'AIza-test', enabled: true, baseUrl: veo.base, allowLocalTestDestinations: true });
    for (const [m, code] of [['billing', 'PROVIDER_BILLING_REQUIRED'], ['quota', 'PROVIDER_QUOTA_EXCEEDED'], ['auth', 'PROVIDER_AUTH_FAILED']] as const) {
      mode = m;
      await assert.rejects(() => adapter.submitVideo(spec()), (e: any) => e.code === code && !String(e.message).includes('AIza-test'), m);
    }
    mode = 'ok';
    const png = Buffer.from('iVBORw0KGgo=', 'base64');
    const { providerRequestId } = await adapter.submitVideo(spec({ sourceImage: { bytes: png, mimeType: 'image/png', imageId: 'img_x' } }));
    assert.equal(veo.calls.at(-1)!.body.instances[0].image.inlineData.data, png.toString('base64'));
    assert.equal(veo.calls.at(-1)!.body.instances[0].image.inlineData.mimeType, 'image/png');
    const filtered = await adapter.pollVideo(providerRequestId);
    assert.equal(filtered.state, 'CONTENT_REJECTED');
    await assert.rejects(() => adapter.downloadVideo({ url: 'https://example.com/v.mp4' }), (e: any) => e.code === 'MEDIA_DOWNLOAD_FAILED');
  } finally { await veo.close(); }
});

// ── the job service ────────────────────────────────────────────────────────

async function world(options: FakeHiggsfieldOptions = {}, serviceOptions: Record<string, unknown> = {}) {
  const { fake, adapter } = await higgs(options);
  const clock = { t: Date.parse('2026-10-16T10:00:00.000Z') };
  const router = new CreationProviderRouter();
  router.registerVideoProvider(adapter);
  const approvals = new ActionApprovalStore(() => clock.t, 15 * 60 * 1000);
  const videoStore = new VideoStore({ metaDir: tmp('nagex-vid-meta-'), bytesDir: tmp('nagex-vid-bytes-') });
  const imageStore = new ImageStore({ metaDir: tmp('nagex-vid-img-meta-'), bytesDir: tmp('nagex-vid-img-bytes-') });
  const artifactStore = new ArtifactStore({ dir: tmp('nagex-vid-art-'), now: () => new Date(clock.t).toISOString() });
  const service = new VideoJobService({ store: videoStore, providerRouter: router, approvalStore: approvals, artifactStore, imageStore, now: () => clock.t, ...serviceOptions });
  const prepare = (prompt = 'A red fox runs across a snowy field at dawn', extra: Record<string, unknown> = {}) =>
    service.prepare({ tenantId: TENANT, ownerId: OWNER, requestId: 'req_p', prompt, durationSeconds: 5, ...extra });
  const drive = async (jobId: string, until: (status: string) => boolean, steps = 40) => {
    let job = service.get(jobId, TENANT, OWNER)!;
    for (let i = 0; i < steps && !until(job.status); i += 1) {
      clock.t += 11_000;
      job = (await service.refresh(jobId, TENANT, OWNER))!;
    }
    return job;
  };
  return { fake, adapter, clock, router, approvals, videoStore, imageStore, artifactStore, service, prepare, drive };
}

test('service: prepare prices and asks for approval - NOTHING is sent to the provider', async () => {
  const w = await world({ usd: 0.21 });
  try {
    const { job, deduplicated } = await w.prepare();
    assert.equal(deduplicated, false);
    assert.equal(job.status, 'AWAITING_APPROVAL');
    assert.equal(job.estimate.usd, 0.21);
    assert.equal(w.fake.estimates.length, 1);
    assert.equal(w.fake.submits.length, 0, 'no paid job was started');
    assert.equal(w.fake.jobCount(), 0);
    const view = w.service.toView(job);
    assert.equal(view.serviceLabel, 'Higgsfield');
    assert.equal(view.estimate.usd, 0.21);
    assert.equal((view as any).providerRequestId, undefined);
    assert.equal((view as any).idempotencyKey, undefined);
    const approval = w.approvals.get(job.approvalId, TENANT, OWNER);
    assert.equal(approval?.status, 'PENDING');
    assert.equal(approval?.toolId, 'creation.video.generate');
    assert.equal(approval?.canonicalPayload.estimateUsd, 0.21);
  } finally { await w.fake.close(); }
});

test('service: approve starts exactly one job, a double approve does not, and the same request is not prepared twice', async () => {
  const w = await world();
  try {
    const { job } = await w.prepare();
    const again = await w.prepare();
    assert.equal(again.deduplicated, true);
    assert.equal(again.job.jobId, job.jobId, 'an identical active request is the same job');

    const [first, second] = await Promise.all([w.service.approve(job.jobId, TENANT, OWNER, 'req_a1'), w.service.approve(job.jobId, TENANT, OWNER, 'req_a2')]);
    assert.ok(['PENDING', 'AWAITING_APPROVAL'].includes(second.job.status) || second.job.status === first.job.status);
    await w.service.approve(job.jobId, TENANT, OWNER, 'req_a3');
    assert.equal(w.fake.submits.length, 1, 'one paid job');
    assert.equal(w.fake.submits[0].idempotencyKey, w.service.get(job.jobId, TENANT, OWNER)!.idempotencyKey);
    const stored = w.service.get(job.jobId, TENANT, OWNER)!;
    assert.equal(stored.status, 'PENDING');
    assert.ok(stored.providerRequestId);
    assert.equal(w.approvals.get(stored.approvalId, TENANT, OWNER)?.status, 'CONSUMED');
  } finally { await w.fake.close(); }
});

test('service: the whole life - PENDING -> RUNNING -> COMPLETED, a real MP4 is stored for its owner, an artifact is created, nobody else can read it', async () => {
  const w = await world({ queuedPolls: 1, inProgressPolls: 2 });
  try {
    const { job } = await w.prepare();
    await w.service.approve(job.jobId, TENANT, OWNER, 'req_a');
    const seen: string[] = [];
    let current = w.service.get(job.jobId, TENANT, OWNER)!;
    for (let i = 0; i < 30 && current.status !== 'COMPLETED'; i += 1) {
      w.clock.t += 11_000;
      current = (await w.service.refresh(job.jobId, TENANT, OWNER))!;
      if (seen.at(-1) !== current.status) seen.push(current.status);
    }
    assert.deepEqual(seen, ['PENDING', 'RUNNING', 'COMPLETED'], 'real provider states, in order, no invented progress');
    assert.equal(current.mimeType, 'video/mp4');
    assert.equal(current.byteLength, makeMp4().length);
    assert.ok(current.artifactId);
    const media = w.service.media(job.jobId, TENANT, OWNER)!;
    assert.deepEqual(media.bytes, makeMp4(), 'the stored bytes are what the provider served');
    assert.equal(w.artifactStore.get(current.artifactId!, TENANT, OWNER)?.type, 'VIDEO');
    assert.equal(w.artifactStore.get(current.artifactId!, TENANT, OWNER)?.openTarget, `/api/v1/creations/videos/${job.jobId}`);
    assert.ok(!/higgsfield|kling/i.test(w.artifactStore.get(current.artifactId!, TENANT, OWNER)!.preview), 'the creation card text is provider-neutral');
    assert.equal(w.service.get(job.jobId, TENANT, OTHER), null, 'another person gets nothing');
    assert.equal(w.service.get(job.jobId, 'ten_other', OWNER), null, 'another tenant gets nothing');
    assert.equal(w.service.media(job.jobId, TENANT, OTHER), null);
    const view = w.service.toView(current);
    assert.equal(view.mediaUrl, `/api/v1/creations/videos/${job.jobId}/media`);
    // a restart: a fresh store over the same directory sees the same finished job and bytes
    const reopened = new VideoStore({ metaDir: (w.videoStore as any).records.dir, bytesDir: (w.videoStore as any).bytesDir });
    assert.equal(reopened.get(job.jobId, TENANT, OWNER)?.status, 'COMPLETED');
    assert.deepEqual(reopened.readBinary(reopened.get(job.jobId, TENANT, OWNER)!), makeMp4());
  } finally { await w.fake.close(); }
});

test('service: declining sends nothing; an approval that expires sends nothing; a declined job cannot be approved later', async () => {
  const w = await world();
  try {
    const { job } = await w.prepare();
    const declined = w.service.decline(job.jobId, TENANT, OWNER, 'req_d');
    assert.equal(declined.status, 'DECLINED');
    assert.equal(declined.errorCode, 'USER_DECLINED');
    const after = await w.service.approve(job.jobId, TENANT, OWNER, 'req_a');
    assert.equal(after.job.status, 'DECLINED');
    assert.equal(w.fake.submits.length, 0);

    const { job: second } = await w.prepare('A blue whale glides under pack ice');
    w.clock.t += 16 * 60 * 1000;
    await assert.rejects(() => w.service.approve(second.jobId, TENANT, OWNER, 'req_e'), (e: any) => e.code === 'APPROVAL_EXPIRED');
    assert.equal(w.service.get(second.jobId, TENANT, OWNER)!.status, 'DECLINED');
    assert.equal(w.service.get(second.jobId, TENANT, OWNER)!.errorCode, 'APPROVAL_EXPIRED');
    assert.equal(w.fake.submits.length, 0, 'an expired approval never starts a job');

    const { job: third } = await w.prepare('A paper boat on a rain puddle');
    w.clock.t += 16 * 60 * 1000;
    await w.service.tick();
    assert.equal(w.service.get(third.jobId, TENANT, OWNER)!.status, 'DECLINED', 'the driver also retires a lapsed approval');
  } finally { await w.fake.close(); }
});

test('service: nobody else can approve, decline, cancel or read a job (indistinguishable from not existing)', async () => {
  const w = await world();
  try {
    const { job } = await w.prepare();
    await assert.rejects(() => w.service.approve(job.jobId, TENANT, OTHER, 'r'), (e: any) => e.code === 'VIDEO_NOT_FOUND');
    assert.throws(() => w.service.decline(job.jobId, TENANT, OTHER, 'r'), (e: any) => e.code === 'VIDEO_NOT_FOUND');
    await assert.rejects(() => w.service.cancel(job.jobId, 'ten_other', OWNER, 'r'), (e: any) => e.code === 'VIDEO_NOT_FOUND');
    assert.equal(await w.service.refresh(job.jobId, TENANT, OTHER), null);
    assert.equal(w.fake.submits.length, 0);
  } finally { await w.fake.close(); }
});

test('service: a price that rose after it was shown needs a NEW approval; the old one cannot start anything', async () => {
  const w = await world({ usd: 0.2 });
  try {
    const { job } = await w.prepare();
    const oldApproval = job.approvalId;
    w.fake.opts.usd = 0.5;
    const result = await w.service.approve(job.jobId, TENANT, OWNER, 'req_a');
    assert.equal(result.reapprovalRequired, true);
    assert.equal(result.job.status, 'AWAITING_APPROVAL');
    assert.equal(result.job.estimate.usd, 0.5);
    assert.notEqual(result.job.approvalId, oldApproval);
    assert.equal(w.approvals.get(oldApproval, TENANT, OWNER)?.status, 'REJECTED');
    assert.equal(w.fake.submits.length, 0);
    const second = await w.service.approve(job.jobId, TENANT, OWNER, 'req_a2');
    assert.equal(second.reapprovalRequired, false);
    assert.equal(second.job.status, 'PENDING');
    assert.equal(w.fake.submits.length, 1);
    // a small drift inside the tolerance does not bother the person again
    w.fake.opts.usd = 0.53;
    const { job: other } = await w.prepare('Mist over a quiet lake');
    w.fake.opts.usd = 0.55;
    assert.equal((await w.service.approve(other.jobId, TENANT, OWNER, 'req_a3')).reapprovalRequired, false);
  } finally { await w.fake.close(); }
});

test('service: a video dearer than the limit is refused before any approval is asked for', async () => {
  const w = await world({ usd: 7.5 });
  try {
    await assert.rejects(() => w.prepare(), (e: any) => e.code === 'COST_LIMIT_EXCEEDED');
    assert.equal(w.service.list(TENANT, OWNER).length, 0, 'no job and no approval were created');
  } finally { await w.fake.close(); }
});

test('service: provider-side failure, content rejection and credit problems are reported as themselves', async () => {
  const failed = await world({ inProgressPolls: 0, finalState: 'failed', failureText: 'render crashed' });
  try {
    const { job } = await failed.prepare();
    await failed.service.approve(job.jobId, TENANT, OWNER, 'r');
    const done = await failed.drive(job.jobId, (s) => s === 'FAILED');
    assert.equal(done.status, 'FAILED');
    assert.match(done.errorMessage || '', /render crashed/);
    assert.equal(done.artifactId, undefined);
    assert.equal(failed.service.media(job.jobId, TENANT, OWNER), null);
  } finally { await failed.fake.close(); }

  const nsfw = await world({ inProgressPolls: 0, finalState: 'nsfw' });
  try {
    const { job } = await nsfw.prepare();
    await nsfw.service.approve(job.jobId, TENANT, OWNER, 'r');
    const done = await nsfw.drive(job.jobId, (s) => s === 'FAILED');
    assert.equal(done.errorCode, 'CONTENT_REJECTED');
  } finally { await nsfw.fake.close(); }

  const noCredit = await world({ submitFailures: [403] });
  try {
    const { job } = await noCredit.prepare();
    const { job: after } = await noCredit.service.approve(job.jobId, TENANT, OWNER, 'r');
    assert.equal(after.status, 'UNAVAILABLE', 'a refused submission is "cannot be done now", not a started job');
    assert.equal(after.errorCode, 'PROVIDER_INSUFFICIENT_CREDITS');
    assert.equal(noCredit.fake.jobCount(), 0);
  } finally { await noCredit.fake.close(); }
});

test('service: a lost answer to the submission is retried ONCE with the same key (no second paid job); a second loss is said as uncertain', async () => {
  const w = await world({ submitFailures: [500] });
  try {
    const { job } = await w.prepare();
    const { job: after } = await w.service.approve(job.jobId, TENANT, OWNER, 'r');
    assert.equal(after.status, 'PENDING', 'the retry reached the provider');
    assert.equal(w.fake.submits.length, 2);
    assert.equal(w.fake.submits[0].idempotencyKey, w.fake.submits[1].idempotencyKey);
    assert.equal(w.fake.jobCount(), 1, 'one job at the provider');
  } finally { await w.fake.close(); }
  const w2 = await world({ submitFailures: [500, 502] });
  try {
    const { job } = await w2.prepare();
    const { job: after } = await w2.service.approve(job.jobId, TENANT, OWNER, 'r');
    assert.equal(after.status, 'FAILED');
    assert.equal(after.errorCode, 'SUBMIT_UNCERTAIN');
    assert.match(after.errorMessage || '', /could not confirm/i);
    assert.equal(w2.fake.submits.length, 2, 'no further blind retries');
  } finally { await w2.fake.close(); }
});

test('service: a restart in the middle of a submission is resolved - same key where the provider de-duplicates, "uncertain" otherwise', async () => {
  const w = await world();
  try {
    const { job } = await w.prepare();
    // simulate: approval consumed, state written, process died before the provider answered
    w.approvals.approve(job.approvalId, TENANT, OWNER, 'r');
    const stored = w.service.get(job.jobId, TENANT, OWNER)!;
    stored.status = 'SUBMITTING'; stored.submitAttempts = 1; w.videoStore.save(stored);
    await w.service.tick();
    const resumed = w.service.get(job.jobId, TENANT, OWNER)!;
    assert.equal(resumed.status, 'PENDING');
    assert.equal(w.fake.submits.length, 1);
    assert.equal(w.fake.submits[0].idempotencyKey, stored.idempotencyKey);
    // the same thing again with the key already used at the provider: still one job
    const again = w.service.get(job.jobId, TENANT, OWNER)!;
    again.status = 'SUBMITTING'; again.submitAttempts = 1; w.videoStore.save(again);
    await w.service.tick();
    assert.equal(w.fake.jobCount(), 1, 'the provider returned the existing job for the same key');
  } finally { await w.fake.close(); }

  // a provider with no idempotency key: never guess
  const veo = await fakeVeo((_c, res) => send(res, 200, { name: 'operations/op1' }));
  try {
    const adapter = new VeoVideoAdapter({ apiKey: 'AIza-t', enabled: true, baseUrl: veo.base });
    const clock = { t: Date.parse('2026-10-16T10:00:00Z') };
    const router = new CreationProviderRouter(); router.registerVideoProvider(adapter);
    const approvals = new ActionApprovalStore(() => clock.t);
    const store = new VideoStore({ metaDir: tmp('nagex-veo-m-'), bytesDir: tmp('nagex-veo-b-') });
    const service = new VideoJobService({ store, providerRouter: router, approvalStore: approvals, now: () => clock.t });
    const { job } = await service.prepare({ tenantId: TENANT, ownerId: OWNER, requestId: 'r', prompt: 'Waves at dusk', durationSeconds: 4 });
    approvals.approve(job.approvalId, TENANT, OWNER, 'r');
    job.status = 'SUBMITTING'; job.submitAttempts = 1; store.save(job);
    await service.tick();
    const after = service.get(job.jobId, TENANT, OWNER)!;
    assert.equal(after.status, 'FAILED');
    assert.equal(after.errorCode, 'SUBMIT_UNCERTAIN');
    assert.equal(veo.calls.length, 0, 'nothing was resent blindly');
  } finally { await veo.close(); }
});

test('service: waiting is bounded, a file that is not an MP4 is not a success, a provider outage is retried a few times only', async () => {
  const slow = await world({ inProgressPolls: 999 }, { maxWaitMs: 60_000 });
  try {
    const { job } = await slow.prepare();
    await slow.service.approve(job.jobId, TENANT, OWNER, 'r');
    const done = await slow.drive(job.jobId, (s) => s === 'FAILED', 20);
    assert.equal(done.status, 'FAILED');
    assert.equal(done.errorCode, 'WAIT_LIMIT_REACHED');
    assert.match(done.errorMessage || '', /may still complete|check/i);
  } finally { await slow.fake.close(); }

  const html = await world({ inProgressPolls: 0, mediaBody: Buffer.from('<html>Access denied</html>'.padEnd(80, ' ')), mediaContentType: 'text/html' });
  try {
    const { job } = await html.prepare();
    await html.service.approve(job.jobId, TENANT, OWNER, 'r');
    const done = await html.drive(job.jobId, (s) => s === 'FAILED');
    assert.equal(done.status, 'FAILED');
    assert.equal(done.errorCode, 'MEDIA_INVALID');
    assert.equal(html.service.media(job.jobId, TENANT, OWNER), null);
    assert.equal(done.artifactId, undefined, 'no artifact for a video that was never obtained');
  } finally { await html.fake.close(); }
});

test('service: queued jobs can be cancelled at a provider that supports it; a started one cannot', async () => {
  const queued = await world({ queuedPolls: 5, inProgressPolls: 1 });
  try {
    const { job } = await queued.prepare();
    await queued.service.approve(job.jobId, TENANT, OWNER, 'r');
    assert.equal(queued.service.toView(queued.service.get(job.jobId, TENANT, OWNER)!).cancellable, true);
    const result = await queued.service.cancel(job.jobId, TENANT, OWNER, 'r2');
    assert.equal(result.cancelled, true);
    assert.equal(result.job.status, 'CANCELLED');
  } finally { await queued.fake.close(); }

  const running = await world({ queuedPolls: 0, inProgressPolls: 5 });
  try {
    const { job } = await running.prepare();
    await running.service.approve(job.jobId, TENANT, OWNER, 'r');
    await running.drive(job.jobId, (s) => s === 'RUNNING', 5);
    await assert.rejects(() => running.service.cancel(job.jobId, TENANT, OWNER, 'r2'), (e: any) => e.code === 'CANCEL_NOT_POSSIBLE');
    assert.equal(running.service.get(job.jobId, TENANT, OWNER)!.status, 'RUNNING');
  } finally { await running.fake.close(); }
});

test('service: image-to-video uses the person\'s own image, uploads it only after approval, and refuses someone else\'s image', async () => {
  const w = await world();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const binaryStoragePath = w.imageStore.saveBinary('img_0123456789abcdef01234567', png, 'image/png');
    w.imageStore.save({
      imageId: 'img_0123456789abcdef01234567', tenantId: TENANT, ownerId: OWNER, title: 't', prompt: 'p', aspectRatio: '1:1', mimeType: 'image/png', width: 1, height: 1,
      binaryStoragePath, revisionIndex: 1, sourceRefs: [], providerExecutionMetadata: { providerId: 'x', createdAt: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await assert.rejects(() => w.service.prepare({ tenantId: TENANT, ownerId: OTHER, requestId: 'r', prompt: 'Animate this', sourceImageId: 'img_0123456789abcdef01234567' }), (e: any) => e.code === 'IMAGE_NOT_FOUND');
    const { job } = await w.prepare('The picture slowly comes alive', { sourceImageId: 'img_0123456789abcdef01234567' });
    assert.equal(job.mode, 'IMAGE_TO_VIDEO');
    assert.equal(job.model, 'kling-video/v3.0/std/image-to-video');
    assert.equal(w.fake.uploadSlots, 0, 'the image has not left NAgex before approval');
    assert.equal(w.fake.estimates[0].path, 'kling-video/v3.0/std/text-to-video', 'priced from the text-to-video quote and labelled an estimate');
    assert.equal(job.estimate.basis, 'PRICE_TABLE');
    await w.service.approve(job.jobId, TENANT, OWNER, 'r');
    assert.equal(w.fake.uploadSlots, 1);
    assert.equal(w.fake.uploads[0].bytes, png.length);
    assert.equal(w.fake.uploads[0].authorization, undefined, 'no credential is sent to the upload address');
    assert.match(w.fake.submits[0].body.image_url, /\/public\/[0-9a-f]+\.png$/);
    assert.equal(w.fake.submits[0].body.aspect_ratio, undefined);
  } finally { await w.fake.close(); }
});

test('service: with no video service configured nothing is offered; with one, availability is true', async () => {
  const empty = new CreationProviderRouter();
  const none = new VideoJobService({ store: new VideoStore({ metaDir: tmp('nagex-n-m-'), bytesDir: tmp('nagex-n-b-') }), providerRouter: empty, approvalStore: new ActionApprovalStore() });
  assert.equal(none.isAvailable(), false);
  await assert.rejects(() => none.prepare({ tenantId: TENANT, ownerId: OWNER, requestId: 'r', prompt: 'A cat' }), (e: any) => e.code === 'NO_CREATION_PROVIDER_AVAILABLE');
  const unconfigured = new CreationProviderRouter();
  unconfigured.registerVideoProvider(new HiggsfieldVideoAdapter({ keyId: '', keySecret: '', baseUrl: 'http://127.0.0.1:1' }));
  unconfigured.registerVideoProvider(new VeoVideoAdapter({ apiKey: 'AIza', enabled: false }));
  assert.equal(new VideoJobService({ store: new VideoStore({ metaDir: tmp('nagex-u-m-'), bytesDir: tmp('nagex-u-b-') }), providerRouter: unconfigured, approvalStore: new ActionApprovalStore() }).isAvailable(), false);
  const w = await world();
  try { assert.equal(w.service.isAvailable(), true); } finally { await w.fake.close(); }
});

// ── the routes ─────────────────────────────────────────────────────────────

const route = (...args: Parameters<typeof handleVideoCreationRoutes>): Promise<any> => handleVideoCreationRoutes(...args) as Promise<any>;

test('routes: prepare -> approve -> status -> playback with Range -> download; owner only; anonymous callers get nothing', async () => {
  const w = await world({ inProgressPolls: 0 });
  try {
    const call = (method: string, pathname: string, body: any, who: string | null, extra: Record<string, string> = {}, query: Record<string, string> = {}) =>
      // the verified identity is attached to the very headers object the session produced, so extra headers are added to it (not copied)
      route(method, pathname, body, who ? Object.assign(authAs(TENANT, who), extra) : { ...extra }, query, { videoJobService: w.service });

    assert.equal(await call('POST', '/api/v1/creations/videos', { prompt: 'x' }, null), undefined, 'anonymous: handled by the access gate, not here');
    assert.equal((await call('POST', '/api/v1/creations/videos', { prompt: '   ' }, OWNER))!.status, 400);
    assert.equal((await call('GET', '/api/v1/creations/videos/capability', null, OWNER))!.data.available, true);

    const created = (await call('POST', '/api/v1/creations/videos', { prompt: 'A red fox runs across a snowy field at dawn', durationSeconds: 5 }, OWNER))!;
    assert.equal(created.status, 201);
    const jobId = created.data.video.jobId;
    assert.equal(created.data.video.status, 'AWAITING_APPROVAL');
    assert.equal(w.fake.submits.length, 0);
    assert.equal((await call('POST', '/api/v1/creations/videos', { prompt: 'A red fox runs across a snowy field at dawn', durationSeconds: 5 }, OWNER))!.status, 200, 'the same request is not prepared twice');

    assert.equal((await call('GET', `/api/v1/creations/videos/${jobId}`, null, OTHER))!.status, 404);
    assert.equal((await call('POST', `/api/v1/creations/videos/${jobId}/approve`, {}, OTHER))!.status, 404);
    assert.equal(w.fake.submits.length, 0);

    const approved = (await call('POST', `/api/v1/creations/videos/${jobId}/approve`, {}, OWNER))!;
    assert.equal(approved.status, 200);
    assert.equal(approved.data.video.status, 'PENDING');

    w.clock.t += 11_000;
    const status = (await call('GET', `/api/v1/creations/videos/${jobId}`, null, OWNER))!;
    assert.equal(status.data.video.status, 'COMPLETED');
    assert.equal(status.data.video.mediaUrl, `/api/v1/creations/videos/${jobId}/media`);

    const whole = (await call('GET', `/api/v1/creations/videos/${jobId}/media`, null, OWNER))! as any;
    assert.equal(whole.status, 200);
    assert.equal(whole.contentType, 'video/mp4');
    assert.equal(whole.headers['Accept-Ranges'], 'bytes');
    assert.match(whole.headers['Content-Disposition'], /^inline;/);
    assert.deepEqual(whole.data, makeMp4());

    const partial = (await call('GET', `/api/v1/creations/videos/${jobId}/media`, null, OWNER, { range: 'bytes=0-99' }))! as any;
    assert.equal(partial.status, 206);
    assert.equal(partial.data.length, 100);
    assert.equal(partial.headers['Content-Range'], `bytes 0-99/${makeMp4().length}`);
    const bad = (await call('GET', `/api/v1/creations/videos/${jobId}/media`, null, OWNER, { range: 'bytes=999999-' }))! as any;
    assert.equal(bad.status, 416);

    const download = (await call('GET', `/api/v1/creations/videos/${jobId}/media`, null, OWNER, {}, { download: '1' }))! as any;
    assert.match(download.headers['Content-Disposition'], /^attachment; filename="nagex-vid_[0-9a-f]{24}\.mp4"$/);

    assert.equal((await call('GET', `/api/v1/creations/videos/${jobId}/media`, null, OTHER))!.status, 404, 'another person cannot play or download it');
    assert.equal((await call('GET', '/api/v1/creations/videos/vid_zzzz/media', null, OWNER))!.status, 404);
    assert.equal((await call('GET', '/api/v1/creations/videos', null, OWNER))!.data.videos.length, 1);
    assert.equal((await call('GET', '/api/v1/creations/videos', null, OTHER))!.data.videos.length, 0);
  } finally { await w.fake.close(); }
});

test('routes: declining answers 200 with DECLINED and sends nothing; an unconfigured server answers 503, not a fake job', async () => {
  const w = await world();
  try {
    const h = (who: string) => authAs(TENANT, who);
    const created = (await route('POST', '/api/v1/creations/videos', { prompt: 'Lanterns drifting up a river' }, h(OWNER), {}, { videoJobService: w.service }))!;
    const jobId = created.data.video.jobId;
    const declined = (await route('POST', `/api/v1/creations/videos/${jobId}/decline`, {}, h(OWNER), {}, { videoJobService: w.service }))!;
    assert.equal(declined.status, 200);
    assert.equal(declined.data.video.status, 'DECLINED');
    assert.equal(w.fake.submits.length, 0);
    const late = (await route('POST', `/api/v1/creations/videos/${jobId}/decline`, {}, h(OWNER), {}, { videoJobService: w.service }))!;
    assert.equal(late.status, 409);
  } finally { await w.fake.close(); }
  const off = await route('POST', '/api/v1/creations/videos', { prompt: 'A cat' }, authAs(TENANT, OWNER), {}, { videoJobService: undefined });
  assert.equal(off!.status, 503);
  const none = new VideoJobService({ store: new VideoStore({ metaDir: tmp('nagex-r-m-'), bytesDir: tmp('nagex-r-b-') }), providerRouter: new CreationProviderRouter(), approvalStore: new ActionApprovalStore() });
  const unavailable = await route('POST', '/api/v1/creations/videos', { prompt: 'A cat on a roof' }, authAs(TENANT, OWNER), {}, { videoJobService: none });
  assert.equal(unavailable!.status, 503);
  assert.equal(unavailable!.data.error, 'NO_CREATION_PROVIDER_AVAILABLE');
});

// ── what the rest of the product is told ───────────────────────────────────

test('routing: a video request is an honest "not available" until a video service exists, then an approval-gated creation', () => {
  for (const text of ['10초짜리 여우가 눈밭을 달리는 영상을 만들어줘', 'Create a 6 second video of paper lanterns rising over a river']) {
    const without = decideRouting(text);
    assert.equal(without.kind, 'UNSUPPORTED');
    assert.equal(without.supported, false);
    assert.equal(without.targetArtifactType, 'VIDEO');
    const withService = decideRouting(text, { videoAvailable: true });
    assert.equal(withService.kind, 'CREATE_ARTIFACT');
    assert.equal(withService.targetArtifactType, 'VIDEO');
    assert.equal(withService.supported, true);
    assert.equal(withService.permissionRisk, 'EXTERNAL_CONSEQUENTIAL', 'a paid job at an outside service');
    assert.deepEqual(withService.needs.map((n) => [n.capability, n.supported, n.approvalRequired]), [['VIDEO', true, true]]);
    assert.equal(withService.ambiguity.level, 'NONE');
  }
  const topicless = decideRouting('영상 만들어줘', { videoAvailable: true });
  assert.equal(topicless.ambiguity.level, 'HIGH', 'a video of nothing asks what it should show');
  assert.ok(topicless.ambiguity.clarifyingQuestion);
  // the Video shortcut means nothing where no service exists, and routes a plain description where one does
  assert.notEqual(decideRouting('a fox in the snow', { hint: { artifactType: 'VIDEO' } }).targetArtifactType, 'VIDEO');
  assert.equal(decideRouting('a fox in the snow', { hint: { artifactType: 'VIDEO' }, videoAvailable: true }).targetArtifactType, 'VIDEO');
  // a document ABOUT video is still a document, and a request to send something is still an action
  assert.equal(decideRouting('Write a report about video marketing trends').targetArtifactType, 'DOCUMENT');
});

test('capability brief: video is described as available only where a service is configured, and never both ways', () => {
  assert.equal(capabilityBriefFor({}), CAPABILITY_BRIEF);
  assert.ok(CAPABILITY_BRIEF.notAvailable.some((line) => /^Video creation/.test(line)));
  const on = capabilityBriefFor({ video: true });
  assert.ok(on.available.some((line) => /Short videos/.test(line) && /approves it first/.test(line)));
  assert.ok(!on.notAvailable.some((line) => /Video creation/.test(line)));
  assert.ok(!CAPABILITY_BRIEF.available.some((line) => /video/i.test(line)), 'the shipped brief makes no video claim');
  assert.ok(capabilityBriefLines(on).join(String.fromCharCode(10)).includes('Short videos'));
});

test('chat answer: the model is told about video only when a video service exists', async () => {
  const seen: string[] = [];
  const make = () => new AiService(new UnifiedModelRouter([new GeminiProvider({
    apiKey: 'k', model: 'gemini-test',
    fetchFn: (async (_u: any, init: any) => {
      seen.push(String(JSON.parse(String(init?.body ?? '{}')).systemInstruction?.parts?.[0]?.text ?? ''));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
    }) as typeof fetch,
  })], { info: () => {}, warn: () => {} }));
  const none = make();
  await none.chat({ message: 'What can you make?', mode: 'auto', requestId: 'req_b1' });
  assert.match(seen[0], /Video creation/);
  assert.match(seen[0], /NAgex cannot make videos yet/);
  assert.doesNotMatch(seen[0], /Short videos/);
  const some = make();
  some.setCapabilityProbe(() => ({ video: true }));
  await some.chat({ message: 'What can you make?', mode: 'auto', requestId: 'req_b2' });
  assert.match(seen[1], /Short videos/);
  assert.doesNotMatch(seen[1], /NAgex cannot make videos yet/);
  const broken = make();
  broken.setCapabilityProbe(() => { throw new Error('probe failed'); });
  await broken.chat({ message: 'What can you make?', mode: 'auto', requestId: 'req_b3' });
  assert.match(seen[2], /NAgex cannot make videos yet/, 'a failing probe falls back to the conservative brief');
});

test('artifacts: a finished video has its own playable, owner-checked media path; a record with no open target stays a placeholder', () => {
  const base = { artifactId: 'art_v', tenantId: TENANT, ownerId: OWNER, type: 'VIDEO' as const, status: 'COMPLETED' as const, title: 't', preview: 'Video (5s, 16:9)', sourceType: 'CAPTURE' as const, sourceId: 'vid_x', createdAt: 'x', updatedAt: 'x' };
  const real = toArtifactUxProjection({ ...base, openTarget: '/api/v1/creations/videos/vid_0123456789abcdef01234567' } as any);
  assert.equal(real.previewKind, 'VIDEO');
  assert.equal(real.previewTarget, '/api/v1/creations/videos/vid_0123456789abcdef01234567/media');
  assert.equal(real.canvasTarget, '');
  const planned = toArtifactUxProjection({ ...base, openTarget: '' } as any);
  assert.equal(planned.previewKind, 'PLANNED');
  assert.equal(planned.previewTarget, null);
});
