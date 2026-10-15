// Baseline: the CURRENT NAgex PPTX writer on the shared deck input; runtime over repeated builds.
const fs = require('fs');
const path = require('path');
const { buildPptx } = require('F:/nxppt/dist/src/creation/pptx/pptx-writer.js');
const deck = JSON.parse(fs.readFileSync(path.join(__dirname, 'deck.json'), 'utf8'));
const out = process.argv[2];
let buf = buildPptx(deck);
fs.writeFileSync(out, buf);
const N = 50; const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) buf = buildPptx(deck);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
console.log(JSON.stringify({ impl: 'nagex-pptx-writer', bytes: buf.length, msPerBuild: Math.round(ms * 100) / 100 }));
