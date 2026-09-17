// Preloaded via `node --require ./dist/tests/_setup.js` before any test file
// (or server_web.ts, which constructs file-backed singletons at module load)
// runs. Without this, PersistentActionApprovalStore/ExecutionStore/
// SessionStore/TaskStore/TaskRunStore would default to /var/lib/nagex (or
// ~/.local/share/nagex on a dev machine) and litter the real filesystem
// with test data on every `npm test` run. The Google OAuth token store is
// safe by construction (it only ever writes when NAGEX_TOKEN_ENCRYPTION_KEY
// is set, which tests never set), but it's redirected too for defense in
// depth.
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// R15 stabilization — dozens of test files call `instance.listen(0, '127.0.0.1', cb)`
// to get an OS-assigned ephemeral port for a real in-process HTTP server,
// then immediately `fetch()` it or drive a real Chromium browser against
// it. Both Node's undici (fetch) and Chromium independently refuse to
// connect to a small, well-known set of "unsafe"/"bad" ports (mirroring
// each other — see the Fetch spec's bad port list / Chromium's
// net/base/port_util.cc), and the OS's ephemeral range can occasionally
// hand one of them back. That produced two distinct, previously
// "environmental" flake signatures across this suite: `TypeError: fetch
// failed` / `Error: bad port` from undici, and `page.goto: net::
// ERR_UNSAFE_PORT` from Playwright. Rather than patch every call site
// individually, every ephemeral listen() in every test file is
// transparently retried here — before any test file even runs — until it
// lands on a port neither fetch() nor Chromium will refuse. This is a
// process-wide fix for a process-wide (test-harness-only) problem, not a
// change to any production code path.
const UNSAFE_EPHEMERAL_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
]);

const originalListen: (this: net.Server, ...args: any[]) => net.Server = net.Server.prototype.listen as any;
net.Server.prototype.listen = function patchedListen(this: net.Server, ...args: any[]): net.Server {
  // Only the ephemeral-port pattern (port 0) can land on an unsafe port;
  // fixed-port and pipe/handle listen() calls are never touched.
  if (args[0] !== 0) {
    return originalListen.apply(this, args);
  }
  const host = typeof args[1] === 'string' ? (args[1] as string) : undefined;
  const userCallback = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as () => void) : undefined;
  const server = this;
  let attempts = 0;

  const tryListen = () => {
    attempts += 1;
    const onListening = () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      if (port !== null && UNSAFE_EPHEMERAL_PORTS.has(port) && attempts < 10) {
        server.close(() => tryListen());
        return;
      }
      if (userCallback) userCallback();
    };
    server.once('listening', onListening);
    if (host) originalListen.call(server, 0, host);
    else originalListen.call(server, 0);
  };
  tryListen();
  return this;
} as any;

const dataRoot = path.join(os.tmpdir(), 'nagex-test-data', `${process.pid}-${Date.now()}`);

process.env.NODE_ENV ??= 'test';
process.env.NAGEX_ALLOW_LOCAL_TEST_URLS ??= '1';
process.env.NAGEX_APPROVALS_DIR ??= path.join(dataRoot, 'approvals');
process.env.NAGEX_EXECUTIONS_DIR ??= path.join(dataRoot, 'executions');
process.env.NAGEX_GOOGLE_TOKEN_STORE_PATH ??= path.join(dataRoot, 'google-oauth.json');
process.env.NAGEX_SESSIONS_DIR ??= path.join(dataRoot, 'sessions');
process.env.NAGEX_TASKS_DIR ??= path.join(dataRoot, 'tasks');
process.env.NAGEX_TASK_RUNS_DIR ??= path.join(dataRoot, 'task-runs');
process.env.NAGEX_BROWSER_SESSIONS_DIR ??= path.join(dataRoot, 'browser-sessions');
process.env.NAGEX_BROWSER_PROFILE_DIR ??= path.join(dataRoot, 'browser-profile');
process.env.NAGEX_BROWSER_EVIDENCE_DIR ??= path.join(dataRoot, 'browser-evidence');
process.env.NAGEX_SAFETY_DIR ??= path.join(dataRoot, 'safety');
process.env.NAGEX_ACTIVITY_DIR ??= path.join(dataRoot, 'activity');
process.env.NAGEX_CAPTURES_DIR ??= path.join(dataRoot, 'workspace-captures');
process.env.NAGEX_CANDIDATES_DIR ??= path.join(dataRoot, 'candidates');
process.env.NAGEX_CONVERSATIONS_DIR ??= path.join(dataRoot, 'conversations');
process.env.NAGEX_NOTIFICATIONS_DIR ??= path.join(dataRoot, 'notifications');
process.env.NAGEX_OBJECT_STORAGE_DIR ??= path.join(dataRoot, 'object-storage');
process.env.NAGEX_TELEGRAM_DIR ??= path.join(dataRoot, 'telegram-identities');
process.env.NAGEX_SLACK_DIR ??= path.join(dataRoot, 'slack-identities');
process.env.NAGEX_MEMORIES_DIR ??= path.join(dataRoot, 'memories');
process.env.NAGEX_MODULE_STATE_DIR ??= path.join(dataRoot, 'module-state');
process.env.NAGEX_WORKFLOW_DEFINITIONS_DIR ??= path.join(dataRoot, 'workflows');
process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR ??= path.join(dataRoot, 'capabilities_idempotency');


