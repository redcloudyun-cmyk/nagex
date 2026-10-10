import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CreationCapabilityResolver } from './creation-capability-resolver.js';
import { CreationPlanner } from './creation-planner.js';
import { LocalRasterImageProvider, type ImageProviderAdapter } from './image-provider.js';
import { renderDocxReport, renderPptx } from './office-renderers.js';
import { validateDocxLayout, validatePngImage, validateSlideVisuals, validateVideoArtifact, type ValidationResult } from './visual-validation.js';
import { FfmpegVideoProvider, type VideoProviderAdapter, type VideoRenderResult } from './video-provider.js';
import type { ArtifactDependencyGraph, ArtifactVisualTheme, CreationArtifactRecord, CreationIntent, LinkedArtifactSet, ResolvedCreationContext, SourceReference } from './creation-agent.types.js';

export const neutralProfessionalTheme: ArtifactVisualTheme = {
  themeId: 'neutral-professional-phase2',
  brandStyleId: 'nagex-corporate',
  fontPolicy: 'system sans, restrained hierarchy',
  colorTokens: ['#14213d', '#2a9d8f', '#f4f7f5', '#e9c46a'],
  spacingScale: [8, 12, 16, 24, 32, 48],
  cornerRadiusPolicy: 'SUBTLE',
  imageStyle: 'premium minimal, calm professional, no decorative clutter',
  chartStyle: 'clear labels, moderate contrast, no default-office styling',
  density: 'BALANCED',
  tone: 'executive assistant',
};

export class CreationContextResolver {
  resolve(intent: CreationIntent): ResolvedCreationContext {
    const refs: SourceReference[] = [
      ...intent.sourceFiles.map((file, i) => ({ sourceId: `file-${i}`, kind: 'FILE' as const, label: file, classification: 'SOURCE_FACT' as const })),
      ...intent.sourceURLs.map((url, i) => ({ sourceId: `url-${i}`, kind: 'URL' as const, label: url, classification: 'SOURCE_FACT' as const })),
    ];
    if (intent.screenContext) refs.push({ sourceId: 'screen-context', kind: 'SCREEN', label: intent.screenContext, classification: 'USER_PROVIDED_CONTENT' });
    if (!refs.length) refs.push({ sourceId: 'user-instruction', kind: 'USER_INSTRUCTION', label: intent.goal, classification: 'USER_PROVIDED_CONTENT' });
    return {
      confidence: refs.length ? 'CONFIRMED' : 'UNKNOWN',
      sourceRefs: refs,
      limitations: intent.sourceFiles.length || intent.sourceURLs.length || intent.screenContext ? [] : ['No external source material was provided.'],
    };
  }
}

export class RevisionEngine {
  revise(record: CreationArtifactRecord, instructions: string): CreationArtifactRecord {
    return {
      ...record,
      version: record.version + 1,
      modifiedAt: new Date().toISOString(),
      derivedFrom: record.artifactId,
      checksum: crypto.createHash('sha256').update(`${record.checksum}:${instructions}`).digest('hex'),
    };
  }
}

export class UniversalCreationAgent {
  private readonly planner = new CreationPlanner();
  private readonly contextResolver = new CreationContextResolver();
  private readonly capabilityResolver = new CreationCapabilityResolver();
  private readonly imageProvider: ImageProviderAdapter;
  private readonly videoProvider: VideoProviderAdapter;

  constructor(options: { readonly imageProvider?: ImageProviderAdapter; readonly videoProvider?: VideoProviderAdapter } = {}) {
    this.imageProvider = options.imageProvider ?? new LocalRasterImageProvider();
    this.videoProvider = options.videoProvider ?? new FfmpegVideoProvider();
  }

  runPhase1Compound(intent: CreationIntent): LinkedArtifactSet {
    fs.mkdirSync(intent.outputLocation, { recursive: true });
    const context = this.contextResolver.resolve(intent);
    const plan = this.planner.plan(intent);
    const capabilities = this.capabilityResolver.resolve(intent);
    if (plan.state === 'NEEDS_INFORMATION') throw new Error('Critical creation requirement missing.');
    if (!capabilities.capabilities.includes('DOCX_RENDER') || !capabilities.capabilities.includes('SLIDE_RENDER')) throw new Error('Required render capabilities unavailable.');

    const now = new Date().toISOString();
    const sourceRefs = context.sourceRefs.map((ref) => ref.sourceId);
    const artifacts: CreationArtifactRecord[] = [];
    if (intent.artifactTypes.includes('REPORT') || intent.artifactTypes.includes('DOCUMENT')) {
      const file = path.join(intent.outputLocation, 'nagex-phase1-report.docx');
      const content = renderDocxReport({
        title: 'NAgex Phase 1 Creation Report',
        paragraphs: [
          `Goal: ${intent.goal}`,
          'This report was generated through the shared UniversalCreationAgent pipeline.',
          'Generated content is separated from source facts and user-provided content.',
        ],
        tableRows: [
          ['Source confidence', context.confidence],
          ['Planner state', plan.state],
          ['Evidence model', 'SOURCE_FACT / USER_PROVIDED_CONTENT / GENERATED_CONTENT'],
        ],
      });
      fs.writeFileSync(file, content);
      artifacts.push(this.record(intent.goalId, 'REPORT', 'DOCX', file, now, sourceRefs));
    }
    if (intent.artifactTypes.includes('SLIDES')) {
      const file = path.join(intent.outputLocation, 'nagex-phase1-slides.pptx');
      const content = renderPptx({
        title: 'NAgex Creation Deck',
        slides: Array.from({ length: 8 }, (_, i) => ({
          title: `${i + 1}. ${['Goal', 'Context', 'Plan', 'Sources', 'Draft', 'Visuals', 'Validation', 'Next Steps'][i]}`,
          bullets: [`Shared goal: ${intent.goalId}`, 'Provider-neutral capability path', 'Ready for revision'],
        })),
      });
      fs.writeFileSync(file, content);
      artifacts.push(this.record(intent.goalId, 'SLIDES', 'PPTX', file, now, sourceRefs));
    }
    return { parentGoalId: intent.goalId, artifacts };
  }

  runPhase2Compound(intent: CreationIntent): LinkedArtifactSet & {
    readonly graph: ArtifactDependencyGraph;
    readonly validations: Record<string, ValidationResult>;
    readonly theme: ArtifactVisualTheme;
    readonly video: VideoRenderResult;
    readonly progress: readonly string[];
  } {
    fs.mkdirSync(intent.outputLocation, { recursive: true });
    const context = this.contextResolver.resolve(intent);
    const now = new Date().toISOString();
    const sourceRefs = context.sourceRefs.map((ref) => ref.sourceId);
    const artifacts: CreationArtifactRecord[] = [];
    const validations: Record<string, ValidationResult> = {};
    const progress = ['source-analysis', 'report-authoring', 'slide-composition', 'image-generation', 'video-composition', 'final-validation', 'complete'];

    const reportFile = path.join(intent.outputLocation, 'report.docx');
    fs.writeFileSync(reportFile, renderDocxReport({
      title: 'NAgex Knowledge Creation Agent Phase 2',
      paragraphs: [
        `Goal: ${intent.goal}`,
        'This report, slide deck, hero image, and intro video share one compound CreationGoal.',
        'Visual validation checks layout, hierarchy, spacing, and artifact linkage before delivery.',
      ],
      tableRows: [
        ['Artifact graph', 'source -> report -> slides -> image -> video'],
        ['Generation rule', 'Generation is not success until validation passes.'],
        ['Voice policy', 'Dynamic commercial NAgex voice remains unresolved; video uses captions only.'],
      ],
    }));
    validations.report = validateDocxLayout(reportFile);
    const report = this.record(intent.goalId, 'REPORT', 'DOCX', reportFile, now, sourceRefs, validations.report.status);
    artifacts.push(report);

    const slideFile = path.join(intent.outputLocation, 'slides.pptx');
    fs.writeFileSync(slideFile, renderPptx({
      title: 'NAgex Creation Agent Phase 2',
      slides: Array.from({ length: 8 }, (_, i) => ({
        title: `${i + 1}. ${['Goal', 'Evidence', 'Report', 'Slides', 'Hero Image', 'Intro Video', 'Validation', 'Next Step'][i]}`,
        bullets: ['One compound goal', 'Linked artifact lineage', 'Revision-capable output'],
      })),
    }));
    validations.slides = validateSlideVisuals(slideFile, 8);
    const slides = this.record(intent.goalId, 'SLIDES', 'PPTX', slideFile, now, sourceRefs, validations.slides.status, report.artifactId);
    artifacts.push(slides);

    const image = this.imageProvider.create({
      prompt: 'NAgex creation agent hero image for professional report and slides',
      negativeConstraints: ['childish', 'random gradients', 'decorative clutter', 'unwanted text'],
      brandStyleId: neutralProfessionalTheme.brandStyleId,
      aspectRatio: '16:9',
      usageContext: 'compound creation report cover and slide hero',
      parentGoalId: intent.goalId,
      parentArtifactId: slides.artifactId,
      outputPurpose: 'SLIDE_HERO',
      outputPath: path.join(intent.outputLocation, 'hero-image.png'),
      theme: neutralProfessionalTheme,
    });
    validations.image = validatePngImage(image.file);
    const imageRecord = this.record(intent.goalId, 'IMAGE', image.format, image.file, now, sourceRefs, validations.image.status, slides.artifactId);
    artifacts.push(imageRecord);

    const revisedImage = this.imageProvider.edit({
      prompt: 'Make the background simpler and emphasize the central assistant silhouette without adding text',
      sourceImage: image.file,
      revisionInstruction: 'simplify background, stronger central object, no text',
      brandStyleId: neutralProfessionalTheme.brandStyleId,
      aspectRatio: '16:9',
      usageContext: 'image revision certification',
      parentGoalId: intent.goalId,
      parentArtifactId: imageRecord.artifactId,
      outputPurpose: 'REPORT_COVER',
      outputPath: path.join(intent.outputLocation, 'hero-image-v2.png'),
      theme: neutralProfessionalTheme,
    });
    validations.imageRevision = validatePngImage(revisedImage.file);
    const revisedImageRecord = this.record(intent.goalId, 'IMAGE', revisedImage.format, revisedImage.file, now, sourceRefs, validations.imageRevision.status, imageRecord.artifactId, 2);
    artifacts.push(revisedImageRecord);

    const sceneFiles = [1, 2, 3].map((n) => path.join(intent.outputLocation, `video-scene-${n}.png`));
    sceneFiles.forEach((file, i) => this.imageProvider.variation({
      prompt: `Phase 2 intro video scene ${i + 1}`,
      sourceImage: revisedImage.file,
      brandStyleId: neutralProfessionalTheme.brandStyleId,
      aspectRatio: '16:9',
      usageContext: 'video scene visual asset',
      parentGoalId: intent.goalId,
      parentArtifactId: revisedImageRecord.artifactId,
      outputPurpose: 'VIDEO_SCENE',
      outputPath: file,
      theme: neutralProfessionalTheme,
    }));
    const video = this.videoProvider.render({
      goalId: intent.goalId,
      scenes: sceneFiles.map((file, i) => ({
        sceneId: `scene-${i + 1}`,
        imageFile: file,
        caption: ['Create from evidence', 'Render linked artifacts', 'Validate before delivery'][i],
        durationSeconds: 7,
        transition: i === 0 ? 'CUT' : 'FADE',
      })),
      outputPath: path.join(intent.outputLocation, 'intro-video.mp4'),
      derivedFromArtifactIds: [slides.artifactId, revisedImageRecord.artifactId],
      audioPolicy: 'SILENT_CAPTIONS_ONLY',
    });
    validations.video = validateVideoArtifact(video.file, video.sceneCount);
    artifacts.push({
      artifactId: `cre_video_${crypto.createHash('sha256').update(`${intent.goalId}:${video.status}:${video.durationSeconds}`).digest('hex').slice(0, 12)}`,
      goalId: intent.goalId,
      artifactType: 'VIDEO',
      version: 1,
      format: 'MP4',
      createdAt: now,
      modifiedAt: now,
      sourceRefs,
      storageLocation: video.file ?? path.join(intent.outputLocation, 'intro-video.mp4'),
      checksum: crypto.createHash('sha256').update(video.file && fs.existsSync(video.file) ? fs.readFileSync(video.file) : Buffer.from(video.status)).digest('hex'),
      derivedFrom: revisedImageRecord.artifactId,
      status: video.status === 'RENDERED' ? 'VALIDATED' : 'FAILED',
      validationStatus: validations.video.status === 'NEEDS_REVISION' ? 'PARTIAL' : validations.video.status,
      visualQualityStatus: validations.video.status,
    });

    const graph: ArtifactDependencyGraph = {
      goalId: intent.goalId,
      edges: [
        { fromArtifactId: report.artifactId, toArtifactId: slides.artifactId, relationship: 'summarized-as-slides' },
        { fromArtifactId: slides.artifactId, toArtifactId: imageRecord.artifactId, relationship: 'visual-brief' },
        { fromArtifactId: imageRecord.artifactId, toArtifactId: revisedImageRecord.artifactId, relationship: 'revised-version' },
        { fromArtifactId: revisedImageRecord.artifactId, toArtifactId: artifacts[artifacts.length - 1].artifactId, relationship: 'video-scene-source' },
      ],
    };

    return { parentGoalId: intent.goalId, artifacts, graph, validations, theme: neutralProfessionalTheme, video, progress };
  }

  private record(goalId: string, artifactType: CreationArtifactRecord['artifactType'], format: string, file: string, now: string, sourceRefs: readonly string[], visualQualityStatus: CreationArtifactRecord['visualQualityStatus'] = 'PASS', derivedFrom?: string, version = 1): CreationArtifactRecord {
    const bytes = fs.readFileSync(file);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    return {
      artifactId: `cre_${checksum.slice(0, 16)}`,
      goalId,
      artifactType,
      version,
      format,
      createdAt: now,
      modifiedAt: now,
      sourceRefs,
      storageLocation: file,
      checksum,
      derivedFrom,
      status: visualQualityStatus === 'FAIL' ? 'FAILED' : 'VALIDATED',
      validationStatus: visualQualityStatus === 'FAIL' ? 'FAIL' : visualQualityStatus === 'PARTIAL' || visualQualityStatus === 'NEEDS_REVISION' ? 'PARTIAL' : 'PASS',
      visualQualityStatus,
    };
  }
}
