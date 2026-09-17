// R17 — Creation Domain Service Layer
import crypto from 'node:crypto';
import type { CreationStore } from './creation.store.ts';
import type { CreationGenerationParams, CreationRecord, CreationRecipe, CreationVariationParams } from './creation.types.js';
import type { AuditLogger } from '../governance/audit.logger.js';

export function generateMockImageSvg(prompt: string, style?: string, seed?: number): string {
  const safePrompt = prompt.replace(/[<>&"]/g, '');
  const safeStyle = style || 'digital_art';
  const colorHash = crypto.createHash('md5').update(prompt + (seed || 0)).digest('hex');
  const c1 = `#${colorHash.slice(0, 6)}`;
  const c2 = `#${colorHash.slice(6, 12)}`;
  
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}" />
      <stop offset="100%" stop-color="${c2}" />
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="8" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)" />
  <circle cx="400" cy="350" r="180" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="8" filter="url(#glow)"/>
  <rect x="250" y="200" width="300" height="300" rx="20" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.6)" stroke-width="4"/>
  <text x="400" y="620" font-family="system-ui, sans-serif" font-size="28" font-weight="bold" fill="#ffffff" text-anchor="middle" filter="url(#glow)">${safePrompt.slice(0, 40)}</text>
  <text x="400" y="660" font-family="system-ui, sans-serif" font-size="18" fill="rgba(255,255,255,0.8)" text-anchor="middle">Style: ${safeStyle} · NAgex AI Creation</text>
</svg>`;

  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

export class CreationService {
  constructor(
    private readonly store: CreationStore,
    private readonly auditLogger: AuditLogger
  ) {}

  public async generateCreation(params: CreationGenerationParams): Promise<CreationRecord> {
    const prompt = params.prompt.trim();
    if (!prompt) {
      throw new Error('PROMPT_REQUIRED: Prompt text is required for creation generation.');
    }

    const creationId = `cr_${crypto.randomUUID()}`;
    const recipe: CreationRecipe = {
      prompt,
      style: params.recipe?.style || (params.recipe as any)?.stylePreset || 'digital_art',
      stylePreset: (params.recipe as any)?.stylePreset || params.recipe?.style || 'digital_art',
      aspectRatio: params.recipe?.aspectRatio || '1:1',
      guidanceScale: params.recipe?.guidanceScale || 7.5,
      quality: params.recipe?.quality || 'standard',
      seed: params.recipe?.seed || Math.floor(Math.random() * 1000000),
    };

    const imageUrl = generateMockImageSvg(prompt, recipe.style, recipe.seed);
    const now = new Date().toISOString();

    const record: CreationRecord = {
      creationId,
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      type: params.parentCreationId ? 'VARIATION' : params.referenceImageId ? 'IMAGE_EDIT' : 'TEXT_TO_IMAGE',
      status: 'COMPLETED',
      prompt,
      recipe,
      imageUrl,
      outputAssetUrl: imageUrl,
      thumbnailUrl: imageUrl,
      referenceImageId: params.referenceImageId,
      parentCreationId: params.parentCreationId,
      mimeType: 'image/svg+xml',
      width: 800,
      height: 800,
      createdAt: now,
      updatedAt: now,
    };

    const saved = this.store.saveCreation(record);

    this.auditLogger.logEvent({
      actor: { type: 'user', id: params.ownerId },
      tenant_id: params.tenantId,
      action: 'creation.generated',
      resource: { type: 'CreationRecord', id: creationId },
      result: 'SUCCESS',
      request_id: `req_${creationId}`,
      details: { prompt, type: record.type, parentCreationId: params.parentCreationId },
    });

    return saved;
  }

  public async generateVariation(params: CreationVariationParams): Promise<CreationRecord> {
    const parent = this.store.getCreation(params.parentCreationId, params.tenantId, params.ownerId);
    if (!parent) {
      throw new Error(`CREATION_NOT_FOUND: Creation ${params.parentCreationId} not found.`);
    }

    const modifiedPrompt = params.promptModifier
      ? `${parent.prompt} (${params.promptModifier})`
      : parent.prompt;

    return this.generateCreation({
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      prompt: modifiedPrompt,
      recipe: {
        ...parent.recipe,
        ...params.recipeOverrides,
        seed: Math.floor(Math.random() * 1000000),
      },
      parentCreationId: parent.creationId,
      referenceImageId: parent.creationId,
    });
  }

  public getCreation(creationId: string, tenantId: string, ownerId: string): CreationRecord | null {
    return this.store.getCreation(creationId, tenantId, ownerId);
  }

  public listCreations(tenantId: string, ownerId: string, limit = 50): CreationRecord[] {
    return this.store.listCreations(tenantId, ownerId, limit);
  }

  public getLineage(parentCreationId: string, tenantId: string, ownerId: string): CreationRecord[] {
    return this.store.getLineage(parentCreationId, tenantId, ownerId);
  }
}
