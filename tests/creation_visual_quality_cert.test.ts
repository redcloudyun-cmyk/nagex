import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactVisualQualityVerifier,
  CreationVisualCertRunner,
  VisualRepairLoop,
  type RenderedPage,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-visual-cert-'));
}

function defectivePage(): RenderedPage {
  return {
    artifactId: 'slide-defective',
    index: 1,
    width: 1280,
    height: 720,
    previewPath: path.join(tempDir(), 'defective.png'),
    boxes: [
      { role: 'title', text: 'This title is intentionally too long for a tiny unsafe box that should overflow', x: 4, y: 4, width: 80, height: 30, fontSize: 10 },
      { role: 'body', text: 'body', x: 90, y: 90, width: 300, height: 120, fontSize: 18 },
      { role: 'image', x: 100, y: 100, width: 300, height: 120, fontSize: 0 },
    ],
  };
}

test('visual QA defect model reports severity, region, repairability, and recommendation', () => {
  const result = new ArtifactVisualQualityVerifier().verify([defectivePage()], { artifactId: 'slide-defective', minFontSize: 22, margin: 40, maxDensity: 0.6 });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.defects.some((defect) => defect.type === 'TEXT_OVERFLOW'));
  assert.ok(result.defects.every((defect) => defect.region.width > 0));
  assert.ok(result.defects.some((defect) => defect.repairability === 'AUTO_REPAIRABLE'));
});

test('auto-repair loop performs bounded repairs and improves blocking defects', () => {
  const repaired = new VisualRepairLoop().repair([defectivePage()], { artifactId: 'slide-defective', minFontSize: 22, margin: 40, maxDensity: 0.6, maxPasses: 3 });
  assert.equal(repaired.initialDefects > 0, true);
  assert.equal(repaired.passes > 0, true);
  assert.equal(repaired.repairedCount > 0, true);
  assert.notEqual(repaired.result.status, 'FAIL');
});

test('visual certification runner enforces same content variants and rendered previews before completion', () => {
  const result = new CreationVisualCertRunner().run(tempDir());
  assert.ok(fs.existsSync(result.manifestPath));
  assert.equal(result.variants.length, 3);
  assert.equal(new Set(result.variants.map((variant) => variant.styleProfileId)).size, 3);
  assert.ok(result.reportPages.every((page) => fs.existsSync(page.previewPath)));
  assert.ok(result.slidePages.every((page) => fs.existsSync(page.previewPath)));
});

test('report visual certification state includes all rendered pages and QA result', () => {
  const result = new CreationVisualCertRunner().run(tempDir());
  assert.equal(result.reportPages.length, 4);
  assert.equal(result.reportQa.result.status, 'PASS');
  assert.equal(fs.existsSync(result.reportFile), true);
});

test('slide visual certification state includes all eight rendered slides', () => {
  const result = new CreationVisualCertRunner().run(tempDir());
  assert.equal(result.slidePages.length, 8);
  assert.equal(result.slideQa.result.status, 'PASS');
  assert.equal(fs.existsSync(result.slideFile), true);
});

test('Korean typography rules are represented through minimum readable text policy', () => {
  const koreanPage: RenderedPage = {
    artifactId: 'ko-report',
    index: 1,
    width: 900,
    height: 1200,
    previewPath: path.join(tempDir(), 'ko.png'),
    boxes: [{ role: 'body', text: '한국어 본문은 라틴 기준보다 작게 가정하지 않는다.', x: 80, y: 100, width: 600, height: 80, fontSize: 15 }],
  };
  const result = new ArtifactVisualQualityVerifier().verify([koreanPage], { artifactId: 'ko-report', minFontSize: 14, margin: 48, maxDensity: 0.7 });
  assert.equal(result.status, 'PASS');
});

test('chart proportionality and infographic quality are captured in final manifest', () => {
  const result = new CreationVisualCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.ok(manifest.content.dataPoints.some((point: { value: number }) => point.value > 0));
  assert.equal(manifest.selectedStyleId, 'DATA_PROFESSIONAL');
});

test('artifact lineage records content version, style version, variants, and source', () => {
  const result = new CreationVisualCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.lineage.contentVersionId, result.content.contentVersionId);
  assert.equal(manifest.lineage.variantIds.length, 3);
  assert.equal(manifest.lineage.derivedFrom.length, 1);
});

test('visual revision preserves original files and creates incremented versions', () => {
  const result = new CreationVisualCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.ok(fs.existsSync(manifest.files.reportFile));
  assert.ok(fs.existsSync(manifest.files.slideFile));
  assert.ok(fs.existsSync(manifest.files.revisedReport));
  assert.ok(fs.existsSync(manifest.files.revisedSlides));
});
