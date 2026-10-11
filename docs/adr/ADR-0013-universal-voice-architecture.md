# ADR-0013 — Universal Voice architecture: Dictation, Conversation and Action behind platform adapters

**Status:** Accepted (architecture principle approved 2026-10-11; implementation gaps listed in §6 are open)
**Date:** 2026-10-11
**Related:** UX and Interaction Architecture §16; Trust, Identity, Privacy and Approval §4; Execution and Cross-Platform Architecture; MASTER §5, §7, §8; ADR-0006 (identity boundary), ADR-0009 (outbound recipient authority)

## Context

NAgex has several independent voice pieces: the Android `VoiceSession`/`VoiceCaptureManager`, the shared renderer adapter used by Main and
the desktop quick-wake surface, a server-side Whisper route, a wake/speaker-trust service, a background call UX, and TTS output.
Treating all of them as "speech-to-text" hides three different product capabilities with different risk, and has already caused
privacy ambiguity (which processor hears the audio) and surface drift (one surface fills an editable composer, another submits).

## Decision

### 1. Three distinct capabilities

| Capability | Meaning | Output |
|---|---|---|
| **Dictation** | Speech → editable text | Text in a composer. Never submitted by the voice layer. |
| **Conversation** | Speech → AI understanding → spoken/text response | A response. No external side effect. |
| **Action** | Speech → intent → authorized execution → verification | Goes through the existing deterministic NAgex controls only. |

They may share capture, perception and session infrastructure. They are separate features, selected explicitly, with separate tests.

### 2. Architecture

- Platform-specific **Voice Adapters** sit behind one capability contract: `DeviceVoiceAdapter → Transcript → NAgex` (composer, conversation or intent resolver).
- **STT is a replaceable implementation, not the architecture.** Direct speech understanding may be added later, but it must still produce a
  bounded, inspectable intent representation before any consequential execution.
- The Android `VoiceSession` lifecycle (single invocation entry, timeout, cancellation, single-result delivery) is the reference pattern.
- Voice adapters make **no** permission, approval, contact, policy or execution decision. They emit text (or a truthful failure/empty result) only.
- Existing Android Voice Session, desktop Shared Voice Adapter, intent resolver, execution runtime and Authority Core are preserved.
  Mobile and desktop are consistent at the contract level, not necessarily at the OS API level.

### 3. Privacy

- Prefer **verified** on-device processing. OS speech APIs are not assumed to be offline: a recognizer is "on-device" only when the
  platform reports it as local (for example Web Speech `processLocally` with `available() === 'available'`, Android on-device recognizer
  availability) or it is a process we run on the same device.
- Raw audio is never silently sent to a remote processor. Server or third-party audio processing requires explicit, informed consent that
  names the processor, and a visible indication while it is in use. There is no hidden fallback from a local path to a remote one.
- Raw audio is not persisted by default; transcripts and audio are not written to logs.
- **Voice-processing consent is separate from execution approval.** Consent to a speech processor never approves an action, and an approval never implies consent to send audio anywhere.

### 4. Voice Action safety

Voice commands confer no execution authority. Every action follows
`Identity → Consent → Permission → Approval when required → Execution → Verification`.
Wake-word detection and speaker match are inputs to risk policy, never authority. Messages, purchases, deletion and other sensitive
operations are never approved by the act of speaking them, and silence is never approval.

### 5. Provenance

Voice-originated text should remain distinguishable (`inputModality: VOICE`) so risk policy can account for STT error (for example proper-noun drift
on recipients). Production execution from non-TEXT modalities remains disabled until it is routed through §4.

## 6. As-built audit (2026-10-11) and open gaps

Verified in code (see `tests/voice_architecture_boundaries.test.ts` for the pinned invariants):

- Dictation into Main composer preserves existing text and does not auto-submit.
- The server STT route is authenticated, size/duration bounded, runs a local whisper.cpp subprocess in a private temp directory removed in `finally`, and has no outbound network, logging or persistence.
- The server-Whisper path has no fallback to browser recognition.
- The Android capture/session classes do not call the API, approval or send paths; the activity only resolves a spoken name to a contact via the server.
- Speaker enrollment is device-local with ephemeral raw audio; wake detection never implies speaker trust; high-risk voice requires approval.
- Non-TEXT modalities are normalized into `CommandContext` but not executed (`productionExecutionEnabled: false`).

Open gaps (not yet changed; each needs its own scoped change):

1. **Default is remote on public HTTPS.** The shared adapter selects server Whisper by default on `https`, and falls back to the browser vendor's recognizer when no backend is configured (non-HTTPS). No consent record or processor indication exists.
2. **No local-first selection.** Chrome 154 on the reference PC reports Korean `processLocally` as `downloadable`; Edge 155 as `unavailable`. Real-microphone Korean recognition on-device is not yet verified.
3. **Desktop quick-wake auto-submits the transcript** (`submitPrompt`) without a review step; Main does not. Capability mode (dictation vs. conversation vs. action) is implicit.
4. **Android recognizer locality is unverified.** The app uses the default `SpeechRecognizer`; no on-device API or offline preference is used.
5. **Fixed 9 s recording** in the server-Whisper path, no early stop, and a cancel/restart timer race.
6. **Control matrix text** in `main-surface.js` still describes the mic as "Browser SpeechRecognition".
7. **Conversation (spoken reply loop) is not wired** for Main; TTS output exists but the Main voice-session control is continuous dictation.
8. **iOS** has no code in this repository.

## Consequences

- New voice work must name which capability it implements and which processor hears the audio.
- Changing the default processor requires updating the pinned tests in the same change.
- Remote STT stays available only as an explicit, consented option until a verified local path replaces it.
