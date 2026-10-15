#!/usr/bin/env node
// READ-ONLY decision annex for the 2026-10-15 test-data incident. It never modifies, moves, deletes or restores anything under the data root. It reads the private reconciliation table written by
// data-incident-reconcile.mjs and the records it lists, and answers the questions an operator needs per item before approving anything:
//   - what kind of owner does the record claim (demo tenant / registered account / other pre-existing / test-style only)?
//   - would the running service show it to a real owner (tenant+owner pair equal to a pre-existing pair)?
//   - is it referenced by any pre-existing record?   - which added records does it depend on / which depend on it?   - what is its run/continuation/brief state?
// Output: NON-SENSITIVE aggregates on stdout, and ONE private per-item table (mode 0600) in the operator's own logs folder. The table holds row numbers (the row order of reconciliation-added.tsv),
// class codes and enumerated values only - no record content, no identifiers - but it stays private to the host like the table it extends.
// Usage (on the host, as the operator account, ONLY when read access to the records has been approved):  node data-incident-decision-annex.mjs <logsDir> [dataRoot]
import fs from 'node:fs';
import path from 'node:path';

const [logsDir, dataRootArg] = process.argv.slice(2);
if (!logsDir) { console.error('usage: data-incident-decision-annex.mjs <logsDir> [dataRoot]'); process.exit(2); }
const ROOT = fs.realpathSync(dataRootArg || '/var/lib/nagex');
const LOGS = fs.realpathSync(logsDir);
if (LOGS === ROOT || LOGS.startsWith(ROOT + path.sep)) { console.error('refusing: the logs folder is inside the data root'); process.exit(2); }

// The demo tenant constant is public source (src/demo/demo-identity.ts); it is the one pre-existing tenant a test run is expected to share with the live store.
const DEMO_TENANT = 'ten_demo_hackathon';
const CLASS_OF_DIR = {
  'durable-task-runs': 'C01/B', 'task-continuations': 'C02', artifacts: 'C03/B', images: 'C04/B', 'image-bytes': 'C05/B', documents: 'C06', presentations: 'C07', 'presentation-bytes': 'C08',
  'memory-settings': 'C09', 'device-transport-replay': 'C10', 'rbac-bindings': 'C11', 'daily-briefs': 'B-briefs', 'device-connection-status': 'B-device', 'device-identities': 'B-device',
  'mobile-message-runs': 'B-mobile',
};

const rows = fs.readFileSync(path.join(LOGS, 'reconciliation-added.tsv'), 'utf8').split('\n').slice(1).filter(Boolean).map((l, i) => {
  const [rel, size, , mt, verdict] = l.split('\t');
  return { n: i + 1, rel, size: Number(size), mt: Number(mt), verdict, dir: rel.split('/')[0], file: rel.slice(rel.indexOf('/') + 1) };
});
const addedSet = new Set(rows.map((r) => r.rel));
const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };

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

// ---- pre-existing world: every JSON record that is not in the added table ----
const preTenants = new Map(); // tenant -> Set(top-level dirs mentioning it)
const preOwners = new Map();
const prePairs = new Set();
const preRaw = []; // [dir, raw text] for reference search
const walk = (dir, cb) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, cb); else if (e.isFile()) cb(p); } };
walk(ROOT, (abs) => {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (addedSet.has(rel) || !rel.endsWith('.json')) return;
  let raw; try { raw = fs.readFileSync(abs, 'utf8'); } catch { return; }
  const dir = rel.split('/')[0];
  preRaw.push([dir, raw]);
  let j; try { j = JSON.parse(raw); } catch { return; }
  const x = ids(j);
  for (const t of x.tenants) { if (!preTenants.has(t)) preTenants.set(t, new Set()); preTenants.get(t).add(dir); }
  for (const o of x.owners) { if (!preOwners.has(o)) preOwners.set(o, new Set()); preOwners.get(o).add(dir); }
  for (const t of x.tenants) for (const o of x.owners) prePairs.add(`${t}\u0000${o}`);
});
const identityOwners = new Set();
for (const [o, dirs] of preOwners) if ([...dirs].some((d) => d === 'identity' || d === 'identity-tokens' || d === 'sessions' || d === 'organizations')) identityOwners.add(o);

// ---- stems of the added records, for the dependency / reference search ----
const stemOf = (r) => r.file.replace(/\.json$/, '');
const stems = rows.map((r) => ({ n: r.n, stem: stemOf(r) })).filter((s) => s.stem.length >= 8);
const refByPre = new Set();
for (const [, raw] of preRaw) for (const s of stems) if (raw.includes(s.stem)) refByPre.add(s.n);
const rawOfAdded = new Map(); // n -> raw
for (const r of rows) { try { rawOfAdded.set(r.n, fs.readFileSync(path.join(ROOT, r.rel), 'utf8')); } catch { /* not readable: reported as unreadable */ } }
const dependsOn = new Map(); // n -> Set(m) : record n mentions the id of added record m
for (const r of rows) {
  const raw = rawOfAdded.get(r.n); if (!raw) continue;
  for (const s of stems) if (s.n !== r.n && raw.includes(s.stem)) { if (!dependsOn.has(r.n)) dependsOn.set(r.n, new Set()); dependsOn.get(r.n).add(s.n); }
}
const dependedBy = new Map();
for (const [n, set] of dependsOn) for (const m of set) { if (!dependedBy.has(m)) dependedBy.set(m, new Set()); dependedBy.get(m).add(n); }

// ---- per-item annex ----
const kindOf = (set, pre) => {
  if (!set.size) return 'none';
  const kinds = new Set();
  for (const v of set) {
    if (v === DEMO_TENANT) kinds.add('demo');
    else if (identityOwners.has(v)) kinds.add('registered-account');
    else if (pre.has(v)) kinds.add('other-preexisting');
    else kinds.add('test-style-only');
  }
  return [...kinds].sort().join('+');
};
const out = [];
for (const r of rows) {
  const j = readJson(r.rel);
  const x = j ? ids(j) : { tenants: new Set(), owners: new Set() };
  let viewable = 0;
  for (const t of x.tenants) for (const o of x.owners) if (prePairs.has(`${t}\u0000${o}`)) viewable = 1;
  const status = j && typeof (j.status ?? j.state) === 'string' ? String(j.status ?? j.state).slice(0, 24) : '-';
  const dirsMentioned = new Set();
  for (const t of x.tenants) for (const d of preTenants.get(t) ?? []) dirsMentioned.add(d);
  out.push({
    n: r.n, cls: CLASS_OF_DIR[r.dir] ?? (r.dir.startsWith('test_') || r.dir.startsWith('mc5a_') ? 'C12/B-idem' : 'other'), dir: r.dir, verdict: r.verdict, size: r.size, mtime: new Date(r.mt).toISOString(), status,
    tenantKind: kindOf(x.tenants, preTenants), ownerKind: kindOf(x.owners, preOwners), viewableByRealOwner: viewable, referencedByPreexisting: refByPre.has(r.n) ? 1 : 0,
    dependsOn: [...(dependsOn.get(r.n) ?? [])].join(',') || '-', dependedBy: [...(dependedBy.get(r.n) ?? [])].join(',') || '-', preexistingDirsSharingTenant: [...dirsMentioned].sort().join(',') || '-',
    readable: j || rawOfAdded.has(r.n) ? 1 : 0,
  });
}
const header = ['row', 'class', 'dir', 'verdict', 'sizeBytes', 'mtimeUtc', 'status', 'tenantKind', 'ownerKind', 'viewableByRealOwner', 'referencedByPreexisting', 'dependsOnRows', 'dependedByRows', 'preexistingDirsSharingTenant', 'readable'];
const lines = [header.join('\t'), ...out.map((o) => [o.n, o.cls, o.dir, o.verdict, o.size, o.mtime, o.status, o.tenantKind, o.ownerKind, o.viewableByRealOwner, o.referencedByPreexisting, o.dependsOn, o.dependedBy, o.preexistingDirsSharingTenant, o.readable].join('\t'))];
const annexPath = path.join(LOGS, 'decision-annex-items.tsv');
fs.writeFileSync(annexPath, lines.join('\n') + '\n', { mode: 0o600 });

// ---- aggregates (stdout; safe to paste into a report) ----
const cnt = (a, f) => a.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const group = (rowsIn) => {
  const g = {};
  for (const o of rowsIn) {
    const k = `${o.dir} | ${o.verdict.startsWith('BLOCKED') ? 'BLOCKED' : 'CANDIDATE'}`;
    const e = (g[k] ||= { count: 0, ownerKind: {}, status: {}, viewableByRealOwner: 0, referencedByPreexisting: 0, hasDependencies: 0, hasDependents: 0, unreadable: 0 });
    e.count += 1; e.ownerKind[o.ownerKind] = (e.ownerKind[o.ownerKind] || 0) + 1; e.status[o.status] = (e.status[o.status] || 0) + 1;
    e.viewableByRealOwner += o.viewableByRealOwner; e.referencedByPreexisting += o.referencedByPreexisting; e.hasDependencies += o.dependsOn === '-' ? 0 : 1; e.hasDependents += o.dependedBy === '-' ? 0 : 1; e.unreadable += o.readable ? 0 : 1;
  }
  return g;
};
console.log(JSON.stringify({
  mode: 'READ-ONLY (nothing under the data root was modified)',
  rows: rows.length, candidates: out.filter((o) => !o.verdict.startsWith('BLOCKED')).length, blocked: out.filter((o) => o.verdict.startsWith('BLOCKED')).length,
  preexistingJsonRead: preRaw.length, identityLikeOwners: identityOwners.size,
  byGroup: group(out),
  candidatesViewableByARealOwner: out.filter((o) => !o.verdict.startsWith('BLOCKED') && o.viewableByRealOwner).length,
  candidatesReferencedByPreexisting: out.filter((o) => !o.verdict.startsWith('BLOCKED') && o.referencedByPreexisting).length,
  blockedViewableByARealOwner: out.filter((o) => o.verdict.startsWith('BLOCKED') && o.viewableByRealOwner).length,
  blockedOwnerKinds: cnt(out.filter((o) => o.verdict.startsWith('BLOCKED')), (o) => `${o.tenantKind} / ${o.ownerKind}`),
  privateAnnex: `written (0600): ${path.basename(annexPath)} in the logs folder; not published`,
}, null, 1));
