# NAgex PPTX — real-application open and render evidence

**Date:** 2026-10-13
**Branch:** integration/r23.7-20261013
**Scope:** `src/creation/pptx/pptx-writer.ts` (the native OOXML writer behind the presentation creation path)

## What was tested

| Check | Method | Result |
|---|---|---|
| Package structure | Generated a 5-slide Korean + English deck (`sample-ko-en.pptx`, 13 111 bytes, 26 parts) and inspected the ZIP/OOXML with an independent script (`xmldom`): every part well-formed, every part has a content type, every Override names an existing part, every internal relationship target exists | 26/26 well-formed, 0 problems |
| Opens in a presentation application | Microsoft PowerPoint 16.0 on Windows, driven through COM: `Presentations.Open(file, ReadOnly)` | **opened = true, 5 slides** |
| Renders | `Slide.Export(PNG, 1600×900)` for each slide, reviewed by eye | See "Defects found" |
| Mixed-language text | Hangul + Latin in titles/bullets, `& < > " '`, an emoji | Rendered correctly |

PowerPoint compatibility was tested in **PowerPoint 16.0 only**. It was **not** tested in Keynote, LibreOffice Impress, Google Slides, PowerPoint for the web/mobile or older Office versions, so no claim is made for them.

## Defects found by the real render, and the fix

The first render (`before/slide-*.png`) showed two real defects that XML validation cannot see:

1. **The cover subtitle showed a bullet** — it inherited the master's body bullet style.
2. **A three-line title overflowed its placeholder into the bullets.** `<a:normAutofit/>` is only applied by PowerPoint when the text is edited, so a freshly opened deck showed the overflow; very long bullets could likewise run past the content area.

Fix (`pptx-writer.ts`): the cover layout's subtitle placeholder declares `<a:buNone/>`; the writer estimates wrapped height (full-width glyphs ≈ 1.0 em, others ≈ 0.55 em) and sets an explicit size only when the master default would not fit — titles 40 pt → no smaller than 20 pt, body 24 pt → no smaller than 14 pt. Short text keeps the master sizes. Regression test: `G.` in `tests/r23_7c_d_presentation_runtime.test.ts`.

After the fix (`slide-*.png`, same input): the subtitle has no bullet, the long title wraps to two lines inside its area, and the long bullets wrap inside the content area.

## Limits that remain

- The size choice is an estimate from character widths, not a font-metrics layout. Extreme text is bounded (floors above) but may still be dense; text beyond the floor is not truncated or hidden.
- No images, charts or tables are produced by the writer; speaker notes are not produced.
- The render was reviewed by a person-readable inspection of five slides; there is no automated pixel comparison.

## Files

- `docs/evidence/pptx-render-20261013/sample-ko-en.pptx` — the tested deck
- `docs/evidence/pptx-render-20261013/slide-1..5.png` — PowerPoint exports after the fix
- `docs/evidence/pptx-render-20261013/before/slide-1..5.png` — PowerPoint exports before the fix

Human acceptance of the visual design remains **PENDING**.
