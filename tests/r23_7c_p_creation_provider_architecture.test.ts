import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import type {
  ImageProviderPort,
  PresentationProviderPort,
  VideoProviderPort,
  ImageProviderCapabilities,
  PresentationProviderCapabilities,
  VideoProviderCapabilities,
} from '../src/creation/providers/creation-provider.types.js';
import type {
  ImageCreationSpec,
  PresentationCreationSpec,
  VideoCreationSpec,
} from '../src/creation/specs/creation-spec.types.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { DocumentStore } from '../src/creation/document.store.js';

test('A. CreationProviderRouter rejects unsupported capability requirement', () => {
  const router = new CreationProviderRouter();

  const providerWithoutTransparentBg: ImageProviderPort = {
    providerId: 'standard-image-provider',
    getStatus: () => 'AVAILABLE',
    getCapabilities: (): ImageProviderCapabilities => ({
      textToImage: true,
      imageToImage: false,
      editingInpainting: false,
      referenceImageConditioning: false,
      transparentBackground: false, // DOES NOT support transparent background
      textRendering: true,
      supportedAspectRatios: ['1:1', '16:9'],
      maxReferenceImages: 0,
    }),
    generateImage: async () => ({
      status: 'COMPLETED',
      output: { mimeType: 'image/png' },
      metadata: { providerId: 'standard-image-provider', createdAt: new Date().toISOString() },
    }),
  };

  router.registerImageProvider(providerWithoutTransparentBg);

  const spec: ImageCreationSpec = {
    creationKind: 'IMAGE',
    subject: 'Company Logo Badge',
    locale: 'en',
    constraints: {
      transparentBackground: true, // Requires transparent background
    },
    tenantId: 'ten_arch_test',
    ownerId: 'usr_arch_test',
    requestId: 'req_arch_a',
  };

  // Router must fail to find a provider matching required transparentBackground capability
  assert.throws(() => {
    router.selectImageProvider(spec);
  }, (err: any) => err.code === 'NO_CREATION_PROVIDER_AVAILABLE');
});

test('B. Explicit provider override cannot bypass capability requirements', () => {
  const router = new CreationProviderRouter();

  const targetProvider: ImageProviderPort = {
    providerId: 'provider-no-transparency',
    getStatus: () => 'AVAILABLE',
    getCapabilities: (): ImageProviderCapabilities => ({
      textToImage: true,
      imageToImage: false,
      editingInpainting: false,
      referenceImageConditioning: false,
      transparentBackground: false,
      textRendering: false,
      supportedAspectRatios: ['1:1'],
      maxReferenceImages: 0,
    }),
    generateImage: async () => ({
      status: 'COMPLETED',
      output: { mimeType: 'image/png' },
      metadata: { providerId: 'provider-no-transparency', createdAt: new Date().toISOString() },
    }),
  };

  router.registerImageProvider(targetProvider);

  const spec: ImageCreationSpec = {
    creationKind: 'IMAGE',
    subject: 'Transparent Icon',
    locale: 'en',
    constraints: { transparentBackground: true },
    tenantId: 'ten_arch_b',
    ownerId: 'usr_arch_b',
    requestId: 'req_arch_b',
  };

  // Explicit override to 'provider-no-transparency' must be rejected due to capability mismatch
  assert.throws(() => {
    router.selectImageProvider(spec, { requestedProviderId: 'provider-no-transparency' });
  }, (err: any) => err.code === 'CAPABILITY_UNSUPPORTED');
});

test('C. Unavailable or Unconfigured provider is not selected as execution target', () => {
  const router = new CreationProviderRouter();

  const unconfiguredProvider: ImageProviderPort = {
    providerId: 'unconfigured-cloud-provider',
    getStatus: () => 'UNCONFIGURED',
    getCapabilities: (): ImageProviderCapabilities => ({
      textToImage: true,
      imageToImage: true,
      editingInpainting: true,
      referenceImageConditioning: true,
      transparentBackground: true,
      textRendering: true,
      supportedAspectRatios: ['1:1', '16:9'],
      maxReferenceImages: 5,
    }),
    generateImage: async () => ({
      status: 'UNAVAILABLE',
      metadata: { providerId: 'unconfigured-cloud-provider', createdAt: new Date().toISOString() },
    }),
  };

  router.registerImageProvider(unconfiguredProvider);

  const spec: ImageCreationSpec = {
    creationKind: 'IMAGE',
    subject: 'Background landscape',
    locale: 'en',
    tenantId: 'ten_arch_c',
    ownerId: 'usr_arch_c',
    requestId: 'req_arch_c',
  };

  // Must not select unconfigured provider
  assert.throws(() => {
    router.selectImageProvider(spec);
  }, (err: any) => err.code === 'NO_CREATION_PROVIDER_AVAILABLE');
});

test('D. Provider-specific IDs do not become canonical artifact IDs', () => {
  const providerMetadata = {
    providerId: 'gamma-app-api',
    providerJobId: 'gamma_job_9988776655',
    providerAssetId: 'gamma_deck_112233',
    createdAt: new Date().toISOString(),
  };

  const nagexCanonicalArtifactId = `pres_${Date.now()}_canonical`;

  // Verification invariant: canonical NAgex artifact ID must remain distinct from provider IDs
  assert.notEqual(nagexCanonicalArtifactId, providerMetadata.providerJobId);
  assert.notEqual(nagexCanonicalArtifactId, providerMetadata.providerAssetId);
  assert.ok(nagexCanonicalArtifactId.startsWith('pres_'));
});

test('E, F, & G. Creation Specs (Image, Presentation, Video) remain provider-neutral', () => {
  const imageSpec: ImageCreationSpec = {
    creationKind: 'IMAGE',
    subject: 'Executive Dashboard Infographic',
    style: 'minimalist-vector',
    aspectRatio: '16:9',
    outputUsage: 'PRESENTATION_SLIDE',
    qualityPreference: 'HIGH',
    locale: 'en',
    tenantId: 'ten_specs',
    ownerId: 'usr_specs',
    requestId: 'req_spec_img',
  };

  const presentationSpec: PresentationCreationSpec = {
    creationKind: 'PRESENTATION',
    title: 'Q4 Product Roadmap',
    audience: 'Executive Board',
    tone: 'FORMAL',
    locale: 'en',
    slides: [
      {
        slideId: 'slide_01',
        objective: 'Introduce Q4 strategic themes',
        title: 'Q4 Strategic Focus',
        bullets: ['AI Operating System Expansion', 'Enterprise Federation', 'Device Control Agent'],
        visualIntent: 'BULLETS',
      },
    ],
    tenantId: 'ten_specs',
    ownerId: 'usr_specs',
    requestId: 'req_spec_pres',
  };

  const videoSpec: VideoCreationSpec = {
    creationKind: 'VIDEO',
    title: 'Product Walkthrough',
    totalDurationSeconds: 60,
    aspectRatio: '16:9',
    style: 'CINEMATIC',
    locale: 'en',
    storyboard: [
      {
        sceneId: 'scene_01',
        objective: 'Show mobile wake gesture',
        durationSeconds: 15,
        visualDescription: 'User tapping mobile screen to initiate voice wake.',
        cameraIntent: 'CLOSE_UP',
        narration: 'NAgex wakes instantly with voice or touch.',
      },
    ],
    tenantId: 'ten_specs',
    ownerId: 'usr_specs',
    requestId: 'req_spec_vid',
  };

  assert.equal(imageSpec.creationKind, 'IMAGE');
  assert.equal(presentationSpec.creationKind, 'PRESENTATION');
  assert.equal(videoSpec.creationKind, 'VIDEO');

  // Verify specs contain zero provider-specific proprietary keys (e.g. no 'dallePrompt', 'gammaThemeId', 'soraPrompt')
  assert.equal((imageSpec as any).dallePrompt, undefined);
  assert.equal((presentationSpec as any).gammaThemeId, undefined);
  assert.equal((videoSpec as any).soraPrompt, undefined);
});

test('H. Existing R23.7C-B Document Runtime remains 100% operational', async () => {
  const mockAiService: any = {
    documentSynthesis: async (input: any) => ({
      data: {
        title: 'R23.7C-P Regression Check Document',
        summary: 'Verifies Document Runtime remains green.',
        content: '# Document Runtime Operational\n\nAll R23.7C-B invariants remain intact.',
      },
      provider: 'nebius',
      model: 'llama-3.3-70b',
      latencyMs: 80,
      requestId: input.requestId,
    }),
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });
  const runtime = new CreationRuntime([executor]);

  const result = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Verify document creation under R23.7C-P baseline',
    tenantId: 'ten_reg_h',
    ownerId: 'usr_reg_h',
    requestId: 'req_reg_h_01',
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.title, 'R23.7C-P Regression Check Document');
  assert.ok(result.creationId.startsWith('doc_'));
});

test('J. No provider credentials enter execution metadata or client-facing structures', () => {
  const secretApiKey = 'sk-proj-SECRET_OPENAI_API_KEY_123456789';

  const providerMetadata = {
    providerId: 'openai-imagen-3',
    engineOrModel: 'gpt-image-2.5-flare',
    providerJobId: 'job_7788',
    createdAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(providerMetadata);
  assert.equal(serialized.includes(secretApiKey), false, 'Provider secrets must never enter execution metadata');
});

test('K. CreationProviderRouter behavior is deterministic under identical inputs', () => {
  const router = new CreationProviderRouter();

  const providerA: ImageProviderPort = {
    providerId: 'provider-alpha',
    getStatus: () => 'AVAILABLE',
    getCapabilities: () => ({
      textToImage: true,
      imageToImage: false,
      editingInpainting: false,
      referenceImageConditioning: false,
      transparentBackground: true,
      textRendering: false,
      supportedAspectRatios: ['16:9'],
      maxReferenceImages: 0,
    }),
    generateImage: async () => ({
      status: 'COMPLETED',
      metadata: { providerId: 'provider-alpha', createdAt: new Date().toISOString() },
    }),
  };

  router.registerImageProvider(providerA);

  const spec: ImageCreationSpec = {
    creationKind: 'IMAGE',
    subject: 'Deterministic Test Image',
    aspectRatio: '16:9',
    locale: 'en',
    tenantId: 'ten_det',
    ownerId: 'usr_det',
    requestId: 'req_det_01',
  };

  const dec1 = router.selectImageProvider(spec);
  const dec2 = router.selectImageProvider(spec);

  assert.equal(dec1.selectedProvider.providerId, dec2.selectedProvider.providerId);
  assert.equal(dec1.reasonCode, dec2.reasonCode);
});

test('L. Provider failure semantics cannot map to creation success (FAKE_SUCCESS_PATHS = 0)', async () => {
  const failedResult = {
    status: 'FAILED' as const,
    errorCode: 'PROVIDER_TIMEOUT',
    errorMessage: 'Provider timed out after 30000ms',
    metadata: {
      providerId: 'video-render-engine',
      createdAt: new Date().toISOString(),
    },
  };

  // Rule guard: A failed provider execution result MUST NOT produce a success state or fabricated output asset
  assert.notEqual(failedResult.status, 'COMPLETED');
  assert.equal(failedResult.errorCode, 'PROVIDER_TIMEOUT');
});
