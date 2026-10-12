# Design System V2 — before/after evidence

**Date:** 2026-10-12 · **Method:** real Chromium, production server harness, seeded data; metrics are measured from computed styles of the visible text, not estimated. "Before" is the deployed commit `bcfd548` (which already contains the icon-first Connections page, so the Connections "before" is the pre-V2 styling of that page). Tools: `tests/design_capture_tool.ts`, `tests/design_capture_screens.ts`, `tests/design_capture_states.ts`, `tests/design_cascade_probe.ts`. Raw data: the JSON files in this folder. **No screen is approved by this evidence; human review is pending.**

## Home and Apps & Connections (1440×900 and 1920×1080)

### Before

| Screen | Median size / weight | Text at weight 700+ | Card height avg / max | Shadowed elements | Visible chars | Chars in first viewport |
|---|---|---|---|---|---|---|
| home-en-1440x900 | 13px / 400 | 31% | 172 / 172px | 9 | 796 | 796 |
| connections-en-1440x900 | 13px / 600 | 40.2% | 173 / 186px | 29 | 1094 | 817 |
| home-en-1920x1080 | 13px / 400 | 31% | 172 / 172px | 9 | 796 | 796 |
| connections-en-1920x1080 | 13px / 600 | 40.2% | 173 / 186px | 29 | 1094 | 951 |
| home-ko-1440x900 | 13px / 400 | 28.5% | 172 / 172px | 9 | 534 | 534 |
| connections-ko-1440x900 | 13px / 600 | 39% | 173 / 186px | 29 | 629 | 491 |
| home-ko-1920x1080 | 13px / 400 | 28.5% | 172 / 172px | 9 | 534 | 534 |
| connections-ko-1920x1080 | 13px / 600 | 39% | 173 / 186px | 29 | 629 | 629 |

### After

| Screen | Median size / weight | Text at weight 700+ | Card height avg / max | Shadowed elements | Visible chars | Chars in first viewport |
|---|---|---|---|---|---|---|
| home-en-1440x900 | 14px / 400 | 0% | 186 / 186px | 7 | 775 | 775 |
| connections-en-1440x900 | 13px / 500 | 0% | 132 / 155px | 20 | 1094 | 938 |
| home-en-1920x1080 | 14px / 400 | 0% | 186 / 186px | 7 | 775 | 775 |
| connections-en-1920x1080 | 13px / 500 | 0% | 132 / 155px | 20 | 1094 | 1094 |
| home-ko-1440x900 | 14px / 400 | 0% | 194 / 194px | 7 | 524 | 524 |
| connections-ko-1440x900 | 13px / 500 | 0% | 137 / 160px | 20 | 624 | 530 |
| home-ko-1920x1080 | 14px / 400 | 0% | 194 / 194px | 7 | 524 | 524 |
| connections-ko-1920x1080 | 13px / 500 | 0% | 137 / 160px | 20 | 624 | 624 |

## Other Desktop screens (1440×900)

| Screen | Heavy text before → after | Chars in first viewport before → after |
|---|---|---|
| recent-en | 22% → 0% | 337 → 337 |
| workspace-en | 28.6% → 0% | 339 → 333 |
| knowledge-en | 21.3% → 0% | 418 → 418 |
| activity-en | 22.9% → 0% | 340 → 262 |
| settings-account-en | 35.5% → 12.1% | 535 → 546 |
| settings-personalization-en | 42.8% → 12.1% | 781 → 838 |
| settings-privacy-en | 35.5% → 12.1% | 535 → 546 |
| recent-ko | 22.5% → 0% | 227 → 227 |
| workspace-ko | 31.2% → 0% | 221 → 199 |
| knowledge-ko | 24.5% → 0% | 273 → 273 |
| activity-ko | 23.1% → 0% | 169 → 169 |
| settings-account-ko | 32.8% → 16.1% | 327 → 347 |
| settings-personalization-ko | 33.1% → 10.6% | 462 → 472 |
| settings-privacy-ko | 32.8% → 16.1% | 327 → 347 |

## What the cascade audit found (before)

See `cascade-before.json` (winning rule per property, with file and `!important`). Highlights: sidebar 11.5px / weight 650-800 / fixed 149px × 732px with `!important` in `desktop-home.css`; Settings title 2.35rem / 850 and five stacked generations of tab rules in `style.css`; Home briefing cards `min-height: 112px`, titles weight 800; ~100 `!important` declarations in `product-design-convergence.css`; `.btn-primary` / `.btn-secondary` with no base rule.

## Screenshots

Files are named `<before|after>-<screen>-<locale>[-<viewport>].png` (EN and KR).
