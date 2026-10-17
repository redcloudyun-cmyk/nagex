#!/usr/bin/env node
// Measures a picture by DECODING it in a real browser (Chromium, already a dependency) and judges it with the same rules the tests pin (src/creation/quality/media-quality.ts).
//
//   node scripts/image-quality-check.mjs <image> [--ratio 16:9] [--min-width 1024] [--min-height 576] [--parent <original image>] [--text "first text|second text" --recognized "what a reader read back"]
//
// Pixel facts: the decoded size, the mean and spread of brightness, how many distinct colours (4 bits per channel), how much of the picture is edges. A blank or flat fill fails; a picture with detail
// passes. Text legibility is NOT measured here: pass what an OCR / vision reader read back (--recognized) and it is compared - the reader is named ADVISORY. Nothing is sent anywhere.
import fs from 'node:fs';
import { chromium } from 'playwright';
import { evaluateImage } from '../dist/src/creation/quality/media-quality.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && fs.existsSync(a));
if (!file) { console.error('usage: node scripts/image-quality-check.mjs <image> [options]'); process.exit(2); }
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const bytes = fs.readFileSync(file);

const browser = await chromium.launch({ headless: true });
let pixels;
try {
  const page = await browser.newPage();
  const mime = bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
  pixels = await page.evaluate(async ({ base64, mime }) => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('the browser could not decode the picture')); image.src = `data:${mime};base64,${base64}`; });
    const w = image.naturalWidth; const h = image.naturalHeight;
    const scale = Math.min(1, 512 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luma = new Float64Array(canvas.width * canvas.height);
    const colours = new Set();
    let sum = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += luma[p];
      colours.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
    }
    const mean = sum / luma.length;
    let variance = 0; for (const v of luma) variance += (v - mean) ** 2;
    let edges = 0;
    for (let y = 0; y < canvas.height - 1; y += 1) for (let x = 0; x < canvas.width - 1; x += 1) {
      const i = y * canvas.width + x;
      if (Math.abs(luma[i] - luma[i + 1]) + Math.abs(luma[i] - luma[i + canvas.width]) > 24) edges += 1;
    }
    return { width: w, height: h, meanLuma: mean, stdLuma: Math.sqrt(variance / luma.length), distinctColors: colours.size, edgeShare: edges / luma.length };
  }, { base64: bytes.toString('base64'), mime });
} catch (error) {
  console.log(`DECODE=FAIL ${error.message}`);
} finally { await browser.close(); }

const parent = option('--parent');
const text = option('--text');
const recognized = option('--recognized');
const expectation = {
  scenario: parent ? 'EDIT' : 'CREATE',
  ...(option('--ratio') ? { aspectRatio: option('--ratio') } : {}),
  ...(option('--min-width') ? { minWidth: Number(option('--min-width')) } : {}),
  ...(option('--min-height') ? { minHeight: Number(option('--min-height')) } : {}),
  ...(parent ? { parent: { bytes: fs.readFileSync(parent) } } : {}),
  ...(text ? { text: text.split('|') } : {}),
};
const report = evaluateImage(bytes, expectation, pixels, recognized ? { recognized, engine: option('--reader') ?? 'supplied reader' } : undefined);
console.log(JSON.stringify({ file, pixels, technical: report.technical, quality: report.quality, checks: report.checks }, null, 2));
