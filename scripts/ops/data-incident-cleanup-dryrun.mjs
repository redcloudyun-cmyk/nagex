#!/usr/bin/env node
// DRY-RUN ONLY. Plans the exact, manifest-guided QUARANTINE of the test records that an earlier test run wrote into the live data root, and re-verifies every candidate right before it would be
// acted on. This file deliberately has NO mutating capability: it imports only read-only filesystem calls and prints what a separately authorised step WOULD do. There is no --apply flag.
// Usage (host, operator account):  node data-incident-cleanup-dryrun.mjs <logsDir> [dataRoot] [holdingDir]
import { readFileSync, lstatSync, realpathSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [logsDir, dataRootArg, holdingArg] = process.argv.slice(2);
if (!logsDir) { console.error('usage: data-incident-cleanup-dryrun.mjs <logsDir> [dataRoot] [holdingDir]'); process.exit(2); }
const ROOT = realpathSync(dataRootArg || '/var/lib/nagex');
const HOLDING = holdingArg || path.join(path.dirname(logsDir), 'nagex-incident-holding'); // outside the data root, operator-private, would be created 0700 by the authorised step
const rows = readFileSync(path.join(logsDir, 'reconciliation-added.tsv'), 'utf8').split('\n').slice(1).filter(Boolean).map((l) => { const [rel, size, sha256, mtimeMs, verdict] = l.split('\t'); return { rel, size: Number(size), sha256, mtimeMs: Number(mtimeMs), verdict }; });

const candidates = rows.filter((r) => r.verdict.startsWith('TEST_ONLY'));
const excluded = rows.filter((r) => !r.verdict.startsWith('TEST_ONLY'));
const problems = {};
const note = (k) => { problems[k] = (problems[k] || 0) + 1; };
let wouldMove = 0, bytes = 0;
const byDir = {};
for (const r of candidates) {
  const abs = path.resolve(ROOT, r.rel);
  if (r.rel.includes('..') || path.isAbsolute(r.rel) || !abs.startsWith(ROOT + path.sep)) { note('PATH_ESCAPES_ROOT'); continue; }
  if (!existsSync(abs)) { note('MISSING'); continue; }
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) { note('NOT_A_REGULAR_FILE'); continue; }
  if (realpathSync(abs) !== abs) { note('SYMLINK_IN_PATH'); continue; }
  if (st.size !== r.size) { note('SIZE_CHANGED'); continue; }
  if (Math.round(st.mtimeMs) !== r.mtimeMs) { note('MTIME_CHANGED'); continue; }
  if (crypto.createHash('sha256').update(readFileSync(abs)).digest('hex') !== r.sha256) { note('CONTENT_CHANGED'); continue; }
  wouldMove += 1; bytes += st.size;
  const d = r.rel.split('/')[0]; byDir[d] = (byDir[d] || 0) + 1;
}
const ready = wouldMove === candidates.length && Object.keys(problems).length === 0;
console.log(JSON.stringify({
  mode: 'DRY-RUN (no file was touched; this program cannot modify anything)',
  dataRoot: ROOT === '/var/lib/nagex' ? '/var/lib/nagex' : '(custom)',
  candidatesInTable: candidates.length,
  excludedAsBlocked: excluded.length,
  reverifiedUnchanged: wouldMove,
  problems,
  wouldQuarantineBytes: bytes,
  wouldQuarantineByDirectory: byDir,
  plannedAction: ready ? `MOVE (rename, same filesystem) ${wouldMove} files into a private 0700 holding directory outside the data root, preserving relative paths; then re-run the verification; deletion is a later, separate decision` : 'BLOCKED: at least one candidate failed re-verification - nothing would be done',
  holdingDirectoryWouldBe: path.basename(HOLDING),
  preconditions: [
    'separate explicit operator authorisation for the live-root change',
    'a quiescence decision: the running service must not be reading these directories during the move (a stop/maintenance window, or an agreed proof that it cannot)',
    'a fresh read-only re-run of this program immediately before, with problems == {}',
    'the 4 built-in role records are NOT touched (updatedAt only; restoring needs proof of no legitimate change)',
    'blocked records stay untouched',
  ],
}, null, 1));
void statSync;
