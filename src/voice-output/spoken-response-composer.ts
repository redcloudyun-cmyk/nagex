import { PronunciationLexicon } from './pronunciation-lexicon.js';
import { ProsodyPlanner, type VoiceIntentTone } from './prosody-planner.js';
import { SpeechNormalizer } from './speech-normalizer.js';
import { VoiceOutputPrivacyFilter } from './voice-output-privacy-filter.js';
import { VoiceOutputResolver, type VoiceSynthesisResult } from './voice-output-provider.js';

export type ExecutionTruthState = 'UNVERIFIED' | 'IN_PROGRESS' | 'VERIFIED_SUCCESS' | 'FAILED';

export interface SpokenResponseInput {
  visualText: string;
  spokenDraft?: string;
  locale: 'ko-KR' | 'en-US';
  tone: VoiceIntentTone;
  executionTruthState?: ExecutionTruthState;
  allowVoiceOutput?: boolean;
  allowCloudTts?: boolean;
  hiddenContext?: unknown;
  emphasis?: string[];
}

export interface SpokenResponse {
  text: string;
  prosody: ReturnType<ProsodyPlanner['plan']>;
  ttsPayload: string;
  rawContextSentToTts: false;
  voiceOutputDisabled: boolean;
}

const VERIFIED_SUCCESS_WORDS = [
  '\uBCF4\uB0C8\uC5B4\uC694',
  '\uC608\uC57D\uB410\uC5B4\uC694',
  '\uACB0\uC81C\uB410\uC5B4\uC694',
  '\uC644\uB8CC\uB410\uC2B5\uB2C8\uB2E4',
];

export class SpokenResponseComposer {
  private readonly lexicon = PronunciationLexicon.canonical();
  private readonly normalizer = new SpeechNormalizer(this.lexicon);
  private readonly prosodyPlanner = new ProsodyPlanner();
  private readonly privacyFilter = new VoiceOutputPrivacyFilter();

  public compose(input: SpokenResponseInput): SpokenResponse {
    if (input.allowVoiceOutput === false) {
      return {
        text: '',
        prosody: this.prosodyPlanner.plan(input.tone, input.emphasis),
        ttsPayload: '',
        rawContextSentToTts: false,
        voiceOutputDisabled: true,
      };
    }

    const base = input.spokenDraft || this.summarizeVisual(input.visualText, input.tone);
    const truthful = this.enforceTruthfulness(base, input.executionTruthState ?? 'UNVERIFIED');
    const normalized = this.normalizer.normalize(truthful, input.locale);
    const privacy = this.privacyFilter.filter({ spokenText: normalized, hiddenContext: input.hiddenContext, allowCloudTts: input.allowCloudTts ?? false });
    return {
      text: normalized,
      prosody: this.prosodyPlanner.plan(input.tone, input.emphasis),
      ttsPayload: privacy.spokenPayload,
      rawContextSentToTts: privacy.rawContextSentToTts,
      voiceOutputDisabled: false,
    };
  }

  public async synthesize(input: SpokenResponseInput, resolver = VoiceOutputResolver.default()): Promise<VoiceSynthesisResult> {
    const spoken = this.compose(input);
    if (spoken.voiceOutputDisabled) {
      return { ok: false, route: 'NATIVE_OS', spokenText: '', fallbackUsed: false, developerDiagnostics: ['VOICE_OUTPUT_DISABLED'] };
    }
    return resolver.synthesizeWithFallback({
      text: spoken.ttsPayload,
      language: input.locale,
      voiceProfile: 'NAGEX_NATURAL',
      prosody: spoken.prosody,
      pronunciationHints: Object.fromEntries(this.lexicon.list().map((entry) => [entry.term, entry.spoken])),
      outputFormat: 'AUDIO_MPEG',
    });
  }

  private summarizeVisual(visualText: string, tone: VoiceIntentTone): string {
    const compact = visualText.replace(/\s+/g, ' ').trim();
    if (tone === 'ACKNOWLEDGEMENT') return '\uB124, \uB9D0\uC500\uD558\uC138\uC694.';
    if (compact.length <= 120) return compact;
    return `${compact.slice(0, 96).trim()}. \uC790\uC138\uD55C \uB0B4\uC6A9\uC740 \uD654\uBA74\uC5D0 \uC815\uB9AC\uD574\uB450\uC5C8\uC5B4\uC694.`;
  }

  private enforceTruthfulness(text: string, state: ExecutionTruthState): string {
    if (state === 'VERIFIED_SUCCESS') return text;
    let output = text;
    for (const word of VERIFIED_SUCCESS_WORDS) {
      output = output.replaceAll(word, '\uACB0\uACFC\uB97C \uD655\uC778\uD558\uACE0 \uC788\uC5B4\uC694');
    }
    return output;
  }
}
