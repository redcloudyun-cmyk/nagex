#!/usr/bin/env node
// READ-ONLY decision annex (v2) for the 2026-10-15 test-data incident.
//
// WHAT IT IS: a stand-alone script that imports ONLY node:fs and node:path. It imports no NAgex module, constructs no store, starts no server, spawns no process, opens no socket. It cannot
// "initialize a store that mutates data" because no store code is loaded.
// WHAT IT READS: (1) the private reconciliation table in --logs; (2) the records that table lists; (3) every other *.json under --root EXCEPT the secret-bearing locations listed in SECRET_DIRS /
// SECRET_FILE_RE, which are never opened; (4) directory metadata (names, sizes, mtimes) of --root and of any --probe-path. Record content is parsed in memory only to extract id-valued fields
// (tenantId/ownerId/userId/principalId), a whitelisted status token, and a few task timing fields; it is dropped immediately and never printed or stored.
// WHAT IT WRITES: nothing under --root. With --out it creates ONE new file (exclusive create, mode 0600, never overwrites) outside --root; without --out it writes nothing at all.
// WHAT IT PRINTS: a redacted JSON report (counts, enumerated values, row numbers) - no identifier, name, e-mail, token, key, device identity, path of a record, or content.
// BOUNDS: --max-files, --max-seconds, --max-file-bytes, --max-rows; on any limit it aborts WITHOUT writing the output file (exit 3).
// BELT AND BRACES: run it under the Node permission model (see D09_A6_ANNEX_REVIEW_AND_EXECUTION_REQUEST.md) so that the process is unable to write anywhere except the one output file,
// to spawn a child process or to read outside the stated paths, even if this source were wrong.
import fs from 'node:fs';
import path from 'node:path';

const USAGE = 'usage: data-incident-decision-annex.mjs --logs <dir> [--root <dir>] [--out <new file>] [--max-files N] [--max-seconds N] [--max-file-bytes N] [--max-rows N] [--no-identity-read] [--probe-path <p>]...';
function parseArgs(argv) {
  const o = { root: '/var/lib/nagex', out: null, maxFiles: 60000, maxSeconds: 240, maxFileBytes: 2 * 1024 * 1024, maxRows: 5000, identityRead: true, probes: [], logs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`); i += 1; return argv[i]; };
    if (a === '--logs') o.logs = val();
    else if (a === '--root') o.root = val();
    else if (a === '--out') o.out = val();
    else if (a === '--max-files') o.maxFiles = Number(val());
    else if (a === '--max-seconds') o.maxSeconds = Number(val());
    else if (a === '--max-file-bytes') o.maxFileBytes = Number(val());
    else if (a === '--max-rows') o.maxRows = Number(val());
    else if (a === '--no-identity-read') o.identityRead = false;
    else if (a === '--probe-path') o.probes.push(val());
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['maxFiles', 'maxSeconds', 'maxFileBytes', 'maxRows']) if (!Number.isFinite(o[k]) || o[k] <= 0) throw new Error(`invalid ${k}`);
  if (!o.logs) throw new Error('--logs is required');
  return o;
}
let ARGS;
try { ARGS = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }

const ROOT = fs.realpathSync(ARGS.root);
const LOGS = fs.realpathSync(ARGS.logs);
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
if (inside(LOGS, ROOT)) { console.error('refusing: the logs folder is inside the data root'); process.exit(2); }
let OUT = null;
if (ARGS.out) {
  const parent = fs.realpathSync(path.dirname(path.resolve(ARGS.out)));
  OUT = path.join(parent, path.basename(ARGS.out));
  if (inside(OUT, ROOT)) { console.error('refusing: --out is inside the data root'); process.exit(2); }
  if (fs.existsSync(OUT)) { console.error('refusing: --out already exists (this tool never overwrites)'); process.exit(2); }
}

// ---- bounds -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const STARTED = Date.now();
const DEADLINE = STARTED + ARGS.maxSeconds * 1000;
let FILES_READ = 0;
class Abort extends Error {}
const tick = () => { if (Date.now() > DEADLINE) throw new Abort(`time limit of ${ARGS.maxSeconds}s reached`); };
const countRead = () => { FILES_READ += 1; if (FILES_READ > ARGS.maxFiles) throw new Abort(`file limit of ${ARGS.maxFiles} reached`); tick(); };

// ---- what is never opened -----------------------------------------------------------------------------------------------------------------------------------------------------------
const SECRET_DIRS = new Set(['identity-tokens', 'sessions', 'browser-profile', 'browser-sessions', 'sso-flow', 'enterprise-identity', 'social-identities', 'telegram_identities', 'slack_identities', 'identity-audit']);
const SECRET_FILE_RE = /(oauth|token|secret|credential|mcp-connections|\.env$|\.key$|\.pem$)/i;
// directories whose records are user content: read transiently for id-valued fields only (same scope as the approved reconciliation); listed in the report
const PERSONAL_CONTENT_DIRS = new Set(['vault', 'conversations', 'memories', 'knowledge', 'documents', 'images', 'presentations', 'artifacts', 'workspace-captures', 'notifications', 'activity']);
const IDENTITY_DIRS = new Set(['identity', 'organizations']);
// store directory names the certified source (068f13d) can create under the data root; anything else at the top level is reported as unknown
const KNOWN_STORE_DIRS = new Set(['action-proposals', 'activity', 'approvals', 'artifacts', 'browser-evidence', 'browser-profile', 'browser-sessions', 'candidates', 'command-contexts', 'competitor-pricing-baselines', 'competitor-pricing-runs',
  'conversations', 'creations', 'daily-briefs', 'desktop-execution-sessions', 'device-command-status', 'device-connection-status', 'device-execution-sessions', 'device-identities', 'device-pending-commands', 'device-transport-replay',
  'documents', 'durable-task-runs', 'enterprise-identity', 'executions', 'identity', 'identity-audit', 'identity-tokens', 'image-bytes', 'images', 'kakao-accessibility-drafts', 'knowledge', 'memories', 'memory-settings', 'messaging-handoff-runs',
  'mobile-conversation-targets', 'mobile-message-runs', 'mobile-recipient-refs', 'notifications', 'object-storage', 'organizations', 'plans', 'presentation-bytes', 'presentations', 'proactive-interactions', 'rbac-bindings', 'rbac-roles', 'safety',
  'sessions', 'slack_identities', 'social-identities', 'sso-flow', 'task-continuations', 'task-runs', 'tasks', 'telegram_identities', 'vault', 'workflows', 'workspace-captures', 'capabilities_idempotency', 'module-state']);
const KNOWN_ROOT_FILES = new Set(['github-oauth.json', 'google-oauth.json', 'mcp-connections.json']);
const DEMO_TENANT = 'ten_demo_hackathon'; // public constant in src/demo/demo-identity.ts

// ---- the reconciliation table -------------------------------------------------------------------------------------------------------------------------------------------------------
const tableText = fs.readFileSync(path.join(LOGS, 'reconciliation-added.tsv'), 'utf8');
const rows = tableText.split('\n').slice(1).filter(Boolean).map((l, i) => {
  const [rel, size, , mt, verdict] = l.split('\t');
  return { n: i + 1, rel, size: Number(size), mt: Number(mt), verdict, dir: (rel ?? '').split('/')[0], file: (rel ?? '').slice((rel ?? '').indexOf('/') + 1) };
});
if (rows.length === 0 || rows.length > ARGS.maxRows) { console.error(`refusing: the table has ${rows.length} rows (limit ${ARGS.maxRows})`); process.exit(2); }
const addedSet = new Set(rows.map((r) => r.rel));

// A table path is trusted only if it is relative, normalised, stays under ROOT, and is a regular file that is not a symlink.
function safeRegularFile(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split('/').some((p) => p === '..' || p === '')) return null;
  const abs = path.join(ROOT, rel);
  if (!inside(abs, ROOT)) return null;
  try { const st = fs.lstatSync(abs); return st.isFile() && !st.isSymbolicLink() ? { abs, st } : null; } catch { return null; }
}

const STATUS_RE = /^[A-Z][A-Z_]{1,23}$/;
const statusOf = (j) => { if (!j) return '-'; const s = j.status ?? j.state; return typeof s === 'string' && STATUS_RE.test(s) ? s : s === undefined ? '-' : '(other)'; };
const ids = (j) => {
  const out = { tenants: new Set(), owners: new Set() };
  const visit = (o, d) => {
    if (!o || typeof o !== 'object' || d > 2) return;
    for (const k of ['tenantId', 'tenant_id']) if (typeof o[k] === 'string') out.tenants.add(o[k]);
    for (const k of ['ownerId', 'principalId', 'userId', 'owner_id']) if (typeof o[k] === 'string') out.owners.add(o[k]);
    for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, d + 1);
  };
  visit(j, 0);
  return out;
};
const isoOrNull = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

try {
  // ---- the added records (368) --------------------------------------------------------------------------------------------------------------------------------------------------
  const stems = rows.map((r) => ({ n: r.n, stem: r.file.replace(/\.json$/, '') })).filter((s) => s.stem.length >= 8);
  const added = new Map(); // n -> { raw|null, j|null, x, valid }
  for (const r of rows) {
    const f = safeRegularFile(r.rel);
    const isJson = r.rel.endsWith('.json');
    let raw = null, j = null;
    if (f && isJson && f.st.size <= ARGS.maxFileBytes) {
      countRead();
      try { raw = fs.readFileSync(f.abs, 'utf8'); j = JSON.parse(raw); } catch { j = null; }
    } else if (f && !isJson) {
      // payload file (binary): never opened, only its existence/size matter
      j = null;
    }
    added.set(r.n, { raw, j, x: j ? ids(j) : { tenants: new Set(), owners: new Set() }, valid: Boolean(f), json: isJson });
  }
  const winStart = Math.min(...rows.map((r) => r.mt)) - 5 * 60 * 1000;
  const winEnd = Math.max(...rows.map((r) => r.mt)) + 5 * 60 * 1000;

  // ---- the pre-existing world, streamed: raw content is dropped after each file -------------------------------------------------------------------------------------------------
  const preTenants = new Map(), preOwners = new Map(), prePairs = new Set();
  const identityOwners = new Set();
  const refByPre = new Set();
  const dirCounts = {};
  const skipped = { secretDirs: new Set(), secretFiles: 0, tooLarge: 0, unparseable: 0, identityDirsSkipped: false };
  const personalSeen = new Set();
  const tasks = [], approvals = [], durableRuns = { RUNNING: 0, other: 0 }, contWaiting = { n: 0 };
  const walk = (dir, top) => {
    tick();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        const t = top ?? e.name;
        if (!top && SECRET_DIRS.has(e.name)) { skipped.secretDirs.add(e.name); continue; }
        if (!top && IDENTITY_DIRS.has(e.name) && !ARGS.identityRead) { skipped.identityDirsSkipped = true; continue; }
        walk(abs, t);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        if (SECRET_FILE_RE.test(e.name)) { skipped.secretFiles += 1; continue; }
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (addedSet.has(rel)) continue;
        const dir0 = top ?? '(root)';
        let st; try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.size > ARGS.maxFileBytes) { skipped.tooLarge += 1; continue; }
        countRead();
        let raw; try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        dirCounts[dir0] = (dirCounts[dir0] || 0) + 1;
        if (PERSONAL_CONTENT_DIRS.has(dir0)) personalSeen.add(dir0);
        for (const s of stems) if (raw.includes(s.stem)) refByPre.add(s.n);
        let j; try { j = JSON.parse(raw); } catch { skipped.unparseable += 1; continue; }
        raw = null;
        const x = ids(j);
        for (const t of x.tenants) { if (!preTenants.has(t)) preTenants.set(t, new Set()); preTenants.get(t).add(dir0); }
        for (const o of x.owners) { if (!preOwners.has(o)) preOwners.set(o, new Set()); preOwners.get(o).add(dir0); }
        for (const t of x.tenants) for (const o of x.owners) prePairs.add(`${t}\u0000${o}`);
        if (IDENTITY_DIRS.has(dir0)) for (const o of x.owners) identityOwners.add(o);
        // timing-relevant fields only (no names, objectives or ids leave this block)
        if (dir0 === 'tasks') tasks.push({ status: statusOf(j), type: typeof j.type === 'string' && STATUS_RE.test(j.type) ? j.type : '(other)', next: isoOrNull(j.nextRunAt), last: isoOrNull(j.lastRunAt), brief: j.automationKind === 'DAILY_BRIEF', t: [...x.tenants][0], o: [...x.owners][0] });
        else if (dir0 === 'approvals') approvals.push({ status: statusOf(j), created: isoOrNull(j.createdAt), expires: isoOrNull(j.expiresAt) });
        else if (dir0 === 'durable-task-runs') { if (j.status === 'RUNNING') durableRuns.RUNNING += 1; else durableRuns.other += 1; }
        else if (dir0 === 'task-continuations' && j.status === 'WAITING') contWaiting.n += 1;
      }
    }
  };
  walk(ROOT, null);

  // ---- dependencies among the added records ---------------------------------------------------------------------------------------------------------------------------------------
  const dependsOn = new Map(), dependedBy = new Map();
  for (const r of rows) {
    const a = added.get(r.n); if (!a.raw) continue;
    for (const s of stems) if (s.n !== r.n && a.raw.includes(s.stem)) {
      if (!dependsOn.has(r.n)) dependsOn.set(r.n, new Set()); dependsOn.get(r.n).add(s.n);
      if (!dependedBy.has(s.n)) dependedBy.set(s.n, new Set()); dependedBy.get(s.n).add(r.n);
    }
  }
  // payload (non-JSON) files are linked through the parent's stem (binaryStoragePath names them); the parent mentions the payload's file name
  const kindOf = (set, pre) => {
    if (!set.size) return 'none';
    const kinds = new Set();
    for (const v of set) kinds.add(v === DEMO_TENANT ? 'demo' : identityOwners.has(v) ? 'registered-account' : pre.has(v) ? 'other-preexisting' : 'test-style-only');
    return [...kinds].sort().join('+');
  };

  // ---- daily-brief automation: could the live scheduler have produced the blocked briefs? ---------------------------------------------------------------------------------------------
  const briefTasks = tasks.filter((t) => t.brief);
  const briefRanInWindow = new Set(briefTasks.filter((t) => t.last !== null && t.last >= winStart && t.last <= winEnd).map((t) => `${t.t}\u0000${t.o}`));

  const items = rows.map((r) => {
    const a = added.get(r.n);
    let viewable = 0;
    for (const t of a.x.tenants) for (const o of a.x.owners) if (prePairs.has(`${t}\u0000${o}`)) viewable = 1;
    let briefTaskRan = 0;
    if (r.dir === 'daily-briefs') for (const t of a.x.tenants) for (const o of a.x.owners) if (briefRanInWindow.has(`${t}\u0000${o}`)) briefTaskRan = 1;
    const dirsMentioned = new Set();
    for (const t of a.x.tenants) for (const d of preTenants.get(t) ?? []) dirsMentioned.add(d);
    return {
      n: r.n, dir: a.valid ? r.dir : '(invalid path)', verdict: r.verdict, blocked: r.verdict.startsWith('BLOCKED'), size: r.size, mtime: new Date(r.mt).toISOString(), status: statusOf(a.j),
      tenantKind: kindOf(a.x.tenants, preTenants), ownerKind: kindOf(a.x.owners, preOwners), viewable, briefTaskRan, refByPre: refByPre.has(r.n) ? 1 : 0,
      dependsOn: [...(dependsOn.get(r.n) ?? [])], dependedBy: [...(dependedBy.get(r.n) ?? [])], sharedDirs: [...dirsMentioned].sort(), valid: a.valid ? 1 : 0, json: a.json ? 1 : 0, parsed: a.j ? 1 : 0,
    };
  });
  const byN = new Map(items.map((i) => [i.n, i]));
  const unresolved = items.filter((i) => i.blocked && (i.tenantKind === 'none' && i.ownerKind === 'none') && i.json);
  const closure = {
    candidatesDependingOnBlocked: items.filter((i) => !i.blocked && i.dependsOn.some((m) => byN.get(m)?.blocked)).length,
    blockedDependingOnCandidates: items.filter((i) => i.blocked && i.dependsOn.some((m) => !byN.get(m)?.blocked)).length,
    candidatesReferencedByPreexisting: items.filter((i) => !i.blocked && i.refByPre).length,
    blockedReferencedByPreexisting: items.filter((i) => i.blocked && i.refByPre).length,
    candidatesViewableByARealOwner: items.filter((i) => !i.blocked && i.viewable).length,
    blockedViewableByARealOwner: items.filter((i) => i.blocked && i.viewable).length,
  };

  // ---- aggregates --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const group = {};
  for (const i of items) {
    const g = (group[`${i.dir} | ${i.blocked ? 'BLOCKED' : 'CANDIDATE'}`] ||= { count: 0, ownerKind: {}, tenantKind: {}, status: {}, viewable: 0, referencedByPreexisting: 0, withDependencies: 0, withDependents: 0, briefTaskRanInWindow: 0, notParsed: 0 });
    g.count += 1; g.ownerKind[i.ownerKind] = (g.ownerKind[i.ownerKind] || 0) + 1; g.tenantKind[i.tenantKind] = (g.tenantKind[i.tenantKind] || 0) + 1; g.status[i.status] = (g.status[i.status] || 0) + 1;
    g.viewable += i.viewable; g.referencedByPreexisting += i.refByPre; g.withDependencies += i.dependsOn.length ? 1 : 0; g.withDependents += i.dependedBy.length ? 1 : 0; g.briefTaskRanInWindow += i.briefTaskRan; g.notParsed += i.json && !i.parsed ? 1 : 0;
  }
  const now = Date.now();
  const H = 3600 * 1000;
  const live = tasks.filter((t) => t.status !== 'PAUSED');
  const bucket = (arr, key) => ({ overdue: arr.filter((t) => t[key] !== null && t[key] < now).length, within24h: arr.filter((t) => t[key] !== null && t[key] >= now && t[key] < now + 24 * H).length, within72h: arr.filter((t) => t[key] !== null && t[key] >= now + 24 * H && t[key] < now + 72 * H).length, later: arr.filter((t) => t[key] !== null && t[key] >= now + 72 * H).length, none: arr.filter((t) => t[key] === null).length });
  const hourHist = new Array(24).fill(0);
  for (const t of live) if (t.next !== null && t.next >= now) hourHist[new Date(t.next).getUTCHours()] += 1;
  const tasksTiming = {
    total: tasks.length, byStatus: tasks.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {}), byType: tasks.reduce((m, t) => { m[t.type] = (m[t.type] || 0) + 1; return m; }, {}),
    notPausedNextRun: bucket(live, 'next'), notPausedUpcomingByUtcHour: hourHist,
    dailyBriefAutomation: { tasks: briefTasks.length, notPaused: briefTasks.filter((t) => t.status !== 'PAUSED').length, lastRunInIncidentWindow: briefTasks.filter((t) => t.last !== null && t.last >= winStart && t.last <= winEnd).length },
  };
  const pending = approvals.filter((a) => a.status === 'PENDING');
  const approvalsTiming = {
    total: approvals.length, byStatus: approvals.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {}),
    pending: pending.length, pendingExpiringWithin24h: pending.filter((a) => a.expires !== null && a.expires >= now && a.expires < now + 24 * H).length, pendingAlreadyExpired: pending.filter((a) => a.expires !== null && a.expires < now).length,
    oldestPendingAgeHours: pending.length ? Math.round(Math.max(...pending.map((a) => (a.created !== null ? (now - a.created) / H : 0)))) : null,
  };
  const dirSummary = (abs) => {
    let files = 0, bytes = 0, newest = 0, dirs = 0;
    const w = (d) => { tick(); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { dirs += 1; w(p); } else if (e.isFile()) { files += 1; try { const st = fs.lstatSync(p); bytes += st.size; newest = Math.max(newest, st.mtimeMs); } catch { /* vanished */ } } } };
    w(abs);
    return { files, dirs, bytes, newestMtimeUtc: newest ? new Date(newest).toISOString() : null };
  };
  const rootEntries = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isDirectory()) rootEntries.push({ name: e.name, type: 'dir', known: KNOWN_STORE_DIRS.has(e.name), ...dirSummary(path.join(ROOT, e.name)) });
    else if (e.isFile()) { const st = fs.lstatSync(path.join(ROOT, e.name)); rootEntries.push({ name: e.name, type: 'file', known: KNOWN_ROOT_FILES.has(e.name), files: 1, bytes: st.size, newestMtimeUtc: new Date(st.mtimeMs).toISOString() }); }
    else rootEntries.push({ name: e.name, type: 'other', known: false });
  }
  const probes = ARGS.probes.map((p) => {
    try { const rp = fs.realpathSync(p); const st = fs.lstatSync(rp); return { probe: path.basename(p), exists: true, type: st.isDirectory() ? 'dir' : 'file', ...(st.isDirectory() ? dirSummary(rp) : { files: 1, bytes: st.size, newestMtimeUtc: new Date(st.mtimeMs).toISOString() }) }; } catch { return { probe: path.basename(p), exists: false }; }
  });

  // ---- the one optional private output (all-or-nothing, after every analysis step succeeded) -----------------------------------------------------------------------------------------
  if (OUT) {
    const header = ['row', 'dir', 'verdict', 'sizeBytes', 'mtimeUtc', 'status', 'tenantKind', 'ownerKind', 'viewableByRealOwner', 'briefTaskRanInWindow', 'referencedByPreexisting', 'dependsOnRows', 'dependedByRows', 'preexistingDirsSharingTenant', 'validPath', 'parsedJson'];
    const lines = [header.join('\t'), ...items.map((i) => [i.n, i.dir, i.verdict, i.size, i.mtime, i.status, i.tenantKind, i.ownerKind, i.viewable, i.briefTaskRan, i.refByPre, i.dependsOn.join(',') || '-', i.dependedBy.join(',') || '-', i.sharedDirs.join(',') || '-', i.valid, i.parsed].join('\t'))];
    const fd = fs.openSync(OUT, 'wx', 0o600);
    try { fs.writeSync(fd, lines.join('\n') + '\n'); } finally { fs.closeSync(fd); }
  }

  console.log(JSON.stringify({
    tool: 'data-incident-decision-annex v2', mode: 'READ-ONLY: nothing under the data root was modified', bounds: { maxFiles: ARGS.maxFiles, maxSeconds: ARGS.maxSeconds, maxFileBytes: ARGS.maxFileBytes, maxRows: ARGS.maxRows },
    run: { filesRead: FILES_READ, seconds: Math.round((Date.now() - STARTED) / 100) / 10, incidentWindowUtc: [new Date(winStart + 5 * 60000).toISOString(), new Date(winEnd - 5 * 60000).toISOString()] },
    scope: { preexistingJsonRead: Object.values(dirCounts).reduce((a, b) => a + b, 0), skippedSecretDirs: [...skipped.secretDirs].sort(), skippedSecretFiles: skipped.secretFiles, skippedTooLarge: skipped.tooLarge, unparseable: skipped.unparseable,
      identityRead: ARGS.identityRead, identityDirsSkipped: skipped.identityDirsSkipped, personalContentDirsReadTransiently: [...personalSeen].sort(), identityLikeOwners: identityOwners.size },
    rows: rows.length, candidates: items.filter((i) => !i.blocked).length, blocked: items.filter((i) => i.blocked).length,
    closure, unresolvedOwnership: { blockedWithNoOwnerClaim: unresolved.length, rowsWithInvalidPath: items.filter((i) => !i.valid).length, jsonRowsNotParsed: items.filter((i) => i.json && !i.parsed).length },
    byGroup: group, blockedOwnerKinds: items.filter((i) => i.blocked).reduce((m, i) => { const k = `${i.tenantKind} / ${i.ownerKind}`; m[k] = (m[k] || 0) + 1; return m; }, {}),
    tasksTiming, approvalsTiming, durableRunsOutsideIncident: durableRuns, waitingContinuationsOutsideIncident: contWaiting.n,
    stateLocations: { rootEntries: rootEntries.sort((a, b) => a.name.localeCompare(b.name)), unknownRootEntries: rootEntries.filter((e) => !e.known).map((e) => e.name).sort(), probes },
    privateOutput: OUT ? `written (0600, exclusive create): ${path.basename(OUT)}` : 'none (no --out given)',
  }, null, 1));
} catch (e) {
  if (e instanceof Abort) { console.log(JSON.stringify({ tool: 'data-incident-decision-annex v2', aborted: true, reason: e.message, filesRead: FILES_READ, outputWritten: false }, null, 1)); process.exit(3); }
  console.error(`failed: ${e && e.code ? e.code : 'error'} (no output file written)`);
  process.exit(1);
}
