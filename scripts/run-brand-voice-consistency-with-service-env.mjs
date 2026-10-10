import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const mainPid = execFileSync('systemctl', ['show', 'nagex.service', '-p', 'MainPID', '--value'], {
  encoding: 'utf8',
}).trim();

if (!mainPid || mainPid === '0') {
  throw new Error('NAGEX_SERVICE_NOT_RUNNING');
}

const environ = fs.readFileSync(`/proc/${mainPid}/environ`, 'utf8');
for (const entry of environ.split('\0')) {
  if (!entry) continue;
  const separator = entry.indexOf('=');
  if (separator <= 0) continue;
  const key = entry.slice(0, separator);
  const value = entry.slice(separator + 1);
  if (key === 'OPENAI_API_KEY' || key === 'NAGEX_TTS_OPENAI_API_KEY' || key.startsWith('NAGEX_TTS_')) {
    process.env[key] = value;
  }
}

if (!process.env.NAGEX_TTS_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
  throw new Error('NAGEX_TTS_SECRET_NOT_FOUND_IN_SERVICE_ENV');
}

await import('./brand-voice-consistency-cert.mjs');
