// R17 — Creation Domain Types
export type CreationType = 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'VARIATION';
export type CreationStatus = 'COMPLETED' | 'FAILED';

export interface CreationRecipe {
  prompt: string;
  style?: string; // 'photorealistic' | 'digital_art' | 'anime' | 'cinematic' | '3d_render' | 'minimalist'
  stylePreset?: string;
  aspectRatio?: string; // '1:1' | '16:9' | '9:16' | '4:3' | '3:2'
  guidanceScale?: number;
  quality?: 'standard' | 'hd';
  seed?: number;
}

export interface CreationRecord {
  creationId: string;
  tenantId: string;
  ownerId: string;
  type: CreationType;
  status: CreationStatus;
  prompt: string;
  recipe: CreationRecipe;
  imageUrl: string;
  outputAssetUrl?: string;
  thumbnailUrl?: string;
  referenceImageId?: string;
  parentCreationId?: string; // Lineage for edit/variation continuity
  mimeType: string;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreationGenerationParams {
  tenantId: string;
  ownerId: string;
  prompt: string;
  recipe?: Partial<CreationRecipe>;
  referenceImageId?: string;
  parentCreationId?: string;
  source?: string;
}

export interface CreationVariationParams {
  tenantId: string;
  ownerId: string;
  parentCreationId: string;
  promptModifier?: string;
  recipeOverrides?: Partial<CreationRecipe>;
}
