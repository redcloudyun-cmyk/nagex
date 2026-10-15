# PPTX quality evaluation (2026-10-15) - PptxGenJS 4.0.1 vs the existing NAgex PresentationML writer

Input: `deck.json` (Korean, 1 cover + 8 content slides incl. a very long title and 5-bullet slides). Everything was opened in the REAL Microsoft PowerPoint (COM): `inspect_pptx.ps1` exports every
slide to PNG and records per-shape fonts, sizes and text overflow; `summarize.cjs` tabulates it. Dist path in the scripts points at F:/nxppt - adjust when moving.

| measure (PowerPoint) | baseline (existing writer) | existing writer + template (adopted) | PptxGenJS plain | PptxGenJS designed |
|---|---|---|---|---|
| opens in PowerPoint | yes | yes | yes | yes |
| title placeholders (outline view, accessibility, restyle via master) | 9/9 | 9/9 | **0/9** | **0/9** |
| text as free text boxes | 0 | 0 | 18 | 18 |
| Latin font == East-Asian font in text | **0/18** (Calibri + Malgun) | **26/26** | 18/18 | 26/26 |
| slide numbers | 0 | 8 | 0 | 8 |
| text overflowing its shape | 0 | 0 | 1 | 0 |
| design (cover, accent bar, rule, footer) | none | yes | none | yes |
| file size | 18.1 KB | 19.9 KB | 110.5 KB | 124.6 KB |
| build time (mean of 30-50) | 1.5 ms | 1.9 ms | 3.0 ms | 3.3 ms |
| new dependencies | 0 | 0 | 19 packages / 7.5 MB (jszip MIT-or-GPL, image-size MIT, `https` empty ISC shim, @types/node) | same |

Decision: IMPROVE_EXISTING. The visual gain comes from the template (colour, shapes, numbers, fonts), not from the library; PptxGenJS output has no title placeholders, is ~6x larger, needs 19 extra
packages and does not auto-fit text (`fit: shrink` is applied by PowerPoint only on edit). `patch_writer.cjs` is the one-shot patch that was applied to `src/creation/pptx/pptx-writer.ts`.
Real UI journey: `e2e/e2e_pptx.cjs` (Korean prompt -> deck -> download -> Recent -> new browser), downloaded deck re-opened in PowerPoint: `e2e/e2e.json`, `e2e/e2e_slide03.png`.
Not covered: Keynote / Google Slides / LibreOffice rendering (not available here), charts / images / speaker notes (the writer still has none; PptxGenJS would be the candidate if they become a requirement).
