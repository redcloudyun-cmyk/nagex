import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const candidateVoice = process.env.NAGEX_TTS_CANDIDATE_VOICE ?? 'sage';
const outDir = path.join(root, 'artifacts', `voice-candidate-${candidateVoice}`);
await fs.mkdir(outDir, { recursive: true });

const { OpenAiNeuralVoiceProvider } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'openai-neural-voice-provider.js')));
const { NAGEX_CANONICAL_BRAND_VOICE } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'brand-voice-profile.js')));

const provider = new OpenAiNeuralVoiceProvider({
  voice: candidateVoice,
  model: NAGEX_CANONICAL_BRAND_VOICE.model,
  outputDir: outDir,
});

const text = '안녕하세요. 네이젝스입니다. 필요한 일을 말씀해 주세요.';
const samples = [];

for (let index = 1; index <= 5; index += 1) {
  const result = await provider.synthesize({
    text,
    language: 'ko-KR',
    voiceProfile: 'NAGEX_NATURAL',
    prosody: {
      tone: 'ACKNOWLEDGEMENT',
      speakingRate: 'NORMAL',
      pitch: 'NEUTRAL',
      pauseMs: 120,
      emphasis: [],
    },
    pronunciationHints: {},
    outputFormat: 'AUDIO_MPEG',
  });
  samples.push({
    id: `candidate_${candidateVoice}_repeat_greeting_${index}`,
    spokenText: text,
    route: result.route,
    ok: result.ok,
    fallbackUsed: result.fallbackUsed,
    audioRef: result.audioRef ?? null,
    diagnostics: result.developerDiagnostics,
  });
}

const report = {
  startedAt: new Date().toISOString(),
  voiceCandidate: candidateVoice,
  voiceModel: NAGEX_CANONICAL_BRAND_VOICE.model,
  baseRate: NAGEX_CANONICAL_BRAND_VOICE.baseSpeakingRate,
  baseStyle: NAGEX_CANONICAL_BRAND_VOICE.baseStyle,
  languagePolicy: NAGEX_CANONICAL_BRAND_VOICE.languageStrategy,
  outputFormat: NAGEX_CANONICAL_BRAND_VOICE.outputFormat,
  sameTextRepeatCount: 5,
  samples,
};

await fs.writeFile(path.join(outDir, 'brand-voice-candidate-repeat-cert.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
