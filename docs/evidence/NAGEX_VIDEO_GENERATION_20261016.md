# Video generation (Higgsfield, Google Veo) — what exists, what was verified, what is blocked

**Status:** EVIDENCE (point-in-time)
**Date:** 2026-10-16
**Base:** integration `7b911621580e472c6c7559dd6b477f8f0cf27c98`
**RELEASE = NO-GO.** No deployment, `main` untouched, no real generation was requested and no money was spent.

## 0. Verdict per item

| Item | Status | Evidence |
|---|---|---|
| HIGGSFIELD_API_AVAILABLE | **YES (documented)** — REST at `https://api.higgsfield.ai`, `Authorization: Key <id>:<secret>`, asynchronous queue, `Idempotency-Key`, price estimate endpoint, status polling, cancel while queued | `docs.higgsfield.ai` read 2026-10-16 (links in §1) |
| HIGGSFIELD_MCP_AVAILABLE | **YES, not used** — `https://mcp.higgsfield.ai/mcp` is OAuth in a browser per person; NAgex must poll a job with nobody present | §1 |
| Higgsfield adapter | **IMPLEMENTED + tested against a loopback stand-in**; **LIVE = BLOCKED** (no Higgsfield API key pair on this machine; the account balance is unknown) | `src/creation/providers/adapters/higgsfield-video-adapter.ts`, `tests/video_generation.test.ts` |
| VEO_API_AVAILABLE | **Documented, paid only** — `predictLongRunning`; the pricing page lists **no free tier** for any Veo 3.1 model; the dev key is on the free tier (every image request is answered `RESOURCE_EXHAUSTED … free_tier`) | §1 |
| Veo adapter | **IMPLEMENTED + tested against a loopback stand-in**; reports `UNCONFIGURED` unless the operator sets `NAGEX_VEO_ENABLED=1`; **LIVE = BLOCKED** (billing; no authorised spend) | `veo-video-adapter.ts` |
| VIDEO_EXECUTOR | **IMPLEMENTED** as `VideoJobService` (price → approval → submit → bounded polling → download → validate → store) | `src/creation/video-job.service.ts` |
| VIDEO_ARTIFACT_STORE | **IMPLEMENTED** — persistent job record + MP4 bytes (owner-checked), artifact of type `VIDEO` in the existing `ArtifactStore` | `video.store.ts`, `video-media.ts` |
| VIDEO_UI | **IMPLEMENTED** in Main (price/approval card, real states, player, download, history, refresh recovery), Korean and English, 390px | `public/main-surface.js`, `tests/video_generation_browser.test.ts` |
| REAL_VIDEO_E2E | **BLOCKED** — needs a Higgsfield key pair with credit (or a billing-enabled Google project + `NAGEX_VEO_ENABLED=1`) **and an explicit spend authorisation with the price shown by the estimate endpoint**. Not simulated, not claimed. | §4 |

## 1. What the providers' documentation says (and where NAgex follows it)

Read on 2026-10-16:

* Higgsfield — <https://docs.higgsfield.ai/docs/authentication.md>, `…/quickstart.md`, `…/concepts/requests.md`, `…/concepts/polling.md`, `…/concepts/errors.md`, `…/concepts/billing-and-retention.md`, `…/concepts/file-uploads.md`, `…/models/kling-3/standard-text-to-video.md`, `…/standard-image-to-video.md`, OpenAPI `…/openapi.json`.
  * Submit `POST /<model path>` (default `kling-video/v3.0/std/text-to-video`, `…/image-to-video`: `prompt`, `duration` 3–15, `aspect_ratio` `16:9|9:16|1:1`, `image_url` public URL). Estimate `POST /estimate/<model path>` → `{"credits":"1.500","usd":"0.094"}`. Status `GET /requests/{id}/status` → `queued | in_progress | completed | failed | nsfw | canceled`, `video.url`. Cancel only while queued (202 / 400). Only successful requests are charged. Outputs are kept ≥ 7 days. Upload `POST /files/generate-upload-url` then PUT to the presigned URL **without** credentials. Errors: 401 credentials, 403 insufficient credits, 404, 422 (validation or idempotency-key reuse), 423/503 model busy, 500.
  * Following the docs literally, the response's `status_url` is **not** followed (NAgex rebuilds the address from its configured base, so the credential is never sent to an address taken from a response; a test proves it).
  * Not verified against the live service: the exact estimate field types for every model, whether `sound` defaults change the price (the default is left to the provider and the estimate uses the same request body).
* Google Veo — <https://ai.google.dev/gemini-api/docs/veo>, <https://ai.google.dev/gemini-api/docs/pricing>.
  * `POST /models/<veo-3.1-…-preview>:predictLongRunning` (`x-goog-api-key`), body `instances[].prompt` (+ `image.inlineData` for image-to-video), `parameters.aspectRatio|durationSeconds ("4"|"6"|"8")|resolution`; poll the operation until `done`; `response.generateVideoResponse.generatedSamples[0].video.uri`; download with the key header (redirects followed); videos are deleted after two days. Paid-tier prices per second (720p / 1080p): Standard $0.40 / $0.40, Fast $0.10 / $0.12, Lite $0.05 / $0.08. **No free tier.**
  * The docs page is internally inconsistent about `generateContent` versus `predictLongRunning` for REST; the REST examples (and therefore this adapter) use `predictLongRunning`. Unverified live.

Choice made: Higgsfield first (server-side key pair = unattended polling; idempotent submit; quote endpoint), Veo second on the same runtime. MCP was compared and left out for the OAuth reason above.

## 2. What was built

* **Port** — `VideoProviderPort` is now an asynchronous job port (`estimateCost`, `submitVideo(idempotencyKey)`, `pollVideo`, `cancelVideo?`, `downloadVideo`, capabilities incl. `cancelQueued` / `idempotentSubmit`). The previous single-call `generateVideo` had no implementation. `VideoProviderError` carries stable codes (credentials, credits, quota, billing, model, busy, content, timeout, network, malformed, invalid media).
* **Job runtime** — `VideoJobService`:
  * `prepare` prices the request (provider quote, or the published price list for Veo — labelled) and creates the approval request in the **existing `ActionApprovalStore`** (`creation.video.generate`, payload binds provider, model, mode, prompt, length, shape, source-image digest and price). **Nothing is sent to any provider.** A request dearer than `NAGEX_VIDEO_MAX_COST_USD` (default 5) is refused before approval; an identical active request is returned as the same job.
  * `approve` re-prices; a rise above 10 % needs a **new** approval (the old one is rejected). The approval is consumed once, for exactly that payload. Then `SUBMITTING` is persisted **before** the provider call. The call carries `Idempotency-Key: nagex-<jobId>`; a lost answer is retried once with the same key where the provider de-duplicates, otherwise the job says **SUBMIT_UNCERTAIN** (never a blind second paid job). A restart in the middle of a submission is resolved the same way.
  * Polling is bounded (2 s growing to 10 s, 20 minutes total — `NAGEX_VIDEO_MAX_WAIT_SECONDS`, five consecutive failures, three download attempts). States are the provider's: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` (only where the provider can cancel a queued request), `UNAVAILABLE` (the service could not take the job: credentials, credit, quota, billing), plus `AWAITING_APPROVAL` and `DECLINED` (nothing sent). No percentage is ever shown.
  * Completion downloads from the provider's address under the outbound-URL policy (https only, no private/loopback/link-local destination, DNS pinned, ≤ 3 re-validated redirects, credential dropped on a host change, 300 MB cap), accepts only a **structurally valid MP4** (`ftyp` first, boxes tile the file, `moov` present), stores it, creates a `VIDEO` artifact and only then reports `COMPLETED`.
  * Image-to-video reads the person's **own** NAgex image (tenant/owner checked), uploads it only after approval (Higgsfield presigned upload without credentials; Veo inline), and prices from the text-to-video quote labelled as an estimate.
* **Routes** (8, owner-scoped, 404 for others): prepare, list, capability, status (refreshes from the provider if due), approve, decline, cancel, media (`Range` → 206/416, `?download=1`, `nosniff`).
* **Driver** — a lifecycle task polls unfinished jobs, also after a restart.
* **Product surfaces** — the router offers a video only when a service is really configured (otherwise the honest "not available" stays); the chat capability brief says the same; the video shortcut chip enables only then; Main shows the price/approval card, real states, the player (NAgex path only), a download link, the creation history entry and the waiting card after a refresh. The legacy Home opens a finished video in Main.
* **Configuration** — `NAGEX_HIGGSFIELD_KEY_ID` / `NAGEX_HIGGSFIELD_KEY_SECRET` (or `HF_API_KEY_ID` / `HF_API_KEY_SECRET`), `NAGEX_VIDEO_HIGGSFIELD_MODEL` (model family, validated as a plain path), `NAGEX_VIDEO_HIGGSFIELD_BASE_URL`; Veo: a Gemini key **and** `NAGEX_VEO_ENABLED=1`, `NAGEX_VIDEO_VEO_MODEL` (default the cheapest, `veo-3.1-lite-generate-preview`), `NAGEX_VIDEO_VEO_BASE_URL`; `NAGEX_VIDEO_MAX_COST_USD`, `NAGEX_VIDEO_MAX_WAIT_SECONDS`, `NAGEX_VIDEOS_DIR`, `NAGEX_VIDEO_BYTES_DIR`.

## 3. Tests (all against loopback stand-ins written from the documentation; no real provider, no spend)

* `tests/video_generation.test.ts` (31): MP4 validation, Range parsing, Higgsfield contract (estimate, submit headers, poll states, status_url not followed, cancel rules, 401/403/404/422/503/500 mapping, unconfigured, odd model path ignored, SSRF refusals), Veo (disabled unless enabled, price table, request shape, image inline, billing/quota/auth/safety codes, foreign download host never gets the key), the job service (nothing sent before approval; one job on double approve; full life PENDING→RUNNING→COMPLETED with stored bytes, artifact, owner/tenant isolation, reopened store; decline/expiry/lost approval send nothing; price rise needs new approval; cost limit; failure/content/credit; lost answer retried once with the same key then "uncertain"; restart mid-submission; wait limit; invalid media; cancel rules; image-to-video upload after approval), the routes (owner only, Range, download, 503 when unconfigured), routing/brief/chat-prompt honesty, artifact projection.
* `tests/video_generation_browser.test.ts` (5, real Chromium, production server): Korean full journey (price first, nothing sent, approve, states, stored MP4 played from the NAgex path, 206 range, download header, history, survives refresh, other account 404), English decline / refresh recovery / double click, credit refusal, content rejection (Korean), 390px layout.
* Registry/route inventory updated (375 routes); existing router, capability, artifact and canvas contract tests pass.
* A pass proves NAgex's side. It does **not** prove Higgsfield or Google answer this way today, nor video quality.

## 4. What is needed for a live run (REAL_VIDEO_E2E)

1. A Higgsfield API key pair with credit (Console → API credentials) or a billing-enabled Google project with `NAGEX_VEO_ENABLED=1`.
2. The user's explicit authorisation of a spend limit. The flow already shows the provider's own estimate and asks for approval; the first live run should use the shortest clip at the cheapest model and record the estimate, the provider request id and the downloaded MP4's size and digest here.
3. Playback in the product browser: Playwright's bundled Chromium does not decode H.264, so the automated browser tests check the player element and the served bytes rather than decoding frames; a human check in Chrome/Edge is part of the live run.

## 5. Known limits (honest)

* Quality of the generated video, and exact provider behaviour beyond the documentation, are unmeasured.
* The legacy Home capability tile still says "Video: upcoming" (a static client table pinned by older contract tests); Main is the surface that follows the real configuration.
* A job that outlives NAgex's wait limit is reported as such; NAgex does not keep polling and cannot cancel a started Higgsfield job.
* No automatic fallback between providers: a change of provider or price needs a fresh approval (it would be a new request).
