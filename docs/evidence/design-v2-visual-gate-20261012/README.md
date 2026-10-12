# Design System V2 — Visual Acceptance Gate: observations (no styling changes made)

**Date:** 2026-10-12 · **Baseline:** `bc54999` ("after") vs `bcfd548` ("before") · **Status:** IMPLEMENTED, NOT DESIGN-APPROVED · **Human acceptance: PENDING**

This document records what the V2 UI actually looks like, measured and viewed, **before any further styling change**. Nothing in `public/` was modified for this gate. No screen is declared closed.

## 0. Method and limits (read first)

- **Real Chrome** (installed channel) driving the **production server harness** at the same commits (`bc54999`, `bcfd548`), seeded data, 1440×900 and 1680×900, EN and KR. This is the same code that is deployed (server HEAD `bc54999`), **not a capture of the deployed instance itself**.
- **Authenticated capture of the deployed instance was NOT possible**: login is Google/OAuth-only and no test credentials exist. The deployed site was probed **signed-out only** (assets + fonts, §3, §6).
- Side-by-side images: `sbs-<screen>.png` (left = before, right = after). Raw per-run JSON (fonts, geometry): `raw/`. Tools: `tests/design_gate_tool.ts`, `tests/design_gate_compose.cjs`, `tests/design_gate_public_probe.cjs`.
- Test users have long generated names (`r247b_gate_…`); that inflates the greeting length in every screenshot and is a harness artefact.
- The dev machine has **Inter and Noto Sans KR installed locally**, so blocking Google Fonts there does not show a true fallback; §3 uses a simulation.
- **Mobile captures are not valid evidence** (`sbs-mobile-*`): the harness loads the Desktop SPA at 390px and renders a broken layout (giant logo, overlapping landing text) **identically before and after**. They say nothing about the Mobile UI.

## 1. Measured: Home and Connections (computed from the live DOM)

| Metric | Home before → after (EN, 1440 and 1680 identical) | Connections before → after |
|---|---|---|
| Page heading | 28.8px / 700 → 28px / 600 | **37.6px / 850 → 24px / 600** |
| Card height (avg) | **215 → 233px (+8%)**; KR 215 → **243px (+13%)** | **173 → 132px (−24%)**; KR → 137px |
| Card width (median) | 273 → 271px | 269 → 270px |
| Text sizes by character count | 13.76/12.16/13.33 → **12px: 301 chars (largest share)**, 14px: 234, 13.5px: 154 | 13.44/12.8 → 13px: 356, **12px: 276**, 13.5px: 210 |
| KR text sizes | – | Home: **12px: 213 chars (largest share)**, 14px: 188; Connections: 13px: 188, 12px: 185 |
| Content width at 1680 | identical to 1440 (column does not grow) | same |

## 2. Observed visual problems (not fixed — for the design review)

**Home**
1. **Briefing cards got taller, not more compact** (+8% EN, +13% KR) while text got smaller. They are equal-height boxes; the Suggestions card is mostly empty and the other three carry large bottom padding. Contradicts "compact".
2. **12px is the dominant text size on Home** (rows' secondary lines/time). On Korean Home it is also the dominant size. This is at or below the comfortable reading floor for Hangul; "body text comfortably readable" is **not clearly met** for secondary text.
3. At **1680 the layout is the same as at 1440**: the content column does not use the extra width; large empty washes left/right of the briefing cards. At 1440 the vertical area below the cards is empty (approx. half the viewport) in both languages.
4. The **greeting wraps/overflows with long names** (harness artefact, but a real user with a long display name would see the same wrap); KR places the name first in blue followed by "님, 좋은 저녁이에요" — visually the name dominates the greeting.
5. Sidebar is a tall white slab (`calc(100vh − 90px)`) with six short items and nothing else; the empty height is more prominent after V2 than before.

**Connections**
6. **"My connections" duplicates "Built-in apps"**: Google/Gmail/Calendar and GitHub each appear twice with the same "Connected" badge and a Manage button — redundant and makes the page longer.
7. **Uneven card heights/rows in Built-in apps** (coming-later cards are shorter than connected ones; row 2 holds only 2 of 4 columns) — ragged grid.
8. Secondary lines (`Gmail · Calendar`, `Uses your Google connection`, `Not available yet.`) are small low-contrast grey on white; on Korean they are hard to read at a glance.
9. The **Settings tab row wraps**: "Advanced" sits alone on a second, otherwise empty row at 1440 and at 1680 (before: "Appearance" and "Advanced" both wrapped).

**Unconverted Settings sub-panels (Devices, Permissions, Notifications, Appearance — viewed EN, KR for all)**
10. **Mixed generations on one screen**: converted chrome (24/600 title, 34px tabs) above untouched inner cards. Inner card headings (e.g. "Select a device", "Connected devices are not listed here yet.", "My devices (0)") are visually ~20px and heavy, **nearly as strong as the new 24/600 page title** — hierarchy is flattened and the new title looks lighter than the content below it.
11. Legacy primary buttons ("Connect a device", "Save changes") still render heavy/bold and differ from the V2 button (34px/13.5/500) used on converted screens; Permissions/Notifications status chips ("Ask when needed", "Always ask", "ON") are small bold uppercase-style chips unlike the V2 12/500 sentence-case badge. (Visual observation; these classes were not individually measured.)

**Legacy routes (Tasks, Vault, Create, Analyze, My Space)** — all render, nothing broken by the global rules:
12. Tasks: the shared `.view-header-bar` moved "View activity history" and "New Task" to the right edge, away from the title; "New Task" is still a legacy green button inconsistent with the blue primary elsewhere.
13. Vault/Create/Analyze/My Space: only the page title/subtitle and shared pills/badges changed; cards unchanged. Create's tool chips are now bordered pills (before they showed broken underlined/parenthesised text) — an improvement. No lost or hidden function seen.

**Public entry (signed-out, deployed)**
14. The signed-out page of the deployed site renders the **legacy Home** ("Good morning / What should we work on?", weight-800 heading) with overlapping text in the right-hand "Chat / Context / Suggestions" panel, grey skeleton placeholders, and a generic "User" chip. This is the first screen a visitor sees and it is **not V2** and looks broken. Pre-existing (not caused by V2), but it dominates first impressions. KR locale preference is not applied in this state (page stays English).

## 3. Font rendering (browser font matcher, `CSS.getPlatformFontsForNode`)

| Case | Result |
|---|---|
| EN, network OK | Inter (web font) for all measured text; Google Fonts: 6 requests, all 200; loaded faces Inter 400/500/600 **and 700/800** plus Outfit 700 (legacy weights still requested) |
| KR, before | Latin in Inter + **Hangul in Malgun Gothic (OS fallback, mixed fonts)** |
| KR, after, network OK | **Noto Sans KR (web font) for Hangul and Latin**; matcher names it "Noto Sans KR Thin" because that is the variable font's default instance name; faces loaded are 400/500/600. **29 font requests** (unicode-range slices) vs 6 before; all 200 |
| Network blocked, this machine | Inter / Noto Sans KR still render (locally installed) → not a fallback proof |
| Simulated "no local fonts" (family names removed from the stack) | EN → **Segoe UI Semibold**; KR → **Malgun Gothic**. Legible and layout-stable in `after-gate-home-ko-1440x900-simfallback.png`; Malgun has only regular/bold, so 500/600 resolve to those two (expected font matching, not separately measured) |
| Deployed site, signed-out, EN | `--nagex-font-ui` = Inter stack; 3 font requests OK; 6 faces loaded. KR probe inconclusive (page stayed EN, §2-14) |

Third-party font requests to Google on every load remain (privacy/offline consideration, and 29 requests for Korean).

## 4. Global CSS audit (what V2 changed globally and where it lands)

`.btn-primary/.btn-secondary` (new base rule), `.badge-status`, `.filter-pill`, `.view-header-bar/.view-header`, `.view-sub`, `.empty-state-text`, list-screen width cap, Settings chrome rules, `.app-wrapper` font family. Effects seen: Tasks header actions relocated (§2-12); Vault "Local Development Vault" badge lost uppercase; Create chips restyled; empty states became dashed cards; no functional or layout breakage found on Settings sub-panels, Tasks, Vault, Create, Analyze, My Space. Residual inconsistency is generational (§2-10, 11). Not audited: Mobile (invalid capture) and pages needing live data (task/vault detail views).

## 5. Acceptance criteria — current reading (for the reviewer, not a verdict)

| Criterion | Reading |
|---|---|
| Modern / globally competitive | Improved weight/size discipline; still uneven (§2-10, 14) |
| Friendly everyday AI, not console | Copy improved; briefing cards and duplicated connection lists feel heavy |
| Not childish / oversized / excessively bold | Met on converted screens (no ≥700 text there); legacy panels still heavy |
| Not excessively compact / readable | **Doubtful**: 12px dominant on Home and KR (§2-2, 8) |
| English-first, natural Korean | Met on Home/Connections; formal register remains elsewhere (DEBT-0011) |
| Briefing visible on idle Home | Met |
| One continuous conversation | Not re-verified in this gate |
| Compact recognizable connected-app cards | Met (−24% height) with duplication caveat (§2-6) |
| No lost/hidden functionality | None found |

## 6. Files

`sbs-*.png` (44 side-by-sides), `raw/*.json` (font + geometry reports per run), `raw/deployed-signedout-*.{png,json}`, `raw/after-gate-home-*-simfallback.png`.
