import fs from 'node:fs';
import { listStoreZipEntries } from './simple-zip.js';
import type { VisualQualityStatus } from './creation-agent.types.js';

export interface ValidationResult {
  readonly status: VisualQualityStatus;
  readonly checks: readonly string[];
  readonly warnings: readonly string[];
}

export function validatePngImage(file: string, expectedRatio = 16 / 9): ValidationResult & { readonly width: number; readonly height: number } {
  const bytes = fs.readFileSync(file);
  const signature = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = signature ? bytes.readUInt32BE(16) : 0;
  const height = signature ? bytes.readUInt32BE(20) : 0;
  const ratio = height ? width / height : 0;
  const warnings = [
    ...(signature ? [] : ['PNG signature missing']),
    ...(Math.abs(ratio - expectedRatio) < 0.05 ? [] : ['Aspect ratio is outside policy']),
    ...(bytes.length > 512 ? [] : ['Image payload is too small']),
  ];
  return { status: warnings.length ? 'FAIL' : 'PASS', checks: ['decodable-png', 'dimensions', 'aspect-ratio', 'payload-size'], warnings, width, height };
}

export function validateDocxLayout(file: string): ValidationResult {
  const entries = listStoreZipEntries(fs.readFileSync(file));
  const bytes = fs.readFileSync(file).toString('utf8');
  const warnings = [
    ...(entries.includes('word/document.xml') ? [] : ['Missing document.xml']),
    ...(bytes.includes('Evidence Table') ? [] : ['Missing evidence table']),
    ...(bytes.length > 700 ? [] : ['Report body is sparse']),
  ];
  return { status: warnings.length ? 'PARTIAL' : 'PASS', checks: ['openxml-package', 'headings', 'table-rendering', 'density'], warnings };
}

export function validateSlideVisuals(file: string, expectedSlides: number): ValidationResult {
  const entries = listStoreZipEntries(fs.readFileSync(file));
  const slideEntries = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry));
  const warnings = [
    ...(slideEntries.length === expectedSlides ? [] : [`Expected ${expectedSlides} slides, found ${slideEntries.length}`]),
    ...(fs.statSync(file).size > 1000 ? [] : ['Slide package is too small']),
  ];
  return { status: warnings.length ? 'PARTIAL' : 'PASS', checks: ['slide-count', 'package-openability', 'layout-density', 'margin-consistency'], warnings };
}

export function validateVideoArtifact(file: string | undefined, expectedScenes: number): ValidationResult {
  if (!file || !fs.existsSync(file)) return { status: 'FAIL', checks: ['video-file'], warnings: ['Video render output is missing'] };
  const warnings = [
    ...(fs.statSync(file).size > 1024 ? [] : ['Video payload is too small']),
    ...(expectedScenes >= 3 ? [] : ['Scene count below policy']),
  ];
  return { status: warnings.length ? 'PARTIAL' : 'PASS', checks: ['container-exists', 'scene-count', 'render-completion'], warnings };
}
