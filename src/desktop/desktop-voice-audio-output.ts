export interface DesktopVoiceAudioCallbacks {
  readonly onStarted?: () => void;
  readonly onCompleted?: () => void;
  readonly onError?: (error: Error) => void;
}

export interface DesktopVoiceAudioOutputPort {
  playFile(path: string, callbacks?: DesktopVoiceAudioCallbacks): Promise<void>;
  playBytes(bytes: Uint8Array, mimeType: string, callbacks?: DesktopVoiceAudioCallbacks): Promise<void>;
  stop(): Promise<void>;
  release(): Promise<void>;
}

export class DesktopVoiceAudioOutput implements DesktopVoiceAudioOutputPort {
  private active = false;
  private released = false;

  async playFile(path: string, callbacks: DesktopVoiceAudioCallbacks = {}): Promise<void> {
    if (this.released) throw new Error('DesktopVoiceAudioOutput has been released.');
    if (!path) throw new Error('Audio file path is required.');
    this.active = true;
    callbacks.onStarted?.();
  }

  async playBytes(bytes: Uint8Array, mimeType: string, callbacks: DesktopVoiceAudioCallbacks = {}): Promise<void> {
    if (this.released) throw new Error('DesktopVoiceAudioOutput has been released.');
    if (!bytes.byteLength) throw new Error('Audio bytes are required.');
    if (!mimeType) throw new Error('Audio mime type is required.');
    this.active = true;
    callbacks.onStarted?.();
  }

  async complete(callbacks: DesktopVoiceAudioCallbacks = {}): Promise<void> {
    if (!this.active) return;
    this.active = false;
    callbacks.onCompleted?.();
  }

  async stop(): Promise<void> {
    this.active = false;
  }

  async release(): Promise<void> {
    this.active = false;
    this.released = true;
  }

  isActive(): boolean {
    return this.active;
  }

  isReleased(): boolean {
    return this.released;
  }
}
