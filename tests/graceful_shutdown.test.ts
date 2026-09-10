import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';

function waitForServer(port: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else if (Date.now() - start < timeoutMs) {
          setTimeout(check, 100);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => {
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, 100);
        } else {
          resolve(false);
        }
      });
    };
    check();
  });
}

// Node cannot deliver a real, interceptable SIGTERM/SIGINT to a child
// process on Windows — child_process.kill() there unconditionally
// terminates the process instead of signaling it, which the production
// listeners in server_web.ts (SIGTERM/SIGINT only, matching the real
// systemd/Linux deployment target) could never observe. Production code
// intentionally carries no test-only IPC signal protocol to work around
// that gap, so these tests exercise the real signal path on POSIX only and
// are skipped — not faked — on Windows.
const skipReason = process.platform === 'win32'
  ? 'Real SIGTERM/SIGINT delivery is not available on Windows; this path is verified on POSIX, the actual production (systemd/Linux) deployment target.'
  : false;

test('Graceful Shutdown — SIGTERM stops HTTP server and exits naturally', { skip: skipReason }, async () => {
  const testPort = 4185;
  const serverPath = path.resolve('dist/src/server_web.js');

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });

  const ready = await waitForServer(testPort);
  assert.equal(ready, true, 'Server failed to start on test port');

  const startTime = Date.now();
  child.kill('SIGTERM');

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const res = await exitPromise;
  const elapsedMs = Date.now() - startTime;

  assert.equal(res.code, 0, `Expected exit code 0, got code=${res.code}, signal=${res.signal}`);
  assert.ok(elapsedMs < 5000, `Expected shutdown under 5s, took ${elapsedMs}ms`);
  assert.match(stdout, /\[server_web\] Received SIGTERM/);
  assert.match(stdout, /HTTP server stopped accepting connections/);
  assert.match(stdout, /Graceful shutdown complete/);
});

test('Graceful Shutdown — SIGINT stops HTTP server and exits naturally', { skip: skipReason }, async () => {
  const testPort = 4186;
  const serverPath = path.resolve('dist/src/server_web.js');

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });

  const ready = await waitForServer(testPort);
  assert.equal(ready, true, 'Server failed to start on test port');

  child.kill('SIGINT');

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const res = await exitPromise;
  assert.equal(res.code, 0, `Expected exit code 0, got code=${res.code}`);
  assert.match(stdout, /\[server_web\] Received SIGINT/);
  assert.match(stdout, /Graceful shutdown complete/);
});

test('Graceful Shutdown — Duplicate signals run cleanup only once', { skip: skipReason }, async () => {
  const testPort = 4187;
  const serverPath = path.resolve('dist/src/server_web.js');

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });

  const ready = await waitForServer(testPort);
  assert.equal(ready, true, 'Server failed to start on test port');

  child.kill('SIGTERM');
  child.kill('SIGINT');
  child.kill('SIGTERM');

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const res = await exitPromise;
  assert.equal(res.code, 0, `Expected exit code 0, got code=${res.code}`);

  const matches = stdout.match(/\[server_web\] Received SIG/g) || [];
  assert.equal(matches.length, 1, 'Shutdown should be executed exactly once');
});

test('Graceful Shutdown — Server refuses new connections after SIGTERM', { skip: skipReason }, async () => {
  const testPort = 4188;
  const serverPath = path.resolve('dist/src/server_web.js');

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = await waitForServer(testPort);
  assert.equal(ready, true, 'Server failed to start on test port');

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));

  let connectionRefused = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${testPort}/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', (err) => {
        connectionRefused = true;
        reject(err);
      });
    });
  } catch {
    connectionRefused = true;
  }

  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(connectionRefused, true, 'New connections should be refused after SIGTERM');
});
