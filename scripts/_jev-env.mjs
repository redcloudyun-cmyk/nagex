// Shared by the JEV configuration / live checks: assembles the environment those checks look at, from the places a JEV credential is actually kept, WITHOUT ever printing a value.
//
//   1. this process's environment
//   2. NAGEX_CERT_ENV_FROM_PID=<pid of the running service> (Linux): the JEV names from /proc/<pid>/environ, the same allow-list pattern the other live certs use
//   3. --jev-env-file <path> (repeatable): the JEV names from a .env file the person points at (for example the service's own .env on the server)
//
// Only the allow-listed names below are ever read from a pid or a file; nothing else in them is parsed into the result. A location is reported as a label ("process", "pid:123", "file:<path>"), never a value.
import fs from 'node:fs';
import { JEV_ADVISORY_ENABLED_ENV, JEV_DECISION_ENABLED_ENV, JEV_KEY_ENV_LEGACY, JEV_KEY_ENV_PRIMARY } from '../dist/src/model-gateway/jev-config.js';

export const JEV_ALLOWED = new Set([JEV_KEY_ENV_PRIMARY, JEV_KEY_ENV_LEGACY, JEV_DECISION_ENABLED_ENV, JEV_ADVISORY_ENABLED_ENV]);

/** KEY=VALUE lines of a .env file, allow-listed names only. A malformed line is skipped, never reported with its content. */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !JEV_ALLOWED.has(m[1])) continue;
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function loadJevEnv(argv = process.argv.slice(2), baseEnv = process.env) {
  const env = {};
  const locations = {}; // variable name -> where it was first found (a label, never a value)
  const take = (values, label) => {
    for (const [name, value] of Object.entries(values)) {
      if (!JEV_ALLOWED.has(name) || String(value ?? '').trim() === '' || name in env) continue;
      env[name] = String(value);
      locations[name] = label;
    }
  };
  take(Object.fromEntries([...JEV_ALLOWED].map((n) => [n, baseEnv[n]])), 'process');
  const problems = [];
  const pid = baseEnv.NAGEX_CERT_ENV_FROM_PID;
  if (pid) {
    if (!/^[0-9]{1,9}$/.test(pid)) problems.push('PID_INVALID');
    else {
      try {
        const values = {};
        for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
          const i = entry.indexOf('=');
          if (i > 0) values[entry.slice(0, i)] = entry.slice(i + 1);
        }
        take(values, `pid:${pid}`);
      } catch { problems.push('PID_ENVIRONMENT_NOT_READABLE'); }
    }
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--jev-env-file' || !argv[i + 1]) continue;
    const file = argv[i + 1];
    try { take(parseEnvText(fs.readFileSync(file, 'utf8')), `file:${file}`); } catch { problems.push(`ENV_FILE_NOT_READABLE:${file}`); }
    i += 1;
  }
  return { env, locations, problems };
}
