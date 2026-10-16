(function () {
  'use strict';

  // Renderer Voice Adapter (ADR-0013).
  //
  // Capture only: microphone in, transcript text out. It never submits, approves or executes anything.
  //
  // Processing-location policy (NAgex hosts no speech-to-text engine of its own; see ADR-0013):
  //   LOCAL        browser reports on-device recognition for the language (SpeechRecognition.available(...) === 'available')
  //                and processLocally is applied. No audio leaves the device, no consent needed.
  //   THIRD_PARTY  the browser vendor's speech service (Chrome -> Google, Edge -> Microsoft). Audio is sent to that vendor,
  //                so recording starts only after provider-specific informed consent.
  //   NONE         no compliant engine (unknown provider, desktop runtime without STT, no SpeechRecognition).
  //                Voice is reported unavailable; text input remains.
  // A browser SpeechRecognition is never assumed to be local. There is no fallback from one processor to another.

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    REQUESTING_PERMISSION: 'REQUESTING_PERMISSION',
    LISTENING: 'LISTENING',
    TRANSCRIBING: 'TRANSCRIBING',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    UNAVAILABLE: 'UNAVAILABLE',
    CONSENT_REQUIRED: 'CONSENT_REQUIRED',
    ERROR: 'ERROR',
  });

  const CONSENT_STORAGE_KEY = 'nagex_voice_consent_v1';
  const THIRD_PARTY_DISCLOSURE_VERSION = 1;
  const DEFAULT_MAX_RECORD_MS = 60000;
  const STOP_TIMEOUT_MS = 10000;

  function recognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function permissionName() {
    return { name: 'microphone' };
  }

  // ── Voice-processing consent (separate from execution approval) ─────────────
  let memoryGrants = {};

  function readGrants() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(CONSENT_STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 1 && parsed.grants && typeof parsed.grants === 'object') return { ...parsed.grants };
      }
      return window.localStorage ? {} : { ...memoryGrants };
    } catch {
      return { ...memoryGrants };
    }
  }

  function writeGrants(grants) {
    memoryGrants = { ...grants };
    try {
      if (window.localStorage) window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: 1, grants }));
    } catch {
      // storage unavailable: consent lives for this page session only
    }
  }

  const consent = Object.freeze({
    keyFor(provider) {
      return 'third-party:' + provider + ':v' + THIRD_PARTY_DISCLOSURE_VERSION;
    },
    has(key) {
      return Boolean(key && readGrants()[key]);
    },
    grant(key) {
      if (!key) return;
      const grants = readGrants();
      grants[key] = new Date().toISOString();
      writeGrants(grants);
    },
    withdraw(key) {
      const grants = readGrants();
      delete grants[key];
      writeGrants(grants);
    },
    withdrawAll() {
      writeGrants({});
    },
    list() {
      return Object.entries(readGrants()).map(([key, grantedAt]) => ({ key, grantedAt }));
    },
  });

  // ── Processor resolution ────────────────────────────────────────────────────
  function detectProvider() {
    const ua = (window.navigator && window.navigator.userAgent) || '';
    if (/Electron\//.test(ua)) return { id: null, reason: 'DESKTOP_RUNTIME_NO_STT' };
    if (/\bEdg\//.test(ua)) return { id: 'microsoft', label: 'Microsoft' };
    if (/\bOPR\//.test(ua) || /Firefox\//.test(ua) || /Safari\//.test(ua) && !/Chrome\//.test(ua)) return { id: null, reason: 'PROVIDER_UNKNOWN' };
    if (/Chrome\//.test(ua)) return { id: 'google', label: 'Google' };
    return { id: null, reason: 'PROVIDER_UNKNOWN' };
  }

  async function resolveProcessor(lang) {
    const Ctor = recognitionCtor();
    if (!Ctor) return { kind: 'NONE', reason: 'SPEECH_RECOGNITION_UNAVAILABLE' };
    const runtime = detectProvider();
    if (runtime.reason === 'DESKTOP_RUNTIME_NO_STT') return { kind: 'NONE', reason: runtime.reason };
    let localAvailability = 'unsupported';
    if (typeof Ctor.available === 'function') {
      try {
        localAvailability = String(await Ctor.available({ langs: [lang], processLocally: true }));
      } catch {
        localAvailability = 'unknown';
      }
    }
    if (localAvailability === 'available') return { kind: 'LOCAL', label: 'On this device', localAvailability };
    if (!runtime.id) return { kind: 'NONE', reason: runtime.reason || 'PROVIDER_UNKNOWN', localAvailability };
    return {
      kind: 'THIRD_PARTY',
      provider: runtime.id,
      label: runtime.label,
      consentKey: consent.keyFor(runtime.id),
      localAvailability,
      localInstallable: localAvailability === 'downloadable',
    };
  }

  // Downloads the browser's on-device speech model (model data only; no audio is sent). User-initiated by the caller.
  async function installLocalModel(lang) {
    const Ctor = recognitionCtor();
    if (!Ctor || typeof Ctor.install !== 'function') return false;
    try {
      return Boolean(await Ctor.install({ langs: [lang || 'ko-KR'], processLocally: true }));
    } catch {
      return false;
    }
  }

  class RendererVoiceAdapter {
    constructor(options) {
      this.options = options || {};
      this.state = STATES.IDLE;
      this.mediaStream = null;
      this.recognition = null;
      this.finalTranscript = '';
      this.cancelled = false;
      this.stopRequested = false;
      this.starting = false;
      this.runId = 0;
      this.settleRun = null;
      this.maxTimer = null;
      this.stopTimer = null;
      this.processor = null;
      this.activeSession = null;
      this.lastDiagnostic = null;
      this.lastResultDiagnostic = null;
      this.committedFinalResults = new Set();
    }

    isActive() {
      return Boolean(this.starting || this.recognition || this.mediaStream);
    }

    async microphonePermission() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return STATES.UNAVAILABLE;
      if (!navigator.permissions || !navigator.permissions.query) return 'UNKNOWN';
      try {
        const permission = await navigator.permissions.query(permissionName());
        if (permission.state === 'granted') return 'ALLOWED';
        if (permission.state === 'denied') return STATES.PERMISSION_DENIED;
        return 'UNKNOWN';
      } catch {
        return 'UNKNOWN';
      }
    }

    async start(options) {
      const opts = options || {};
      if (this.isActive()) return { state: this.state, transcript: '', reason: 'BUSY' };
      const runId = this.runId + 1;
      this.runId = runId;
      this.starting = true;
      this.cancelled = false;
      this.stopRequested = false;
      this.finalTranscript = '';
      this.lastResultDiagnostic = null;
      this.committedFinalResults = new Set();
      this.activeSession = opts.session || null;

      const lang = opts.lang || this.options.lang || 'ko-KR';
      this.diagnose('START_REQUESTED', {
        secureContext: Boolean(window.isSecureContext),
        mediaDevices: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        speechRecognition: Boolean(recognitionCtor()),
      });

      const prepared = await this.prepare(lang, runId);
      this.starting = false;
      if (prepared.fail) return prepared.fail;
      const processor = prepared.processor;

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (payload, detail) => {
          if (settled) return;
          settled = true;
          this.clearTimers();
          this.settleRun = null;
          this.cleanup();
          this.transition(payload.state, { ...(detail || {}), session: this.activeSession });
          resolve({ ...payload, processor });
        };
        this.settleRun = finish;

        const Recognition = recognitionCtor();
        const recognition = new Recognition();
        recognition.lang = lang;
        recognition.interimResults = opts.interimResults !== false;
        recognition.continuous = Boolean(opts.continuous);
        recognition.maxAlternatives = 1;
        if (processor.kind === 'LOCAL') {
          if ('processLocally' in recognition) recognition.processLocally = true;
          if (!('processLocally' in recognition) || recognition.processLocally !== true) {
            // never claim on-device processing the browser did not accept
            this.diagnose('LOCAL_PROCESSING_NOT_APPLIED', {});
            finish({ state: STATES.UNAVAILABLE, transcript: '', reason: 'LOCAL_PROCESSING_NOT_VERIFIED' }, { reason: 'LOCAL_PROCESSING_NOT_VERIFIED' });
            return;
          }
        }
        this.recognition = recognition;

        recognition.onstart = () => {
          this.diagnose('RECOGNITION_STARTED', { lang: recognition.lang, continuous: recognition.continuous, processor: processor.kind });
          this.transition(STATES.LISTENING, { session: this.activeSession });
        };
        recognition.onresult = (event) => {
          if (this.cancelled || runId !== this.runId) return;
          let interim = '';
          let resultDiagnostic = {
            resultIndex: event.resultIndex,
            resultCount: event.results ? event.results.length : 0,
            alternativeCount: 0,
            alternativePresent: false,
            rawTranscriptType: 'undefined',
            rawTranscriptLength: 0,
            isFinal: false,
            transcriptLength: 0,
            transcriptPresent: false,
            confidencePresent: false,
            confidence: null,
            callbackDelivered: false,
          };
          const startIndex = Number.isFinite(event.resultIndex) ? event.resultIndex : 0;
          for (let i = startIndex; event.results && i < event.results.length; i += 1) {
            const result = event.results[i];
            const alternative = result && result[0] ? result[0] : null;
            const rawTranscriptValue = alternative ? alternative.transcript : undefined;
            const rawTranscript = typeof rawTranscriptValue === 'string' ? rawTranscriptValue : '';
            const text = rawTranscript.trim();
            const confidence = alternative && typeof alternative.confidence === 'number' ? alternative.confidence : null;
            resultDiagnostic = {
              resultIndex: event.resultIndex,
              resultOffset: i,
              resultCount: event.results ? event.results.length : 0,
              alternativeCount: result && typeof result.length === 'number' ? result.length : 0,
              alternativePresent: Boolean(alternative),
              rawTranscriptType: typeof rawTranscriptValue,
              rawTranscriptLength: rawTranscript.length,
              isFinal: Boolean(result && result.isFinal),
              transcriptLength: text.length,
              transcriptPresent: text.length > 0,
              confidencePresent: confidence !== null,
              confidence,
              callbackDelivered: false,
            };
            if (!text) continue;
            if (result.isFinal) {
              const finalKey = [i, text].join(':');
              if (!this.committedFinalResults.has(finalKey)) {
                this.committedFinalResults.add(finalKey);
                this.finalTranscript += (this.finalTranscript ? ' ' : '') + text;
              }
            } else {
              interim += (interim ? ' ' : '') + text;
            }
          }
          this.lastResultDiagnostic = resultDiagnostic;
          this.diagnose('RECOGNITION_RESULT', resultDiagnostic);
          try {
            this.options.onTranscript?.({
              finalTranscript: this.finalTranscript,
              interimTranscript: interim,
              transcript: [this.finalTranscript, interim].filter(Boolean).join(' ').trim(),
              session: this.activeSession,
            });
            this.lastResultDiagnostic = { ...resultDiagnostic, callbackDelivered: true };
            this.diagnose('TRANSCRIPT_CALLBACK_DELIVERED', {
              ...this.lastResultDiagnostic,
              finalTranscriptLength: this.finalTranscript.trim().length,
              interimTranscriptLength: interim.trim().length,
            });
          } catch (error) {
            this.lastResultDiagnostic = { ...resultDiagnostic, callbackDelivered: false };
            this.diagnose('TRANSCRIPT_CALLBACK_ERROR', {
              ...this.lastResultDiagnostic,
              name: error && error.name,
              message: error && error.message,
            });
          }
        };
        recognition.onerror = (event) => {
          const normalized = this.normalizeError(event);
          this.diagnose('RECOGNITION_ERROR', { error: event && event.error, message: event && event.message, state: normalized.state, reason: normalized.reason });
          finish({ state: normalized.state, transcript: this.cancelled ? '' : this.finalTranscript, reason: normalized.reason }, { error: event, reason: normalized.reason });
        };
        recognition.onend = () => {
          if (this.cancelled) {
            this.diagnose('RECOGNITION_ENDED', { state: STATES.CANCELLED, transcriptLength: 0, reason: 'cancelled' });
            finish({ state: STATES.CANCELLED, transcript: '', reason: 'cancelled' }, { reason: 'cancelled' });
            return;
          }
          const transcript = this.finalTranscript.trim();
          const state = transcript ? STATES.COMPLETED : STATES.CANCELLED;
          const reason = transcript ? undefined : 'NO_TRANSCRIPT';
          this.diagnose('RECOGNITION_ENDED', { state, transcriptLength: transcript.length, reason });
          finish({ state, transcript, reason }, { transcript, reason });
        };

        // Consent can be withdrawn while the page is open: re-check immediately before any remote audio flows.
        if (processor.kind === 'THIRD_PARTY' && !consent.has(processor.consentKey)) {
          finish({ state: STATES.CONSENT_REQUIRED, transcript: '', reason: 'CONSENT_REQUIRED' }, { reason: 'CONSENT_REQUIRED' });
          return;
        }

        const maxRecordMs = opts.maxRecordMs || window.NAGEX_STT_MAX_RECORD_MS || DEFAULT_MAX_RECORD_MS;
        this.maxTimer = setTimeout(() => { this.stop(); }, maxRecordMs);

        try {
          recognition.start();
        } catch (error) {
          this.diagnose('RECOGNITION_START_ERROR', { name: error && error.name, message: error && error.message });
          finish({ state: STATES.ERROR, transcript: '', reason: 'START_FAILED' }, { error, reason: 'START_FAILED' });
        }
      });
    }

    // Resolves the processor, enforces consent and opens the microphone. No audio is captured by NAgex code itself;
    // the stream is held only so the permission prompt and track lifecycle are explicit.
    async prepare(lang, runId) {
      const processor = await resolveProcessor(lang);
      if (runId !== this.runId || this.cancelled) {
        return { fail: { state: STATES.CANCELLED, transcript: '', reason: 'cancelled' } };
      }
      this.processor = processor;
      this.diagnose('PROCESSOR_RESOLVED', { kind: processor.kind, provider: processor.provider || '', localAvailability: processor.localAvailability || '', reason: processor.reason || '' });
      try { this.options.onProcessor?.(processor); } catch {}

      if (processor.kind === 'NONE') {
        this.diagnose('UNAVAILABLE', { reason: processor.reason });
        this.transition(STATES.UNAVAILABLE, { reason: processor.reason });
        return { fail: { state: STATES.UNAVAILABLE, transcript: '', reason: processor.reason, processor } };
      }
      if (processor.kind === 'THIRD_PARTY' && !consent.has(processor.consentKey)) {
        this.diagnose('CONSENT_REQUIRED', { provider: processor.provider });
        this.transition(STATES.CONSENT_REQUIRED, { reason: 'CONSENT_REQUIRED', processor });
        return { fail: { state: STATES.CONSENT_REQUIRED, transcript: '', reason: 'CONSENT_REQUIRED', processor } };
      }

      const permission = await this.microphonePermission();
      this.diagnose('MIC_PERMISSION', { permission });
      if (permission === STATES.UNAVAILABLE || permission === STATES.PERMISSION_DENIED) {
        this.transition(permission, { reason: permission });
        return { fail: { state: permission, transcript: '', processor } };
      }
      this.transition(STATES.REQUESTING_PERMISSION, { session: this.activeSession });
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.diagnose('MEDIA_STREAM_OPENED', {
          audioTracks: this.mediaStream.getAudioTracks ? this.mediaStream.getAudioTracks().length : undefined,
          tracks: this.mediaStream.getTracks ? this.mediaStream.getTracks().length : undefined,
        });
      } catch (error) {
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
        const missing = error && (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError');
        const busy = error && (error.name === 'NotReadableError' || error.name === 'TrackStartError');
        const reason = missing ? 'NO_MICROPHONE' : busy ? 'MICROPHONE_BUSY' : undefined;
        const state = denied ? STATES.PERMISSION_DENIED : missing ? STATES.UNAVAILABLE : STATES.ERROR;
        this.diagnose('MEDIA_STREAM_ERROR', { name: error && error.name, message: error && error.message, state });
        this.cleanup();
        this.transition(state, { error, reason, session: this.activeSession });
        return { fail: { state, transcript: '', reason, processor } };
      }
      if (runId !== this.runId || this.cancelled) {
        this.cleanup();
        return { fail: { state: STATES.CANCELLED, transcript: '', reason: 'cancelled', processor } };
      }
      return { processor };
    }

    // Stop recording and transcribe what was captured so far. Never discards.
    async stop() {
      if (!this.recognition || this.stopRequested || this.cancelled) return;
      this.stopRequested = true;
      this.diagnose('STOP_REQUESTED', {});
      this.transition(STATES.TRANSCRIBING, { session: this.activeSession });
      try { this.recognition.stop(); } catch {}
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        // the engine did not finish after stop(): give up truthfully instead of waiting forever
        if (this.recognition) { try { this.recognition.abort(); } catch {} }
        this.settleRun?.({ state: STATES.CANCELLED, transcript: '', reason: 'NO_TRANSCRIPT' }, { reason: 'NO_TRANSCRIPT' });
      }, STOP_TIMEOUT_MS);
    }

    // Discard the recording: nothing is delivered after cancel.
    async cancel() {
      this.cancelled = true;
      this.finalTranscript = '';
      this.runId += 1;
      if (this.recognition) {
        try { this.recognition.abort(); } catch { try { this.recognition.stop(); } catch {} }
      }
      if (this.settleRun) {
        this.settleRun({ state: STATES.CANCELLED, transcript: '', reason: 'cancelled' }, { reason: 'cancelled' });
        return;
      }
      this.clearTimers();
      this.cleanup();
      this.transition(STATES.CANCELLED, { session: this.activeSession });
    }

    clearTimers() {
      clearTimeout(this.maxTimer);
      clearTimeout(this.stopTimer);
      this.maxTimer = null;
      this.stopTimer = null;
    }

    cleanup() {
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((track) => {
          try { track.stop(); } catch {}
        });
      }
      this.mediaStream = null;
      this.recognition = null;
    }

    normalizeError(event) {
      const code = event && event.error ? String(event.error) : 'UNKNOWN';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        return { state: STATES.PERMISSION_DENIED, reason: code };
      }
      if (code === 'audio-capture') return { state: STATES.UNAVAILABLE, reason: code };
      if (code === 'language-not-supported') return { state: STATES.UNAVAILABLE, reason: code };
      if (code === 'no-speech' || code === 'aborted') return { state: STATES.CANCELLED, reason: code };
      if (code === 'network') return { state: STATES.ERROR, reason: 'SPEECH_RECOGNITION_NETWORK' };
      return { state: STATES.ERROR, reason: code };
    }

    transition(nextState, detail) {
      this.state = nextState;
      this.options.onStateChange?.({ state: nextState, detail: detail || {}, active: this.isActive() });
    }

    diagnose(event, detail) {
      const resultDiagnostic = this.lastResultDiagnostic || {};
      const diagnostic = {
        event,
        resultIndex: resultDiagnostic.resultIndex,
        resultCount: resultDiagnostic.resultCount,
        alternativeCount: resultDiagnostic.alternativeCount,
        alternativePresent: resultDiagnostic.alternativePresent,
        rawTranscriptType: resultDiagnostic.rawTranscriptType,
        rawTranscriptLength: resultDiagnostic.rawTranscriptLength,
        isFinal: resultDiagnostic.isFinal,
        transcriptLength: resultDiagnostic.transcriptLength,
        transcriptPresent: resultDiagnostic.transcriptPresent,
        confidencePresent: resultDiagnostic.confidencePresent,
        confidence: resultDiagnostic.confidence,
        callbackDelivered: resultDiagnostic.callbackDelivered,
        detail: detail || {},
        state: this.state,
        at: new Date().toISOString(),
      };
      this.lastDiagnostic = diagnostic;
      window.__NAGEX_LAST_VOICE_DIAGNOSTIC = diagnostic;
      try {
        window.dispatchEvent(new CustomEvent('nagex:voice-diagnostic', { detail: diagnostic }));
      } catch {}
      if (this.options.onDiagnostic) this.options.onDiagnostic(diagnostic);
      if (window.console && window.console.info) window.console.info('[NAgex voice]', diagnostic);
    }
  }

  window.NAGEX_RENDERER_VOICE = Object.freeze({ RendererVoiceAdapter, STATES, consent, resolveProcessor, installLocalModel });
})();
