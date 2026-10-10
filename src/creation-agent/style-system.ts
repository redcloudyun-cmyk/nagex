import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LocalRasterImageProvider } from './image-provider.js';
import { renderPptx } from './office-renderers.js';
import type { ArtifactVisualTheme, CreationArtifactType } from './creation-agent.types.js';

export type StyleSelectionMode = 'AUTO_RECOMMEND' | 'PICK_FIRST' | 'COMPARE_FIRST';
export type StyleProfileId = 'EXECUTIVE_MINIMAL' | 'EDITORIAL_MODERN' | 'DATA_PROFESSIONAL' | 'TECH_PREMIUM' | 'WARM_HUMAN' | 'BOLD_PRESENTATION' | 'CUSTOM_STYLE';

export interface ArtifactStyleProfile {
  readonly styleId: StyleProfileId | string;
  readonly version: number;
  readonly displayName: string;
  readonly shortDescription: string;
  readonly designPhilosophy: string;
  readonly emotionalTone: readonly string[];
  readonly bestFor: readonly string[];
  readonly avoidFor: readonly string[];
  readonly typography: Record<string, string>;
  readonly colorSystem: Record<string, string>;
  readonly spacingSystem: Record<string, string>;
  readonly layoutPrinciples: readonly string[];
  readonly density: 'LOW' | 'BALANCED' | 'HIGH';
  readonly radiusPolicy: string;
  readonly borderPolicy: string;
  readonly shadowPolicy: string;
  readonly elevationPolicy: string;
  readonly imageDirection: string;
  readonly illustrationDirection: string;
  readonly iconDirection: string;
  readonly chartStyle: Record<string, string>;
  readonly tableStyle: string;
  readonly motionPolicy: string;
  readonly componentLanguage: string;
  readonly doRules: readonly string[];
  readonly dontRules: readonly string[];
  readonly rationale: string;
  readonly artifactOverrides: Record<'report' | 'slides' | 'image' | 'video' | 'infographic', string>;
  readonly sourceProfileIds?: readonly string[];
  readonly customOverrides?: Record<string, string>;
}

export interface StyleResolutionInput {
  readonly artifactType: CreationArtifactType;
  readonly purpose?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly brandContext?: { readonly approvedStyleId?: string; readonly requiredColorRole?: string };
  readonly sourceContent?: string;
  readonly userPreference?: string;
  readonly desiredTone?: string;
  readonly mode?: StyleSelectionMode;
}

export interface StyleResolution {
  readonly recommendedStyleIds: readonly string[];
  readonly recommendationReasons: readonly string[];
  readonly confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly selectedStyleId?: string;
  readonly selectionMode: StyleSelectionMode;
}

export interface ArtifactVariant {
  readonly variantId: string;
  readonly goalId: string;
  readonly artifactId: string;
  readonly styleProfileId: string;
  readonly contentVersionId: string;
  readonly visualThemeVersion: number;
  readonly previewArtifacts: readonly string[];
  readonly createdAt: string;
  readonly status: 'PREVIEW_READY' | 'FAILED';
}

export interface StyleLock {
  readonly goalId: string;
  readonly styleProfileId: string;
  readonly lockedAt: string;
  readonly styleVersion: number;
}

function profile(styleId: StyleProfileId, displayName: string, shortDescription: string, tone: readonly string[], bestFor: readonly string[], avoidFor: readonly string[], overrides: ArtifactStyleProfile['artifactOverrides'], chart: Record<string, string>): ArtifactStyleProfile {
  return {
    styleId,
    version: 1,
    displayName,
    shortDescription,
    designPhilosophy: `${displayName} separates content authority from visual restraint and applies the same design logic across artifacts.`,
    emotionalTone: tone,
    bestFor,
    avoidFor,
    typography: {
      display: 'large, high-contrast, disciplined line length',
      title: 'clear hierarchy with restrained tracking',
      heading1: 'strong section marker',
      heading2: 'compact secondary hierarchy',
      body: 'readable, moderate line height, no tiny text',
      caption: 'quiet and legible',
      dataLabel: 'precise numeric labels',
      footnote: 'visible source line, never hidden',
    },
    colorSystem: { background: '#f7f8f6', foreground: '#111827', accent: '#2a9d8f', support: '#e9c46a', danger: '#b42318' },
    spacingSystem: { pageMargin: 'generous', slideMargin: 'consistent', grid: '8pt-based', rhythm: 'content-led' },
    layoutPrinciples: ['clear hierarchy', 'aligned grids', 'purposeful negative space', 'no decorative clutter'],
    density: styleId === 'DATA_PROFESSIONAL' ? 'HIGH' : styleId === 'BOLD_PRESENTATION' ? 'LOW' : 'BALANCED',
    radiusPolicy: 'subtle radius only when it clarifies grouping',
    borderPolicy: 'thin dividers before heavy boxes',
    shadowPolicy: 'minimal shadows, never decoration-first',
    elevationPolicy: 'semantic layering only',
    imageDirection: tone.join(', '),
    illustrationDirection: 'restrained, adult, non-childish',
    iconDirection: 'few icons, meaningful only',
    chartStyle: chart,
    tableStyle: 'structured rows, visible headers, source line, no template striping unless useful',
    motionPolicy: 'motion supports pacing and does not distract from message',
    componentLanguage: 'professional cards, tables, captions, dividers, and preview frames',
    doRules: ['preserve content semantics', 'use style-specific typography', 'verify cross-artifact consistency'],
    dontRules: ['generic purple/blue gradient everywhere', 'excessive glassmorphism', 'random decorative blobs', 'meaningless icons', 'template-like repetition'],
    rationale: `${displayName} is defined with WHAT, WHERE, and WHY so the agent can recommend, apply, and revise style without conflating style with content reasoning.`,
    artifactOverrides: overrides,
  };
}

export const canonicalStyleProfiles: readonly ArtifactStyleProfile[] = [
  profile('EXECUTIVE_MINIMAL', 'Executive Minimal', 'Calm, premium, precise, restrained, high trust.', ['calm', 'premium', 'precise'], ['executive reports', 'board decks', 'policy reports', 'professional proposals'], ['cartoon styling', 'busy layouts'], { report: 'restrained headings, wider margins, subtle tables', slides: 'large title, one strong message, high whitespace', image: 'controlled composition and clean background', video: 'calm transitions and restrained captions', infographic: 'minimal numeric hierarchy' }, { bar: 'thin axis, direct labels', line: 'few series, clear comparison', area: 'only for accumulated trend', scatter: 'annotation-led', pie: 'avoid unless under five categories', annotation: 'visible but restrained', sourceLine: 'always present' }),
  profile('EDITORIAL_MODERN', 'Editorial Modern', 'Editorial, confident, visual, narrative-driven, contemporary.', ['editorial', 'confident', 'visual'], ['thought leadership', 'research stories', 'brand narratives'], ['dashboard density', 'tiny text'], { report: 'strong section openers and pacing', slides: 'asymmetric but controlled story slides', image: 'strong editorial hero imagery', video: 'chapter pacing and visual rhythm', infographic: 'narrative callouts around evidence' }, { bar: 'story-highlighted bars', line: 'narrative trend emphasis', area: 'soft editorial support', scatter: 'selective labeled points', pie: 'rare and simple', annotation: 'editorial callouts', sourceLine: 'clean bottom note' }),
  profile('DATA_PROFESSIONAL', 'Data Professional', 'Analytical, structured, evidence-first, precise, credible.', ['analytical', 'structured', 'credible'], ['research', 'statistics', 'policy', 'business intelligence'], ['decorative charts', '3D graphs', 'chart junk'], { report: 'chart-first pages, disciplined tables', slides: 'numeric hierarchy and source visibility', image: 'data-aware visual metaphors only', video: 'clear captioned evidence beats', infographic: 'proportional encodings required' }, { bar: 'zero baseline for quantities', line: 'consistent scale and labels', area: 'avoid unless cumulative', scatter: 'show axes and units', pie: 'avoid for comparisons', annotation: 'explain the important number', sourceLine: 'mandatory' }),
  profile('TECH_PREMIUM', 'Tech Premium', 'Advanced, precise, modern, AI-native, controlled futuristic.', ['advanced', 'precise', 'modern'], ['AI', 'SaaS', 'technology', 'platform architecture'], ['generic purple AI gradients', 'cyberpunk excess'], { report: 'clean diagrams and technical hierarchy', slides: 'structured grids with restrained luminous accents', image: 'precise product/editorial lighting', video: 'controlled futuristic pacing', infographic: 'architecture-first diagrams' }, { bar: 'dark-compatible palette', line: 'precise highlight line', area: 'subtle depth only', scatter: 'technical labels', pie: 'avoid', annotation: 'diagram-style tags', sourceLine: 'quiet but visible' }),
  profile('WARM_HUMAN', 'Warm Human', 'Approachable, human, calm, empathetic, story-focused.', ['approachable', 'human', 'calm'], ['education', 'health communication', 'community', 'public-facing explanation'], ['cute sticker aesthetics', 'low-authority typography'], { report: 'comfortable line length and gentle hierarchy', slides: 'human story pacing', image: 'natural documentary/editorial warmth', video: 'gentle transitions and readable captions', infographic: 'simple proportional visuals with plain language' }, { bar: 'warm accent, direct values', line: 'gentle but precise', area: 'soft context', scatter: 'avoid overplotting', pie: 'only for simple parts of whole', annotation: 'plain-language note', sourceLine: 'human-readable' }),
  profile('BOLD_PRESENTATION', 'Bold Presentation', 'High impact, speaker-led, confident, dramatic, minimal text.', ['high impact', 'confident', 'dramatic'], ['keynotes', 'pitch decks', 'launch presentations'], ['paragraph slides', 'dense tables'], { report: 'not primary, use concise executive pages', slides: 'one idea per slide, large statement typography', image: 'strong visual anchors', video: 'strong cuts and large statements', infographic: 'few numbers, high contrast' }, { bar: 'large highlights only', line: 'one message trend', area: 'avoid', scatter: 'avoid unless central story', pie: 'avoid', annotation: 'big takeaway labels', sourceLine: 'small but present' }),
];

export function styleProfileToDesignMd(profile: ArtifactStyleProfile): string {
  return [
    `# NAgex Artifact Style - ${profile.displayName}`,
    '## Philosophy',
    profile.designPhilosophy,
    '## Typography',
    Object.entries(profile.typography).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    '## Color',
    Object.entries(profile.colorSystem).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    '## Spacing',
    Object.entries(profile.spacingSystem).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    '## Layout',
    profile.layoutPrinciples.map((rule) => `- ${rule}`).join('\n'),
    '## Imagery',
    profile.imageDirection,
    '## Charts',
    Object.entries(profile.chartStyle).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    '## Motion',
    profile.motionPolicy,
    '## Do',
    profile.doRules.map((rule) => `- ${rule}`).join('\n'),
    "## Don't",
    profile.dontRules.map((rule) => `- ${rule}`).join('\n'),
    '## Rationale',
    profile.rationale,
  ].join('\n\n');
}

export class ArtifactStyleResolver {
  resolve(input: StyleResolutionInput): StyleResolution {
    const text = `${input.purpose ?? ''} ${input.subject ?? ''} ${input.sourceContent ?? ''} ${input.desiredTone ?? ''}`.toLowerCase();
    const user = input.userPreference?.toUpperCase().replace(/\s+/g, '_');
    const explicit = canonicalStyleProfiles.find((style) => style.styleId === user || style.displayName.toUpperCase().replace(/\s+/g, '_') === user);
    const brand = input.brandContext?.approvedStyleId;
    const recommendations = text.match(/survey|statistics|policy|data|analysis|research/) ? ['DATA_PROFESSIONAL', 'EXECUTIVE_MINIMAL'] : text.match(/ai|saas|technology|platform/) ? ['TECH_PREMIUM', 'BOLD_PRESENTATION'] : text.match(/human|health|community|education/) ? ['WARM_HUMAN', 'EDITORIAL_MODERN'] : ['EXECUTIVE_MINIMAL', 'EDITORIAL_MODERN'];
    const selectedStyleId = explicit?.styleId ?? brand ?? undefined;
    return {
      recommendedStyleIds: selectedStyleId ? [selectedStyleId, ...recommendations.filter((id) => id !== selectedStyleId)] : recommendations,
      recommendationReasons: [
        explicit ? 'User explicitly selected this style.' : brand ? 'Project brand style takes precedence over generic recommendations.' : 'Recommended from artifact purpose, audience, subject, and source content.',
        `Primary evidence: ${recommendations[0]} matches the requested content shape.`,
      ],
      confidence: text.length > 20 || explicit || brand ? 'HIGH' : 'MEDIUM',
      selectedStyleId,
      selectionMode: input.mode ?? 'AUTO_RECOMMEND',
    };
  }
}

export function profileToTheme(profile: ArtifactStyleProfile): ArtifactVisualTheme {
  return {
    themeId: `${profile.styleId.toLowerCase()}-theme-v${profile.version}`,
    brandStyleId: String(profile.styleId),
    fontPolicy: `${profile.typography.display}; ${profile.typography.body}`,
    colorTokens: [profile.colorSystem.foreground, profile.colorSystem.accent, profile.colorSystem.background, profile.colorSystem.support],
    spacingScale: [8, 12, 16, 24, 32, 48],
    cornerRadiusPolicy: profile.radiusPolicy.includes('subtle') ? 'SUBTLE' : 'NONE',
    imageStyle: profile.imageDirection,
    chartStyle: Object.values(profile.chartStyle).join('; '),
    density: profile.density === 'HIGH' ? 'COMPACT' : profile.density === 'LOW' ? 'AIRY' : 'BALANCED',
    tone: profile.emotionalTone.join(', '),
  };
}

export class ArtifactVariantGenerator {
  private readonly imageProvider = new LocalRasterImageProvider();

  generateCompareFirstPreviews(input: { readonly goalId: string; readonly contentVersionId: string; readonly outputLocation: string; readonly styleIds?: readonly string[] }): readonly ArtifactVariant[] {
    fs.mkdirSync(input.outputLocation, { recursive: true });
    const styles = (input.styleIds ?? ['EXECUTIVE_MINIMAL', 'EDITORIAL_MODERN', 'DATA_PROFESSIONAL']).map((id) => canonicalStyleProfiles.find((style) => style.styleId === id)).filter((style): style is ArtifactStyleProfile => Boolean(style));
    return styles.map((style, index) => {
      const prefix = `variant-${String.fromCharCode(97 + index)}-${String(style.styleId).toLowerCase()}`;
      const deck = path.join(input.outputLocation, `${prefix}-preview.pptx`);
      fs.writeFileSync(deck, renderPptx({
        title: `${style.displayName} Preview`,
        slides: [
          { title: `${style.displayName}: Cover`, bullets: [style.shortDescription, style.emotionalTone.join(' / ')] },
          { title: 'Representative Content', bullets: [style.artifactOverrides.slides, style.layoutPrinciples[0]] },
          { title: 'Data / Visual Treatment', bullets: [style.chartStyle.bar, style.tableStyle] },
        ],
      }));
      const image = path.join(input.outputLocation, `${prefix}-hero.png`);
      this.imageProvider.create({
        prompt: `${style.displayName}: ${style.imageDirection}. ${style.rationale}`,
        aspectRatio: '16:9',
        usageContext: 'style comparison preview',
        parentGoalId: input.goalId,
        outputPurpose: 'SLIDE_HERO',
        outputPath: image,
        theme: profileToTheme(style),
      });
      const artifactId = `style_${crypto.createHash('sha256').update(`${input.goalId}:${style.styleId}:${input.contentVersionId}`).digest('hex').slice(0, 12)}`;
      return {
        variantId: `variant_${String.fromCharCode(65 + index)}`,
        goalId: input.goalId,
        artifactId,
        styleProfileId: style.styleId,
        contentVersionId: input.contentVersionId,
        visualThemeVersion: style.version,
        previewArtifacts: [deck, image],
        createdAt: new Date().toISOString(),
        status: 'PREVIEW_READY',
      };
    });
  }

  lock(goalId: string, styleProfileId: string): StyleLock {
    const style = canonicalStyleProfiles.find((profile) => profile.styleId === styleProfileId);
    return { goalId, styleProfileId, lockedAt: new Date().toISOString(), styleVersion: style?.version ?? 1 };
  }

  reviseStyle(base: ArtifactStyleProfile, overrides: Record<string, string>): ArtifactStyleProfile {
    return { ...base, styleId: `${base.styleId}_DERIVED`, version: base.version + 1, sourceProfileIds: [base.styleId], customOverrides: overrides };
  }

  deriveHybrid(base: ArtifactStyleProfile, borrow: ArtifactStyleProfile, custom: Record<string, string>): ArtifactStyleProfile {
    return {
      ...base,
      styleId: `${base.styleId}_HYBRID_${borrow.styleId}`,
      version: base.version + 1,
      typography: { ...base.typography, display: borrow.typography.display },
      colorSystem: { ...base.colorSystem, ...custom },
      sourceProfileIds: [base.styleId, borrow.styleId],
      customOverrides: custom,
    };
  }
}

export class ArtifactStyleConsistencyVerifier {
  verify(input: { readonly selectedStyleId: string; readonly artifactStyleIds: readonly string[]; readonly usedColors?: readonly string[]; readonly chartPolicy?: Record<string, string> }): { readonly status: 'PASS' | 'NEEDS_REVISION' | 'FAIL'; readonly findings: readonly string[] } {
    const findings = [
      ...(input.artifactStyleIds.every((id) => id === input.selectedStyleId) ? [] : ['Cross-artifact style IDs diverge']),
      ...((input.usedColors ?? []).some((color) => /purple|#7c3aed|#6366f1/i.test(color)) ? ['Generic AI purple dominance detected'] : []),
      ...(input.chartPolicy?.bar?.includes('zero baseline') || input.selectedStyleId !== 'DATA_PROFESSIONAL' ? [] : ['Data Professional bar chart policy must require zero baseline']),
    ];
    return { status: findings.length ? 'NEEDS_REVISION' : 'PASS', findings };
  }
}
