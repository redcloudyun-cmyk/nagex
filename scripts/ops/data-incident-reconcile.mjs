#!/usr/bin/env node
// READ-ONLY reconciliation of the 2026-10-15 test-data incident in the live data root. It never modifies, moves, deletes or restores anything under the data root: it only reads files, hashes
// them and prints NON-SENSITIVE aggregates. Its single write is a private table (mode 0600) in the operator's own logs folder, so a later, separately authorised cleanup can be exact.
// Usage (on the host, as the operator account):  node data-incident-reconcile.mjs <logsDir> <archive.tgz> [dataRoot]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [logsDir, archive, dataRootArg] = process.argv.slice(2);
if (!logsDir || !archive) { console.error('usage: data-incident-reconcile.mjs <logsDir> <archive.tgz> [dataRoot]'); process.exit(2); }
const ROOT = fs.realpathSync(dataRootArg || '/var/lib/nagex');
// the only thing this program writes is a private table; it must never be inside the data root it is inspecting
if (fs.realpathSync(logsDir).startsWith(ROOT + path.sep) || fs.realpathSync(logsDir) === ROOT) { console.error('refusing: the logs folder is inside the data root'); process.exit(2); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0);
const added = lines(path.join(logsDir, 'contamination-added.manifest'));
const modified = lines(path.join(logsDir, 'contamination-modified.manifest'));

// ---- 0. the pre-test archive: which files existed then (names only) ----
const archiveNames = new Set(execFileSync('tar', ['-tzf', archive], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^nagex\//, '')));
const archiveMtime = fs.statSync(archive).mtimeMs;

// ---- 1. everything that existed BEFORE the incident: which tenants / owners are real ----
const idsOf = (j) => {
  const out = { tenants: [], owners: [] };
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 2) return;
    for (const k of ['tenantId', 'tenant_id']) if (typeof o[k] === 'string') out.tenants.push(o[k]);
    for (const k of ['ownerId', 'principalId', 'userId', 'owner_id']) if (typeof o[k] === 'string') out.owners.push(o[k]);
    for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, depth + 1);
  };
  visit(j, 0);
  return out;
};
const preTenants = new Set(), preOwners = new Set();
const walk = (dir, cb) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, cb); else if (e.isFile()) cb(p); } };
const addedSet = new Set(added);
const modifiedSet = new Set(modified);
let preJson = 0;
walk(ROOT, (p) => {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  if (addedSet.has(rel) || !p.endsWith('.json')) return;
  try { const ids = idsOf(JSON.parse(fs.readFileSync(p, 'utf8'))); ids.tenants.forEach((t) => preTenants.add(t)); ids.owners.forEach((o) => preOwners.add(o)); preJson += 1; } catch { /* skip */ }
});

// ---- 2. verify each of the added files ----
const ALLOWED_PREFIX = new Set(added.map((r) => r.split('/')[0]));
const TEST_TENANT = /^(ten_|t1$|tenant|t_|test)/i;
const rows = [];
const verdicts = {};
const byDir = {};
const parsedById = new Map();
let newestMtime = 0;
const bump = (k) => { verdicts[k] = (verdicts[k] || 0) + 1; };
for (const rel of added) {
  const row = { rel, verdict: '', size: 0, sha256: '', mtime: 0, claim: '' };
  const abs = path.resolve(ROOT, rel);
  let verdict = 'TEST_ONLY_VERIFIED';
  if (rel.includes('..') || path.isAbsolute(rel) || !abs.startsWith(ROOT + path.sep)) verdict = 'BLOCKED_PATH';
  else {
    let st = null; try { st = fs.lstatSync(abs); } catch { /* missing */ }
    if (!st) verdict = 'BLOCKED_MISSING';
    else if (st.isSymbolicLink() || !st.isFile()) verdict = 'BLOCKED_NOT_REGULAR';
    else if (fs.realpathSync(abs) !== abs) verdict = 'BLOCKED_PATH';
    else if (!ALLOWED_PREFIX.has(rel.split('/')[0])) verdict = 'BLOCKED_PREFIX';
    else {
      const buf = fs.readFileSync(abs);
      row.size = st.size; row.mtime = Math.round(st.mtimeMs); row.sha256 = sha(buf); newestMtime = Math.max(newestMtime, st.mtimeMs);
      if (st.mtimeMs < archiveMtime) verdict = 'BLOCKED_OLDER_THAN_ARCHIVE';
      else if (abs.endsWith('.json')) {
        try {
          const j = JSON.parse(buf.toString('utf8'));
          parsedById.set(rel, j);
          const ids = idsOf(j);
          row.claim = ids.tenants.length ? 'tenant-claim' : 'no-tenant-field';
          if (ids.tenants.some((t) => preTenants.has(t)) || ids.owners.some((o) => preOwners.has(o))) verdict = 'BLOCKED_OWNER_OVERLAPS_PREEXISTING';
          else if (ids.tenants.length && !ids.tenants.every((t) => TEST_TENANT.test(t))) verdict = 'BLOCKED_TENANT_NOT_TEST_STYLE';
          else if (!ids.tenants.length) verdict = /^(test_|mc5a_idem_)/.test(rel.split('/')[0]) || /^(rbac-bindings|memory-settings|device-)/.test(rel.split('/')[0]) ? 'TEST_ONLY_BY_DIRECTORY_OR_CONTEXT' : 'BLOCKED_NO_OWNER_CLAIM';
        } catch { verdict = 'BLOCKED_UNPARSEABLE'; }
      } else row.claim = 'non-json (linked below)';
    }
  }
  row.verdict = verdict;
  rows.push(row);
  bump(verdict);
  byDir[rel.split('/')[0]] = (byDir[rel.split('/')[0]] || 0) + 1;
}
// non-JSON payload files are judged through their parent record: the parent names its payload in binaryStoragePath. A payload is test-owned only if its parent is in the added set AND verified.
const parentOfPayload = new Map();
for (const [rel, j] of parsedById) if (typeof j.binaryStoragePath === 'string') parentOfPayload.set(path.basename(j.binaryStoragePath), rel);
for (const row of rows.filter((r) => r.claim === 'non-json (linked below)')) {
  const parentRel = parentOfPayload.get(path.basename(row.rel));
  const parent = parentRel ? rows.find((r) => r.rel === parentRel) : null;
  verdicts[row.verdict] -= 1;
  if (parent && parent.verdict.startsWith('TEST_ONLY')) { row.verdict = 'TEST_ONLY_BY_LINKED_PARENT'; bump(row.verdict); }
  else { row.verdict = parent ? 'BLOCKED_PARENT_BLOCKED' : 'BLOCKED_NO_LINKED_PARENT'; bump(row.verdict); }
}

// ---- 2b. set-closure: a cleanup set must not leave a dangling reference. Any record that references, or is referenced by, a BLOCKED record is blocked too (iterated to a fixed point). ----
const idLike = /[a-z]{2,6}_[0-9a-f]{8,}/g;
const refsOf = new Map(); // rel -> Set(ids mentioned)
const ownIds = new Map(); // rel -> Set(ids it is known by: file stem and *Id fields)
for (const r of rows) {
  const j = parsedById.get(r.rel);
  const stem = path.basename(r.rel).replace(/.[^.]+$/, '');
  const own = new Set([stem]); const mentioned = new Set();
  if (j) { const text = JSON.stringify(j); for (const m of text.match(idLike) || []) mentioned.add(m); for (const [k, v] of Object.entries(j)) if (/Id$/.test(k) && typeof v === 'string' && v.includes(stem)) own.add(v); }
  refsOf.set(r.rel, mentioned); ownIds.set(r.rel, own);
}
const owners = new Map(); for (const r of rows) for (const id of ownIds.get(r.rel)) { if (!owners.has(id)) owners.set(id, new Set()); owners.get(id).add(r.rel); }
let changed = true; let demoted = 0;
while (changed) {
  changed = false;
  const blockedNow = new Set(rows.filter((r) => r.verdict.startsWith('BLOCKED')).map((r) => r.rel));
  for (const r of rows) {
    if (r.verdict.startsWith('BLOCKED')) continue;
    let linked = false;
    for (const id of refsOf.get(r.rel)) for (const o of owners.get(id) || []) if (o !== r.rel && blockedNow.has(o)) linked = true;          // r points at a blocked record
    for (const id of ownIds.get(r.rel)) for (const o of rows) if (o.rel !== r.rel && blockedNow.has(o.rel) && refsOf.get(o.rel).has(id)) linked = true; // a blocked record points at r
    if (linked) { verdicts[r.verdict] -= 1; r.verdict = 'BLOCKED_DEPENDS_ON_BLOCKED'; bump(r.verdict); demoted += 1; changed = true; }
  }
}
const cleanupCandidates = rows.filter((r) => r.verdict.startsWith('TEST_ONLY')).length;
const blockedCount = rows.length - cleanupCandidates;
const candidateByDir = {}; const blockedByDir = {};
for (const r of rows) { const d = r.rel.split('/')[0]; const t = r.verdict.startsWith('TEST_ONLY') ? candidateByDir : blockedByDir; t[d] = (t[d] || 0) + 1; }

// ---- 3. the five waiting runs / continuations: trace every reference (booleans and counts only) ----
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const liveFile = (dir, id) => fs.existsSync(path.join(ROOT, dir, `${id}.json`));
const conts = [...parsedById.entries()].filter(([r]) => r.startsWith('task-continuations/'));
const runs = [...parsedById.entries()].filter(([r]) => r.startsWith('durable-task-runs/'));
const waitingConts = conts.filter(([, j]) => j.status === 'WAITING');
const waitingRuns = runs.filter(([, j]) => j.status === 'WAITING_APPROVAL');
const runIdsInAdded = new Set(runs.map(([, j]) => j.runId));
const trace = {
  waiting_continuations: waitingConts.length,
  waiting_runs: waitingRuns.length,
  running_runs_among_added: runs.filter(([, j]) => j.status === 'RUNNING').length,
  continuation_approval_exists_in_live_approvals: waitingConts.filter(([, j]) => j.approvalId && liveFile('approvals', j.approvalId)).length,
  continuation_task_exists_in_live_tasks: conts.filter(([, j]) => j.taskId && liveFile('tasks', j.taskId)).length,
  waiting_run_task_exists_in_live_tasks: waitingRuns.filter(([, j]) => j.taskId && liveFile('tasks', j.taskId)).length,
  waiting_run_in_live_task_runs: waitingRuns.filter(([, j]) => j.runId && liveFile('task-runs', j.runId)).length,
  waiting_continuation_run_in_added_set: waitingConts.filter(([, j]) => runIdsInAdded.has(j.runId)).length,
  all_added_continuations_run_in_added_set: conts.filter(([, j]) => runIdsInAdded.has(j.runId)).length + '/' + conts.length,
};
// set-closed: does any PRE-EXISTING file mention an id that only the added set owns? (a pre-existing record pointing at a record I would remove)
const addedRunIds = new Set(runs.map(([, j]) => j.runId).filter(Boolean));
const addedTaskIds = new Set([...runs, ...conts].map(([, j]) => j.taskId).filter(Boolean));
let preReferencesAdded = 0;
walk(ROOT, (p) => {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  if (addedSet.has(rel) || !p.endsWith('.json')) return;
  const dir = rel.split('/')[0];
  if (!['tasks', 'task-runs', 'approvals', 'executions', 'task-continuations', 'durable-task-runs'].includes(dir)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const id of addedRunIds) if (text.includes(id)) { preReferencesAdded += 1; return; }
  for (const id of addedTaskIds) if (text.includes(id)) { preReferencesAdded += 1; return; }
});
trace.preexisting_records_referencing_added_ids = preReferencesAdded;

// ---- 4. changes since the incident (normal writes included) ----
const nowNames = []; walk(ROOT, (p) => nowNames.push(path.relative(ROOT, p).split(path.sep).join('/')));
const known = new Set([...archiveNames, ...addedSet]);
const newSinceManifest = nowNames.filter((n) => !known.has(n));
const modifiedNow = nowNames.filter((n) => archiveNames.has(n) && fs.statSync(path.join(ROOT, n)).mtimeMs > archiveMtime);
const unexpectedModified = modifiedNow.filter((n) => !modifiedSet.has(n));
// the last test app start re-stamped the RBAC records at 04:04:10Z; nothing of the incident can be later than a few minutes after that
const INCIDENT_END = Date.parse('2026-10-15T04:06:00Z');
const addedChangedAfterManifest = rows.filter((r) => r.mtime > INCIDENT_END).length;

// ---- 5. the four RBAC records: before/after hashes and field-level diff ----
const rbac = [];
const tmp = fs.mkdtempSync(path.join(logsDir, '.rbac-cmp-'));
try {
  fs.chmodSync(tmp, 0o700);
  if (modified.length) execFileSync('tar', ['-C', tmp, '-xzf', archive, ...modified.map((m) => 'nagex/' + m)]);
  for (const m of modified) {
    const before = fs.readFileSync(path.join(tmp, 'nagex', m)); const after = fs.readFileSync(path.join(ROOT, m));
    const a = JSON.parse(before.toString('utf8')), b = JSON.parse(after.toString('utf8'));
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    const { updatedAt: ua, ...restA } = a; const { updatedAt: ub, ...restB } = b;
    rbac.push({ dir: m.split('/')[0], beforeSha8: sha(before).slice(0, 8), afterSha8: sha(after).slice(0, 8), changedFields: keys.join(','), identicalExceptUpdatedAt: JSON.stringify(restA) === JSON.stringify(restB), mtimeAfterArchive: fs.statSync(path.join(ROOT, m)).mtimeMs > archiveMtime });
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// ---- private table (0600) ----
const table = path.join(logsDir, 'reconciliation-added.tsv');
fs.writeFileSync(table, ['path\tsize\tsha256\tmtimeMs\tverdict', ...rows.map((r) => [r.rel, r.size, r.sha256, r.mtime, r.verdict].join('\t'))].join('\n') + '\n', { mode: 0o600 });
fs.chmodSync(table, 0o600);

// ---- aggregate (non-sensitive) report ----
const out = {
  dataRootCanonical: ROOT === '/var/lib/nagex' ? '/var/lib/nagex' : '(custom)',
  added: added.length, modifiedExisting: modified.length,
  addedBytes: rows.reduce((s, r) => s + r.size, 0),
  verdicts, byDirectory: byDir,
  partition: { cleanupCandidates, blocked: blockedCount, demotedForClosure: demoted, candidateByDir, blockedByDir },
  preexistingJsonRead: preJson, preexistingDistinctTenants: preTenants.size, preexistingDistinctOwners: preOwners.size,
  windowMinutes: { firstAddedToLastAdded: Math.round((newestMtime - Math.min(...rows.map((r) => r.mtime).filter(Boolean))) / 60000) },
  newestAddedMtimeIso: new Date(newestMtime).toISOString(),
  pendingTrace: trace,
  sinceIncident: { newFilesNotInArchiveNorManifest: newSinceManifest.length, newFilesByDir: newSinceManifest.reduce((m, n) => { const d = n.split('/')[0]; m[d] = (m[d] || 0) + 1; return m; }, {}), preexistingModifiedBeyondTheFour: unexpectedModified.length, addedFilesModifiedAfterIncidentEnd: addedChangedAfterManifest },
  rbac,
  privateTable: 'written (0600) in the logs folder; not published',
};
console.log(JSON.stringify(out, null, 1));
