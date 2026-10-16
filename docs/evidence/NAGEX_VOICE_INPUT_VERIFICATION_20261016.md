# Voice-to-text in the Main composer — audit, blocker, fix, verification

**Status:** EVIDENCE (point-in-time)
**Date:** 2026-10-16
**Base:** `integration/product-completion-20261015` at `3de7b1e9062f3b1c84cce9544de0253496e1b1a2`
**Scope:** the existing microphone button of the Main composer. No new engine, no new modal, no new provider.

## 1. What existed (Phase A)

| Piece | What it is |
|---|---|
| Button | `#main-mic` (dictation) and `#main-voice` (continuous "voice mode") in `public/main-surface.js` |
| Engine | the **browser's own SpeechRecognition** through `public/renderer-voice-adapter.js` (ADR-0013). NAgex hosts **no** speech-to-text engine; there is no server STT route on this path and no audio is uploaded by NAgex |
| Processing location | `LOCAL` when the browser reports on-device recognition for the language; otherwise `THIRD_PARTY` (Chrome → Google, Edge → Microsoft) and **recording starts only after the person allowed that vendor** in NAgex's own consent prompt (withdrawable); unknown browsers / the desktop runtime without STT → `NONE` (reported unavailable) |
| Safety | the adapter only produces text. It never submits, approves or executes. Cancel discards; Stop keeps; a 60 s ceiling; microphone tracks stopped on every exit |
| Tests | `main_surface_hard_rebuild_browser`, `voice_architecture_boundaries` (scripted engine) |

## 2. Verified blockers (a real Chrome 155 session, production server, real PC microphone)

The existing path **worked end to end**: click → consent → microphone permission → recognition → text in the box → released. What actually stood in the way of the requested behaviour:

1. **The recognizer language was fixed to Korean** (`lang: 'ko-KR'` in `startVoiceRecognition`; also the on-device model install). On an English screen the engine therefore listened for Korean, so English dictation could not work (a code-level fact; the unfixed build was not run against an English speaker).
2. **Enter / Send while recording** sent half a sentence and left the recognizer writing into the (cleared) box afterwards.
3. **Typing while dictating** was overwritten by the next interim result.
4. **A missing microphone and a microphone in use** surfaced as the generic "Voice input failed".
5. **The unsupported-browser notice was a dead end** (no way to still talk) and **nothing stopped capture when the person left the screen**.

Not a blocker, by design: the first use asks for the vendor consent (one click) — it is the policy that keeps audio from reaching a provider without the person's knowledge.

## 3. Changes

* language = the screen language (`ko-KR` / `en-US`), also for the on-device model
* Enter and the Send button while recording stop the recording and keep the text for review (same handler as typed input); the next Enter sends
* typing while dictating ends the dictation; a late result never overwrites what was typed
* `NO_MICROPHONE` / `MICROPHONE_BUSY` reasons in the adapter and named notices (KR/EN)
* truthful fallback text per platform when the browser cannot listen: Windows → "Win + H", macOS → system dictation, phones → the keyboard microphone key. **NAgex presses, simulates or automates nothing** — it only tells the person what their system offers
* capture stops on `pagehide` and when the person leaves Home
* `scripts/voice-real-browser-check.mjs`: the real-browser / real-microphone check (not part of CI)

## 4. Verification

* `tests/voice_input_browser.test.ts` (18, real Chromium, scripted engine): KR/EN language, consent before recording, interim/final text, no submit at the end of recognition, edit then Enter, duplicate final, permission denied, no microphone / busy, unsupported browser per platform, Korean notices, repeated clicks, stop / cancel / Escape, typing, Enter / Send while recording, leaving the screen, voice-dictated action stays a plan preview, IME Enter, 360/390/430 px.
* Real engine (Chrome 155 + Google speech + the PC's microphone, `scripts/voice-real-browser-check.mjs`): the click reached `LISTENING`, the text reached the box, recognition ended in `IDLE`, **no request was made by the end of recognition**, the microphone was released. Phrases were spoken by a Windows voice through the PC's speakers and picked up by the real microphone: Korean `안녕하세요. 오늘 일정을 알려 주세요.` → `안녕하세요`; English `What is on my schedule today?` → `what is`. The engine ended each recognition at its own end-of-speech detection, so the rest of the sentence was not captured in these two runs (speaker→microphone loopback quality). Recognition accuracy belongs to the vendor engine and is not claimed.
* An earlier probe run before the language fix recorded two unrelated Korean sentences from the room (the microphone is real and open to ambient sound while recording — which is what the consent text says).
* Chrome's fake-audio-file switch does **not** feed `SpeechRecognition` (it feeds only `getUserMedia`), so file-driven speech E2E is not possible with Chrome's engine.
* Windows `Win + H` (system dictation) writes into the composer like into any text field. It is an operating-system feature outside the page; it was **not** automated or simulated here and is not claimed as tested.

## 5. Not done / open

* Edge (Microsoft vendor path) and Android Chrome were not exercised with a real engine.
* No on-device recognition model was installed or tested.
* Continuous dictation across long pauses is the browser engine's behaviour (non-continuous mode ends at the first end of speech); changing it would be a UX decision.
