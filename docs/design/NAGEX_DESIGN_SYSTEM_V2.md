# NAgex Design System V2 — Modern Everyday Personal AI

**Status:** CURRENT DESIGN REFERENCE (implementation guide; not a Level-0 document)
**Date:** 2026-10-12
**Scope delivered:** token layer, Desktop shell, Home, Apps & Connections, Recent, Workspace, Knowledge, Activity, Settings chrome.
**Not yet converted:** see [Remaining work](#9-remaining-work-and-known-debt). Human acceptance of every screen is PENDING.

## 1. Direction

NAgex is a Personal AI Assistant for everyday life: friendly but not childish, modern but not intimidating, personal but not intrusive. The default
experience must never read as an enterprise dashboard, developer console or oversized tutorial. The objective is **comfortably compact** density —
not "everything smaller", but balanced information per screen with one calm hierarchy.

English (en-US) is the source language for UX writing, component names, tokens and documentation. Korean (ko-KR) is the first localization and is
written for Korean users, not translated word for word.

## 2. Tokens (single authoritative layer)

All V2 tokens live in `public/shared/tokens.css` (the existing shared token file). New names only; the earlier `--nagex-*` names keep their values so
the Mobile UI, which loads the same file, is unchanged. Desktop CSS that is new or migrated reads only these tokens (no literal sizes, weights or
palette values).

| Role | Tokens | Values |
|---|---|---|
| Type size | `--nagex-fs-micro/caption/secondary/body/reading/control/card-title/section/page/hero` | 11 / 12 / 13 / 14 / 15 / 13.5 / 15 / 18 / 24 / 28 px |
| Weight | `--nagex-fw-regular/medium/semibold` | 400 / 500 / 600 (700-900 are not defaults) |
| Line height | `--nagex-lh-tight/ui/reading` | 1.25 / 1.4 / 1.55 (Korean: 1.35 / 1.5 / 1.65) |
| Spacing | `--nagex-spacing-1…7`, roles `--nagex-gap-control/card/section`, `--nagex-pad-card` | 4 8 12 16 20 24 32 · control 8 · card 12 · section 24 |
| Controls | `--nagex-control-sm/md/lg` | 30 / 34 / 38 px |
| Shape | `--nagex-r-control/card/panel` | 8 / 10 / 12 px |
| Elevation | `--nagex-elevation-card/popover` | one hairline shadow / one popover shadow |
| Colour | `--nagex-ink/ink-2/ink-3`, `--nagex-canvas/paper/wash`, `--nagex-line/line-strong`, `--nagex-blue/blue-wash`, `--nagex-focus-ring` | neutral first; brand blue only for selection, the primary action, focus and meaningful progress |
| Layout | `--nagex-sidebar-w` | 176 px |

## 3. Typography and fonts

- English UI: Inter. Korean UI: Noto Sans KR (SIL Open Font License, served from Google Fonts in unicode-range slices, weights 400/500/600 only),
  followed by Apple SD Gothic Neo / Malgun Gothic / Nanum Gothic. Chosen over relying on the OS fallback because the fallback differs per platform,
  has no medium/semibold faces on Windows, and previously produced synthetic bold at weights 800-900.
- `html[lang]` is set by the existing i18n runtime, so `html[lang="ko"]` switches `--nagex-font-ui` and the Korean line heights live, with no reload.
- The Desktop shell (`.app-wrapper`) reads `--nagex-font-ui`; Mobile keeps `--font-sans`. Form controls inherit the same font.
- No English letter-spacing is applied to Hangul. No new font files are shipped.

## 4. Components and rules

- **Cards:** neutral hairline border, `--nagex-r-card`, one subtle shadow, content-driven height. No artificial `min-height` (the old Home briefing
  card had 112px; Connections cards were 170-190px).
- **Buttons:** 30 (compact) / 34 (standard) / 38 (primary action), 13.5px / 500. Only one filled primary per region. `.btn-primary` / `.btn-secondary`
  had no base rule before V2 and rendered as browser defaults.
- **Navigation:** 13.5px / 500, 600 when active, 34px rows, 176px sidebar that follows the viewport height.
- **Status badges:** 12px / 500, sentence case (no uppercase), pill; colour carries meaning only (connected, attention, error, neutral).
- **Icons:** static NAgex-drawn glyphs on a coloured tile (`public/connections-ui.js`). No third-party logo files, no emoji, no remote or
  server-provided images, never injected from untrusted data.
- **Focus:** `--nagex-focus-ring` (white gap + blue ring) on every interactive control; Escape closes layers and focus returns to the opener.

## 5. UX writing

English is canonical: short, warm, calm, actionable; first person where NAgex speaks ("I couldn't load your briefing. Try again.").
Examples now shipped: "What can I help with?", "You're all caught up.", "Connect your calendar", "Show me the plan first".
Never enthusiastic, robotic, childish or corporate; never make a failure sound like a success; never soften an approval or security statement.

## 6. Translation vs localization (developer guide)

- **Translation** converts words. **Localization** makes the product feel written for the locale: register, word order, idiom, formats, typography.
- Korean copy uses friendly 해요체 for conversational text ("곧 예정된 일정이에요."), noun/verb forms for buttons ("연결하기"), and keeps clear
  formal wording only where precision matters. Greeting order differs by language (EN "Good evening, Name"; KO "Name님, 좋은 저녁이에요").
- Use structured keys through the existing runtime: `NAGEX_I18N.t('area.key')`, `data-i18n*` attributes, `mt()/bt()` on Home. Do not build a second
  system and do not match English sentences for new features. New Connections strings use `conn.*` keys with `{placeholder}` values.
- Home keys have several historical definitions in `public/i18n.js`; the block marked "Design System V2 copy" is the single authoritative definition
  (later `Object.assign` wins). Connections keys are edited in place.
- Never translate user-created content: event names, document titles, message bodies, MCP server names/tool descriptions, repository names, AI output.
- Never change numbers, dates, currencies or permissions; format dates/times with the locale (`Intl`/`toLocale*`).
- Review checklist for any new string: meaning and capability unchanged · risk and approval wording unchanged · no literal English word order ·
  no unnecessary loanwords · wraps well in both languages · accessibility labels localized too.

## 7. Evidence and gates

- Before/after screenshots and measured metrics: `docs/evidence/design-v2-20261012/` (tools: `tests/design_capture_*.ts`, cascade audit:
  `tests/design_cascade_probe.ts`).
- Contract: `tests/design_system_v2_browser.test.ts` asserts computed type sizes/weights, control heights, card density, spacing scale, locale font
  stacks, natural Korean copy, live language switching, shell geometry and list-screen consistency in real Chromium.
- Functional regressions: `main_*`, `connections_redesign_browser`, `sidebar_*`, `settings_*`, `workspace_knowledge_activity_*`.

## 8. Cascade audit (what was wrong)

The Desktop stylesheets contained five stacked generations of rules for the same elements (`desktop-home.css` "V2 D2 final geometry" with a fixed
149px / 732px sidebar and 11.5px type, `product-design-convergence.css` with ~100 `!important` declarations, five generations of the Settings chrome
in `style.css`). V2 edits the rules that actually win (found with the DevTools cascade probe) instead of adding another override layer, and brings
superseded generations to the same values so they cannot contradict.

## 9. Remaining work and known debt

Tracked as DEBT-0011 in `docs/debt/TECHNICAL_DEBT_REGISTRY.md`: the legacy `!important` layers still in `desktop-home.css` and
`product-design-convergence.css`; Settings sub-panels beyond the chrome (rows, forms, Devices, Permissions, Notifications, Appearance); Create/Analyze,
Vault detail, Plans/Tasks screens; and Korean copy of provider/technical notices outside Home and Connections. Mobile is intentionally unchanged.
