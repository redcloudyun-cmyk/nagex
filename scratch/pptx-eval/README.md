# PPTX quality evaluation (work in progress, 2026-10-15)

Phase 1 of "Selective Open Source Integration": compare the current NAgex PPTX writer (`src/creation/pptx/pptx-writer.ts`, hand-written PresentationML behind
`PresentationProviderPort` / `LocalPptxPresentationAdapter`) with PptxGenJS 4.0.1 (MIT) on the same Korean deck (`deck.json`), measured in real Microsoft PowerPoint (COM).

- `build_baseline.cjs` builds the baseline with the current writer (50 builds timed). The path to `dist/` is hard-coded to F:/nxppt - adjust when resuming.
- `inspect_pptx.ps1` opens a .pptx in PowerPoint, exports every slide to PNG and records per-shape fonts, size and text overflow.
- `baseline/` holds the baseline result: 9 slides, 18,138 bytes, ~1.5 ms per build, rendered PNGs and the per-shape JSON.
- NOT DONE yet: PptxGenJS build of the same deck, its inspection, the comparison, the decision and any change to the product code.
- PptxGenJS facts so far: MIT; runtime deps jszip (MIT OR GPL-3.0-or-later: use under MIT), image-size (MIT), https 1.0.0 (ISC, an empty shim package), @types/node; 19 packages / 7.5 MB installed.
