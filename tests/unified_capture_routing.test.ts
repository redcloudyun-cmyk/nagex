// STEP 1 — Unified Capture Routing regression guards.
//
// InputRouter's own classification (ASK/COMMAND/CAPTURE/LINK_CAPTURE/UPLOAD/
// AUDIO_CAPTURE) is already covered by workspace_truthfulness.test.ts. This
// file guards the parts of "unified" routing that classification alone does
// not: that the Home composer and server routes each resolve to exactly one
// primary path, and that no surface silently drops or duplicates a route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleAsyncApiRequest } from '../src/server_web.js';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf8');
}

test('server_web.ts defines exactly one handler for each capture-routing endpoint (no duplicate/missing routes)', () => {
  const src = readSrc('src/server_web.ts');
  const countMatches = (pattern: RegExp) => (src.match(pattern) || []).length;

  // Each of these was found completely missing (404) after a prior
  // "consolidation" commit deleted them while claiming they lived
  // elsewhere in the file. Pin the count so a future edit cannot silently
  // remove or duplicate them again.
  assert.equal(countMatches(/pathname === '\/api\/v1\/workspace\/route-input'/g), 1);
  assert.equal(countMatches(/pathname === '\/api\/v1\/workspace\/storage\/status'/g), 1);
  assert.equal(countMatches(/pathname === '\/api\/v1\/workspace\/inbox'/g), 1);
  assert.equal(countMatches(/pathname === '\/api\/v1\/workspace\/vault'/g), 1);
  assert.equal(countMatches(/pathname === '\/api\/v1\/workspace\/upload'/g), 1);
  assert.equal(countMatches(/pathname === '\/api\/v1\/workspace\/captures' \|\| pathname === '\/api\/v1\/workspace\/capture'\)/g), 1);
});

test('route-input, inbox, vault, and storage/status all resolve (never 404), and route-input never creates a Task/Candidate as a side effect', async () => {
  const headers = { 'x-nagex-tenant': 'ten_step1_test', 'x-principal-id': 'usr_step1_test' };

  const route = await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: 'What is NAgex?' }, headers);
  assert.equal(route.status, 200);
  assert.equal((route.data as any).primaryIntent, 'ASK');
  // Pure classification: no captureId/taskId/candidateId in the response —
  // route-input never itself creates a persisted record.
  assert.equal((route.data as any).captureId, undefined);
  assert.equal((route.data as any).taskId, undefined);

  const inbox = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.equal(inbox.status, 200);
  assert.ok(Array.isArray((inbox.data as any).items));

  const vault = await handleAsyncApiRequest('GET', '/api/v1/workspace/vault', null, headers);
  assert.equal(vault.status, 200);
  assert.ok((vault.data as any).quotaSizeBytes > 0);

  const storage = await handleAsyncApiRequest('GET', '/api/v1/workspace/storage/status', null, headers);
  assert.equal(storage.status, 200);
});

test('Home composer dispatches to exactly one primary path — ambient chat OR capture, never both — from a single route-input classification', () => {
  const src = readSrc('public/app.js');
  const start = src.indexOf('if (btnSend && homeInput) {');
  assert.ok(start >= 0, 'Home send-button handler should exist');
  const end = src.indexOf('if (btnLink && homeInput)', start);
  const body = src.slice(start, end);

  const routeIdx = body.indexOf('/api/v1/workspace/route-input');
  const branchIdx = body.indexOf("if (intent === 'ASK' || intent === 'COMMAND')");
  assert.ok(routeIdx >= 0 && branchIdx >= 0);
  assert.ok(routeIdx < branchIdx, 'classification must happen before the dispatch decision');

  // The ASK/COMMAND and LINK_CAPTURE/CAPTURE branches must be mutually
  // exclusive (if / else if), not two independent ifs that could both run.
  assert.match(
    body,
    /if \(intent === 'ASK' \|\| intent === 'COMMAND'\) \{[\s\S]*?\} else if \(intent === 'LINK_CAPTURE' \|\| intent === 'CAPTURE'\) \{/
  );

  // Exactly one ambient dispatch and exactly one capture dispatch exist in
  // this handler — never a second, competing call to either.
  assert.equal((body.match(/runAmbientTask\(text\)/g) || []).length, 1);
  assert.equal((body.match(/apiFetch\('\/api\/v1\/workspace\/capture'/g) || []).length, 1);
});

test('Home composer submit clears the input synchronously before any await, so a rapid double-click cannot dispatch the same text twice', () => {
  const src = readSrc('public/app.js');
  const start = src.indexOf('if (btnSend && homeInput) {');
  const end = src.indexOf('if (btnLink && homeInput)', start);
  const body = src.slice(start, end);

  const textReadIdx = body.indexOf('const text = homeInput.value.trim();');
  const clearIdx = body.indexOf("homeInput.value = '';");
  const firstAwaitIdx = body.indexOf('await ');
  assert.ok(textReadIdx >= 0 && clearIdx >= 0 && firstAwaitIdx >= 0);
  assert.ok(textReadIdx < clearIdx && clearIdx < firstAwaitIdx, 'input must be cleared before the first await, not after');
});
