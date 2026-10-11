#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = process.cwd();
const PORT = Number(process.env.NAGEX_STT_POC_PORT || 4760);
const ENGINE = process.env.NAGEX_STT_POC_ENGINE || 'whisper.cpp';
const WHISPER_CPP_BIN = process.env.NAGEX_WHISPER_CPP_BIN || '';
const WHISPER_CPP_MODEL = process.env.NAGEX_WHISPER_CPP_MODEL || '';
const FASTER_WHISPER_BIN = process.env.NAGEX_FASTER_WHISPER_BIN || '';
const TMP_ROOT = path.join(os.tmpdir(), 'nagex-stt-poc');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('AUDIO_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function run(command, args) {
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      resolve({ ok: false, code: null, error: error.message, stdout, stderr, latencyMs: Math.round(performance.now() - started), rssDeltaMb: 0 });
    });
    child.on('close', (code) => {
      const rssAfter = process.memoryUsage().rss;
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        latencyMs: Math.round(performance.now() - started),
        rssDeltaMb: Math.round((rssAfter - rssBefore) / 1024 / 1024),
      });
    });
  });
}

function cleanTranscript(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function transcribeWithWhisperCpp(wavPath) {
  if (!WHISPER_CPP_BIN || !WHISPER_CPP_MODEL) {
    return { ok: false, reason: 'WHISPER_CPP_NOT_CONFIGURED', transcript: '', latencyMs: 0, rssDeltaMb: 0 };
  }
  const outputBase = path.join(path.dirname(wavPath), 'transcript');
  const args = ['-m', WHISPER_CPP_MODEL, '-f', wavPath, '-l', 'ko', '-otxt', '-of', outputBase];
  const result = await run(WHISPER_CPP_BIN, args);
  let transcript = cleanTranscript(result.stdout);
  try {
    transcript = cleanTranscript(await readFile(`${outputBase}.txt`, 'utf8')) || transcript;
  } catch {}
  return { ...result, reason: result.ok ? undefined : 'WHISPER_CPP_FAILED', transcript };
}

async function transcribeWithFasterWhisper(wavPath) {
  if (!FASTER_WHISPER_BIN) {
    return { ok: false, reason: 'FASTER_WHISPER_NOT_CONFIGURED', transcript: '', latencyMs: 0, rssDeltaMb: 0 };
  }
  const args = [wavPath, '--language', 'ko', '--output_format', 'txt', '--output_dir', path.dirname(wavPath)];
  const result = await run(FASTER_WHISPER_BIN, args);
  let transcript = cleanTranscript(result.stdout);
  try {
    transcript = cleanTranscript(await readFile(path.join(path.dirname(wavPath), `${path.basename(wavPath, '.wav')}.txt`), 'utf8')) || transcript;
  } catch {}
  return { ...result, reason: result.ok ? undefined : 'FASTER_WHISPER_FAILED', transcript };
}

async function transcribe(wavPath) {
  if (ENGINE === 'faster-whisper') return await transcribeWithFasterWhisper(wavPath);
  return await transcribeWithWhisperCpp(wavPath);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = await readFile(path.join(ROOT, 'scripts', 'stt-open-source-poc.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, {
        ok: true,
        engine: ENGINE,
        whisperCppConfigured: Boolean(WHISPER_CPP_BIN && WHISPER_CPP_MODEL),
        fasterWhisperConfigured: Boolean(FASTER_WHISPER_BIN),
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/transcribe') {
      const audio = await readBody(req);
      if (audio.length < 44) {
        json(res, 400, { ok: false, reason: 'EMPTY_AUDIO' });
        return;
      }
      const runId = randomUUID();
      const dir = path.join(TMP_ROOT, runId);
      await mkdir(dir, { recursive: true });
      const wavPath = path.join(dir, 'mic.wav');
      await writeFile(wavPath, audio, { mode: 0o600 });
      const result = await transcribe(wavPath);
      await rm(dir, { recursive: true, force: true });
      json(res, result.ok && result.transcript ? 200 : 503, {
        ok: Boolean(result.ok && result.transcript),
        engine: ENGINE,
        reason: result.reason,
        transcript: result.transcript || '',
        transcriptLength: (result.transcript || '').trim().length,
        latencyMs: result.latencyMs,
        rssDeltaMb: result.rssDeltaMb,
      });
      return;
    }
    json(res, 404, { ok: false, reason: 'NOT_FOUND' });
  } catch (error) {
    json(res, 500, { ok: false, reason: error && error.message ? error.message : 'STT_POC_ERROR' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NAgex STT POC listening on http://127.0.0.1:${PORT}`);
  console.log(`Engine=${ENGINE}`);
});
