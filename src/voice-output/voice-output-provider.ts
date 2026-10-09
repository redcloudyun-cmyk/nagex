import type { ProsodyPlan } from './prosody-planner.js';

export type VoiceProfile = 'NAGEX_NATURAL';
export type VoiceOutputRoute = 'HIGH_QUALITY_NEURAL' | 'NATIVE_OS' | 'LOCAL_OFFLINE';

export interface VoiceSynthesisRequest {
  text: string;
  language: 'ko-KR' | 'en-US';
  voiceProfile: VoiceProfile;
  prosody: ProsodyPlan;
  pronunciationHints: Record<string, string>;
  outputFormat: 'AUDIO_MPEG' | 'PCM_16';
}

export interface VoiceSynthesisResult {
  ok: boolean;
  route: VoiceOutputRoute;
  audioRef?: string;
  spokenText: string;
  fallbackUsed: boolean;
  developerDiagnostics: string[];
}

export interface VoiceOutputProvider {
  readonly route: VoiceOutputRoute;
  synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
}

export class NativeOsVoiceProvider implements VoiceOutputProvider {
  public readonly route = 'NATIVE_OS' as const;

  public async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    return {
      ok: true,
      route: this.route,
      audioRef: `native-os:${Buffer.from(request.text).toString('base64url')}`,
      spokenText: request.text,
      fallbackUsed: false,
      developerDiagnostics: [],
    };
  }
}

export class UnavailableVoiceProvider implements VoiceOutputProvider {
  public constructor(public readonly route: VoiceOutputRoute, private readonly reason = 'UNAVAILABLE') {}

  public async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    return { ok: false, route: this.route, spokenText: request.text, fallbackUsed: false, developerDiagnostics: [this.reason] };
  }
}

export class VoiceOutputResolver {
  public constructor(private readonly providers: VoiceOutputProvider[]) {}

  public async synthesizeWithFallback(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const diagnostics: string[] = [];
    for (const provider of this.providers) {
      const result = await provider.synthesize(request);
      diagnostics.push(...result.developerDiagnostics.map((line) => `${provider.route}:${line}`));
      if (result.ok) return { ...result, fallbackUsed: provider !== this.providers[0], developerDiagnostics: diagnostics };
    }
    return { ok: false, route: this.providers[0]?.route ?? 'NATIVE_OS', spokenText: request.text, fallbackUsed: false, developerDiagnostics: diagnostics };
  }

  public static default(): VoiceOutputResolver {
    return new VoiceOutputResolver([new NativeOsVoiceProvider()]);
  }
}
