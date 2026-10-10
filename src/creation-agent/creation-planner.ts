import type { CreationArtifactType, CreationIntent, CreationPlan, CreationPlanStep, MissingRequirement } from './creation-agent.types.js';

export class CreationPlanner {
  plan(intent: CreationIntent): CreationPlan {
    const missing = this.missingRequirements(intent);
    const artifactTypes = intent.artifactTypes;
    const steps: CreationPlanStep[] = [
      { stepId: 'source-extraction', kind: 'source_extraction', artifactTypes },
      { stepId: 'outline', kind: 'outline', artifactTypes },
      { stepId: 'draft', kind: 'draft', artifactTypes },
      { stepId: 'visual-plan', kind: 'visual_plan', artifactTypes: artifactTypes.filter((t) => t !== 'REPORT' && t !== 'DOCUMENT') },
      { stepId: 'asset-generation', kind: 'asset_generation', artifactTypes: artifactTypes.filter((t) => t === 'IMAGE' || t === 'VIDEO') },
      { stepId: 'artifact-rendering', kind: 'artifact_rendering', artifactTypes },
      { stepId: 'validation', kind: 'validation', artifactTypes },
    ];
    return {
      goalId: intent.goalId,
      state: missing.some((m) => m.importance === 'CRITICAL') ? 'NEEDS_INFORMATION' : 'PLAN_CREATED',
      assumptions: this.assumptions(intent),
      missingRequirements: missing,
      steps: steps.filter((step) => step.artifactTypes.length > 0),
    };
  }

  private missingRequirements(intent: CreationIntent): readonly MissingRequirement[] {
    const missing: MissingRequirement[] = [];
    if (!intent.goal.trim()) missing.push({ field: 'goal', importance: 'CRITICAL', reason: 'Creation goal is required.' });
    if (!intent.artifactTypes.length) missing.push({ field: 'artifactTypes', importance: 'CRITICAL', reason: 'At least one artifact type is required.' });
    if (!intent.language) missing.push({ field: 'language', importance: 'IMPORTANT', reason: 'Language can be inferred but should be surfaced.' });
    if (!intent.audience) missing.push({ field: 'audience', importance: this.radicallyAudienceDependent(intent.artifactTypes) ? 'IMPORTANT' : 'OPTIONAL', reason: 'Audience improves tone and structure.' });
    return missing;
  }

  private radicallyAudienceDependent(types: readonly CreationArtifactType[]): boolean {
    return types.includes('SLIDES') || types.includes('VIDEO');
  }

  private assumptions(intent: CreationIntent): readonly string[] {
    const assumptions: string[] = [];
    if (!intent.language) assumptions.push('Language defaults to Korean-first if source material is Korean, otherwise English.');
    if (!intent.audience) assumptions.push('Audience defaults to a general professional reader.');
    if (intent.artifactTypes.includes('SLIDES') && !intent.length) assumptions.push('Slides default to 8 pages for Phase 1 compound certification.');
    return assumptions;
  }
}
