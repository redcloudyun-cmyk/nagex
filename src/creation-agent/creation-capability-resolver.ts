import type { CreationArtifactType, CreationCapability, CreationIntent } from './creation-agent.types.js';

export interface CapabilityResolution {
  readonly goalId: string;
  readonly capabilities: readonly CreationCapability[];
  readonly unavailable: readonly CreationCapability[];
  readonly providerNeutral: true;
}

export class CreationCapabilityResolver {
  resolve(intent: CreationIntent): CapabilityResolution {
    const capabilities = new Set<CreationCapability>(['LLM_TEXT', 'FILE_READ', 'FILE_WRITE', 'BRAND_ASSET_LOOKUP']);
    const unavailable = new Set<CreationCapability>();
    for (const type of intent.artifactTypes) {
      for (const capability of this.requiredFor(type)) capabilities.add(capability);
      if (type === 'VIDEO') {
        unavailable.add('VIDEO_GENERATION');
        unavailable.add('VIDEO_COMPOSITION');
      }
    }
    return {
      goalId: intent.goalId,
      capabilities: [...capabilities],
      unavailable: [...unavailable],
      providerNeutral: true,
    };
  }

  private requiredFor(type: CreationArtifactType): readonly CreationCapability[] {
    switch (type) {
      case 'REPORT':
      case 'DOCUMENT':
        return ['DOCX_RENDER', 'PDF_RENDER'];
      case 'SLIDES':
        return ['SLIDE_RENDER', 'CHART_GENERATION'];
      case 'IMAGE':
        return ['IMAGE_GENERATION', 'IMAGE_EDIT'];
      case 'VIDEO':
        return ['TTS', 'VIDEO_GENERATION', 'VIDEO_COMPOSITION'];
      case 'DATA_VISUALIZATION':
        return ['DATA_ANALYSIS', 'CHART_GENERATION'];
      default:
        return ['LLM_TEXT'];
    }
  }
}
