export const NAGEX_CANONICAL_BRAND_VOICE = {
  profile: 'NAGEX_NATURAL',
  displayName: 'NAgex Natural',
  provider: 'UNRESOLVED_DYNAMIC_PROVIDER',
  model: 'gpt-4o-mini-tts',
  providerVoice: null,
  baseSpeakingRate: 1.0,
  languageStrategy: 'KOREAN_FIRST_NORMALIZED_MIXED_TERMS',
  pitchPolicy: 'FIXED_PROVIDER_VOICE_BOUNDED_PROSODY_METADATA',
  outputFormat: 'AUDIO_MPEG',
  baseStyle:
    'Speak in natural modern Korean with calm confidence, moderate warmth, and a professional personal-assistant tone. Maintain a consistent speaker identity across utterances. Use natural Korean rhythm and avoid exaggerated emotion.',
  fixedBrandVoiceAvailable: true,
  dynamicBrandVoiceStatus: 'UNRESOLVED',
  commercialDynamicVoiceReady: false,
  lockedBy: null,
} as const;

export const CORAL_GOLDEN_TAKE = {
  id: 'CORAL_GOLDEN_TAKE',
  role: 'REFERENCE_AND_FIXED_ASSET_CANDIDATE',
  referenceVoice: true,
  fixedAssetCandidate: true,
  dynamicCanonicalVoice: false,
  sourceSentence: '안녕하세요. 네이젝스입니다. 필요한 일을 말씀해 주세요.',
  model: 'gpt-4o-mini-tts',
  providerVoice: 'coral',
  speed: 1.0,
  style: NAGEX_CANONICAL_BRAND_VOICE.baseStyle,
  languagePolicy: NAGEX_CANONICAL_BRAND_VOICE.languageStrategy,
  outputFormat: NAGEX_CANONICAL_BRAND_VOICE.outputFormat,
  generationId: 'repeat_greeting_5',
  serverAudioRef:
    '/home/redcloud/services/nagex/source/artifacts/voice-consistency/nagex-natural-1791560021382-b21bd93e9e459.mp3',
  localPlaybackArtifact: 'artifacts/voice-consistency-playback-20261010/05_repeat_greeting_5.mp3',
  sourceReport: 'artifacts/voice-consistency-playback-20261010/brand-voice-consistency-cert.json',
  secretStored: false,
  userPreference: 'MOST_COMFORTABLE_CORAL_TAKE',
} as const;

export const GPT4O_MINI_TTS_PRESET_SEARCH = {
  status: 'PAUSED',
  rejectedCandidates: [
    { voice: 'coral', reason: 'SAME_TEXT_SPEAKER_CONSISTENCY_FAIL' },
    { voice: 'sage', reason: 'SAME_TEXT_SPEAKER_CONSISTENCY_FAIL_AND_TOO_SLOW' },
    { voice: 'alloy', reason: 'SAME_TEXT_SPEAKER_CONSISTENCY_FAIL' },
  ],
} as const;
