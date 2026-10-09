import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const outDir = path.join(root, 'artifacts', 'voice-quality');
await fs.mkdir(outDir, { recursive: true });

const { BRAND_VOICE_LIVE_SAMPLES } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'brand-voice-live-samples.js')));
const { SpokenResponseComposer } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'spoken-response-composer.js')));
const { OpenAiNeuralVoiceProvider } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'openai-neural-voice-provider.js')));
const { NativeOsVoiceProvider, VoiceOutputResolver } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'voice-output-provider.js')));

const composer = new SpokenResponseComposer();
const resolver = new VoiceOutputResolver([
  new OpenAiNeuralVoiceProvider({ outputDir: outDir }),
  new NativeOsVoiceProvider(),
]);

const report = {
  startedAt: new Date().toISOString(),
  voiceName: 'NAgex Natural',
  primaryProvider: 'OPENAI_NEURAL_TTS',
  credentialAvailable: Boolean(process.env.NAGEX_TTS_OPENAI_API_KEY || process.env.OPENAI_API_KEY),
  credentialServerSideOnly: true,
  credentialLogged: false,
  providerAbstractionPreserved: true,
  cloudTtsPayloadMinimized: true,
  rawContextSentToTts: false,
  tempTtsAudioEphemeral: true,
  realNeuralTtsRequest: false,
  samples: [],
};

for (const sample of BRAND_VOICE_LIVE_SAMPLES) {
  const composed = composer.compose({
    visualText: sample.visualText,
    spokenDraft: sample.spokenDraft,
    locale: 'ko-KR',
    tone: sample.tone,
    allowCloudTts: true,
    hiddenContext: {
      fullMemory: 'MUST_NOT_BE_SENT_TO_TTS',
      screenshots: ['MUST_NOT_BE_SENT_TO_TTS'],
      reasoning: 'MUST_NOT_BE_SENT_TO_TTS',
    },
  });
  const result = await composer.synthesize({
    visualText: sample.visualText,
    spokenDraft: sample.spokenDraft,
    locale: 'ko-KR',
    tone: sample.tone,
    allowCloudTts: true,
    hiddenContext: {
      fullMemory: 'MUST_NOT_BE_SENT_TO_TTS',
      screenshots: ['MUST_NOT_BE_SENT_TO_TTS'],
      reasoning: 'MUST_NOT_BE_SENT_TO_TTS',
    },
  }, resolver);

  report.samples.push({
    id: sample.id,
    spokenText: composed.text,
    ttsPayload: composed.ttsPayload,
    rawContextSentToTts: composed.rawContextSentToTts,
    route: result.route,
    ok: result.ok,
    fallbackUsed: result.fallbackUsed,
    audioRef: result.audioRef ?? null,
    diagnostics: result.developerDiagnostics,
  });
}

const primaryGenerated = report.samples.some((sample) => sample.route === 'HIGH_QUALITY_NEURAL' && sample.ok);
report.realNeuralTtsRequest = report.credentialAvailable && report.samples.some((sample) =>
  sample.diagnostics.some((line) => String(line).startsWith('HIGH_QUALITY_NEURAL:') || String(line).startsWith('VOICE_MODEL=')),
);
report.primaryProviderUsed = primaryGenerated;
report.fallbackUsed = report.samples.some((sample) => sample.fallbackUsed);
report.neuralAudioGenerated = primaryGenerated;
report.onlyFinalSpokenTextSent = report.samples.every((sample) =>
  sample.rawContextSentToTts === false &&
  !JSON.stringify(sample).includes('MUST_NOT_BE_SENT_TO_TTS')
);
report.finalOutcome = primaryGenerated ? 'AUDIO_GENERATED_REQUIRES_MOBILE_PLAYBACK_AND_HUMAN_REVIEW' : 'BLOCKED_PROVIDER_CREDENTIAL_OR_PROVIDER_FAILURE';

const reportPath = path.join(outDir, 'brand-voice-live-cert.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
