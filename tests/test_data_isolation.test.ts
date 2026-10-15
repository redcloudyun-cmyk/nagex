// P0 (2026-10-15) — TEST DATA ISOLATION CONTRACT.
//
// A test run on the service host wrote 368 records into the LIVE data root and changed four RBAC role records. Root cause: stores whose environment variable the test setup did not know about
// resolved to /var/lib/nagex whenever it was writable. This file is the standing proof that it cannot happen again, for every file-backed store - including stores added later:
//
//   1. INVENTORY (static, table-driven): every resolveNagexDataDir/resolveNagexDataFile call site in src/ is discovered by scanning the source, and each one - env variable ABSENT - must resolve
//      inside the private test root. A new store that bypasses the resolver (its own /var/lib/nagex, ~/.local/share, <cwd>/.nagex_data, homedir path) fails the source scan.
//   2. RESOLVER BEHAVIOUR: explicit override inside / outside the root, symlink escape, production root that exists and is writable, NODE_ENV=production, custom values for some stores.
//   3. SENTINEL (zero writes): a stand-in production root, populated like the real one (role records with an updatedAt), is registered as forbidden; real stores are constructed and written in a
//      child process with their environment variables stripped; the sentinel must be byte-for-byte and mtime-for-mtime unchanged, and the tripwire must refuse direct writes to it - including from
//      a grandchild process, which only has the tripwire through NODE_OPTIONS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertIsolatedTestPath, isTestDataMode, PRODUCTION_DATA_ROOT, TestIsolationError } from '../src/governance/data-root-isolation.js';
import { resolveNagexDataDir, resolveNagexDataFile } from '../src/governance/file-record.store.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');

function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-isolation-${label}-`));
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// code only: block and line comments removed so documentation that mentions a path is not mistaken for a path
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const rel = (file: string) => path.relative(SRC_ROOT, file).split(path.sep).join('/');

interface Site { file: string; kind: 'dir' | 'file'; name: string; envVar: string }
function discoverSites(): { sites: Site[]; dynamic: string[] } {
  const sites: Site[] = [];
  const dynamic: string[] = [];
  for (const file of listSources(SRC_ROOT)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(/\b(resolveNagexDataDir|resolveNagexDataFile)\(\s*([^)]*?)\)/g)) {
      if (rel(file) === 'governance/file-record.store.ts') continue; // the definitions
      const literal = /^\s*'([^']+)'\s*,\s*'([^']+)'/.exec(match[2]);
      if (literal) sites.push({ file: rel(file), kind: match[1] === 'resolveNagexDataFile' ? 'file' : 'dir', name: literal[1], envVar: literal[2] });
      else dynamic.push(`${rel(file)}: ${match[0].slice(0, 80)}`);
    }
  }
  return { sites, dynamic };
}

function testEnv(root: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NAGEX_TEST_DATA_ROOT: root, NAGEX_TEST_DATA_ROOT_OWNER_PID: String(process.pid), NODE_ENV: 'test', ...extra } as NodeJS.ProcessEnv;
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(root, full)}/`] = String(fs.statSync(full).mtimeMs); walk(full); continue; }
      const stat = fs.statSync(full);
      out[path.relative(root, full)] = `${stat.size}:${stat.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}

describe('test data isolation — inventory of every file-backed store', () => {
  const { sites, dynamic } = discoverSites();

  it('discovers the store inventory (a broken scanner must not pass silently) and accounts for every non-literal call site', () => {
    assert.ok(sites.length >= 55, `expected the inventory to find the known stores, found ${sites.length}`);
    for (const known of ['rbac-roles', 'rbac-bindings', 'durable-task-runs', 'task-continuations', 'approvals', 'vault', 'github-oauth.json', 'google-oauth.json', 'mcp-connections.json']) {
      assert.ok(sites.some((s) => s.name === known), `${known} is missing from the discovered inventory`);
    }
    // call sites that pass a variable instead of a literal are reviewed here, by name; a new one fails until a human adds it to this list
    const allowedDynamic = ['capabilities/capability-broker.ts', 'modules/module-state.store.ts'];
    assert.deepEqual(dynamic.map((d) => d.split(':')[0]).sort(), allowedDynamic.sort(), `unreviewed non-literal resolver call sites: ${JSON.stringify(dynamic)}`);
  });

  for (const site of sites) {
    it(`${site.file}: "${site.name}" resolves inside the test root when ${site.envVar} is ABSENT, and an override outside it is refused`, () => {
      const root = makeTempDir('inv');
      try {
        const env = testEnv(root, { NAGEX_TEST_FORBIDDEN_ROOTS: path.join(root, '..', 'sentinel-never-used') });
        const resolved = site.kind === 'file' ? resolveNagexDataFile(site.name, site.envVar, env) : resolveNagexDataDir(site.name, site.envVar, env);
        assert.ok(resolved.startsWith(root), `${resolved} is not under ${root}`);
        const outside = path.join(PRODUCTION_DATA_ROOT, site.name);
        const aimedAtLive = { ...env, [site.envVar]: outside };
        assert.throws(
          () => (site.kind === 'file' ? resolveNagexDataFile(site.name, site.envVar, aimedAtLive) : resolveNagexDataDir(site.name, site.envVar, aimedAtLive)),
          (e: unknown) => e instanceof TestIsolationError,
        );
        const inRoot = { ...env, [site.envVar]: path.join(root, 'custom', site.name) };
        assert.equal(site.kind === 'file' ? resolveNagexDataFile(site.name, site.envVar, inRoot) : resolveNagexDataDir(site.name, site.envVar, inRoot), path.join(root, 'custom', site.name));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('no source file outside the resolver module decides a live data location by itself (so a future store cannot silently bypass the isolation)', () => {
    // production-data locations may be named only by the resolver and the isolation module; the personal reminder store and the desktop stores are reviewed, isolation-aware exceptions
    const reviewed = new Set(['governance/file-record.store.ts', 'governance/data-root-isolation.ts', 'personal/personal-reminder.store.ts', 'desktop/desktop-app.ts', 'desktop/desktop-config.store.ts']);
    const offenders: string[] = [];
    for (const file of listSources(SRC_ROOT)) {
      if (reviewed.has(rel(file))) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\/var\/lib\/nagex|\.nagex_data|['"]\.local['"]\s*,\s*['"]share['"]|os\.homedir\(\)|homedir\(\)/.test(code)) offenders.push(rel(file));
    }
    assert.deepEqual(offenders, [], `these files name a live data location without going through resolveNagexDataDir/File: ${offenders.join(', ')}`);
  });

  it('the reviewed exceptions are themselves isolation-aware (reminder store) or only reachable with an injected directory (desktop stores)', () => {
    const reminder = fs.readFileSync(path.join(SRC_ROOT, 'personal', 'personal-reminder.store.ts'), 'utf8');
    assert.match(reminder, /isTestDataMode\(\)/);
    assert.match(reminder, /assertIsolatedTestPath/);
    const desktopConfig = fs.readFileSync(path.join(SRC_ROOT, 'desktop', 'desktop-config.store.ts'), 'utf8');
    assert.match(desktopConfig, /customDir \|\|/, 'the desktop config store keeps its injectable directory');
  });
});

describe('test data isolation — resolver behaviour', () => {
  it('test mode needs BOTH the root and the owner pid, and is refused in a process that declares production', () => {
    assert.equal(isTestDataMode({} as NodeJS.ProcessEnv), false);
    assert.equal(isTestDataMode({ NAGEX_TEST_DATA_ROOT: '/tmp/x' } as NodeJS.ProcessEnv), false);
    assert.equal(isTestDataMode({ NAGEX_TEST_DATA_ROOT_OWNER_PID: '1' } as NodeJS.ProcessEnv), false);
    assert.equal(isTestDataMode(testEnv('/tmp/x')), true);
    // variables left behind by a FINISHED test run (dead owner pid) must never redirect a real server's storage
    const finished = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    assert.equal(isTestDataMode({ NAGEX_TEST_DATA_ROOT: '/tmp/x', NAGEX_TEST_DATA_ROOT_OWNER_PID: finished.stdout.trim() } as NodeJS.ProcessEnv), false);
    assert.equal(isTestDataMode({ NAGEX_TEST_DATA_ROOT: '/tmp/x', NAGEX_TEST_DATA_ROOT_OWNER_PID: 'not-a-pid' } as NodeJS.ProcessEnv), false);
    assert.throws(() => isTestDataMode(testEnv('/tmp/x', { NODE_ENV: 'production' })), TestIsolationError);
    assert.throws(() => resolveNagexDataDir('plans', 'NAGEX_PLANS_DIR', testEnv('/tmp/x', { NODE_ENV: 'production' })), TestIsolationError);
  });

  it('NEGATIVE: the production root exists and is writable, the env var is absent -> the test root is used and the production root is never touched', () => {
    const production = makeTempDir('prod');
    const root = makeTempDir('root');
    try {
      fs.mkdirSync(path.join(production, 'rbac-roles'));
      fs.writeFileSync(path.join(production, 'rbac-roles', 'role_builtin_owner.json'), JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }));
      const before = snapshot(production);
      const env = testEnv(root, { NAGEX_TEST_FORBIDDEN_ROOTS: production });
      // without test mode the very same call picks the writable production root (behaviour preserved for the real service)
      assert.equal(resolveNagexDataDir('rbac-roles', 'NAGEX_RBAC_ROLES_DIR', {} as NodeJS.ProcessEnv, { productionRoot: production }), path.join(production, 'rbac-roles'));
      assert.equal(resolveNagexDataFile('google-oauth.json', 'NAGEX_GOOGLE_TOKEN_STORE_PATH', {} as NodeJS.ProcessEnv, { productionRoot: production }), path.join(production, 'google-oauth.json'));
      // in test mode the production-root option is irrelevant: private root, nothing created
      assert.equal(resolveNagexDataDir('rbac-roles', 'NAGEX_RBAC_ROLES_DIR', env, { productionRoot: production }), path.join(root, 'rbac-roles'));
      assert.equal(resolveNagexDataFile('google-oauth.json', 'NAGEX_GOOGLE_TOKEN_STORE_PATH', env, { productionRoot: production }), path.join(root, 'google-oauth.json'));
      assert.deepEqual(snapshot(production), before);
      assert.equal(fs.existsSync(path.join(root, 'rbac-roles')), false, 'resolving must not create anything');
    } finally {
      fs.rmSync(production, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: some stores custom, some unset - custom ones inside the root/OS temp are honoured, the others fall under the root, a custom one aimed at a forbidden root throws', () => {
    const root = makeTempDir('mix');
    const sentinel = makeTempDir('sentinel');
    const elsewhereInTemp = makeTempDir('elsewhere');
    try {
      const env = testEnv(root, { NAGEX_TEST_FORBIDDEN_ROOTS: sentinel, NAGEX_TASKS_DIR: path.join(root, 'my-tasks'), NAGEX_PLANS_DIR: path.join(elsewhereInTemp, 'plans'), NAGEX_SESSIONS_DIR: path.join(sentinel, 'sessions') });
      assert.equal(resolveNagexDataDir('tasks', 'NAGEX_TASKS_DIR', env), path.join(root, 'my-tasks'));
      assert.equal(resolveNagexDataDir('plans', 'NAGEX_PLANS_DIR', env), path.join(elsewhereInTemp, 'plans'));
      assert.equal(resolveNagexDataDir('approvals', 'NAGEX_APPROVALS_DIR', env), path.join(root, 'approvals'));
      assert.throws(() => resolveNagexDataDir('sessions', 'NAGEX_SESSIONS_DIR', env), TestIsolationError);
      // outside the root AND outside the OS temp directory (and not a named forbidden root) is refused as well
      const stray = path.parse(os.tmpdir()).root === os.tmpdir() ? null : path.join(path.dirname(os.tmpdir()), 'nagex-isolation-stray');
      if (stray) assert.throws(() => resolveNagexDataDir('x', 'NAGEX_X_DIR', { ...env, NAGEX_X_DIR: stray } as NodeJS.ProcessEnv), TestIsolationError);
    } finally {
      for (const d of [root, sentinel, elsewhereInTemp]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a symlink (junction) INSIDE the test root that leads to a forbidden root is refused, for existing and not-yet-created paths', () => {
    const root = makeTempDir('link');
    const sentinel = makeTempDir('linktarget');
    try {
      const link = path.join(root, 'looks-private');
      fs.symlinkSync(sentinel, link, 'junction');
      const env = testEnv(root, { NAGEX_TEST_FORBIDDEN_ROOTS: sentinel });
      assert.throws(() => assertIsolatedTestPath(link, env), TestIsolationError);
      assert.throws(() => assertIsolatedTestPath(path.join(link, 'not-yet', 'created'), env), TestIsolationError);
      assert.throws(() => resolveNagexDataDir('tasks', 'NAGEX_TASKS_DIR', { ...env, NAGEX_TASKS_DIR: path.join(link, 'tasks') } as NodeJS.ProcessEnv), TestIsolationError);
      assert.deepEqual(fs.readdirSync(sentinel), [], 'refusal happens before anything is created');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sentinel, { recursive: true, force: true });
    }
  });

  it('the live locations are always forbidden: the production data root, the per-user fallback dir, the working-directory fallback, and the desktop home dir', () => {
    const root = makeTempDir('forbid');
    try {
      const env = testEnv(root);
      for (const live of [PRODUCTION_DATA_ROOT, path.join(os.homedir(), '.local', 'share', 'nagex'), path.join(process.cwd(), '.nagex_data'), path.join(os.homedir(), '.nagex')]) {
        assert.throws(() => assertIsolatedTestPath(path.join(live, 'anything'), env), TestIsolationError, live);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('test data isolation — sentinel production root, zero writes (real stores, real child processes)', () => {
  // A stand-in production root populated like the real one: role records with an updatedAt, plus an approval record.
  function makeSentinel(): string {
    const sentinel = makeTempDir('sentinel-root');
    for (const dir of ['rbac-roles', 'rbac-bindings', 'approvals', 'task-continuations', 'durable-task-runs']) fs.mkdirSync(path.join(sentinel, dir));
    for (const id of ['role_builtin_owner', 'role_builtin_admin', 'role_builtin_member', 'role_builtin_viewer']) {
      fs.writeFileSync(path.join(sentinel, 'rbac-roles', `${id}.json`), JSON.stringify({ roleId: id, name: id, description: 'd', isSystem: true, permissions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    }
    fs.writeFileSync(path.join(sentinel, 'github-oauth.json'), '{}');
    // make the mtimes unmistakably old so any touch is visible
    const old = new Date('2026-01-01T00:00:00.000Z');
    for (const f of fs.readdirSync(path.join(sentinel, 'rbac-roles'))) fs.utimesSync(path.join(sentinel, 'rbac-roles', f), old, old);
    return sentinel;
  }

  // The child gets the REAL harness (_setup.js) and then has every store variable removed, which is exactly the condition that leaked: stores constructed with no directory and no variable.
  function childEnv(sentinel: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, NAGEX_TEST_FORBIDDEN_ROOTS: sentinel };
    for (const key of Object.keys(env)) if (/^NAGEX_TEST_DATA_ROOT/.test(key)) delete env[key];
    delete env.NODE_OPTIONS;
    return env;
  }

  const CHILD_PRELUDE = `
    const path = require('node:path'); const fs = require('node:fs');
    for (const key of Object.keys(process.env)) if (/^NAGEX_.*(_DIR|_PATH)$/.test(key) && !/^NAGEX_TEST_/.test(key)) delete process.env[key];
    const dist = ${JSON.stringify(DIST_ROOT)};
    const load = (p) => require(path.join(dist, 'src', p));
  `;

  function runChild(sentinel: string, body: string): { status: number | null; stdout: string; stderr: string } {
    const script = `${CHILD_PRELUDE}\n${body}`;
    const result = spawnSync(process.execPath, ['--require', path.join(__dirname, '_setup.js'), '-e', script], { env: childEnv(sentinel), encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('real stores constructed and written with NO directories configured stay inside the private root; the sentinel (roles included) is untouched', () => {
    const sentinel = makeSentinel();
    try {
      const before = snapshot(sentinel);
      const { status, stdout, stderr } = runChild(sentinel, `
        const { RbacStore } = load('rbac/rbac.store.js');
        const { DurableTaskRunStateStore } = load('tasks/durable-task-run-state.store.js');
        const { TaskContinuationStore } = load('tasks/task-continuation.store.js');
        const { PersonalReminderStore } = load('personal/personal-reminder.store.js');
        const { resolveDefaultGitHubTokenStorePath } = load('integrations/github/token.store.js');
        const { resolveDefaultGoogleTokenStorePath } = load('integrations/google/token.store.js');
        const { resolveDefaultMcpStorePath } = load('mcp/mcp-connection.store.js');
        const { resolveNagexDataDir } = load('governance/file-record.store.js');
        new RbacStore();                       // seeds (rewrites) the four built-in role records - the incident's RBAC change
        new DurableTaskRunStateStore();
        new TaskContinuationStore();
        new PersonalReminderStore();
        const root = process.env.NAGEX_TEST_DATA_ROOT;
        const paths = {
          github: resolveDefaultGitHubTokenStorePath(process.env), google: resolveDefaultGoogleTokenStorePath(process.env), mcp: resolveDefaultMcpStorePath(process.env),
          roles: resolveNagexDataDir('rbac-roles', 'NAGEX_RBAC_ROLES_DIR'),
        };
        console.log(JSON.stringify({ root, paths, rolesWritten: fs.readdirSync(paths.roles).length }));
      `);
      assert.equal(status, 0, `child failed: ${stderr}`);
      const report = JSON.parse(stdout.trim().split('\n').pop() as string) as { root: string; paths: Record<string, string>; rolesWritten: number };
      assert.ok(report.root.startsWith(os.tmpdir()) || report.root.startsWith(fs.realpathSync(os.tmpdir())));
      for (const [name, p] of Object.entries(report.paths)) assert.ok(p.startsWith(report.root), `${name} -> ${p} is outside the test root ${report.root}`);
      assert.equal(report.rolesWritten, 4, 'the role records were really written - into the private root');
      assert.deepEqual(snapshot(sentinel), before, 'the sentinel production root changed');
      for (const f of fs.readdirSync(path.join(sentinel, 'rbac-roles'))) assert.equal(JSON.parse(fs.readFileSync(path.join(sentinel, 'rbac-roles', f), 'utf8')).updatedAt, '2026-01-01T00:00:00.000Z');
    } finally {
      fs.rmSync(sentinel, { recursive: true, force: true });
    }
  });

  it('the tripwire refuses direct filesystem mutations aimed at the sentinel before they reach the OS - sync, callback, promise and stream forms - while reads and writes elsewhere still work', () => {
    const sentinel = makeSentinel();
    try {
      const before = snapshot(sentinel);
      const { status, stdout, stderr } = runChild(sentinel, `
        const s = ${JSON.stringify(sentinel)}; const out = [];
        const attempt = async (label, fn) => { try { await fn(); out.push([label, 'WROTE']); } catch (e) { out.push([label, e && e.code === 'TEST_ISOLATION_VIOLATION' ? 'REFUSED' : 'OTHER:' + (e && e.message)]); } };
        (async () => {
          await attempt('writeFileSync', () => fs.writeFileSync(path.join(s, 'x.json'), '1'));
          await attempt('appendFileSync', () => fs.appendFileSync(path.join(s, 'x.json'), '1'));
          await attempt('mkdirSync', () => fs.mkdirSync(path.join(s, 'new-dir'), { recursive: true }));
          await attempt('openSync-w', () => fs.openSync(path.join(s, 'y.json'), 'w'));
          await attempt('renameSync', () => fs.renameSync(path.join(s, 'github-oauth.json'), path.join(s, 'z.json')));
          await attempt('copyFileSync', () => fs.copyFileSync(path.join(s, 'github-oauth.json'), path.join(s, 'copy.json')));
          await attempt('unlinkSync', () => fs.unlinkSync(path.join(s, 'github-oauth.json')));
          await attempt('rmSync', () => fs.rmSync(path.join(s, 'rbac-roles'), { recursive: true, force: true }));
          await attempt('utimesSync', () => fs.utimesSync(path.join(s, 'github-oauth.json'), new Date(), new Date()));
          await attempt('createWriteStream', () => fs.createWriteStream(path.join(s, 's.json')));
          await attempt('promises.writeFile', () => fs.promises.writeFile(path.join(s, 'p.json'), '1'));
          await attempt('promises.mkdir', () => fs.promises.mkdir(path.join(s, 'pd')));
          await attempt('promises.rm', () => fs.promises.rm(path.join(s, 'approvals'), { recursive: true, force: true }));
          await attempt('callback writeFile', () => new Promise((resolve, reject) => { try { fs.writeFile(path.join(s, 'c.json'), '1', (err) => (err ? reject(err) : resolve())); } catch (e) { reject(e); } }));
          // a grandchild process only has the tripwire through NODE_OPTIONS
          const grand = require('node:child_process').spawnSync(process.execPath, ['-e', "try{require('node:fs').writeFileSync(" + JSON.stringify(path.join(s, 'g.json')) + ",'1');console.log('WROTE')}catch(e){console.log(e.code==='TEST_ISOLATION_VIOLATION'?'REFUSED':'OTHER')}"], { encoding: 'utf8' });
          out.push(['grandchild writeFileSync', grand.stdout.trim()]);
          // reads of the sentinel and writes elsewhere are not affected
          const readable = fs.readdirSync(s).length > 0 && fs.readFileSync(path.join(s, 'github-oauth.json'), 'utf8') === '{}';
          const elsewhere = path.join(process.env.NAGEX_TEST_DATA_ROOT, 'ok.txt'); fs.mkdirSync(path.dirname(elsewhere), { recursive: true }); fs.writeFileSync(elsewhere, 'ok');
          console.log(JSON.stringify({ out, readable, elsewhere: fs.readFileSync(elsewhere, 'utf8') }));
        })();
      `);
      assert.equal(status, 0, `child failed: ${stderr}`);
      const report = JSON.parse(stdout.trim().split('\n').pop() as string) as { out: Array<[string, string]>; readable: boolean; elsewhere: string };
      assert.ok(report.out.length >= 15);
      for (const [label, verdict] of report.out) assert.equal(verdict, 'REFUSED', `${label}: ${verdict}`);
      assert.equal(report.readable, true);
      assert.equal(report.elsewhere, 'ok');
      assert.deepEqual(snapshot(sentinel), before, 'the sentinel production root changed');
    } finally {
      fs.rmSync(sentinel, { recursive: true, force: true });
    }
  });

  it('without the harness (no test root) the very same code is NOT affected: production behaviour is unchanged', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^NAGEX_/.test(key) || key === 'NODE_OPTIONS') delete env[key];
    const script = `
      const { resolveNagexDataDir } = require(${JSON.stringify(path.join(DIST_ROOT, 'src', 'governance', 'file-record.store.js'))});
      const explicit = resolveNagexDataDir('plans', 'NAGEX_PLANS_DIR', { NAGEX_PLANS_DIR: '/somewhere/else' });
      console.log(JSON.stringify({ explicit, defaulted: resolveNagexDataDir('plans', 'NAGEX_PLANS_DIR', {}) }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim()) as { explicit: string; defaulted: string };
    assert.equal(parsed.explicit, '/somewhere/else');
    assert.ok(parsed.defaulted === path.join(PRODUCTION_DATA_ROOT, 'plans') || parsed.defaulted === path.join(os.homedir(), '.local', 'share', 'nagex', 'plans'));
  });
});
