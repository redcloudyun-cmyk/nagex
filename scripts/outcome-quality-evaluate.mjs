#!/usr/bin/env node
// Judges the files an Outcome Quality run produced: for every <id>.expect.json in a directory, the file it names is evaluated against what the person gave, together with what real Word / PowerPoint
// measured when it opened the file (render/<id>/facts.json, from scripts/office-render.ps1 - optional: without it those checks are NOT_RUN and the verdict is PARTIAL).
//
//   node scripts/outcome-quality-evaluate.mjs <dir>        (after `npm run build`)
//
// Writes <dir>/report.json and <dir>/report.md and prints one line per file. It states TECHNICAL and QUALITY (automated) - never a QUALITY_PASS from the existence of a file, and never a claim that
// the prose or the design is good: that needs a human reader, and the report says so.
import fs from 'node:fs';
import path from 'node:path';
import { evaluateDocx, evaluatePptx } from '../dist/src/creation/quality/outcome-quality.js';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('usage: node scripts/outcome-quality-evaluate.mjs <dir>'); process.exit(2); }
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

const reports = [];
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.expect.json')).sort()) {
  const expect = readJson(path.join(dir, name));
  if (!expect.file || !fs.existsSync(path.join(dir, expect.file))) {
    reports.push({ id: expect.id, file: expect.file ?? null, artifact: expect.kind, technical: 'FAIL', quality: 'FAIL', checks: [{ id: 'FILE_PRODUCED', kind: 'TECHNICAL', status: 'FAIL', detail: 'no file was produced' }], stats: {} });
    continue;
  }
  const bytes = fs.readFileSync(path.join(dir, expect.file));
  const factsPath = path.join(dir, 'render', expect.id, 'facts.json');
  const office = fs.existsSync(factsPath) ? readJson(factsPath) : undefined;
  const expectation = { corpus: expect.corpus, requiredFacts: expect.requiredFacts, charts: expect.charts, minPictures: expect.minPictures, minCharts: expect.minCharts, pages: expect.pages };
  const report = expect.kind === 'DOCX' ? evaluateDocx(bytes, expectation, office) : evaluatePptx(bytes, expectation, office);
  reports.push({ id: expect.id, file: expect.file, bytes: bytes.length, measuredBy: office?.renderedBy ?? null, ...report });
}

const bad = (r) => r.checks.filter((c) => c.status === 'FAIL');
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), reports }, null, 2));
const md = [
  '# Outcome Quality - automated evaluation', '',
  'TECHNICAL = the file is valid and (when measured) opens in the real application. QUALITY = automated checks of structure, accuracy, layout, accessibility and editability. Neither says the prose or the design is good: that is human review.', '',
  '| File | Measured by | TECHNICAL | QUALITY | Checks (pass / fail / not run) |', '|---|---|---|---|---|',
  ...reports.map((r) => `| ${r.id} (${r.file ?? 'none'}) | ${r.measuredBy ?? 'file only'} | ${r.technical} | ${r.quality} | ${r.checks.filter((c) => c.status === 'PASS').length} / ${bad(r).length} / ${r.checks.filter((c) => c.status === 'NOT_RUN').length} |`), '',
  ...reports.flatMap((r) => [`## ${r.id}`, '', '| Check | Kind | Status | Detail |', '|---|---|---|---|', ...r.checks.map((c) => `| ${c.id} | ${c.kind} | ${c.status} | ${String(c.detail).replace(/\|/g, '\\|')} |`), '']),
].join('\n');
fs.writeFileSync(path.join(dir, 'report.md'), md);
for (const r of reports) console.log(`${r.id.padEnd(7)} ${String(r.measuredBy ?? 'file only').padEnd(30)} TECHNICAL=${r.technical} QUALITY=${r.quality}${bad(r).length ? `  FAILED: ${bad(r).map((c) => c.id).join(', ')}` : ''}`);
