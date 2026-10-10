export type SameSpeakerIdentityJudgment = 'PASS' | 'REJECT';

export interface DynamicVoiceProviderCandidate {
  providerId: string;
  model: string;
  voiceProfile: string;
  speed: 1.0;
  style: string;
  languagePolicy: 'KOREAN_FIRST_NORMALIZED_MIXED_TERMS';
  outputFormat: 'AUDIO_MPEG';
}

export interface SameTextConsistencyGate {
  sentence: '안녕하세요. 네이젝스입니다. 필요한 일을 말씀해 주세요.';
  repeatCount: 5;
  decision: SameSpeakerIdentityJudgment;
}

export interface SemanticVoiceBenchmarkResult {
  voiceIdentityConsistency: 'PASS' | 'FAIL';
  koreanNaturalness: 'PASS' | 'FAIL';
  mixedLanguageFlow: 'PASS' | 'FAIL';
  numberTimePronunciation: 'PASS' | 'FAIL';
  prosody: 'PASS' | 'FAIL';
  latency: 'PASS' | 'FAIL';
  listeningFatigue: 'PASS' | 'FAIL';
  executiveAssistantFeel: 'PASS' | 'FAIL';
}

export const DYNAMIC_BRAND_VOICE_BENCHMARK_CONTRACT = {
  firstGateSentence: '안녕하세요. 네이젝스입니다. 필요한 일을 말씀해 주세요.',
  sameTextRepeatCount: 5,
  rejectStopsSemanticTesting: true,
  semanticTestRequiresConsistencyPass: true,
  semanticSamples: ['greeting', 'reservation', 'ktx_time_number', 'call_question', 'mixed_korean_english', 'warning'],
} as const;
