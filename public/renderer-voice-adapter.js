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

  function localWhisperConfig() {
    const storage = window.localStorage || null;
    const backend = window.NAGEX_STT_BACKEND || (storage && storage.getItem('nagex_stt_backend')) || '';
    const endpoint = window.NAGEX_LOCAL_STT_ENDPOINT || (storage && storage.getItem('nagex_stt_endpoint')) || 'http://127.0.0.1:4760';
    const token = window.NAGEX_LOCAL_STT_TOKEN || (storage && storage.getItem('nagex_stt_token')) || '';
    return { enabled: backend === 'whisper-local', endpoint: endpoint.replace(/\/$/, ''), token };
  }

  class RendererVoiceAdapter {
    constructor(options) {
      this.options = options || {};
      this.state = STATES.IDLE;
      this.mediaStream = null;
      this.recognition = null;
      this.audioContext = null;
      this.audioProcessor = null;
      this.audioChunks = [];
      this.audioSampleRate = 16000;
      this.finalTranscript = '';
      this.cancelled = false;
      this.activeSession = null;
      this.lastDiagnostic = null;
      this.lastResultDiagnostic = null;
      this.committedFinalResults = new Set();
    }

    isActive() {
      return Boolean(this.recognition || this.mediaStream || this.audioContext);
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
        localWhisper: localWhisperConfig().enabled,
      });
      const whisper = localWhisperConfig();
      if (whisper.enabled) return await this.startLocalWhisper(opts, whisper);
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
      this.lastResultDiagnostic = null;
      this.committedFinalResults = new Set();
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
          this.transition(STATES.TRANSCRIBING, { session: this.activeSession });
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

    async startLocalWhisper(opts, whisper) {
      const permission = await this.microphonePermission();
      this.diagnose('MIC_PERMISSION', { permission, backend: 'whisper-local' });
      if (permission === STATES.UNAVAILABLE || permission === STATES.PERMISSION_DENIED) {
        this.transition(permission, { reason: permission, backend: 'whisper-local' });
        return { state: permission, transcript: '' };
      }
      this.cancelled = false;
      this.finalTranscript = '';
      this.lastResultDiagnostic = null;
      this.committedFinalResults = new Set();
      this.activeSession = opts.session || null;
      this.transition(STATES.REQUESTING_PERMISSION, { session: this.activeSession, backend: 'whisper-local' });

      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
        this.diagnose('MEDIA_STREAM_OPENED', {
          backend: 'whisper-local',
          audioTracks: this.mediaStream.getAudioTracks ? this.mediaStream.getAudioTracks().length : undefined,
          tracks: this.mediaStream.getTracks ? this.mediaStream.getTracks().length : undefined,
        });
      } catch (error) {
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
        const state = denied ? STATES.PERMISSION_DENIED : STATES.ERROR;
        this.diagnose('MEDIA_STREAM_ERROR', { backend: 'whisper-local', name: error && error.name, message: error && error.message, state });
        this.cleanup();
        this.transition(state, { error, session: this.activeSession, backend: 'whisper-local' });
        return { state, transcript: '' };
      }

      this.transition(STATES.LISTENING, { session: this.activeSession, backend: 'whisper-local' });
      const maxRecordMs = opts.maxRecordMs || window.NAGEX_STT_MAX_RECORD_MS || 9000;
      this.diagnose('WHISPER_LOCAL_RECORDING_STARTED', { backend: 'whisper-local', maxRecordMs });

      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        this.cleanup();
        this.transition(STATES.UNAVAILABLE, { reason: 'AUDIO_CONTEXT_UNAVAILABLE', backend: 'whisper-local' });
        return { state: STATES.UNAVAILABLE, transcript: '', reason: 'AUDIO_CONTEXT_UNAVAILABLE' };
      }

      this.audioChunks = [];
      this.audioContext = new AudioContextCtor({ sampleRate: 16000 });
      this.audioSampleRate = this.audioContext.sampleRate || 16000;
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.audioProcessor.onaudioprocess = (event) => {
        this.audioChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(this.audioProcessor);
      this.audioProcessor.connect(this.audioContext.destination);

      await new Promise((resolve) => setTimeout(resolve, maxRecordMs));
      if (this.cancelled) {
        this.cleanup();
        this.transition(STATES.CANCELLED, { reason: 'cancelled', backend: 'whisper-local' });
        return { state: STATES.CANCELLED, transcript: '', reason: 'cancelled' };
      }

      this.transition(STATES.TRANSCRIBING, { session: this.activeSession, backend: 'whisper-local' });
      const samples = this.resample(this.flattenAudio(), this.audioSampleRate, 16000);
      const wav = this.encodeWav(samples, 16000);
      const started = performance.now();
      try {
        const headers = { 'content-type': 'audio/wav' };
        if (whisper.token) headers['x-nagex-stt-token'] = whisper.token;
        const response = await fetch(`${whisper.endpoint}/transcribe`, { method: 'POST', headers, body: wav });
        const result = await response.json().catch(() => ({}));
        const transcript = typeof result.transcript === 'string' ? result.transcript.trim() : '';
        this.lastResultDiagnostic = {
          resultIndex: 0,
          resultCount: transcript ? 1 : 0,
          alternativeCount: transcript ? 1 : 0,
          alternativePresent: Boolean(transcript),
          rawTranscriptType: 'string',
          rawTranscriptLength: transcript.length,
          isFinal: Boolean(transcript),
          transcriptLength: transcript.length,
          transcriptPresent: Boolean(transcript),
          confidencePresent: false,
          confidence: null,
          callbackDelivered: false,
        };
        this.diagnose('WHISPER_LOCAL_RESULT', {
          backend: 'whisper-local',
          ok: Boolean(response.ok && transcript),
          status: response.status,
          transcriptLength: transcript.length,
          durationSeconds: result.durationSeconds,
          sttLatencyMs: result.latencyMs,
          browserRoundTripMs: Math.round(performance.now() - started),
          peakRssMb: result.peakRssMb,
          reason: result.reason,
        });
        if (!response.ok || !transcript) {
          this.cleanup();
          this.transition(STATES.CANCELLED, { reason: result.reason || 'NO_TRANSCRIPT', backend: 'whisper-local' });
          return { state: STATES.CANCELLED, transcript: '', reason: result.reason || 'NO_TRANSCRIPT' };
        }
        this.finalTranscript = transcript;
        this.options.onTranscript?.({
          finalTranscript: transcript,
          interimTranscript: '',
          transcript,
          session: this.activeSession,
        });
        this.lastResultDiagnostic = { ...this.lastResultDiagnostic, callbackDelivered: true };
        this.diagnose('TRANSCRIPT_CALLBACK_DELIVERED', {
          backend: 'whisper-local',
          finalTranscriptLength: transcript.length,
          interimTranscriptLength: 0,
        });
        this.cleanup();
        this.transition(STATES.COMPLETED, { transcript, session: this.activeSession, backend: 'whisper-local' });
        return { state: STATES.COMPLETED, transcript };
      } catch (error) {
        this.diagnose('WHISPER_LOCAL_ERROR', { backend: 'whisper-local', name: error && error.name, message: error && error.message });
        this.cleanup();
        this.transition(STATES.ERROR, { error, reason: 'WHISPER_LOCAL_ERROR', backend: 'whisper-local' });
        return { state: STATES.ERROR, transcript: '', reason: 'WHISPER_LOCAL_ERROR' };
      }
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
      if (this.audioProcessor) {
        try { this.audioProcessor.disconnect(); } catch {}
      }
      if (this.audioContext) {
        try { this.audioContext.close(); } catch {}
      }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((track) => {
          try { track.stop(); } catch {}
        });
      }
      this.mediaStream = null;
      this.recognition = null;
      this.audioContext = null;
      this.audioProcessor = null;
      this.audioChunks = [];
    }

    flattenAudio() {
      const total = this.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const samples = new Float32Array(total);
      let offset = 0;
      for (const chunk of this.audioChunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      return samples;
    }

    resample(samples, fromRate, toRate) {
      if (fromRate === toRate) return samples;
      const ratio = fromRate / toRate;
      const length = Math.floor(samples.length / ratio);
      const output = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        const sourceIndex = i * ratio;
        const before = Math.floor(sourceIndex);
        const after = Math.min(before + 1, samples.length - 1);
        const weight = sourceIndex - before;
        output[i] = samples[before] * (1 - weight) + samples[after] * weight;
      }
      return output;
    }

    encodeWav(samples, sampleRate) {
      const dataLength = samples.length * 2;
      const buffer = new ArrayBuffer(44 + dataLength);
      const view = new DataView(buffer);
      const write = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
      write(0, 'RIFF');
      view.setUint32(4, 36 + dataLength, true);
      write(8, 'WAVE');
      write(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, dataLength, true);
      let offset = 44;
      for (const sample of samples) {
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
      return new Blob([view], { type: 'audio/wav' });
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

  window.NAGEX_RENDERER_VOICE = Object.freeze({ RendererVoiceAdapter, STATES });
})();
