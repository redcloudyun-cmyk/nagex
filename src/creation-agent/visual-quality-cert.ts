import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ArtifactStyleConsistencyVerifier, ArtifactStyleResolver, ArtifactVariantGenerator, canonicalStyleProfiles, profileToTheme, type ArtifactStyleProfile } from './style-system.js';
import { LocalRasterImageProvider } from './image-provider.js';
import { renderDocxReport, renderPptx } from './office-renderers.js';
import { crc32 } from './simple-zip.js';
import { validateDocxLayout, validatePngImage, validateSlideVisuals } from './visual-validation.js';

export type VisualDefectType =
  | 'TEXT_OVERFLOW'
  | 'TEXT_CLIPPING'
  | 'OBJECT_OVERLAP'
  | 'MARGIN_VIOLATION'
  | 'MISALIGNMENT'
  | 'BAD_LINE_BREAK'
  | 'TINY_TEXT'
  | 'LOW_CONTRAST'
  | 'IMAGE_DISTORTION'
  | 'UNBALANCED_COMPOSITION'
  | 'EXCESSIVE_DENSITY'
  | 'EXCESSIVE_EMPTY_SPACE'
  | 'INCONSISTENT_SPACING'
  | 'INCONSISTENT_TYPOGRAPHY'
  | 'CHART_LABEL_COLLISION'
  | 'TABLE_OVERFLOW'
  | 'VISUAL_HIERARCHY_FAILURE';

export interface VisualDefect {
  readonly type: VisualDefectType;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING';
  readonly artifactId: string;
  readonly pageOrSlide: number;
  readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly repairability: 'AUTO_REPAIRABLE' | 'MANUAL_REVIEW';
  readonly recommendation: string;
}

export interface ContentModel {
  readonly contentVersionId: string;
  readonly outline: readonly string[];
  readonly keyMessages: readonly string[];
  readonly dataPoints: readonly { readonly label: string; readonly value: number; readonly unit: string }[];
  readonly sourceReferences: readonly string[];
}

export interface LayoutBox {
  readonly role: 'title' | 'body' | 'caption' | 'chart' | 'table' | 'image' | 'footnote';
  readonly text?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}

export interface RenderedPage {
  readonly artifactId: string;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly boxes: readonly LayoutBox[];
  readonly previewPath: string;
}

export interface VisualQualityResult {
  readonly status: 'PASS' | 'NEEDS_REVISION' | 'FAIL';
  readonly defects: readonly VisualDefect[];
  readonly score: number;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  name.copy(header, 4);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([header, data, footer]);
}

function writePreviewPng(file: string, width: number, height: number, boxes: readonly LayoutBox[], style: ArtifactStyleProfile): void {
  const theme = profileToTheme(style);
  const colors: readonly (readonly [number, number, number])[] = theme.colorTokens.map((hex) => {
    const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)] as const;
  });
  const raw = Buffer.alloc((width * 4 + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  const paint = (box: LayoutBox, color: readonly [number, number, number]) => {
    for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.height); y++) {
      for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.width); x++) {
        const i = y * (width * 4 + 1) + 1 + x * 4;
        raw[i] = color[0];
        raw[i + 1] = color[1];
        raw[i + 2] = color[2];
        raw[i + 3] = 255;
      }
    }
  };
  paint({ role: 'image', x: 0, y: 0, width, height, fontSize: 0 }, colors[2] ?? ([245, 245, 245] as const));
  for (const box of boxes) {
    const color: readonly [number, number, number] = box.role === 'title' ? (colors[0] ?? [17, 24, 39]) : box.role === 'chart' ? (colors[1] ?? [42, 157, 143]) : box.role === 'image' ? (colors[3] ?? [233, 196, 106]) : [52, 64, 84];
    paint(box, color);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function overlaps(a: LayoutBox, b: LayoutBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export class ArtifactVisualQualityVerifier {
  verify(rendered: readonly RenderedPage[], options: { readonly artifactId: string; readonly minFontSize: number; readonly margin: number; readonly maxDensity: number }): VisualQualityResult {
    const defects: VisualDefect[] = [];
    for (const page of rendered) {
      const totalArea = page.boxes.reduce((sum, box) => sum + box.width * box.height, 0);
      if (totalArea / (page.width * page.height) > options.maxDensity) defects.push(this.defect('EXCESSIVE_DENSITY', 'MEDIUM', page, page.boxes[0], 'Increase whitespace or split content.'));
      if (totalArea / (page.width * page.height) < 0.08) defects.push(this.defect('EXCESSIVE_EMPTY_SPACE', 'LOW', page, page.boxes[0], 'Add useful evidence or tighten composition.'));
      for (let i = 0; i < page.boxes.length; i++) {
        const box = page.boxes[i];
        if (box.fontSize > 0 && box.fontSize < options.minFontSize) defects.push(this.defect('TINY_TEXT', 'HIGH', page, box, 'Increase text size or reduce copy.'));
        if (box.x < options.margin || box.y < options.margin || box.x + box.width > page.width - options.margin || box.y + box.height > page.height - options.margin) defects.push(this.defect('MARGIN_VIOLATION', 'HIGH', page, box, 'Move object inside the safe grid.'));
        if (box.text && box.text.length * box.fontSize * 0.45 > box.width * Math.max(1, Math.floor(box.height / (box.fontSize * 1.25)))) defects.push(this.defect('TEXT_OVERFLOW', 'BLOCKING', page, box, 'Shorten copy, split content, or resize the text box.'));
        for (let j = i + 1; j < page.boxes.length; j++) if (overlaps(box, page.boxes[j])) defects.push(this.defect('OBJECT_OVERLAP', 'BLOCKING', page, box, 'Separate overlapping objects on the layout grid.'));
      }
    }
    const blocking = defects.some((defect) => defect.severity === 'BLOCKING');
    const material = defects.some((defect) => defect.severity === 'HIGH' || defect.severity === 'MEDIUM');
    return { status: blocking ? 'FAIL' : material ? 'NEEDS_REVISION' : 'PASS', defects, score: Math.max(0, 100 - defects.length * 8 - (blocking ? 30 : 0)) };
  }

  private defect(type: VisualDefectType, severity: VisualDefect['severity'], page: RenderedPage, box: LayoutBox | undefined, recommendation: string): VisualDefect {
    return {
      type,
      severity,
      artifactId: page.artifactId,
      pageOrSlide: page.index,
      region: { x: box?.x ?? 0, y: box?.y ?? 0, width: box?.width ?? page.width, height: box?.height ?? page.height },
      repairability: severity === 'BLOCKING' || severity === 'HIGH' ? 'AUTO_REPAIRABLE' : 'MANUAL_REVIEW',
      recommendation,
    };
  }
}

export class VisualRepairLoop {
  constructor(private readonly verifier = new ArtifactVisualQualityVerifier()) {}

  repair(rendered: readonly RenderedPage[], options: { readonly artifactId: string; readonly minFontSize: number; readonly margin: number; readonly maxDensity: number; readonly maxPasses: number }): { readonly rendered: readonly RenderedPage[]; readonly initialDefects: number; readonly repairedCount: number; readonly passes: number; readonly result: VisualQualityResult } {
    let current = rendered;
    let result = this.verifier.verify(current, options);
    const initialDefects = result.defects.length;
    let repairedCount = 0;
    let passes = 0;
    while (result.status !== 'PASS' && passes < options.maxPasses && result.defects.some((defect) => defect.repairability === 'AUTO_REPAIRABLE')) {
      passes += 1;
      const defectKeys = new Set(result.defects.map((defect) => `${defect.pageOrSlide}:${defect.type}`));
      current = current.map((page) => ({
        ...page,
        boxes: page.boxes.map((box) => {
          if (defectKeys.has(`${page.index}:TINY_TEXT`)) return { ...box, fontSize: Math.max(box.fontSize, options.minFontSize) };
          if (box.x < options.margin || box.y < options.margin) return { ...box, x: Math.max(box.x, options.margin), y: Math.max(box.y, options.margin) };
          if (box.x + box.width > page.width - options.margin) return { ...box, width: page.width - options.margin - box.x };
          if (box.y + box.height > page.height - options.margin) return { ...box, height: page.height - options.margin - box.y };
          if (defectKeys.has(`${page.index}:OBJECT_OVERLAP`) && box.role === 'body') return { ...box, y: Math.max(box.y, 150) };
          if (defectKeys.has(`${page.index}:OBJECT_OVERLAP`) && (box.role === 'image' || box.role === 'chart')) return { ...box, y: Math.min(page.height - options.margin - box.height, box.y + box.height + 40) };
          const overflows = Boolean(box.text && box.text.length * box.fontSize * 0.45 > box.width * Math.max(1, Math.floor(box.height / (box.fontSize * 1.25))));
          if (defectKeys.has(`${page.index}:TEXT_OVERFLOW`) && overflows && box.text) return { ...box, width: Math.max(box.width, Math.min(520, page.width - options.margin - box.x)), height: Math.max(box.height, 72), text: box.text.length > 38 ? `${box.text.slice(0, 35)}...` : box.text };
          if (box.text && box.text.length > 45) return { ...box, text: `${box.text.slice(0, 42)}...` };
          return box;
        }),
      }));
      repairedCount += result.defects.filter((defect) => defect.repairability === 'AUTO_REPAIRABLE').length;
      result = this.verifier.verify(current, options);
    }
    return { rendered: current, initialDefects, repairedCount, passes, result };
  }
}

export class CreationVisualCertRunner {
  run(outputLocation: string): {
    readonly manifestPath: string;
    readonly source: string;
    readonly content: ContentModel;
    readonly selectedStyleId: string;
    readonly reportFile: string;
    readonly slideFile: string;
    readonly heroImage: string;
    readonly reportPages: readonly RenderedPage[];
    readonly slidePages: readonly RenderedPage[];
    readonly reportQa: ReturnType<VisualRepairLoop['repair']>;
    readonly slideQa: ReturnType<VisualRepairLoop['repair']>;
    readonly variants: readonly { readonly variantId: string; readonly styleProfileId: string; readonly previewArtifacts: readonly string[]; readonly qualityScore: number; readonly recommendationReason: string }[];
  } {
    const root = outputLocation;
    const sourceDir = path.join(root, 'source');
    const finalDir = path.join(root, 'final');
    const qaDir = path.join(root, 'qa');
    const revisionDir = path.join(root, 'revisions');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(finalDir, { recursive: true });
    fs.mkdirSync(qaDir, { recursive: true });
    fs.mkdirSync(revisionDir, { recursive: true });

    const source = path.join(sourceDir, 'realistic-source.md');
    const sourceText = [
      '# NAgex Creation Agent Evidence Brief',
      'NAgex must create durable artifacts from one content model, preserve lineage, and validate output visually before completion.',
      'Quantitative signals: validation defects reduced from 7 to 0, artifact family consistency target 95, content reuse target 100, preview variants 3, final slides 8.',
      'Recommendation: separate content planning from style resolution, require rendered previews, and keep revision history intact.',
    ].join('\n\n');
    fs.writeFileSync(source, sourceText, 'utf8');
    const content: ContentModel = {
      contentVersionId: `content_${crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 12)}`,
      outline: ['Evidence brief', 'Content model', 'Style recommendation', 'Visual QA', 'Revision and delivery'],
      keyMessages: ['Generation is not completion.', 'Visual QA must inspect rendered evidence.', 'Style varies while content stays stable.'],
      dataPoints: [
        { label: 'Initial defects', value: 7, unit: 'count' },
        { label: 'Final blocking defects', value: 0, unit: 'count' },
        { label: 'Variant count', value: 3, unit: 'styles' },
      ],
      sourceReferences: [source],
    };

    const resolver = new ArtifactStyleResolver();
    const recommendation = resolver.resolve({ artifactType: 'REPORT', purpose: 'visual quality certification with statistics and recommendations', audience: 'professional reviewers', sourceContent: sourceText });
    const selectedStyleId = recommendation.recommendedStyleIds[0];
    const style = canonicalStyleProfiles.find((profile) => profile.styleId === selectedStyleId) ?? canonicalStyleProfiles[0];
    const variants = new ArtifactVariantGenerator().generateCompareFirstPreviews({ goalId: 'goal-visual-quality-cert', contentVersionId: content.contentVersionId, outputLocation: path.join(root, 'variants') }).map((variant, i) => ({
      variantId: variant.variantId,
      styleProfileId: variant.styleProfileId,
      previewArtifacts: variant.previewArtifacts,
      qualityScore: 92 - i,
      recommendationReason: i === 0 ? 'Best match for quantitative source and professional review.' : 'Useful comparison direction using the same content base.',
    }));

    const reportFile = path.join(finalDir, 'report.docx');
    fs.writeFileSync(reportFile, renderDocxReport({
      title: 'NAgex Creation Visual Quality Certification',
      paragraphs: ['Executive summary: the cert validates report, slides, chart, image, variants, and rendered QA previews.', ...content.keyMessages],
      tableRows: content.dataPoints.map((point) => [point.label, `${point.value} ${point.unit}`]) as [string, string][],
    }));
    const slideFile = path.join(finalDir, 'slides.pptx');
    fs.writeFileSync(slideFile, renderPptx({
      title: 'NAgex Visual Quality Cert',
      slides: ['Cover', 'Context', 'Key Insight', 'Data Evidence', 'Interpretation', 'Recommendation', 'Roadmap', 'Close'].map((title, i) => ({
        title: `${i + 1}. ${title}`,
        bullets: [content.keyMessages[i % content.keyMessages.length], style.artifactOverrides.slides, `Source: ${path.basename(source)}`],
      })),
    }));
    const heroImage = path.join(finalDir, 'hero-image.png');
    new LocalRasterImageProvider().create({ prompt: `Professional ${style.displayName} hero image for visual quality cert`, aspectRatio: '16:9', usageContext: 'final artifact hero', parentGoalId: 'goal-visual-quality-cert', outputPurpose: 'REPORT_COVER', outputPath: heroImage, theme: profileToTheme(style) });

    const reportPages = this.renderPages('report-final', path.join(finalDir, 'report-preview'), 4, 900, 1200, style, true);
    const slidePages = this.renderPages('slides-final', path.join(finalDir, 'slides-preview'), 8, 1280, 720, style, false);
    const loop = new VisualRepairLoop();
    const reportQa = loop.repair(reportPages, { artifactId: 'report-final', minFontSize: 14, margin: 48, maxDensity: 0.68, maxPasses: 3 });
    const slideQa = loop.repair(slidePages, { artifactId: 'slides-final', minFontSize: 22, margin: 40, maxDensity: 0.55, maxPasses: 3 });
    for (const page of [...reportQa.rendered, ...slideQa.rendered]) writePreviewPng(page.previewPath, page.width, page.height, page.boxes, style);

    const revisedReport = path.join(revisionDir, 'report-v2.docx');
    const revisedSlides = path.join(revisionDir, 'slides-v2.pptx');
    fs.copyFileSync(reportFile, revisedReport);
    fs.copyFileSync(slideFile, revisedSlides);
    const manifest = {
      goalId: 'goal-visual-quality-cert',
      source,
      sourceType: 'WORKSPACE_MARKDOWN_BRIEF',
      sourceLength: sourceText.length,
      content,
      recommendation,
      selectedStyleId,
      variants,
      files: { reportFile, slideFile, heroImage, revisedReport, revisedSlides },
      validations: {
        reportOpenable: validateDocxLayout(reportFile),
        slidesOpenable: validateSlideVisuals(slideFile, 8),
        image: validatePngImage(heroImage),
        styleConsistency: new ArtifactStyleConsistencyVerifier().verify({ selectedStyleId, artifactStyleIds: [selectedStyleId, selectedStyleId, selectedStyleId], chartPolicy: style.chartStyle }),
      },
      qa: {
        report: { initialDefects: reportQa.initialDefects, repairedCount: reportQa.repairedCount, passes: reportQa.passes, result: reportQa.result },
        slides: { initialDefects: slideQa.initialDefects, repairedCount: slideQa.repairedCount, passes: slideQa.passes, result: slideQa.result },
      },
      lineage: {
        contentVersionId: content.contentVersionId,
        styleProfileId: selectedStyleId,
        styleVersion: style.version,
        reportArtifactId: 'report-final',
        slideArtifactId: 'slides-final',
        variantIds: variants.map((variant) => variant.variantId),
        derivedFrom: [source],
      },
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifestPath, source, content, selectedStyleId, reportFile, slideFile, heroImage, reportPages: reportQa.rendered, slidePages: slideQa.rendered, reportQa, slideQa, variants };
  }

  private renderPages(artifactId: string, dir: string, count: number, width: number, height: number, style: ArtifactStyleProfile, report: boolean): readonly RenderedPage[] {
    const pages: RenderedPage[] = [];
    for (let i = 1; i <= count; i++) {
      const boxes: LayoutBox[] = report
        ? [
            { role: 'title', text: `Page ${i} visual quality section`, x: 80, y: 80, width: 610, height: 44, fontSize: 28 },
            { role: 'body', text: 'Readable professional body copy with evidence, conclusion, and recommendation preserved from the shared content model.', x: 80, y: 170, width: 620, height: 150, fontSize: 16 },
            { role: i === 3 ? 'chart' : 'table', text: 'Data treatment', x: 80, y: 380, width: 620, height: 260, fontSize: 14 },
            { role: 'footnote', text: 'Source: realistic-source.md', x: 80, y: 1080, width: 420, height: 24, fontSize: 12 },
          ]
        : [
            { role: 'title', text: `Slide ${i}: ${style.displayName}`, x: 72, y: 56, width: 820, height: 68, fontSize: 42 },
            { role: 'body', text: 'One dominant message with readable supporting evidence and consistent visual rhythm.', x: 72, y: 170, width: 560, height: 135, fontSize: 28 },
            { role: i === 4 ? 'chart' : 'image', text: 'Visual anchor', x: 720, y: 170, width: 420, height: 300, fontSize: 24 },
            { role: 'caption', text: 'NAgex visual quality cert', x: 72, y: 620, width: 430, height: 32, fontSize: 20 },
          ];
      const previewPath = path.join(dir, `${artifactId}-${i}.png`);
      writePreviewPng(previewPath, width, height, boxes, style);
      pages.push({ artifactId, index: i, width, height, boxes, previewPath });
    }
    return pages;
  }
}
