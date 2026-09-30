import crypto from 'node:crypto';
import type { CreationProviderRouter, ProviderRoutingOptions } from '../providers/creation-provider-router.js';
import type { ImageStore, ImageRecord } from '../image.store.js';
import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type {
  CreationExecutor,
  CreationKind,
  CreationRequest,
  CreationResult,
} from '../creation-runtime.types.js';
import type { ImageCreationSpec } from '../specs/creation-spec.types.js';

export interface ImageExecutorDeps {
  providerRouter: CreationProviderRouter;
  imageStore: ImageStore;
  artifactStore?: ArtifactStore;
  auditLogger?: AuditLogger;
}

export class ImageExecutor implements CreationExecutor<CreationRequest, CreationResult> {
  public readonly kind: CreationKind = 'IMAGE';

  constructor(private readonly deps: ImageExecutorDeps) {}

  public async execute(request: CreationRequest): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, prompt, options = {} } = request;

    if (!prompt || !prompt.trim()) {
      return {
        status: 'FAILED',
        creationId: '',
        creationKind: 'IMAGE',
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        errorCode: 'INVALID_PROMPT',
        errorMessage: 'Image creation prompt is required.',
      };
    }

    // 1. Reference Image Authorization
    const referenceImages: Array<{ assetId?: string; url?: string; weighting?: number; binaryData?: Buffer; mimeType?: string }> = [];
    if (request.sourceRefs && request.sourceRefs.length > 0) {
      if (request.sourceRefs.length > 3) {
        return {
          status: 'FAILED',
          creationId: '',
          creationKind: 'IMAGE',
          title: '',
          summary: '',
          content: '',
          openTarget: '',
          mimeType: 'image/png',
          createdAt: new Date().toISOString(),
          errorCode: 'TOO_MANY_REFERENCES',
          errorMessage: 'Exceeded maximum allowed reference images (3).',
        };
      }

      for (const ref of request.sourceRefs) {
        let resolvedImageId: string | undefined;

        if (ref.type === 'ARTIFACT') {
          const artifact = this.deps.artifactStore?.get(ref.id, tenantId, ownerId);
          if (!artifact) {
             return { status: 'FAILED', creationId: '', creationKind: 'IMAGE', title: '', summary: '', content: '', openTarget: '', mimeType: 'image/png', createdAt: new Date().toISOString(), errorCode: 'UNAUTHORIZED_REFERENCE', errorMessage: `Reference artifact ${ref.id} not found or access denied.` };
          }
          if (artifact.type !== 'IMAGE') {
             return { status: 'FAILED', creationId: '', creationKind: 'IMAGE', title: '', summary: '', content: '', openTarget: '', mimeType: 'image/png', createdAt: new Date().toISOString(), errorCode: 'INVALID_REFERENCE_TYPE', errorMessage: `Artifact ${ref.id} is not an image.` };
          }
          if (artifact.sourceType === 'CAPTURE') {
             resolvedImageId = artifact.sourceId;
          }
        } else if (ref.type === 'CAPTURE') {
          resolvedImageId = ref.id;
        }

        if (!resolvedImageId) {
          return { status: 'FAILED', creationId: '', creationKind: 'IMAGE', title: '', summary: '', content: '', openTarget: '', mimeType: 'image/png', createdAt: new Date().toISOString(), errorCode: 'UNSUPPORTED_REFERENCE', errorMessage: `Unsupported reference type ${ref.type}.` };
        }

        const imageRec = this.deps.imageStore.get(resolvedImageId, tenantId, ownerId);
        if (!imageRec) {
          return { status: 'FAILED', creationId: '', creationKind: 'IMAGE', title: '', summary: '', content: '', openTarget: '', mimeType: 'image/png', createdAt: new Date().toISOString(), errorCode: 'UNAUTHORIZED_REFERENCE', errorMessage: `Referenced image ${resolvedImageId} not found or access denied.` };
        }

        const binaryData = this.deps.imageStore.getBinary(imageRec.binaryStoragePath);
        if (!binaryData || binaryData.length === 0) {
          return { status: 'FAILED', creationId: '', creationKind: 'IMAGE', title: '', summary: '', content: '', openTarget: '', mimeType: 'image/png', createdAt: new Date().toISOString(), errorCode: 'MISSING_BINARY_DATA', errorMessage: `Referenced image binary is missing or unreadable.` };
        }

        referenceImages.push({
          assetId: resolvedImageId,
          binaryData,
          mimeType: imageRec.mimeType,
        });
      }
    }

    // Map request to provider-neutral ImageCreationSpec
    const spec: ImageCreationSpec = {
      creationKind: 'IMAGE',
      subject: prompt.trim(),
      instructions: options.style,
      style: options.style,
      aspectRatio: (options as any).aspectRatio || '1:1',
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      locale: options.locale || 'en',
      tenantId,
      ownerId,
      requestId,
      constraints: {
        transparentBackground: (options as any).transparentBackground ?? false,
      },
    };

    const routingOpts: ProviderRoutingOptions = {
      requestedProviderId: (options as any).requestedProviderId,
      privacyMode: (options as any).privacyMode || 'STANDARD',
    };

    try {
      // Provider selection via CreationProviderRouter (NO provider-specific branching in ImageExecutor)
      const routingDecision = this.deps.providerRouter.selectImageProvider(spec, routingOpts);
      const selectedProvider = routingDecision.selectedProvider;

      // Execute provider port
      const providerResult = await selectedProvider.generateImage(spec);

      // Validate provider result (Truthful execution verification)
      if (providerResult.status !== 'COMPLETED' || !providerResult.output || !providerResult.output.imageBuffer) {
        return {
          status: 'FAILED',
          creationId: '',
          creationKind: 'IMAGE',
          title: '',
          summary: '',
          content: '',
          openTarget: '',
          mimeType: 'image/png',
          createdAt: new Date().toISOString(),
          errorCode: providerResult.errorCode || 'IMAGE_GENERATION_FAILED',
          errorMessage: providerResult.errorMessage || `Provider '${selectedProvider.providerId}' failed to generate image.`,
          metadata: {
            routingReason: routingDecision.reasonCode,
            providerId: selectedProvider.providerId,
          },
        };
      }

      const imageBuffer = providerResult.output.imageBuffer;
      if (!imageBuffer || imageBuffer.length === 0) {
        return {
          status: 'FAILED',
          creationId: '',
          creationKind: 'IMAGE',
          title: '',
          summary: '',
          content: '',
          openTarget: '',
          mimeType: 'image/png',
          createdAt: new Date().toISOString(),
          errorCode: 'EMPTY_IMAGE_BINARY',
          errorMessage: 'Provider returned an empty binary image buffer.',
        };
      }

      const imageId = `img_${crypto.createHash('sha256').update(`${tenantId}:${ownerId}:${requestId}:${prompt.slice(0, 50)}`).digest('hex').slice(0, 24)}`;
      const mimeType = providerResult.output.mimeType || 'image/png';

      // Store binary payload securely in NAgex image store (binary ownership enforcement)
      const binaryStoragePath = this.deps.imageStore.saveBinary(imageId, imageBuffer, mimeType);

      const title = (options as any).title || `Image: ${prompt.trim().slice(0, 40)}`;
      const now = new Date().toISOString();

      const imageRecord: ImageRecord = {
        imageId,
        tenantId,
        ownerId,
        title,
        prompt: prompt.trim(),
        style: options.style,
        aspectRatio: spec.aspectRatio || '1:1',
        mimeType,
        width: spec.aspectRatio === '16:9' ? 1792 : 1024,
        height: spec.aspectRatio === '16:9' ? 1024 : 1024,
        binaryStoragePath,
        revisionIndex: 1,
        sourceRefs: request.sourceRefs || [],
        providerExecutionMetadata: providerResult.metadata,
        createdAt: now,
        updatedAt: now,
      };

      this.deps.imageStore.save(imageRecord);

      // Project thin record to ArtifactStore for Recent Creations UI
      let artifactRecord;
      if (this.deps.artifactStore) {
        artifactRecord = this.deps.artifactStore.saveCompleted({
          tenantId,
          ownerId,
          type: 'IMAGE',
          title,
          // R23.7C-C — provider-neutral by design: this preview reaches
          // ordinary consumer UI (Personal Home Recent Creations via
          // PersonalHomeService -> HomeItem.summary), never technical/
          // audit surfaces — provider/model identity belongs only in
          // providerExecutionMetadata (already preserved above), never
          // here. Plain, locale-neutral factual text, matching the
          // existing convention for other artifact types' previews
          // (e.g. "Grounded research result").
          preview: `Image (${spec.aspectRatio || '1:1'})`,
          sourceType: 'CAPTURE',
          sourceId: imageId,
          openTarget: `/api/v1/creations/images/${imageId}`,
        });
        imageRecord.artifactId = artifactRecord.artifactId;
        this.deps.imageStore.save(imageRecord);
      }

      // Governance audit logging
      this.deps.auditLogger?.logEvent({
        actor: { type: 'user', id: ownerId },
        tenant_id: tenantId,
        action: 'image.created',
        resource: { type: 'ImageRecord', id: imageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: {
          title,
          provider: selectedProvider.providerId,
          model: providerResult.metadata.engineOrModel,
          routingReason: routingDecision.reasonCode,
        },
      });

      const base64Content = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

      return {
        status: 'SUCCESS',
        creationId: imageId,
        creationKind: 'IMAGE',
        title,
        summary: `Canonical Image (${imageBuffer.length} bytes)`,
        content: base64Content,
        openTarget: `/api/v1/creations/images/${imageId}`,
        artifactId: artifactRecord?.artifactId,
        mimeType,
        metadata: {
          providerId: selectedProvider.providerId,
          model: providerResult.metadata.engineOrModel,
          latencyMs: providerResult.metadata.latencyMs,
          routingReason: routingDecision.reasonCode,
          aspectRatio: spec.aspectRatio,
          storagePath: binaryStoragePath,
        },
        createdAt: now,
      };
    } catch (error: any) {
      return {
        status: (error?.code === 'PROVIDER_UNAVAILABLE' || error?.code === 'NO_AVAILABLE_PROVIDER') ? 'UNAVAILABLE' : 'FAILED',
        creationId: '',
        creationKind: 'IMAGE',
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        errorCode: error?.code || 'IMAGE_CREATION_FAILED',
        errorMessage: error?.message || 'Failed to execute image creation.',
      };
    }
  }

  public async executeRevision(params: {
    parentImageId: string;
    instruction: string;
    tenantId: string;
    ownerId: string;
    requestId: string;
    options?: Record<string, unknown>;
  }): Promise<CreationResult> {
    const parent = this.deps.imageStore.get(params.parentImageId, params.tenantId, params.ownerId);
    if (!parent) {
      return {
        status: 'FAILED',
        creationId: '',
        creationKind: 'IMAGE',
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        errorCode: 'IMAGE_NOT_FOUND',
        errorMessage: `Parent image '${params.parentImageId}' not found or access denied.`,
      };
    }

    const revisionPrompt = `${parent.prompt} (${params.instruction.trim()})`;

    const request: CreationRequest = {
      creationKind: 'IMAGE',
      prompt: revisionPrompt,
      options: {
        style: parent.style,
        aspectRatio: parent.aspectRatio,
        ...(params.options as any),
      },
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      requestId: params.requestId,
    };

    const result = await this.execute(request);

    if (result.status === 'SUCCESS' && result.creationId) {
      const revisedImage = this.deps.imageStore.get(result.creationId, params.tenantId, params.ownerId);
      if (revisedImage) {
        revisedImage.parentImageId = parent.imageId;
        revisedImage.revisionIndex = parent.revisionIndex + 1;
        this.deps.imageStore.save(revisedImage);
      }
    }

    return result;
  }
}
