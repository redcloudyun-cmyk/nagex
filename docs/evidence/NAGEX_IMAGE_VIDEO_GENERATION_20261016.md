# Image and video generation — what is real, what is blocked

**Status:** EVIDENCE (point-in-time)
**Date:** 2026-10-16
**Base:** integration `9631e0cedaa74258c8c3c87514d8342793a01c41` → branch `topic/image-video-20261016`
**RELEASE = NO-GO.**

The directive that opened this work was cut off after its Astra section (nothing about Higgsfield and Veo reached the session beyond their names). Everything below about Higgsfield and Veo is therefore an assessment from the code and from probes of the available key, not a response to a specification. Please resend the missing part.

## 1. Status per scenario

| Scenario | Status | Evidence |
|---|---|---|
| ASTRA_IMAGE_GENERATION | **NOT_APPLICABLE** | `gpt-6-astra` (`NAGEX_ASTRA_MODEL`) is the vision-reasoning model behind `src/device-control/astra-visual-execution-model.adapter.ts`: it reads a screenshot and answers where to click. It has no image-generation interface in the repository and none was assumed. |
| Real text-to-image through NAgex (Google image models) | **PARTIAL — implemented and tested against a loopback stand-in; LIVE = BLOCKED** | §2, §3. |
| LIVE image from a real provider | **BLOCKED** | Every real request through the final adapter is answered `429 RESOURCE_EXHAUSTED` (free-tier quota / no billing) — §4. |
| OpenAI image (`gpt-image-*`) | unchanged, unverified live | adapter and 8 unit tests exist; no OpenAI key on this machine. |
| Higgsfield | **BLOCKED — unknown interface** | No adapter, no credential, no specification in the repository or in the received directive. Nothing was built. |
| Video (Google Veo) | **BLOCKED** | See §5. Not implemented; video stays listed as **not available** in the product (`capability-brief.ts`, router `VIDEO` unsupported). |

## 2. What changed

* `src/creation/providers/adapters/google-image-adapter.ts` — rewritten. It existed but was registered nowhere and was untested; it spoke only Imagen `:predict`, which this key does not have (the key lists `gemini-2.5-flash-image`, `gemini-3-pro-image(-preview)`, `gemini-3.1-flash-image(-preview)`, `gemini-3.1-flash-lite-image`, no `imagen-*`).
  * `gemini-*-image` models: `models/<id>:generateContent` with `responseModalities: [TEXT, IMAGE]` and `imageConfig.aspectRatio`; `imagen-*`: `:predict`. Default model `gemini-2.5-flash-image`, `NAGEX_IMAGE_GOOGLE_MODEL` overrides.
  * The key travels in the `x-goog-api-key` header (the old code put it in the URL query, where it would end up in logs and error text).
  * Capabilities are honest: text-to-image only (no image-to-image, editing, reference conditioning or transparent background — it claimed all of them before); aspect ratios per model family (`3:2` is refused for Imagen instead of silently changed).
  * The mime type is the one the provider reports (was hard-coded PNG).
  * Distinct, truthful errors: `PROVIDER_QUOTA_EXCEEDED` (429), `PROVIDER_AUTH_FAILED` (401/403), `PROVIDER_MODEL_NOT_FOUND` (404), `CONTENT_REJECTED` (safety block in prompt feedback / finish reason / `raiFilteredReason`), `PROVIDER_UNAVAILABLE_ERROR` (5xx), `EMPTY_PROVIDER_RESULT` (words but no image — the words are reported, no image is invented), `TIMEOUT` (60 s, was 30 s), `UNSUPPORTED_ASPECT_RATIO`, `PROVIDER_UNCONFIGURED`.
  * `NAGEX_IMAGE_GOOGLE_BASE_URL` (operator setting: proxy / regional endpoint / the loopback stand-in in tests).
* `src/app/create-nagex-application.ts` — registered after OpenAI. The router takes the first configured provider, so OpenAI keeps priority when both are configured; Google serves images when no OpenAI credential exists or when asked for by id. A transparent-background request is never routed to Google.
* Main UI (`public/main-surface.js`, `public/i18n.js`): an image failure is shown in the screen's language with the real reason (quota, credential, content, timeout, unavailable, no image, shape) instead of the provider's raw English text; a created image has a **download link** (NAgex-owned path only, file name from the reported type). Korean and English.

Already present and reused unchanged: `ImageExecutor` (stored bytes, metadata, lineage, artifact), `ImageStore`, canonical owner-only serving `GET /api/v1/creations/images/<id>`, history, `executeRevision` (variation), `POST /api/v1/creations/generate`.

Not done: the Main UI always asks for `1:1` and offers no control for a variation (the server supports both: `aspectRatio`, `executeRevision`, `/variation`).

## 3. Tests (all against a loopback stand-in; no real provider contacted)

* `tests/google_image_adapter.test.ts` — 14 tests: request shape per model family, key header-only, real bytes and real mime type, every error code above, capability honesty, aspect-ratio refusal, unconfigured, model-id configuration, router priority and capability filtering, and the real `ImageExecutor` + `ImageStore` path (stored bytes equal the provider's, other tenant / other user get nothing, a variation builds on the first image and appears in the lineage and history, a quota failure leaves no image behind).
* `tests/image_generation_browser.test.ts` — 4 tests in real Chromium against the production server: Korean request → stored image shown from the NAgex path, provider receives the person's words, download link and exact served bytes, another account gets 404; quota failure (ko, en) and credential failure (ko) are stated in the screen's language with no image, no raw provider text and no internal code.
* A pass proves NAgex's own chain. It does **not** prove that Google accepts the request or what a real model draws.

## 4. Live check (one request per model, final adapter, dev key)

```text
gemini-2.5-flash-image         -> FAILED PROVIDER_QUOTA_EXCEEDED  "You exceeded your current quota, please check your plan and billing details."  (420 ms)
gemini-3.1-flash-image-preview -> FAILED PROVIDER_QUOTA_EXCEEDED  (294 ms)
```

Earlier probes with plain `generateContent` on three image models of this key gave the same 429. Because the quota check can precede request validation, this does not show the request body is accepted either: **the live shape is unverified** until a key with image quota is available. No purchase or plan change was made. Unblock: a Gemini key with billing enabled (then `npm run test:live`-style single probe through the adapter), or an OpenAI key for the existing adapter.

## 5. Video (Veo) — why nothing was built

* The key lists `veo-3.1-*-preview`, but video generation is a paid, long-running operation (submit → poll the operation → download a time-limited file URI); a request cannot be verified without billing.
* The product has `VideoProviderPort` and a router slot but no adapter, no `VideoExecutor`, no video store, no serving route, no UI. A faithful vertical (adapter + executor + store + owner-only serving + Main UI + approval for cost) is several packages of work that could not be exercised live, and building it from memory of an API shape would risk advertising a capability that has never run.
* MASTER §4/§7: unsupported capability must never be advertised. The chat capability brief therefore still says video is not available, and the router answers a video request honestly (`영상 만들기는 아직 지원하지 않아요`). That stays true.

## 6. Open items

* Resend the cut-off part of the directive (Higgsfield and Veo requirements, acceptance).
* A key with image quota → one live probe, then a real-browser run with the real model, then record the result here.
* Decide whether Main should offer aspect-ratio and variation controls (server ready).
* Veo / Higgsfield: spec and credentials first, then adapter → executor → store → serving → UI → approval for cost.
