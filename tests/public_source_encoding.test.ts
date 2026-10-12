// Guards the shipped UI sources against the lossy re-encode that once corrupted public/app.js (commit ef5a4e6): Korean text and glyphs became
// '??' or invalid bytes, and bilingual strings were reduced to ''. Every text file under public/ must be valid UTF-8 and must not contain
// those corruption signatures. (The nullish operator ' ?? ' is legitimate and is not matched.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('public');
const TEXT = new Set(['.js', '.css', '.html', '.json', '.md']);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'assets') out.push(...listFiles(full)); } else if (TEXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

test('every text source under public/ is valid UTF-8', () => {
  const bad: string[] = [];
  for (const file of listFiles(ROOT)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); } catch { bad.push(path.relative(ROOT, file)); }
  }
  assert.deepEqual(bad, [], `files with invalid UTF-8 byte sequences: ${bad.join(', ')}`);
});

test('no public source contains the corruption signatures (glyph/Hangul loss as "??", emptied bilingual literals)', () => {
  const findings: string[] = [];
  for (const file of listFiles(ROOT)) {
    // Only shipped code and visible text matter: HTML comments and comment-only lines of JS/CSS are not user-visible.
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.html')) source = source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      if (/\?\?(?=[A-Za-z0-9가-힣])|'\?\?'|"\?\?"/.test(line)) findings.push(`${path.relative(ROOT, file)}:${index + 1}: "??" in place of a glyph or Korean text`);
      if (/escapeHtml\(''\)|\$\{''\}|^\s*''\s*$/.test(line)) findings.push(`${path.relative(ROOT, file)}:${index + 1}: an empty literal where a bilingual string used to be`);
    });
  }
  assert.deepEqual(findings, [], findings.slice(0, 12).join('\n'));
});
