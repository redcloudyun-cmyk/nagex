import { BrandVoiceAssetRegistry, type BrandVoiceAsset } from './brand-voice-assets.js';
import type { SpokenResponse } from './spoken-response-composer.js';
import type { VoiceOutputResolver, VoiceSynthesisResult } from './voice-output-provider.js';

export type BrandVoiceResolution =
  | { kind: 'FIXED_ASSET'; asset: BrandVoiceAsset }
  | { kind: 'DYNAMIC_PROVIDER'; reason: 'NO_FIXED_ASSET_MATCH' | 'VOICE_OUTPUT_DISABLED' };

export class BrandVoiceResolver {
  public constructor(private readonly assets = new BrandVoiceAssetRegistry()) {}

  public resolve(spoken: SpokenResponse): BrandVoiceResolution {
    if (spoken.voiceOutputDisabled || !spoken.ttsPayload) {
      return { kind: 'DYNAMIC_PROVIDER', reason: 'VOICE_OUTPUT_DISABLED' };
    }
    const fixed = this.assets.findBySpokenText(spoken.ttsPayload);
    if (fixed) return { kind: 'FIXED_ASSET', asset: fixed };
    return { kind: 'DYNAMIC_PROVIDER', reason: 'NO_FIXED_ASSET_MATCH' };
  }

  public async synthesizeDynamic(
    spoken: SpokenResponse,
    dynamicProvider: VoiceOutputResolver,
  ): Promise<VoiceSynthesisResult> {
    return dynamicProvider.synthesizeWithFallback({
      text: spoken.ttsPayload,
      language: 'ko-KR',
      voiceProfile: 'NAGEX_NATURAL',
      prosody: spoken.prosody,
      pronunciationHints: {},
      outputFormat: 'AUDIO_MPEG',
    });
  }
}
