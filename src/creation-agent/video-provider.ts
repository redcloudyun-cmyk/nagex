import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface VideoScenePlan {
  readonly sceneId: string;
  readonly imageFile: string;
  readonly caption: string;
  readonly durationSeconds: number;
  readonly transition: 'CUT' | 'FADE';
}

export interface VideoRenderRequest {
  readonly goalId: string;
  readonly scenes: readonly VideoScenePlan[];
  readonly outputPath: string;
  readonly derivedFromArtifactIds: readonly string[];
  readonly audioPolicy: 'SILENT_CAPTIONS_ONLY' | 'NEUTRAL_NARRATION';
  readonly ffmpegPath?: string;
}

export interface VideoRenderResult {
  readonly file?: string;
  readonly status: 'RENDERED' | 'TOOL_UNAVAILABLE' | 'FAILED';
  readonly durationSeconds: number;
  readonly sceneCount: number;
  readonly audioStatus: string;
  readonly error?: string;
}

export interface VideoProviderAdapter {
  readonly providerId: string;
  render(request: VideoRenderRequest): VideoRenderResult;
}

export class FfmpegVideoProvider implements VideoProviderAdapter {
  readonly providerId = 'ffmpeg-video-composition-provider';

  render(request: VideoRenderRequest): VideoRenderResult {
    const ffmpeg = request.ffmpegPath ?? 'ffmpeg';
    fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
    const listFile = path.join(path.dirname(request.outputPath), 'intro-video-scenes.txt');
    const concat = request.scenes.flatMap((scene) => [`file '${scene.imageFile.replace(/'/g, "'\\''")}'`, `duration ${scene.durationSeconds}`]);
    concat.push(`file '${request.scenes[request.scenes.length - 1]?.imageFile.replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(listFile, concat.join('\n'), 'utf8');
    try {
      childProcess.execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vsync', 'vfr', '-pix_fmt', 'yuv420p', request.outputPath], {
        stdio: 'ignore',
        timeout: 60000,
      });
      return {
        file: request.outputPath,
        status: 'RENDERED',
        durationSeconds: request.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
        sceneCount: request.scenes.length,
        audioStatus: request.audioPolicy,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: message.includes('ENOENT') ? 'TOOL_UNAVAILABLE' : 'FAILED',
        durationSeconds: request.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
        sceneCount: request.scenes.length,
        audioStatus: request.audioPolicy,
        error: message,
      };
    }
  }
}
