# ADR-0020 — Outcome Quality of office files: an open-source writer under NAgex's rules, and an evaluation that cannot be fooled

**Status:** ACCEPTED · **Date:** 2026-10-17 · **Evidence:** `docs/evidence/NAGEX_OUTCOME_QUALITY_20261017.md` · **Canonical text:** `docs/canonical/NAgex_Creation_Architecture.md` §21
**Builds on:** ADR-0016 (Product Builder), ADR-0018 / ADR-0019 (answers: grounded and verified)

## Context

NAgex produced a `.docx` and a `.pptx` from a hand-written OOXML writer. Opened in the real applications the Word file was in **Compatibility Mode**, ignored the table column alignment and had no page numbers or pictures; the PowerPoint writer could only draw a title and bullets. "A file was created" had been reported as "the deliverable works". The directive for this slice: real usable output in documents, presentations, images, video and coding; objective quality verification; reuse proven open source rather than build engines; never count a mock as a live pass.

## Decisions

1. **Presentations are written by PptxGenJS 4.0.1 (MIT)**, behind the existing `PresentationProviderPort` (`LocalPptxPresentationAdapter`, same provider id), pinned exactly, installed with `--ignore-scripts`. NAgex keeps what a slide may contain (`rich-deck.types.ts`), the font size of every text block (`text-fit.ts`, set **on the runs** because the library lets a placeholder's master size win), the pictures it will embed (PNG / JPEG recognised from the bytes) and the package tidy (dangling content types removed). The old `buildPptx` stays only as a fixture builder for older tests.
2. **Word documents keep the existing writer, extended in place** (modern compatibility mode, table alignment / widths, header / footer / page numbers, pictures, page layout). Replacing a working writer with a library would have rewritten tests whose intent was behaviour; the gaps were small and measured.
3. **The figures of a visual are the person's.** Chart values, numeric table cells and key-figure values must appear, as the same number, in the request, the instructions, the source documents or the remembered context; otherwise the slide becomes its takeaways and the person is told which slide and why. A model-computed number is not the person's. (Deterministic; no model asked.)
4. **Pictures reach the model only as references** (`image_1 = "<title>"`), only the person's own (owner-checked), only PNG / JPEG. A document's stored text carries the canonical address; **every other picture-like thing is removed** (a made-up address, an external URL, a picture inside a sentence). The `.docx` resolves the address through the owner-checked store. A reference that was not offered is not drawn.
5. **A visual that does not parse is demoted to text, never repaired by guessing; a slide that only says information is missing never reaches the file.** Each is recorded (`demotions`, `notices`) and shown to the person in their language. A plain deck keeps exactly its old result keys.
6. **Quality is evaluated, not asserted** (`src/creation/quality/`): per-file checks are PASS / FAIL / **NOT_RUN**; a verdict with unrunnable checks is **PARTIAL**, never PASS. TECHNICAL (valid, opens in the real application) and QUALITY (automated) are separate; human review is separate again and is never produced by a model's self-assessment. What only Word / PowerPoint can say (opens, compatibility, overflow via `BoundHeight`, bounds, font sizes, chart data read back, edit and save) comes from `scripts/office-render.ps1`, a **local** certification tool (Windows + Office) - it is not part of CI and no check silently passes without it.
7. **Quality-driven recovery is bounded.** A document draft that still says content is missing is asked for once more, naming exactly what remains (never a third call; the draft with fewer marks is kept; a failing retry keeps the first). There is no loop that regenerates until a score passes.
8. **Media evaluation without a provider**: images (PNG / JPEG from bytes, size, aspect, blank / flat via pixels decoded in a browser, requested text via a named *advisory* reader, EDIT kept apart from CREATE) and video (MP4 read from its own boxes; "plays" needs a real player; scene consistency never decided from the file). Real image / video generation stays **BLOCKED_WITH_EVIDENCE** until a credential and an authorised spend exist.

## Consequences

- + Real Word and PowerPoint open the files in their current mode; charts are native and editable with their data.
- + An invented figure, a truncated bar axis, an overflow, a "withheld" slide, a missing picture are each a recorded finding instead of a surprise.
- + Three real defects of the generation (not only of the writers) were found by reading real renders and fixed with tests.
- - A new third-party dependency: `pptxgenjs` and its tree (`jszip`, `image-size`, `https@1.0.0` - an empty stub, no scripts). `npm audit` reports `image-size` (parser denial of service); the installed build never imports it. Disclosed, not fixed.
- - Number grounding is conservative: a correct derived figure (a percentage the model computed) becomes text unless the person gave it.
- - The Office harness needs Windows + Office; there is no cross-platform render evidence (LibreOffice / Keynote / Google Slides untested).
- - Figures can still sit on the wrong thing; label typos are invisible to the checks. Human review remains necessary.

## Alternatives considered

- *Rewrite the DOCX writer on the `docx` library.* Rejected for now: the measured gaps were four small ones; the library's newest release was one day old at the time.
- *Keep both PPTX writers in production by content.* Rejected: two looks for one product.
- *Ask a model to score the files.* Rejected: it is the self-assessment the directive forbids as evidence of quality.
- *Hard-fail a deck whose slide had to be demoted.* Rejected: the person gets a usable deck and a plain note; the demotion is the truthful behaviour.
