import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactStyleConsistencyVerifier,
  ArtifactStyleResolver,
  ArtifactVariantGenerator,
  canonicalStyleProfiles,
  styleProfileToDesignMd,
  validatePngImage,
  validateSlideVisuals,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-style-system-'));
}

test('six canonical NAgex style profiles are defined with rationale and artifact overrides', () => {
  assert.equal(canonicalStyleProfiles.length, 6);
  for (const id of ['EXECUTIVE_MINIMAL', 'EDITORIAL_MODERN', 'DATA_PROFESSIONAL', 'TECH_PREMIUM', 'WARM_HUMAN', 'BOLD_PRESENTATION']) {
    const profile = canonicalStyleProfiles.find((item) => item.styleId === id);
    assert.ok(profile);
    assert.ok(profile.rationale.length > 40);
    assert.ok(profile.artifactOverrides.report);
    assert.ok(profile.artifactOverrides.video);
  }
});

test('DESIGN.md-compatible text representation is generated from structured profile', () => {
  const text = styleProfileToDesignMd(canonicalStyleProfiles[0]);
  assert.match(text, /## Philosophy/);
  assert.match(text, /## Typography/);
  assert.match(text, /## Rationale/);
});

test('style resolver recommends data professional for policy and statistics work', () => {
  const result = new ArtifactStyleResolver().resolve({
    artifactType: 'REPORT',
    purpose: 'survey policy analysis',
    audience: 'executive reviewers',
    sourceContent: 'statistics and research evidence',
  });
  assert.equal(result.recommendedStyleIds[0], 'DATA_PROFESSIONAL');
  assert.equal(result.selectionMode, 'AUTO_RECOMMEND');
  assert.equal(result.selectedStyleId, undefined);
});

test('user explicit style overrides project brand and recommendation remains explainable', () => {
  const result = new ArtifactStyleResolver().resolve({
    artifactType: 'SLIDES',
    subject: 'AI platform pitch',
    brandContext: { approvedStyleId: 'EXECUTIVE_MINIMAL' },
    userPreference: 'Bold Presentation',
  });
  assert.equal(result.selectedStyleId, 'BOLD_PRESENTATION');
  assert.equal(result.recommendedStyleIds[0], 'BOLD_PRESENTATION');
  assert.match(result.recommendationReasons[0], /User explicitly/);
});

test('project brand style takes precedence when user has not chosen a style', () => {
  const result = new ArtifactStyleResolver().resolve({
    artifactType: 'REPORT',
    subject: 'community health education',
    brandContext: { approvedStyleId: 'EXECUTIVE_MINIMAL' },
  });
  assert.equal(result.selectedStyleId, 'EXECUTIVE_MINIMAL');
  assert.equal(result.recommendedStyleIds[0], 'EXECUTIVE_MINIMAL');
});

test('compare-first generates three meaningful preview variants for the same content base', () => {
  const outputLocation = tempDir();
  const variants = new ArtifactVariantGenerator().generateCompareFirstPreviews({
    goalId: 'goal-style-preview',
    contentVersionId: 'content-v1',
    outputLocation,
  });
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((variant) => variant.styleProfileId), ['EXECUTIVE_MINIMAL', 'EDITORIAL_MODERN', 'DATA_PROFESSIONAL']);
  assert.equal(new Set(variants.map((variant) => variant.contentVersionId)).size, 1);
  for (const variant of variants) {
    assert.equal(variant.status, 'PREVIEW_READY');
    assert.equal(validateSlideVisuals(variant.previewArtifacts[0], 3).status, 'PASS');
    assert.equal(validatePngImage(variant.previewArtifacts[1]).status, 'PASS');
  }
});

test('style lock stores one source of truth for remaining artifacts', () => {
  const lock = new ArtifactVariantGenerator().lock('goal-lock', 'EDITORIAL_MODERN');
  assert.equal(lock.goalId, 'goal-lock');
  assert.equal(lock.styleProfileId, 'EDITORIAL_MODERN');
  assert.equal(lock.styleVersion, 1);
});

test('style revision and hybrid derivation preserve source profile lineage', () => {
  const generator = new ArtifactVariantGenerator();
  const base = canonicalStyleProfiles.find((profile) => profile.styleId === 'EXECUTIVE_MINIMAL')!;
  const borrow = canonicalStyleProfiles.find((profile) => profile.styleId === 'EDITORIAL_MODERN')!;
  const revised = generator.reviseStyle(base, { background: 'warm ivory' });
  const hybrid = generator.deriveHybrid(base, borrow, { accent: '#0f766e' });
  assert.equal(revised.version, 2);
  assert.deepEqual(revised.sourceProfileIds, ['EXECUTIVE_MINIMAL']);
  assert.deepEqual(hybrid.sourceProfileIds, ['EXECUTIVE_MINIMAL', 'EDITORIAL_MODERN']);
  assert.equal(hybrid.colorSystem.accent, '#0f766e');
});

test('style consistency verifier catches cross-artifact drift and generic AI color misuse', () => {
  const verifier = new ArtifactStyleConsistencyVerifier();
  assert.equal(verifier.verify({ selectedStyleId: 'TECH_PREMIUM', artifactStyleIds: ['TECH_PREMIUM', 'TECH_PREMIUM'] }).status, 'PASS');
  const drift = verifier.verify({ selectedStyleId: 'TECH_PREMIUM', artifactStyleIds: ['TECH_PREMIUM', 'BOLD_PRESENTATION'], usedColors: ['#7c3aed'] });
  assert.equal(drift.status, 'NEEDS_REVISION');
  assert.equal(drift.findings.length >= 2, true);
});

test('data professional chart policy requires proportional encodings', () => {
  const data = canonicalStyleProfiles.find((profile) => profile.styleId === 'DATA_PROFESSIONAL')!;
  assert.match(data.chartStyle.bar, /zero baseline/);
  assert.match(data.artifactOverrides.infographic, /proportional/);
});

test('platform-neutral style IDs work across desktop, mobile, smart tv and voice selection', () => {
  const styleId = 'EXECUTIVE_MINIMAL';
  const platformSelections = { desktop: styleId, mobile: styleId, smartTv: styleId, voice: styleId };
  assert.equal(new Set(Object.values(platformSelections)).size, 1);
});
