import { CORAL_GOLDEN_TAKE } from './brand-voice-profile.js';

export type BrandVoiceAssetId =
  | 'GREETING'
  | 'ACKNOWLEDGE'
  | 'WAITING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'GENERIC_ERROR';

export interface BrandVoiceAsset {
  id: BrandVoiceAssetId;
  spokenText: string;
  audioRef: string;
  role: 'REFERENCE' | 'FIXED_ASSET';
  sourceTakeId: string;
}

const ASSETS: Partial<Record<BrandVoiceAssetId, BrandVoiceAsset>> = {
  GREETING: {
    id: 'GREETING',
    spokenText: CORAL_GOLDEN_TAKE.sourceSentence,
    audioRef: CORAL_GOLDEN_TAKE.localPlaybackArtifact,
    role: 'FIXED_ASSET',
    sourceTakeId: CORAL_GOLDEN_TAKE.id,
  },
};

export class BrandVoiceAssetRegistry {
  public get(id: BrandVoiceAssetId): BrandVoiceAsset | null {
    return ASSETS[id] ?? null;
  }

  public findBySpokenText(spokenText: string): BrandVoiceAsset | null {
    const normalized = this.normalize(spokenText);
    for (const asset of Object.values(ASSETS)) {
      if (asset && this.normalize(asset.spokenText) === normalized) return asset;
    }
    return null;
  }

  public list(): BrandVoiceAsset[] {
    return Object.values(ASSETS).filter((asset): asset is BrandVoiceAsset => Boolean(asset));
  }

  private normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }
}
