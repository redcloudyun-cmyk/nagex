import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NAGEX_CANONICAL_BRAND_VOICE } from './brand-voice-profile.js';
import type { VoiceOutputProvider, VoiceSynthesisRequest, VoiceSynthesisResult } from './voice-output-provider.js';

export interface OpenAiNeuralVoiceProviderOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  outputDir?: string;
  endpoint?: string;
}

export class OpenAiNeuralVoiceProvider implements VoiceOutputProvider {
  public readonly route = 'HIGH_QUALITY_NEURAL' as const;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly outputDir: string;
  private readonly endpoint: string;

  public constructor(options: OpenAiNeuralVoiceProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.NAGEX_TTS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.NAGEX_TTS_OPENAI_MODEL ?? NAGEX_CANONICAL_BRAND_VOICE.model;
    this.voice = options.voice ?? process.env.NAGEX_TTS_OPENAI_VOICE ?? 'coral';
    this.outputDir = options.outputDir ?? process.env.NAGEX_TTS_OUTPUT_DIR ?? path.join('artifacts', 'voice-quality');
    this.endpoint = options.endpoint ?? process.env.NAGEX_TTS_OPENAI_ENDPOINT ?? 'https://api.openai.com/v1/audio/speech';
  }

  public async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const startedAt = Date.now();
    if (!this.apiKey) {
      return {
        ok: false,
        route: this.route,
        spokenText: request.text,
        fallbackUsed: false,
        developerDiagnostics: ['OPENAI_TTS_API_KEY_MISSING', 'TTS_LATENCY_MS=0'],
      };
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: request.text,
          instructions: NAGEX_CANONICAL_BRAND_VOICE.baseStyle,
          response_format: request.outputFormat === 'AUDIO_MPEG' ? 'mp3' : 'wav',
          speed: NAGEX_CANONICAL_BRAND_VOICE.baseSpeakingRate,
        }),
      });
    } catch {
      return {
        ok: false,
        route: this.route,
        spokenText: request.text,
        fallbackUsed: false,
        developerDiagnostics: [`OPENAI_TTS_NETWORK_ERROR`, `TTS_LATENCY_MS=${Date.now() - startedAt}`],
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        route: this.route,
        spokenText: request.text,
        fallbackUsed: false,
        developerDiagnostics: [`OPENAI_TTS_HTTP_${response.status}`, `TTS_LATENCY_MS=${Date.now() - startedAt}`],
      };
    }

    await import('node:fs/promises').then((fs) => fs.mkdir(this.outputDir, { recursive: true }));
    const ext = request.outputFormat === 'AUDIO_MPEG' ? 'mp3' : 'wav';
    const filename = `nagex-natural-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
    const audioPath = path.join(this.outputDir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(audioPath, buffer);

    return {
      ok: true,
      route: this.route,
      audioRef: audioPath,
      spokenText: request.text,
      fallbackUsed: false,
      developerDiagnostics: [
        `VOICE_MODEL=${this.model}`,
        `VOICE_PROFILE=${this.voice}`,
        `VOICE_STYLE_FIXED=${NAGEX_CANONICAL_BRAND_VOICE.baseStyle}`,
        `VOICE_BASE_RATE=${NAGEX_CANONICAL_BRAND_VOICE.baseSpeakingRate}`,
        `VOICE_LANGUAGE_STRATEGY=${NAGEX_CANONICAL_BRAND_VOICE.languageStrategy}`,
        `VOICE_PITCH_POLICY=${NAGEX_CANONICAL_BRAND_VOICE.pitchPolicy}`,
        `TTS_LATENCY_MS=${Date.now() - startedAt}`,
        `AUDIO_BYTES=${buffer.byteLength}`,
        'AUDIO_DURATION=UNKNOWN_UNTIL_PLAYBACK_OR_PROBE',
        'TEMP_TTS_AUDIO=EPHEMERAL',
      ],
    };
  }
}
