# ADR-0013 — Universal Voice architecture: Dictation, Conversation and Action behind platform adapters; Whisper prohibited

**Status:** Accepted (architecture principle approved 2026-10-11; Whisper prohibition added 2026-10-11; gaps in §7 are open)
**Date:** 2026-10-11
**Related:** UX and Interaction Architecture §16; Trust, Identity, Privacy and Approval §4; Execution and Cross-Platform Architecture; MASTER §5, §7, §8; ADR-0006 (identity boundary), ADR-0009 (outbound recipient authority)

## Context

NAgex has several independent voice pieces: the Android `VoiceSession`/`VoiceCaptureManager`, the shared renderer adapter used by Main and
the desktop quick-wake surface, a wake/speaker-trust service, a background call UX, and TTS output. Treating all of them as
"speech-to-text" hides three different product capabilities with different risk, and had already caused privacy ambiguity (which
processor hears the audio) and surface drift (one surface fills an editable composer, another submits). An earlier iteration also added
a NAgex-hosted Whisper route; that route is the reason for the prohibition in §2.

## Decision

### 1. Three distinct capabilities

| Capability | Meaning | Output |
|---|---|---|
| **Dictation** | Speech → editable text | Text in a composer. Never submitted by the voice layer. |
| **Conversation** | Speech → AI understanding → spoken/text response | A response. No external side effect. |
| **Action** | Speech → intent → authorized execution → verification | Goes through the existing deterministic NAgex controls only. |

They may share capture, perception and session infrastructure. They are separate features, selected explicitly, with separate tests.

### 2. Whisper prohibition (mandatory)

Whisper and every Whisper-based implementation (OpenAI Whisper, whisper.cpp, faster-whisper, distilled or quantized variants, wrappers)
are prohibited in NAgex: not as a primary engine, not as a fallback, not as an optional or consented route, and not as a development
harness inside the product source tree.

- NAgex hosts **no** speech-to-text engine of its own. NAgex servers receive text, not audio.
- A compliant engine is one of: (a) a platform recognizer that the platform itself reports as running on-device for the language, or
  (b) a third-party platform/browser speech service used only after provider-specific informed consent given on that device.
- If no compliant engine exists on a device, voice input is disabled truthfully and text input remains.
- Existing server-side binaries, models and build trees are **not deleted** until their dependencies are audited and a safe migration is
  agreed (see §6). Their presence does not make any active route use them.

### 3. Architecture

- Platform-specific **Voice Adapters** sit behind one capability contract: `DeviceVoiceAdapter → Transcript → NAgex` (composer, conversation or intent resolver).
- **STT is a replaceable implementation, not the architecture.** Direct speech understanding may be added later, but it must still produce a
  bounded, inspectable intent representation before any consequential execution.
- The Android `VoiceSession` lifecycle (single invocation entry, timeout, cancellation, single-result delivery) is the reference pattern.
- Voice adapters make **no** permission, approval, contact, policy or execution decision. They emit text (or a truthful failure/empty result) only.
- Existing Android Voice Session, desktop Shared Voice Adapter, intent resolver, execution runtime and Authority Core are preserved.
  Mobile and desktop are consistent at the contract level, not necessarily at the OS API level.

### 4. Privacy

- Prefer **verified** on-device processing. OS and browser speech APIs are never assumed to be offline: a recognizer is "on-device" only
  when the platform reports it (for example Web Speech `SpeechRecognition.available({ processLocally: true }) === 'available'` **and**
  `processLocally` is accepted by the recognizer). Unknown processing location is never labeled on-device.
- Raw audio is never silently sent to a remote processor. Third-party processing requires provider-specific informed consent that names
  the processor, a visible indication while it is in use, and is withdrawable; withdrawal blocks the next recording. There is no
  fallback from one processor to another.
- Raw audio is not persisted by default; transcripts and audio are not written to logs.
- **Voice-processing consent is separate from execution approval.** Consent to a speech processor never approves an action, and an approval never implies consent to send audio anywhere.

### 5. Voice Action safety

Voice commands confer no execution authority. Every action follows
`Identity → Consent → Permission → Approval when required → Execution → Verification`.
Wake-word detection and speaker match are inputs to risk policy, never authority. Messages, purchases, deletion and other sensitive
operations are never approved by the act of speaking them, and silence is never approval.

### 6. Provenance and audit of the removal

Voice-originated text should remain distinguishable (`inputModality: VOICE`) so risk policy can account for STT error (for example proper-noun drift
on recipients). Production execution from non-TEXT modalities remains disabled until it is routed through §5.

Whisper reference audit (2026-10-11), tracked repository:

| Location | Disposition |
|---|---|
| `src/http/routes/stt.routes.ts` | Process execution removed. Route kept only as an authenticated `410 SERVER_STT_DISABLED` so stale cached clients get a truthful answer. Never reads the body. |
| `src/http/body-limit.ts`, `src/http/route-access.ts` | Dedicated 10 MB audio limit removed; access rule text updated. |
| `public/renderer-voice-adapter.js` | Server-hosted and local-loopback Whisper backends, audio capture/WAV encoding and the fixed recording timer removed. Web Speech only, with the processing-location policy of §4. |
| `scripts/stt-open-source-poc.{mjs,html}`, `tests/stt_open_source_poc.test.ts`, registry entry | Retired (POC harness for the prohibited engine). Recoverable from git history. |
| `tests/main_surface_hard_rebuild_browser.test.ts` | Whisper scenarios replaced by consent / stop / cancel / no-server-STT scenarios. |

Not in the repository, intentionally untouched (operations resources on the Ubuntu host, user `redcloud`):
`.runtime/whisper/` (`whisper-cli`, `whisper-cli.avx2-sigill.bak`, `build-src/`, `models/ggml-base.bin`), `.runtime/tools/cmake-*`,
and diagnostic leftovers under `/tmp/nagex-stt-diag/`. No active code reads them. Removal is a separate, explicitly approved operations step.

## 7. As-built state (2026-10-11) and open gaps

Verified in code and tests (`tests/voice_architecture_boundaries.test.ts`, `tests/main_surface_hard_rebuild_browser.test.ts`):

- No product source references Whisper; the server STT route starts no process and reads no audio.
- The renderer adapter resolves a processing location (LOCAL / THIRD_PARTY / NONE), requires provider-specific consent before opening the
  microphone for a third-party service, re-checks it before recognition starts, never falls back to another engine, and treats unconfirmed `processLocally` as not local.
- Main dictation: stop = transcribe, Cancel/Esc = discard and restore the composer, existing text preserved, no auto-submit, remote processor disclosed while listening, consent withdrawable in Settings → Voice processing.
- The desktop (Electron) runtime reports voice unavailable (no verified engine); Quick Wake shows a truthful message and text input remains.
- Android capture/session classes do not call the API, approval or send paths; wake/speaker trust never becomes authority; non-TEXT modalities are not executed.

Open gaps (each needs its own scoped change and real-device evidence):

1. **Android recognizer locality is unverified.** The app uses the default `SpeechRecognizer`; no on-device API (`createOnDeviceSpeechRecognizer`, API 31+), offline preference or provider consent exists. The platform recognizer may be remote.
2. **No native Windows engine.** The reference PC has no Korean SAPI/OneCore recognizer; Chrome 154 reports Korean `processLocally` as `downloadable`, Edge 155 as `unavailable`. Real-microphone Korean recognition on-device is not yet verified. The Electron desktop app has no compliant engine.
3. **iOS** has no code in this repository.
4. **Desktop quick-wake submits the transcript** to the normal prompt path (where approvals apply) without a review step; Main does not. Capability mode (dictation vs. conversation vs. action) is implicit.
5. **Conversation (spoken reply loop) is not wired** for Main; TTS output exists but the Main voice-session control is continuous dictation.
6. Consent is stored per browser profile (client-side); there is no server-side consent record.

## Consequences

- New voice work must name which capability it implements and which processor hears the audio.
- Adding any speech engine requires it to meet §2/§4 with platform-specific evidence; Whisper-based engines cannot be added.
- Changing processor policy requires updating the pinned tests in the same change.
