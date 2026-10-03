import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageExecutor } from '../src/creation/executors/image-executor.js';
import { ImageStore } from '../src/creation/image.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import type { ImageProviderPort, ImageProviderCapabilities } from '../src/creation/providers/creation-provider.types.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { handleCreationRoutes } from '../src/http/routes/creation.routes.js';
import { authAs } from './_s1_session_auth.js';

function createFakeProvider(providerId: string, status: 'AVAILABLE' | 'UNCONFIGURED' = 'AVAILABLE', failGenerate = false, returnEmpty = false): ImageProviderPort {
  const caps: ImageProviderCapabilities = {
    textToImage: true,
    imageToImage: true,
    editingInpainting: true,
    referenceImageConditioning: true,
    transparentBackground: true,
    textRendering: true,
    supportedAspectRatios: ['1:1', '16:9'],
    maxReferenceImages: 3,
  };
  return {
    providerId,
    getStatus: () => status,
    getCapabilities: () => caps,
    generateImage: async (spec) => {
      if (failGenerate) throw new Error('Provider specific failure');
      if (returnEmpty) return { status: 'COMPLETED', output: { mimeType: 'image/png' }, metadata: { providerId, createdAt: new Date().toISOString() } } as any;
      return {
        status: 'COMPLETED',
        output: {
          imageBuffer: Buffer.from('fake-image-data'),
          mimeType: 'image/png',
          temporaryUrl: 'https://fake-provider.com/temp/image.png'
        },
        metadata: { providerId, createdAt: new Date().toISOString() },
      };
    },
  };
}

function setup() {
  const imageStore = new ImageStore();
  const artifactStore = new ArtifactStore();
  const providerRouter = new CreationProviderRouter();
  const auditLogger = new AuditLogger();
  providerRouter.registerImageProvider(createFakeProvider('fake-openai'));

  const executor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });
  return { imageStore, artifactStore, providerRouter, executor, auditLogger };
}

test('1. text-to-image successful execution & 2. canonical binary artifact created & 3. provider-neutral routing', async () => {
  const { executor, imageStore, artifactStore } = setup();
  const res = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'A test image',
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_1',
    options: { style: 'photorealistic' }
  });

  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.creationKind, 'IMAGE');
  assert.ok(res.creationId);
  assert.ok(res.artifactId);
  assert.equal(res.mimeType, 'image/png');

  // 4. provider temporary URL not used as artifact identity
  assert.ok(!res.openTarget.includes('fake-provider.com'));

  // Verify artifact in store
  const art = artifactStore.get(res.artifactId, 'ten_test', 'usr_test');
  assert.ok(art);
  assert.equal(art.type, 'IMAGE');
  assert.equal(art.sourceType, 'CAPTURE');
  assert.equal(art.status, 'COMPLETED');
});

test('5. provider failure -> FAILED', async () => {
  const { providerRouter, imageStore, artifactStore, auditLogger } = setup();
  providerRouter.registerImageProvider(createFakeProvider('fail-provider', 'AVAILABLE', true));
  const executor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });

  const res = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'A test image',
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_2',
    options: { requestedProviderId: 'fail-provider' }
  });

  assert.equal(res.status, 'FAILED');
});

test('6. provider unavailable -> truthful unavailable/failure result', async () => {
  const { providerRouter, imageStore, artifactStore, auditLogger } = setup();
  providerRouter.registerImageProvider(createFakeProvider('unavail-provider', 'UNCONFIGURED'));
  const executor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });

  const res = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'A test image',
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_3',
    options: { requestedProviderId: 'unavail-provider' }
  });

  assert.equal(res.status, 'UNAVAILABLE');
});

test('7. empty generation -> not success', async () => {
  const { providerRouter, imageStore, artifactStore, auditLogger } = setup();
  providerRouter.registerImageProvider(createFakeProvider('empty-provider', 'AVAILABLE', false, true));
  const executor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });

  const res = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'A test image',
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_4',
    options: { requestedProviderId: 'empty-provider' }
  });

  assert.equal(res.status, 'FAILED');
  assert.ok(res.errorMessage?.includes('failed to generate image'));
});

test('9. image history persistence & 10. revision lineage', async () => {
  const { executor, imageStore } = setup();
  const parentRes = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'Parent image',
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_5'
  });

  assert.equal(parentRes.status, 'SUCCESS');

  const childRes = await executor.executeRevision({
    parentImageId: parentRes.creationId,
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_5b',
    instruction: 'Add a hat'
  });

  assert.equal(childRes.status, 'SUCCESS');
  const lineage = imageStore.getLineage(parentRes.creationId, 'ten_test', 'usr_test');
  assert.equal(lineage.length, 2);
});

test('11. authorized sourceRef accepted & 12. unauthorized sourceRef rejected', async () => {
  const { executor, artifactStore, imageStore } = setup();

  // Create an artifact first
  const baseRes = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'Base image',
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_6'
  });

  const artId = baseRes.artifactId!;

  // Authorized ref
  const resAuth = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'With ref',
    sourceRefs: [{ type: 'ARTIFACT', id: artId }],
    tenantId: 'ten_test',
    ownerId: 'usr_test',
    requestId: 'req_7'
  });
  assert.equal(resAuth.status, 'SUCCESS');

  // Unauthorized ref (wrong tenant)
  const resUnauth = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'With ref cross tenant',
    sourceRefs: [{ type: 'ARTIFACT', id: artId }],
    tenantId: 'ten_evil',
    ownerId: 'usr_evil',
    requestId: 'req_8'
  });
  assert.equal(resUnauth.status, 'FAILED');
  assert.ok(resUnauth.errorCode === 'UNAUTHORIZED_REFERENCE' || resUnauth.errorMessage?.includes('not found'));
});

test('15. unsupported reference capability does not silently downgrade', async () => {
  const { providerRouter, imageStore, artifactStore, auditLogger } = setup();
  const provider = createFakeProvider('no-ref-provider');
  const caps = provider.getCapabilities();
  caps.referenceImageConditioning = false; // Disable
  providerRouter.registerImageProvider(provider);

  const executor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });

  const baseRes = await executor.execute({ creationKind: 'IMAGE', prompt: 'Base', tenantId: 't1', ownerId: 'u1', requestId: 'req_9' });

  const res = await executor.execute({
    creationKind: 'IMAGE',
    prompt: 'Fail please',
    sourceRefs: [{ type: 'ARTIFACT', id: baseRes.artifactId! }],
    tenantId: 't1',
    ownerId: 'u1',
    requestId: 'req_10',
    options: { requestedProviderId: 'no-ref-provider' }
  });

  assert.equal(res.status, 'FAILED');
  assert.equal(res.errorCode, 'CAPABILITY_UNSUPPORTED');
});

test('19. route invokes ImageExecutor rather than mock SVG', async () => {
  const { executor } = setup();
  const mockCreationService: any = { generateCreation: async () => { throw new Error('Should not be called'); } };

  const res = await handleCreationRoutes('POST', '/api/v1/creations/generate', {
    prompt: 'Route test',
    type: 'IMAGE'
  }, authAs('ten_img_runtime', 'usr_img_runtime'), {}, { creationService: mockCreationService, imageExecutor: executor });

  if (res?.status === 400) console.log('Test 19 Failed with:', res.data);
  assert.ok(res);
  assert.equal(res.status, 201);
  assert.equal((res.data as any).type, 'TEXT_TO_IMAGE');
  assert.ok((res.data as any).artifactId); // Verifies canonical artifact
});
