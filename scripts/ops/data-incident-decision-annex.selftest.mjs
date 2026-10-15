#!/usr/bin/env node
// Self-test for data-incident-decision-annex.mjs. Runs ONLY against a synthetic data root it builds in the OS temp directory (planted canary secrets, symlink, oversized file); it never touches
// a real data root. Proves, under the Node permission model with the same flag pattern the operator would use:
//   P1 static: the annex imports only node:fs and node:path, spawns nothing, opens no socket, and the only write primitive is one exclusive-create open for --out
//   P2 the synthetic data root is byte-, mtime- and mode-identical (files AND directories) before and after a run
//   P3 no canary string (e-mail, token, device key, record id, tenant id, task name) appears in stdout or in the private table
//   P4 the private table is created exclusively with mode 0600 (POSIX) and a second run refuses to overwrite it
//   P5 bounds: a file limit aborts with exit 3, writes no table, and says so
//   P6 the permission model actually blocks what the tool must never do: write into the data root, create files beside the output, spawn a process
//   P7 secret-bearing directories and files are never opened (a planted unparseable file in them would otherwise be counted)
//   P8 a table path that traverses (..), is absolute, or is a symlink is ignored, not followed
// Usage: node data-incident-decision-annex.selftest.mjs      (exit 0 = all pass)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANNEX = path.join(HERE, 'data-incident-decision-annex.mjs');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` -- ${detail}`}`); if (!ok) failed += 1; };

// ---- P1 static -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const src = fs.readFileSync(ANNEX, 'utf8');
const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort();
check('P1a imports are exactly node:fs and node:path', JSON.stringify(imports) === JSON.stringify(['node:fs', 'node:path']), JSON.stringify(imports));
check('P1b no dynamic import / require / eval / child_process / net / http', !/\b(require\(|import\(|eval\(|new Function|child_process|node:net|node:http|node:https|node:dgram|fetch\()/.test(src.replace(/^\/\/.*$/gm, '')));
const fsCalls = [...new Set([...src.replace(/^\/\/.*$/gm, '').matchAll(/\bfs\.([A-Za-z]+)\(/g)].map((m) => m[1]))].sort();
const ALLOWED_READ = new Set(['realpathSync', 'readFileSync', 'readdirSync', 'lstatSync', 'existsSync', 'openSync', 'writeSync', 'closeSync']);
check('P1c only read primitives plus the single exclusive-create write path are used', fsCalls.every((c) => ALLOWED_READ.has(c)), fsCalls.join(','));
const opens = [...src.matchAll(/fs\.openSync\(([^)]*)\)/g)].map((m) => m[1]);
check('P1d the only openSync is the exclusive-create (wx, 0600) of --out', opens.length === 1 && /'wx', 0o600/.test(opens[0]), opens.join(' | '));
check('P1e no chmod/chown/rename/unlink/rm/mkdir/utimes/copy/symlink/truncate/append calls', !/\bfs\.(chmod|chown|rename|unlink|rm|rmdir|mkdir|utimes|copyFile|symlink|link|truncate|appendFile|writeFile|createWriteStream|cp)\w*\(/.test(src));

// ---- synthetic data root --------------------------------------------------------------------------------------------------------------------------------------------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-selftest-'));
const root = path.join(base, 'data'); const logs = path.join(base, 'logs'); const outFile = path.join(logs, 'annex-out.tsv'); const outsideTarget = path.join(base, 'outside-secret.json');
const CANARY = { email: 'canary.person@example.invalid', token: 'tok_CANARY_9f8e7d6c5b4a', key: 'PUBKEY_CANARY_ABCDEF123456', deviceId: 'dev_CANARY_0011223344', tenantReal: 'ten_CANARY_real_tenant', ownerReal: 'usr_CANARY_real_owner', taskName: 'CANARY task name secret objective' };
const w = (rel, v) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
for (const d of ['tasks', 'approvals', 'identity', 'daily-briefs', 'durable-task-runs', 'task-continuations', 'device-identities', 'artifacts', 'images', 'image-bytes', 'identity-tokens', 'sessions']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.mkdirSync(logs);
const nowIso = (offMs) => new Date(Date.now() + offMs).toISOString();
w('identity/u1.json', { userId: CANARY.ownerReal, tenantId: CANARY.tenantReal, email: CANARY.email });
w('tasks/tsk_pre_1.json', { taskId: 'tsk_pre_1', tenantId: CANARY.tenantReal, ownerId: CANARY.ownerReal, name: CANARY.taskName, objective: CANARY.taskName, status: 'ACTIVE', type: 'RECURRING', nextRunAt: nowIso(3 * 3600e3), lastRunAt: nowIso(-30 * 60e3 + 2000), automationKind: 'DAILY_BRIEF' });
w('tasks/tsk_pre_2.json', { taskId: 'tsk_pre_2', tenantId: 'ten_fixture', ownerId: 'usr_fixture', name: 'fixture', objective: 'x', status: 'PAUSED', type: 'RECURRING', nextRunAt: nowIso(48 * 3600e3) });
w('approvals/apr_pre_1.json', { approvalId: 'apr_pre_1', status: 'PENDING', createdAt: nowIso(-5 * 3600e3), expiresAt: nowIso(10 * 3600e3) });
w('device-identities/dev_pre_1.json', { deviceId: CANARY.deviceId, tenantId: CANARY.tenantReal, ownerId: CANARY.ownerReal, publicKey: CANARY.key, status: 'ACTIVE' });
w('identity-tokens/tok_1.json', 'THIS IS NOT JSON - a secret-bearing file that must never be opened ' + CANARY.token);
w('sessions/ses_1.json', 'NOT JSON EITHER ' + CANARY.token);
w('google-oauth.json', JSON.stringify({ refresh_token: CANARY.token }));
w('stray-test-dir/x.json', { tenantId: 'ten_x' });
w('big-pre.json', JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }));
w('daily-briefs/brief_a1.json', { briefId: 'brief_a1', tenantId: CANARY.tenantReal, ownerId: CANARY.ownerReal, status: 'READY' });             // overlaps a real owner -> BLOCKED
w('durable-task-runs/run_a1_0123456789.json', { runId: 'run_a1_0123456789', taskId: 'tsk_t1', tenantId: 'ten_testonly', ownerId: 'usr_testonly', status: 'WAITING_APPROVAL' });
w('task-continuations/cont_a1_0123456789.json', { continuationId: 'cont_a1_0123456789', runId: 'run_a1_0123456789', tenantId: 'ten_testonly', ownerId: 'usr_testonly', status: 'WAITING' });
w('images/img_a12345.json', { imageId: 'img_a12345', tenantId: 'ten_testonly', ownerId: 'usr_testonly', binaryStoragePath: 'image-bytes/img_a12345.png' });
fs.writeFileSync(path.join(root, 'image-bytes', 'img_a12345.png'), 'png-bytes');
fs.writeFileSync(outsideTarget, JSON.stringify({ tenantId: CANARY.tenantReal }));
let symlinkOk = true; try { fs.symlinkSync(outsideTarget, path.join(root, 'artifacts', 'art_link.json')); } catch { symlinkOk = false; }
const t0 = Date.now() - 30 * 60e3;
const tsvRows = [['daily-briefs/brief_a1.json', 'BLOCKED_OWNER_OVERLAPS_PREEXISTING'], ['durable-task-runs/run_a1_0123456789.json', 'TEST_ONLY_VERIFIED'], ['task-continuations/cont_a1_0123456789.json', 'TEST_ONLY_VERIFIED'], ['images/img_a12345.json', 'TEST_ONLY_VERIFIED'],
  ['image-bytes/img_a12345.png', 'TEST_ONLY_BY_LINKED_PARENT'], ['../outside-secret.json', 'TEST_ONLY_VERIFIED'], ['/etc/hostname', 'TEST_ONLY_VERIFIED'], ['artifacts/art_link.json', 'TEST_ONLY_VERIFIED']];
fs.writeFileSync(path.join(logs, 'reconciliation-added.tsv'), ['path\tsize\tsha256\tmtimeMs\tverdict', ...tsvRows.map(([p, v], i) => [p, 10, '0'.repeat(64), t0 + i * 1000, v].join('\t'))].join('\n') + '\n');
fs.copyFileSync(ANNEX, path.join(logs, 'annex.mjs')); // the operator copies the script next to the table; the run uses that copy

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.lstatSync(p); const rel = path.relative(dir, p); out[rel] = e.isDirectory() ? `d:${st.mode}:${st.mtimeMs}` : `f:${st.mode}:${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(st.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p)).digest('hex')}`; if (e.isDirectory()) walk(p); } };
  walk(dir); return out;
}
const runAnnex = (extra, outPath = outFile) => {
  const script = path.join(logs, 'annex.mjs');
  const flags = ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${logs}`, `--allow-fs-write=${outPath}`, script, '--logs', logs, '--root', root, '--out', outPath, ...extra];
  return spawnSync(process.execPath, flags, { encoding: 'utf8', timeout: 60000 });
};

// ---- P2, P3, P4, P7, P8 ------------------------------------------------------------------------------------------------------------------------------------------------------------------
const before = snapshot(root);
const r1 = runAnnex(['--max-file-bytes', String(2 * 1024 * 1024)]);
check('run under --permission exits 0', r1.status === 0, `${r1.status} ${r1.stderr.slice(0, 300)}`);
const after = snapshot(root);
if (process.env.ANNEX_SELFTEST_SHOW) console.log(r1.stdout);
check('P2 data root identical before/after (content, size, mtime, mode; files and directories)', JSON.stringify(before) === JSON.stringify(after));
const report = r1.status === 0 ? JSON.parse(r1.stdout) : {};
const table = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
const everything = r1.stdout + r1.stderr + table;
const leaked = Object.entries(CANARY).filter(([, v]) => everything.includes(v)).map(([k]) => k);
check('P3 no canary (e-mail, token, device key, device id, real tenant/owner id, task name) in stdout, stderr or table', leaked.length === 0, leaked.join(','));
check('P3b no record id or file name of any record appears in stdout', !/brief_a1|run_a1_0123456789|cont_a1_0123456789|img_a12345|tsk_pre|apr_pre|dev_pre/.test(r1.stdout));
check('P4a table exists', table.length > 0);
if (process.platform !== 'win32') check('P4b table mode is 0600', (fs.statSync(outFile).mode & 0o777) === 0o600);
const r2 = runAnnex([]);
check('P4c second run refuses to overwrite the table', r2.status === 2 && /already exists/.test(r2.stderr));
check('P7 secret-bearing dirs/files never opened (no unparseable count, token files skipped)', report.scope?.unparseable === 0 && report.scope?.skippedSecretDirs?.includes('identity-tokens') && report.scope?.skippedSecretDirs?.includes('sessions') && report.scope?.skippedSecretFiles >= 1, JSON.stringify(report.scope));
check('P7b oversized record skipped and counted', report.scope?.skippedTooLarge === 1);
check('P8 traversal, absolute and symlink table paths are not followed', report.unresolvedOwnership?.rowsWithInvalidPath >= (symlinkOk ? 3 : 2), JSON.stringify(report.unresolvedOwnership));
check('classification: the overlapping brief is BLOCKED and viewable by a registered account; candidates are test-style-only', report.byGroup?.['daily-briefs | BLOCKED']?.ownerKind?.['registered-account'] === 1 && report.byGroup?.['durable-task-runs | CANDIDATE']?.ownerKind?.['test-style-only'] === 1);
check('dependencies: continuation depends on run; image depends on payload; closure has no candidate depending on blocked', report.byGroup?.['task-continuations | CANDIDATE']?.withDependencies === 1 && report.byGroup?.['images | CANDIDATE']?.withDependencies === 1 && report.closure?.candidatesDependingOnBlocked === 0);
check('daily-brief scheduler correlation: the real owner\'s DAILY_BRIEF task ran in the window', report.byGroup?.['daily-briefs | BLOCKED']?.briefTaskRanInWindow === 1);
check('task timing and approvals summarised without names', report.tasksTiming?.total === 2 && report.tasksTiming?.byStatus?.PAUSED === 1 && report.approvalsTiming?.pending === 1);
check('unknown root entries are reported by name (store names only)', report.stateLocations?.unknownRootEntries?.includes('stray-test-dir'));

const outS = path.join(logs, 'annex-skip.tsv');
const rs = runAnnex(['--skip-dir', 'tasks', '--no-identity-read'], outS);
const repS = rs.status === 0 ? JSON.parse(rs.stdout) : {};
check('operator scope reduction: --skip-dir and --no-identity-read are honoured and the report says it is partial', repS.scope?.skippedByOperator?.[0] === 'tasks' && repS.tasksTiming?.total === 0 && repS.scope?.identityDirsSkipped === true && repS.scope?.resultsArePartial === true, JSON.stringify(repS.scope));

// ---- P5 bounds -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const outB = path.join(logs, 'annex-bounded.tsv');
const rb = runAnnex(['--max-files', '3'], outB);
check('P5 file limit aborts with exit 3, says so, and writes no table', rb.status === 3 && /aborted/.test(rb.stdout) && !fs.existsSync(outB), `${rb.status}`);
const rt = runAnnex(['--max-seconds', '0.000001'], path.join(logs, 'annex-timed.tsv'));
check('P5b time limit aborts with exit 3 and writes no table', rt.status === 3 && !fs.existsSync(path.join(logs, 'annex-timed.tsv')), `${rt.status}`);

// ---- P6 the permission model really blocks writes / spawns ------------------------------------------------------------------------------------------------------------------------------
const probeScript = path.join(logs, 'probe.mjs');
fs.writeFileSync(probeScript, `import fs from 'node:fs'; import cp from 'node:child_process'; const res = {};
const t = (k, f) => { try { f(); res[k] = 'ALLOWED'; } catch (e) { res[k] = e.code ?? e.name; } };
t('write into data root', () => fs.writeFileSync(${JSON.stringify(path.join(root, 'x.json'))}, '1'));
t('mkdir in data root', () => fs.mkdirSync(${JSON.stringify(path.join(root, 'newdir'))}));
t('delete in data root', () => fs.unlinkSync(${JSON.stringify(path.join(root, 'tasks', 'tsk_pre_2.json'))}));
t('rename in data root', () => fs.renameSync(${JSON.stringify(path.join(root, 'tasks', 'tsk_pre_2.json'))}, ${JSON.stringify(path.join(root, 'tasks', 'moved.json'))}));
t('write beside the output', () => fs.writeFileSync(${JSON.stringify(path.join(logs, 'other.txt'))}, '1'));
t('spawn a process', () => cp.spawnSync(process.execPath, ['-e', '1']));
t('read outside the allowed paths', () => fs.readFileSync(${JSON.stringify(outsideTarget)}, 'utf8'));
t('read inside the data root', () => fs.readFileSync(${JSON.stringify(path.join(root, 'tasks', 'tsk_pre_2.json'))}, 'utf8'));
console.log(JSON.stringify(res));`);
const probe = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${logs}`, `--allow-fs-write=${outFile}`, probeScript], { encoding: 'utf8', timeout: 30000 });
const pr = probe.status === 0 ? JSON.parse(probe.stdout) : {};
check('P6 permission model: writes/mkdir/delete/rename in the data root are refused', ['write into data root', 'mkdir in data root', 'delete in data root', 'rename in data root'].every((k) => pr[k] === 'ERR_ACCESS_DENIED'), JSON.stringify(pr));
check('P6b writes beside the output, child processes and reads outside the allowed paths are refused', ['write beside the output', 'spawn a process', 'read outside the allowed paths'].every((k) => pr[k] === 'ERR_ACCESS_DENIED'), JSON.stringify(pr));
check('P6c reads inside the data root still work (the tool can do its job)', pr['read inside the data root'] === 'ALLOWED');
check('data root still identical after the permission probe', JSON.stringify(snapshot(root)) === JSON.stringify(before));

fs.rmSync(base, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
