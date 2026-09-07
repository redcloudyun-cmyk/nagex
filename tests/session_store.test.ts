import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/sessions/session.store.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-session-store-'));
}

test('getOrCreateMain mints exactly one MAIN session per (tenant, principal), reused on every subsequent call', () => {
  const store = new SessionStore({ dir: tempDir() });
  const first = store.getOrCreateMain('ten_1', 'usr_1');
  const second = store.getOrCreateMain('ten_1', 'usr_1');
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.type, 'MAIN');
});

test('different principals (or tenants) get different MAIN sessions', () => {
  const store = new SessionStore({ dir: tempDir() });
  const a = store.getOrCreateMain('ten_1', 'usr_a');
  const b = store.getOrCreateMain('ten_1', 'usr_b');
  const c = store.getOrCreateMain('ten_2', 'usr_a');
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.sessionId, c.sessionId);
});

test('a MAIN session survives a restart (a fresh SessionStore instance pointed at the same directory)', () => {
  const dir = tempDir();
  const first = new SessionStore({ dir }).getOrCreateMain('ten_1', 'usr_1');
  const second = new SessionStore({ dir }).getOrCreateMain('ten_1', 'usr_1');
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.createdAt, second.createdAt);
});

test('lastActiveAt advances on each getOrCreateMain call, without minting a new session', () => {
  let clock = 1_700_000_000_000;
  const store = new SessionStore({ dir: tempDir(), now: () => new Date(clock).toISOString() });
  const first = store.getOrCreateMain('ten_1', 'usr_1');
  const firstLastActiveAt = first.lastActiveAt; // snapshot: getOrCreateMain returns a live, mutable record reference
  clock += 60_000;
  const second = store.getOrCreateMain('ten_1', 'usr_1');
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(firstLastActiveAt, second.lastActiveAt);
});

test('getOrCreate supports non-MAIN session types independently of the MAIN session', () => {
  const store = new SessionStore({ dir: tempDir() });
  const main = store.getOrCreateMain('ten_1', 'usr_1');
  const background = store.getOrCreate('ten_1', 'usr_1', 'BACKGROUND');
  assert.notEqual(main.sessionId, background.sessionId);
  assert.equal(background.type, 'BACKGROUND');
});
