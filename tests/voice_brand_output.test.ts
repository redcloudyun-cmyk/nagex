import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { PronunciationLexicon } from '../src/voice-output/pronunciation-lexicon.js';
import { SpeechNormalizer } from '../src/voice-output/speech-normalizer.js';
import { SpokenResponseComposer } from '../src/voice-output/spoken-response-composer.js';
import { BRAND_VOICE_LIVE_SAMPLES } from '../src/voice-output/brand-voice-live-samples.js';
import { CORAL_GOLDEN_TAKE, GPT4O_MINI_TTS_PRESET_SEARCH, NAGEX_CANONICAL_BRAND_VOICE } from '../src/voice-output/brand-voice-profile.js';
import { BrandVoiceAssetRegistry } from '../src/voice-output/brand-voice-assets.js';
import { BrandVoiceResolver } from '../src/voice-output/brand-voice-resolver.js';
import { DYNAMIC_BRAND_VOICE_BENCHMARK_CONTRACT } from '../src/voice-output/dynamic-voice-provider-benchmark.js';
import { OpenAiNeuralVoiceProvider } from '../src/voice-output/openai-neural-voice-provider.js';
import { NativeOsVoiceProvider, UnavailableVoiceProvider, VoiceOutputResolver } from '../src/voice-output/voice-output-provider.js';

test('NAgex brand pronunciation is centralized and canonical', () => {
  const lexicon = PronunciationLexicon.canonical();
  assert.equal(lexicon.lookup('NAgex')?.spoken, '\uB124\uC774\uC81D\uC2A4');
  assert.equal(lexicon.lookup('Google')?.spoken, '\uAD6C\uAE00');
  assert.equal(lexicon.lookup('Calendar')?.spoken, '\uCE98\uB9B0\uB354');
  assert.equal(lexicon.lookup('KORAIL')?.spoken, '\uCF54\uB808\uC77C');
  assert.equal(lexicon.lookup('Outlook')?.spoken, '\uC544\uC6C3\uB8E9');
});

test('NAgex Natural separates fixed golden take from unresolved dynamic voice', () => {
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.displayName, 'NAgex Natural');
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.model, 'gpt-4o-mini-tts');
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.providerVoice, null);
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.baseSpeakingRate, 1.0);
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.outputFormat, 'AUDIO_MPEG');
  assert.match(NAGEX_CANONICAL_BRAND_VOICE.baseStyle, /consistent speaker identity/);
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.dynamicBrandVoiceStatus, 'UNRESOLVED');
  assert.equal(NAGEX_CANONICAL_BRAND_VOICE.commercialDynamicVoiceReady, false);
  assert.equal(CORAL_GOLDEN_TAKE.referenceVoice, true);
  assert.equal(CORAL_GOLDEN_TAKE.fixedAssetCandidate, true);
  assert.equal(CORAL_GOLDEN_TAKE.dynamicCanonicalVoice, false);
  assert.equal(CORAL_GOLDEN_TAKE.providerVoice, 'coral');
  assert.equal(GPT4O_MINI_TTS_PRESET_SEARCH.status, 'PAUSED');
});

test('brand voice asset registry resolves only canonical fixed phrases', () => {
  const registry = new BrandVoiceAssetRegistry();
  const greeting = registry.get('GREETING');
  assert.equal(greeting?.sourceTakeId, 'CORAL_GOLDEN_TAKE');
  assert.equal(registry.findBySpokenText('안녕하세요. 네이젝스입니다. 필요한 일을 말씀해 주세요.')?.id, 'GREETING');
  assert.equal(registry.findBySpokenText('내일 저녁 7시에 네 명으로 예약할 수 있어요.'), null);
});

test('brand voice resolver routes fixed assets separately from dynamic speech', () => {
  const composer = new SpokenResponseComposer();
  const resolver = new BrandVoiceResolver();
  const fixed = resolver.resolve(composer.compose({
    visualText: 'NAgex greeting',
    spokenDraft: '안녕하세요. NAgex입니다. 필요한 일을 말씀해 주세요.',
    locale: 'ko-KR',
    tone: 'ACKNOWLEDGEMENT',
    allowCloudTts: true,
  }));
  assert.equal(fixed.kind, 'FIXED_ASSET');

  const dynamic = resolver.resolve(composer.compose({
    visualText: 'Reservation',
    spokenDraft: '내일 저녁 7시에 네 명으로 예약할 수 있어요.',
    locale: 'ko-KR',
    tone: 'INFORMATION',
    allowCloudTts: true,
  }));
  assert.equal(dynamic.kind, 'DYNAMIC_PROVIDER');
});

test('dynamic provider benchmark is consistency-first and stops on reject', () => {
  assert.equal(DYNAMIC_BRAND_VOICE_BENCHMARK_CONTRACT.sameTextRepeatCount, 5);
  assert.equal(DYNAMIC_BRAND_VOICE_BENCHMARK_CONTRACT.rejectStopsSemanticTesting, true);
  assert.equal(DYNAMIC_BRAND_VOICE_BENCHMARK_CONTRACT.semanticTestRequiresConsistencyPass, true);
});

test('NAgex Natural provider-facing identity parameters do not drift by sample tone', async () => {
  const requests: unknown[] = [];
  const provider = new OpenAiNeuralVoiceProvider({
    apiKey: 'test-key',
    endpoint: 'https://tts.example.test/audio',
    outputDir: path.join(os.tmpdir(), 'nagex-voice-quality-test'),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;

  try {
    for (const sample of BRAND_VOICE_LIVE_SAMPLES) {
      await provider.synthesize({
        text: sample.spokenDraft,
        language: 'ko-KR',
        voiceProfile: 'NAGEX_NATURAL',
        prosody: { tone: sample.tone, speakingRate: sample.tone === 'WARNING' ? 'SLOW_CLEAR' : 'BRISK', pitch: 'LOW_MID', pauseMs: 120, emphasis: [] },
        pronunciationHints: {},
        outputFormat: 'AUDIO_MPEG',
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const uniqueIdentityPayloads = new Set(requests.map((request) => {
    const payload = request as { model: string; voice: string; instructions: string; speed: number; response_format: string };
    return JSON.stringify({
      model: payload.model,
      voice: payload.voice,
      instructions: payload.instructions,
      speed: payload.speed,
      response_format: payload.response_format,
    });
  }));
  assert.equal(uniqueIdentityPayloads.size, 1);
});

test('speech normalizer handles Korean dates times currency and provider names', () => {
  const normalizer = new SpeechNormalizer();
  assert.equal(normalizer.normalize('2026-10-10 19:00'), '10\uC6D4 10\uC77C \uC624\uD6C4 7\uC2DC');
  assert.equal(normalizer.normalize('09:05'), '\uC624\uC804 9\uC2DC 5\uBD84');
  assert.equal(normalizer.normalize('₩128,000'), '12\uB9CC 8\uCC9C\uC6D0');
  assert.equal(normalizer.normalize('NAgex Google KORAIL'), '\uB124\uC774\uC81D\uC2A4 \uAD6C\uAE00 \uCF54\uB808\uC77C');
});

test('visual response and spoken response can differ for listening quality', () => {
  const composer = new SpokenResponseComposer();
  const visual = [
    'KTX-\uC0B0\uCC9C 315',
    '\uC218\uC11C 09:00',
    '\uBD80\uC0B0 11:11',
    '2\uC2DC\uAC04 11\uBD84',
    '\uC77C\uBC18\uC2E4 \uC785\uC11D+\uC88C\uC11D',
  ].join('\n');
  const spoken = composer.compose({
    visualText: visual,
    spokenDraft: '09:00\uC5D0 \uC218\uC11C\uC5D0\uC11C \uCD9C\uBC1C\uD558\uB294 KTX-\uC0B0\uCC9C 315\uD3B8\uC774 \uAC00\uC7A5 \uAC00\uAE4C\uC6B4 \uD6C4\uBCF4\uC608\uC694.',
    locale: 'ko-KR',
    tone: 'INFORMATION',
  });
  assert.notEqual(spoken.text, visual);
  assert.match(spoken.text, /\uC624\uC804 9\uC2DC/);
});

test('unverified external actions cannot produce success speech', () => {
  const composer = new SpokenResponseComposer();
  const spoken = composer.compose({
    visualText: '\uC608\uC57D\uB410\uC5B4\uC694.',
    locale: 'ko-KR',
    tone: 'SUCCESS',
    executionTruthState: 'UNVERIFIED',
  });
  assert.doesNotMatch(spoken.text, /\uC608\uC57D\uB410\uC5B4\uC694/);
  assert.match(spoken.text, /\uACB0\uACFC\uB97C \uD655\uC778/);
});

test('cloud TTS receives only spoken payload and personal data is filtered', () => {
  const composer = new SpokenResponseComposer();
  const spoken = composer.compose({
    visualText: '\uC870\uBBFC\uD615\uB2D8\uC5D0\uAC8C \uC804\uD654\uB97C \uAC78\uAE4C\uC694? 010-1234-5678',
    locale: 'ko-KR',
    tone: 'APPROVAL_REQUEST',
    allowCloudTts: true,
    hiddenContext: { fullMemory: 'do not send this' },
  });
  assert.equal(spoken.rawContextSentToTts, false);
  assert.doesNotMatch(spoken.ttsPayload, /010-1234-5678/);
  assert.doesNotMatch(JSON.stringify(spoken), /fullMemory/);
});

test('provider fallback works without exposing provider choice to consumer copy', async () => {
  const composer = new SpokenResponseComposer();
  const resolver = new VoiceOutputResolver([
    new UnavailableVoiceProvider('HIGH_QUALITY_NEURAL', 'NEURAL_TTS_UNAVAILABLE'),
    new NativeOsVoiceProvider(),
  ]);
  const result = await composer.synthesize({
    visualText: '\uB124, \uB9D0\uC500\uD558\uC138\uC694.',
    locale: 'ko-KR',
    tone: 'ACKNOWLEDGEMENT',
  }, resolver);
  assert.equal(result.ok, true);
  assert.equal(result.route, 'NATIVE_OS');
  assert.equal(result.fallbackUsed, true);
  assert.match(result.developerDiagnostics.join(' '), /NEURAL_TTS_UNAVAILABLE/);
});

test('NAgex Natural live sample set uses the real spoken pipeline instead of raw UI text', () => {
  const composer = new SpokenResponseComposer();
  assert.equal(BRAND_VOICE_LIVE_SAMPLES.length, 8);
  for (const sample of BRAND_VOICE_LIVE_SAMPLES) {
    const spoken = composer.compose({
      visualText: sample.visualText,
      spokenDraft: sample.spokenDraft,
      locale: 'ko-KR',
      tone: sample.tone,
      allowCloudTts: true,
      hiddenContext: { fullMemory: 'never send' },
    });
    assert.equal(spoken.rawContextSentToTts, false);
    assert.notEqual(spoken.text, sample.visualText);
    assert.doesNotMatch(spoken.ttsPayload, /Google|Calendar|Microsoft|Outlook|Hotels\.com|NAgex|NAVER/);
  }
});

test('high quality provider remains behind abstraction and fails closed without credentials', async () => {
  const provider = new OpenAiNeuralVoiceProvider({ apiKey: '', outputDir: 'artifacts/voice-quality-test' });
  const result = await provider.synthesize({
    text: '\uC548\uB155\uD558\uC138\uC694. \uB124\uC774\uC81D\uC2A4\uC785\uB2C8\uB2E4.',
    language: 'ko-KR',
    voiceProfile: 'NAGEX_NATURAL',
    prosody: { tone: 'ACKNOWLEDGEMENT', speakingRate: 'BRISK', pitch: 'NEUTRAL', pauseMs: 120, emphasis: [] },
    pronunciationHints: {},
    outputFormat: 'AUDIO_MPEG',
  });
  assert.equal(result.ok, false);
  assert.equal(result.route, 'HIGH_QUALITY_NEURAL');
  assert.match(result.developerDiagnostics.join(' '), /OPENAI_TTS_API_KEY_MISSING/);
});

test('voice output can be disabled for text-only mode', () => {
  const composer = new SpokenResponseComposer();
  const spoken = composer.compose({
    visualText: '\uB124, \uB9D0\uC500\uD558\uC138\uC694.',
    locale: 'ko-KR',
    tone: 'ACKNOWLEDGEMENT',
    allowVoiceOutput: false,
  });
  assert.equal(spoken.voiceOutputDisabled, true);
  assert.equal(spoken.ttsPayload, '');
});
