import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';

const MAX_AUDIO_BYTES = Number(process.env.NAGEX_STT_MAX_AUDIO_BYTES || 10 * 1024 * 1024);
const MAX_AUDIO_SECONDS = Number(process.env.NAGEX_STT_MAX_AUDIO_SECONDS || 20);
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.NAGEX_STT_TIMEOUT_MS || 120_000);
const MAX_CONCURRENT_TRANSCRIPTIONS = Math.max(1, Number(process.env.NAGEX_STT_MAX_CONCURRENT || 1));

let activeTranscriptions = 0;

type BinaryBody = Record<string, unknown> & {
  data?: unknown;
  mimeType?: unknown;
};

function error(status: number, reason: string): ApiResult {
  return { status, data: { ok: false, reason } };
}

function configuredWhisperPaths(): { bin: string; model: string } {
  return {
    bin: process.env.NAGEX_WHISPER_CPP_BIN || path.join(process.cwd(), '.runtime', 'whisper', 'whisper-cli'),
    model: process.env.NAGEX_WHISPER_CPP_MODEL || path.join(process.cwd(), '.runtime', 'whisper', 'models', 'ggml-base.bin'),
  };
}

function readUint32LE(buffer: Buffer, offset: number): number {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

function estimateWavDurationSeconds(buffer: Buffer): number | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = readUint32LE(buffer, offset + 4);
    const chunkData = offset + 8;
    if (chunkId === 'fmt ' && chunkData + 16 <= buffer.length) {
      byteRate = readUint32LE(buffer, chunkData + 8);
    } else if (chunkId === 'data') {
      dataBytes = Math.min(chunkSize, buffer.length - chunkData);
      break;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataBytes) return null;
  return dataBytes / byteRate;
}

function transcriptFromWhisperText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runWhisperCpp(wavPath: string, outputBase: string): Promise<{ transcript: string; latencyMs: number; peakRssMb: number | null }> {
  const { bin, model } = configuredWhisperPaths();
  if (!existsSync(bin) || !existsSync(model)) {
    throw Object.assign(new Error('WHISPER_CPP_NOT_CONFIGURED'), { code: 'WHISPER_CPP_NOT_CONFIGURED' });
  }

  const started = performance.now();
  let peakRssMb: number | null = null;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ['-m', model, '-f', wavPath, '-l', 'ko', '-otxt', '-of', outputBase], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const memoryTimer = setInterval(() => {
      const usage = process.memoryUsage();
      peakRssMb = Math.max(peakRssMb ?? 0, Math.round(usage.rss / 1024 / 1024));
    }, 50);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('TRANSCRIBE_TIMEOUT'), { code: 'TRANSCRIBE_TIMEOUT' }));
    }, TRANSCRIBE_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 4000);
    });
    child.on('error', (cause) => {
      clearTimeout(timeout);
      clearInterval(memoryTimer);
      reject(Object.assign(new Error('WHISPER_EXEC_FAILED'), { code: 'WHISPER_EXEC_FAILED', cause }));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(memoryTimer);
      if (code === 0) {
        resolve();
      } else {
        reject(Object.assign(new Error('WHISPER_PROCESS_FAILED'), { code: 'WHISPER_PROCESS_FAILED', stderr }));
      }
    });
  });

  const text = await readFile(`${outputBase}.txt`, 'utf8');
  return { transcript: transcriptFromWhisperText(text), latencyMs: Math.round(performance.now() - started), peakRssMb };
}

export const handleSttRoutes: AsyncRouteRegistrar<Record<string, never>> = async (method, pathname, body, headers) => {
  if (method !== 'POST' || pathname !== '/api/v1/stt/transcribe') return undefined;
  if (!tryGetCallerIdentity(headers)) return error(401, 'AUTHENTICATION_REQUIRED');
  const binaryBody = body as BinaryBody | null;
  const audio = binaryBody && Buffer.isBuffer(binaryBody.data) ? binaryBody.data : null;
  const mimeType = typeof binaryBody?.mimeType === 'string' ? binaryBody.mimeType.toLowerCase() : '';
  if (!audio || audio.length === 0) return error(400, 'AUDIO_REQUIRED');
  if (audio.length > MAX_AUDIO_BYTES) return error(413, 'AUDIO_TOO_LARGE');
  if (mimeType && !mimeType.includes('wav')) return error(415, 'WAV_REQUIRED');

  const durationSeconds = estimateWavDurationSeconds(audio);
  if (durationSeconds === null) return error(400, 'AUDIO_DURATION_UNSUPPORTED');
  if (durationSeconds > MAX_AUDIO_SECONDS) return error(413, 'AUDIO_TOO_LONG');
  if (activeTranscriptions >= MAX_CONCURRENT_TRANSCRIPTIONS) return error(429, 'TRANSCRIPTION_BUSY');

  activeTranscriptions += 1;
  const dir = path.join(tmpdir(), `nagex-stt-${randomUUID()}`);
  const wavPath = path.join(dir, 'audio.wav');
  const outputBase = path.join(dir, 'transcript');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(wavPath, audio, { mode: 0o600 });
    const result = await runWhisperCpp(wavPath, outputBase);
    return {
      status: 200,
      data: {
        ok: true,
        engine: 'whisper.cpp',
        transcript: result.transcript,
        transcriptLength: result.transcript.length,
        durationSeconds: Number(durationSeconds.toFixed(3)),
        latencyMs: result.latencyMs,
        peakRssMb: result.peakRssMb,
      },
    };
  } catch (cause) {
    const code = cause instanceof Error ? (cause as Error & { code?: unknown }).code : undefined;
    const reason = typeof code === 'string' ? code : 'STT_TRANSCRIBE_FAILED';
    const status = reason === 'WHISPER_CPP_NOT_CONFIGURED' ? 503 : reason === 'TRANSCRIBE_TIMEOUT' ? 504 : 500;
    return error(status, reason);
  } finally {
    activeTranscriptions -= 1;
    await rm(dir, { recursive: true, force: true });
  }
};
