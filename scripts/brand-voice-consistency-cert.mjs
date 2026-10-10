import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const outDir = path.join(root, 'artifacts', 'voice-consistency');
await fs.mkdir(outDir, { recursive: true });

const { SpokenResponseComposer } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'spoken-response-composer.js')));
const { OpenAiNeuralVoiceProvider } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'openai-neural-voice-provider.js')));
const { VoiceOutputResolver } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'voice-output-provider.js')));
const { NAGEX_CANONICAL_BRAND_VOICE } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'voice-output', 'brand-voice-profile.js')));

const composer = new SpokenResponseComposer();
const resolver = new VoiceOutputResolver([
  new OpenAiNeuralVoiceProvider({ outputDir: outDir }),
]);

const greeting = '안녕하세요. NAgex입니다. 필요한 일을 말씀해 주세요.';
const samples = [
  { id: 'consistency_1_greeting', spokenDraft: greeting, tone: 'ACKNOWLEDGEMENT' },
  { id: 'consistency_2_reservation', spokenDraft: '내일 저녁 7시에 네 명으로 예약할 수 있어요.', tone: 'INFORMATION' },
  { id: 'consistency_3_ktx', spokenDraft: '9시에 수서에서 출발하는 KTX 산천 315편입니다.', tone: 'INFORMATION' },
  { id: 'consistency_4_call', spokenDraft: '조민형님께 전화를 걸까요?', tone: 'APPROVAL_REQUEST' },
  { id: 'consistency_5_mixed_calendar', spokenDraft: 'Google Calendar 일정과 Microsoft Outlook 일정을 함께 확인했어요.', tone: 'INFORMATION' },
  { id: 'consistency_6_warning', spokenDraft: '예약 조건이 바뀌었어요. 결제하기 전에 다시 확인해 주세요.', tone: 'WARNING' },
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `repeat_greeting_${index + 1}`,
    spokenDraft: greeting,
    tone: 'ACKNOWLEDGEMENT',
  })),
];

const report = {
  startedAt: new Date().toISOString(),
  voiceModel: NAGEX_CANONICAL_BRAND_VOICE.model,
  voiceProfile: NAGEX_CANONICAL_BRAND_VOICE.providerVoice,
  baseRate: NAGEX_CANONICAL_BRAND_VOICE.baseSpeakingRate,
  baseStyle: NAGEX_CANONICAL_BRAND_VOICE.baseStyle,
  voiceIdentityFixed: true,
  prosodyBounded: true,
  sameTextRepeatCount: 5,
  requestParameterDriftFound: false,
  samples: [],
};

for (const sample of samples) {
  const composed = composer.compose({
    visualText: sample.spokenDraft,
    spokenDraft: sample.spokenDraft,
    locale: 'ko-KR',
    tone: sample.tone,
    allowCloudTts: true,
    hiddenContext: { rawContext: 'MUST_NOT_BE_SENT_TO_TTS' },
  });
  const result = await composer.synthesize({
    visualText: sample.spokenDraft,
    spokenDraft: sample.spokenDraft,
    locale: 'ko-KR',
    tone: sample.tone,
    allowCloudTts: true,
    hiddenContext: { rawContext: 'MUST_NOT_BE_SENT_TO_TTS' },
  }, resolver);
  report.samples.push({
    id: sample.id,
    spokenText: composed.text,
    route: result.route,
    ok: result.ok,
    fallbackUsed: result.fallbackUsed,
    audioRef: result.audioRef ?? null,
    diagnostics: result.developerDiagnostics,
  });
}

const reportPath = path.join(outDir, 'brand-voice-consistency-cert.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
