import type { CreationKind, CreationSourceRef } from '../creation-runtime.types.js';

export interface CanonicalCreationSpecBase {
  creationKind: CreationKind;
  purpose?: string;
  instructions?: string;
  locale: 'en' | 'ko';
  sourceRefs?: CreationSourceRef[];
  contextRefs?: CreationSourceRef[];
  userPreferences?: Record<string, unknown>;
  brandContext?: {
    brandName?: string;
    primaryColor?: string;
    toneOfVoice?: string;
    logoAssetId?: string;
  };
  outputRequirements?: {
    format?: string;
    quality?: 'DRAFT' | 'BALANCED' | 'HIGH' | 'ULTRA';
    targetAudience?: string;
  };
  tenantId: string;
  ownerId: string;
  requestId: string;
}

// ── Image Creation Specification ──

export interface ImageCreationSpec extends CanonicalCreationSpecBase {
  creationKind: 'IMAGE';
  subject: string;
  composition?: string;
  style?: string; // e.g. 'photorealistic', 'vector-art', '3d-render', 'minimalist'
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:2';
  referenceImages?: Array<{ assetId?: string; url?: string; weighting?: number }>;
  textRequirements?: {
    embeddedText?: string;
    fontStyle?: string;
  };
  outputUsage?: 'HERO_BANNER' | 'PRESENTATION_SLIDE' | 'SOCIAL_MEDIA' | 'DOCUMENT_ILLUSTRATION' | 'AVATAR';
  qualityPreference?: 'DRAFT' | 'BALANCED' | 'HIGH' | 'ULTRA';
  constraints?: {
    negativePrompts?: string[];
    transparentBackground?: boolean;
  };
}

// ── Presentation / Slides Creation Specification ──

export interface PresentationSlideSpec {
  slideId: string;
  objective: string;
  title: string;
  narrative?: string;
  bullets?: string[];
  visualIntent?: 'TITLE' | 'BULLETS' | 'CHART' | 'SPLIT_IMAGE' | 'QUOTE' | 'TIMELINE' | 'METRIC';
  imagePrompt?: string;
  chartSpec?: {
    chartType: 'BAR' | 'LINE' | 'PIE' | 'METRIC_CARD';
    dataPoints: Array<{ label: string; value: number }>;
  };
  sourceRefs?: CreationSourceRef[];
}

export interface PresentationCreationSpec extends CanonicalCreationSpecBase {
  creationKind: 'PRESENTATION';
  title: string;
  audience?: string;
  tone?: 'FORMAL' | 'CONVERSATIONAL' | 'INSPIRATIONAL' | 'TECHNICAL';
  slides: PresentationSlideSpec[];
  speakerNotes?: boolean;
  references?: Array<{ citationId: string; title: string; url?: string }>;
}

// ── Video Creation Specification ──

export interface VideoSceneSpec {
  sceneId: string;
  objective: string;
  durationSeconds: number;
  visualDescription: string;
  cameraIntent?: 'PAN_LEFT' | 'ZOOM_IN' | 'STATIC_WIDE' | 'CLOSE_UP' | 'DRONE_FLYOVER';
  narration?: string;
  dialogue?: Array<{ speaker: string; text: string }>;
  assetRefs?: CreationSourceRef[];
}

export interface VideoCreationSpec extends CanonicalCreationSpecBase {
  creationKind: 'VIDEO';
  title: string;
  audience?: string;
  totalDurationSeconds?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  style?: 'CINEMATIC' | 'ANIMATED' | 'EXPLAINER' | 'SCREENCAST';
  narrativeSummary?: string;
  audioRequirements?: {
    backgroundMusicStyle?: string;
    voiceGender?: 'MALE' | 'FEMALE' | 'NEUTRAL';
    voiceLanguage?: 'en' | 'ko';
  };
  storyboard: VideoSceneSpec[];
}
