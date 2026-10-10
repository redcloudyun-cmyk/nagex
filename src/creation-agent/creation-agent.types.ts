export type CreationArtifactType = 'REPORT' | 'DOCUMENT' | 'SLIDES' | 'IMAGE' | 'VIDEO' | 'DATA_VISUALIZATION' | 'OTHER';
export type CreationInputModality = 'TEXT' | 'VOICE' | 'FILE' | 'SCREEN' | 'URL' | 'IMAGE' | 'MULTIMODAL';
export type CreationGoalState =
  | 'INTENT_RECEIVED'
  | 'CONTEXT_RESOLVED'
  | 'REQUIREMENTS_INTERPRETED'
  | 'PLAN_CREATED'
  | 'SOURCES_RESOLVED'
  | 'CAPABILITIES_SELECTED'
  | 'DRAFTING'
  | 'ARTIFACT_GENERATED'
  | 'VALIDATING'
  | 'REVISION_NEEDED'
  | 'READY'
  | 'DELIVERED'
  | 'NEEDS_INFORMATION'
  | 'NEEDS_SOURCE_ACCESS'
  | 'NEEDS_USER_CHOICE'
  | 'GENERATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'PARTIAL_COMPLETE';

export type ContextConfidence = 'CONFIRMED' | 'PARTIAL' | 'UNKNOWN';
export type RequirementImportance = 'CRITICAL' | 'IMPORTANT' | 'OPTIONAL';
export type EvidenceClassification = 'SOURCE_FACT' | 'MODEL_INFERENCE' | 'USER_PROVIDED_CONTENT' | 'GENERATED_CONTENT';
export type CreationCapability =
  | 'LLM_TEXT'
  | 'WEB_RESEARCH'
  | 'FILE_READ'
  | 'FILE_WRITE'
  | 'DOCX_RENDER'
  | 'PDF_RENDER'
  | 'SLIDE_RENDER'
  | 'IMAGE_GENERATION'
  | 'IMAGE_EDIT'
  | 'VIDEO_GENERATION'
  | 'VIDEO_COMPOSITION'
  | 'CHART_GENERATION'
  | 'DATA_ANALYSIS'
  | 'TTS'
  | 'STT'
  | 'BRAND_ASSET_LOOKUP';
export type VisualQualityStatus = 'PASS' | 'NEEDS_REVISION' | 'FAIL' | 'PARTIAL';
export type ArtifactOutputPurpose = 'REPORT_COVER' | 'SLIDE_HERO' | 'INFOGRAPHIC' | 'VIDEO_SCENE' | 'SOCIAL_IMAGE' | 'GENERAL';

export interface ArtifactVisualTheme {
  readonly themeId: string;
  readonly brandStyleId: string;
  readonly fontPolicy: string;
  readonly colorTokens: readonly string[];
  readonly spacingScale: readonly number[];
  readonly cornerRadiusPolicy: 'NONE' | 'SUBTLE' | 'ROUNDED';
  readonly imageStyle: string;
  readonly chartStyle: string;
  readonly density: 'COMPACT' | 'BALANCED' | 'AIRY';
  readonly tone: string;
}

export interface CreationIntent {
  readonly goalId: string;
  readonly goal: string;
  readonly artifactTypes: readonly CreationArtifactType[];
  readonly inputModalities: readonly CreationInputModality[];
  readonly audience?: string;
  readonly purpose?: string;
  readonly language?: 'en' | 'ko';
  readonly tone?: string;
  readonly length?: string;
  readonly format?: string;
  readonly brandContext?: {
    readonly brandStyleId?: string;
    readonly visualTheme?: string;
    readonly typographyPolicy?: string;
    readonly spacingPolicy?: string;
    readonly colorTokenHook?: string;
    readonly logoAssetHook?: string;
  };
  readonly sourceFiles: readonly string[];
  readonly sourceURLs: readonly string[];
  readonly screenContext?: string;
  readonly personalContextAllowed: boolean;
  readonly deadline?: string;
  readonly outputLocation: string;
  readonly revisionInstructions?: string;
}

export interface ResolvedCreationContext {
  readonly confidence: ContextConfidence;
  readonly sourceRefs: readonly SourceReference[];
  readonly limitations: readonly string[];
}

export interface SourceReference {
  readonly sourceId: string;
  readonly kind: 'FILE' | 'URL' | 'SCREEN' | 'KNOWLEDGE' | 'MEMORY' | 'USER_INSTRUCTION';
  readonly label: string;
  readonly classification: EvidenceClassification;
}

export interface MissingRequirement {
  readonly field: string;
  readonly importance: RequirementImportance;
  readonly reason: string;
}

export interface CreationPlanStep {
  readonly stepId: string;
  readonly kind: 'research' | 'source_extraction' | 'outline' | 'draft' | 'visual_plan' | 'asset_generation' | 'artifact_rendering' | 'validation' | 'revision';
  readonly artifactTypes: readonly CreationArtifactType[];
}

export interface CreationPlan {
  readonly goalId: string;
  readonly state: CreationGoalState;
  readonly steps: readonly CreationPlanStep[];
  readonly assumptions: readonly string[];
  readonly missingRequirements: readonly MissingRequirement[];
}

export interface CreationArtifactRecord {
  readonly artifactId: string;
  readonly goalId: string;
  readonly artifactType: CreationArtifactType;
  readonly version: number;
  readonly format: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly sourceRefs: readonly string[];
  readonly storageLocation: string;
  readonly checksum: string;
  readonly derivedFrom?: string;
  readonly status: 'GENERATED' | 'VALIDATED' | 'FAILED';
  readonly validationStatus?: 'PASS' | 'PARTIAL' | 'FAIL';
  readonly visualQualityStatus?: VisualQualityStatus;
}

export interface LinkedArtifactSet {
  readonly parentGoalId: string;
  readonly artifacts: readonly CreationArtifactRecord[];
}

export interface ArtifactDependencyGraph {
  readonly goalId: string;
  readonly edges: readonly { readonly fromArtifactId: string; readonly toArtifactId: string; readonly relationship: string }[];
}
