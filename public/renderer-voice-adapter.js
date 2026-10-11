(function () {
  'use strict';

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    REQUESTING_PERMISSION: 'REQUESTING_PERMISSION',
    LISTENING: 'LISTENING',
    TRANSCRIBING: 'TRANSCRIBING',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    UNAVAILABLE: 'UNAVAILABLE',
    ERROR: 'ERROR',
  });

  function recognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function permissionName() {
    return { name: 'microphone' };
  }

  class RendererVoiceAdapter {
    constructor(options) {
      this.options = options || {};
      this.state = STATES.IDLE;
      this.mediaStream = null;
      this.recognition = null;
      this.finalTranscript = '';
      this.cancelled = false;
      this.activeSession = null;
      this.lastDiagnostic = null;
    }

    isActive() {
      return Boolean(this.recognition || this.mediaStream);
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
      if (this.isActive()) {
        await this.cancel();
        return { state: STATES.CANCELLED, transcript: '' };
      }
      this.diagnose('START_REQUESTED', {
        secureContext: Boolean(window.isSecureContext),
        mediaDevices: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        speechRecognition: Boolean(recognitionCtor()),
      });
      const Recognition = recognitionCtor();
      if (!Recognition) {
        this.diagnose('UNAVAILABLE', { reason: 'SPEECH_RECOGNITION_UNAVAILABLE' });
        this.transition(STATES.UNAVAILABLE, { reason: 'SPEECH_RECOGNITION_UNAVAILABLE' });
        return { state: STATES.UNAVAILABLE, transcript: '' };
      }
      const permission = await this.microphonePermission();
      this.diagnose('MIC_PERMISSION', { permission });
      if (permission === STATES.UNAVAILABLE || permission === STATES.PERMISSION_DENIED) {
        this.transition(permission, { reason: permission });
        return { state: permission, transcript: '' };
      }

      this.cancelled = false;
      this.finalTranscript = '';
      this.activeSession = opts.session || null;
      this.transition(STATES.REQUESTING_PERMISSION, { session: this.activeSession });

      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.diagnose('MEDIA_STREAM_OPENED', {
          audioTracks: this.mediaStream.getAudioTracks ? this.mediaStream.getAudioTracks().length : undefined,
          tracks: this.mediaStream.getTracks ? this.mediaStream.getTracks().length : undefined,
        });
      } catch (error) {
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
        const state = denied ? STATES.PERMISSION_DENIED : STATES.ERROR;
        this.diagnose('MEDIA_STREAM_ERROR', { name: error && error.name, message: error && error.message, state });
        this.cleanup();
        this.transition(state, { error, session: this.activeSession });
        return { state, transcript: '' };
      }

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (payload, detail) => {
          if (settled) return;
          settled = true;
          this.cleanup();
          this.transition(payload.state, { ...(detail || {}), session: this.activeSession });
          resolve(payload);
        };
        const recognition = new Recognition();
        recognition.lang = opts.lang || this.options.lang || 'ko-KR';
        recognition.interimResults = opts.interimResults !== false;
        recognition.continuous = Boolean(opts.continuous);
        recognition.maxAlternatives = 1;
        this.recognition = recognition;

        recognition.onstart = () => {
          this.diagnose('RECOGNITION_STARTED', { lang: recognition.lang, continuous: recognition.continuous });
          this.transition(STATES.LISTENING, { session: this.activeSession });
        };
        recognition.onresult = (event) => {
          this.diagnose('RECOGNITION_RESULT', { resultIndex: event.resultIndex, resultCount: event.results ? event.results.length : undefined });
          this.transition(STATES.TRANSCRIBING, { session: this.activeSession });
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const text = result && result[0] && result[0].transcript ? result[0].transcript.trim() : '';
            if (!text) continue;
            if (result.isFinal) this.finalTranscript += (this.finalTranscript ? ' ' : '') + text;
            else interim += (interim ? ' ' : '') + text;
          }
          this.options.onTranscript?.({
            finalTranscript: this.finalTranscript,
            interimTranscript: interim,
            transcript: [this.finalTranscript, interim].filter(Boolean).join(' ').trim(),
            session: this.activeSession,
          });
        };
        recognition.onerror = (event) => {
          const normalized = this.normalizeError(event);
          this.diagnose('RECOGNITION_ERROR', { error: event && event.error, message: event && event.message, state: normalized.state, reason: normalized.reason });
          finish({ state: normalized.state, transcript: this.finalTranscript, reason: normalized.reason }, { error: event, reason: normalized.reason });
        };
        recognition.onend = () => {
          const transcript = this.finalTranscript.trim();
          const state = this.cancelled ? STATES.CANCELLED : transcript ? STATES.COMPLETED : STATES.CANCELLED;
          const reason = transcript ? undefined : 'NO_TRANSCRIPT';
          this.diagnose('RECOGNITION_ENDED', { state, transcriptLength: transcript.length, reason });
          finish({ state, transcript, reason }, { transcript, reason });
        };

        try {
          recognition.start();
        } catch (error) {
          this.diagnose('RECOGNITION_START_ERROR', { name: error && error.name, message: error && error.message });
          finish({ state: STATES.ERROR, transcript: '', reason: 'START_FAILED' }, { error, reason: 'START_FAILED' });
        }
      });
    }

    async cancel() {
      this.cancelled = true;
      if (this.recognition) {
        try { this.recognition.stop(); } catch {}
      }
      this.cleanup();
      this.transition(STATES.CANCELLED, { session: this.activeSession });
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
      if (code === 'no-speech' || code === 'aborted') return { state: STATES.CANCELLED, reason: code };
      if (code === 'network') return { state: STATES.ERROR, reason: 'SPEECH_RECOGNITION_NETWORK' };
      return { state: STATES.ERROR, reason: code };
    }

    transition(nextState, detail) {
      this.state = nextState;
      this.options.onStateChange?.({ state: nextState, detail: detail || {}, active: this.isActive() });
    }

    diagnose(event, detail) {
      const diagnostic = {
        event,
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

  window.NAGEX_RENDERER_VOICE = Object.freeze({ RendererVoiceAdapter, STATES });
})();
