// Phase 05 — Gmail & Calendar Module Extraction.
//
// Verifies Gmail and Calendar each now have exactly one implementation
// location (src/modules/gmail/, src/modules/calendar/), external consumers
// reach them only through each module's public index or the Phase 03 ports
// (GmailPort / CalendarApprovalRequesterPort / CalendarExecutionPort), the
// shared Google OAuth/token-store infrastructure was never moved or
// re-exported through either module, and the old scattered paths no longer
// contain any implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GmailService } from '../src/modules/gmail/index.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import type { GmailPort } from '../src/contracts/gmail.port.js';
import type { CalendarApprovalRequesterPort, CalendarExecutionPort } from '../src/contracts/calendar.port.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

function readSourceWithoutComments(relPath: string): string {
  const source = fs.readFileSync(path.resolve(relPath), 'utf8');
  return source.split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

// ─── 1-3: real implementations satisfy the Phase 03 ports (compile-time) ───

void function gmailConformance(real: GmailService): void {
  const _asPort: GmailPort = real; // 1. GmailService structurally satisfies GmailPort
};

void function calendarApprovalConformance(real: GoogleCalendarService): void {
  const _asPort: CalendarApprovalRequesterPort = real; // 2. GoogleCalendarService satisfies CalendarApprovalRequesterPort
};

void function calendarExecutionConformance(real: GoogleCalendarService): void {
  const _asPort: CalendarExecutionPort = real; // 3. GoogleCalendarService satisfies CalendarExecutionPort
};

test('1-3. Gmail/Calendar implementations satisfy their Phase 03 ports (exercised at runtime via the real app graph)', () => {
  const app = createNagexApplication();
  const gmailPort: GmailPort = app.gmailService;
  const calendarPort: CalendarApprovalRequesterPort = app.googleCalendarService;
  assert.equal(typeof gmailPort.search, 'function');
  assert.equal(typeof calendarPort.getFreeSlots, 'function');
});

// ─── 4-5: Composition Root imports through the module public entrypoints ───

test('4. Composition Root imports Gmail only through modules/gmail/index.js, never a deep internal file', () => {
  const code = readSourceWithoutComments('src/app/create-nagex-application.ts');
  assert.match(code, /from ['"]\.\.\/modules\/gmail\/index\.js['"]/, 'create-nagex-application.ts must import Gmail through the module public index');
  assert.doesNotMatch(code, /modules\/gmail\/gmail\.(service|client)\.js/, 'create-nagex-application.ts must never deep-import a Gmail module internal file');
});

test('5. Composition Root imports Calendar only through modules/calendar/index.js, never a deep internal file', () => {
  const code = readSourceWithoutComments('src/app/create-nagex-application.ts');
  assert.match(code, /from ['"]\.\.\/modules\/calendar\/index\.js['"]/, 'create-nagex-application.ts must import Calendar through the module public index');
  assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, 'create-nagex-application.ts must never deep-import a Calendar module internal file');
});

// ─── 6: CapabilityBroker has no concrete Gmail/Calendar import ───

test('6. CapabilityBroker has zero Gmail/Calendar concrete/internal imports — only the ports', () => {
  const code = readSourceWithoutComments('src/capabilities/capability-broker.ts');
  assert.doesNotMatch(code, /modules\/(gmail|calendar)\//, 'capability-broker.ts must never import from modules/gmail/ or modules/calendar/ directly');
  assert.match(code, /from ['"]\.\.\/contracts\/gmail\.port\.js['"]/, 'capability-broker.ts must depend on GmailPort');
  assert.match(code, /from ['"]\.\.\/contracts\/calendar\.port\.js['"]/, 'capability-broker.ts must depend on CalendarApprovalRequesterPort');
});

// ─── 7: CandidateActionResolver has no concrete Calendar import ───

test('7. CandidateActionResolver has zero Calendar concrete/internal imports outside the module public index (for the CalendarEventPayload type) and the port', () => {
  const code = readSourceWithoutComments('src/workspace/action-resolver.ts');
  assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, 'action-resolver.ts must never deep-import a Calendar module internal file');
  assert.match(code, /from ['"]\.\.\/modules\/calendar\/index\.js['"]/, 'action-resolver.ts must reach CalendarEventPayload only through the module public index');
});

// ─── 8: server_web.ts has no deep Gmail/Calendar client import ───

test('8. server_web.ts never deep-imports a Gmail/Calendar module internal file', () => {
  const code = readSourceWithoutComments('src/server_web.ts');
  assert.doesNotMatch(code, /modules\/gmail\/gmail\.(service|client)\.js/, 'server_web.ts must never deep-import a Gmail module internal file');
  assert.doesNotMatch(code, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, 'server_web.ts must never deep-import a Calendar module internal file');
  assert.match(code, /from ['"]\.\/modules\/gmail\/index\.js['"]/, 'server_web.ts must import Gmail only through the module public index');
  assert.match(code, /from ['"]\.\/modules\/calendar\/index\.js['"]/, 'server_web.ts must import Calendar only through the module public index');
});

// ─── 9-10: module public indexes never export OAuth/token-store internals ───

test('9. Gmail module public index does not export OAuth/token-store internals', () => {
  const code = readSourceWithoutComments('src/modules/gmail/index.ts');
  assert.doesNotMatch(code, /oauth\.client|token\.store|token\.crypto/, 'the Gmail module public index must never export shared Google OAuth/token-store internals');
});

test('10. Calendar module public index does not export OAuth/token-store internals', () => {
  const code = readSourceWithoutComments('src/modules/calendar/index.ts');
  assert.doesNotMatch(code, /oauth\.client|token\.store|token\.crypto/, 'the Calendar module public index must never export shared Google OAuth/token-store internals');
});

// ─── 11: no production module outside the owning module deep-imports Gmail/Calendar internals ───
//
// Scoped to production src/ only — test files legitimately construct real
// internals directly for genuine integration testing, per this repo's
// established pattern (see browser_module_boundary.test.ts test 6).

test('11. No production module outside src/modules/gmail/ or src/modules/calendar/ imports a Gmail/Calendar module internal file directly (only the public index or contracts)', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const normalized = full.replace(/\\/g, '/');
        if (normalized.endsWith('src/modules/gmail') || normalized.endsWith('src/modules/calendar')) continue; // each module's own internals may reference each other
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const code = readSourceWithoutComments(full);
        if (/modules\/gmail\/gmail\.(service|client)\.js|modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/.test(code)) {
          offenders.push(full);
        }
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], `these files deep-import a Gmail/Calendar module internal file instead of going through the module public index: ${offenders.join(', ')}`);
});

// ─── 12: old scattered implementation paths no longer contain independent implementations ───

test('12. The pre-Phase-05 scattered Gmail/Calendar paths no longer exist, and shared Google OAuth infra was never moved', () => {
  const oldPaths = [
    'src/tools/gmail.service.ts',
    'src/tools/google-calendar.service.ts',
    'src/integrations/google/gmail.client.ts',
    'src/integrations/google/calendar.client.ts',
  ];
  for (const oldPath of oldPaths) {
    assert.equal(fs.existsSync(path.resolve(oldPath)), false, `${oldPath} must no longer exist — Gmail/Calendar have exactly one source of truth now, under src/modules/`);
  }
  for (const file of ['gmail.service.ts', 'gmail.client.ts', 'index.ts']) {
    assert.ok(fs.existsSync(path.resolve('src/modules/gmail', file)), `src/modules/gmail/${file} must exist`);
  }
  for (const file of ['google-calendar.service.ts', 'calendar.client.ts', 'index.ts']) {
    assert.ok(fs.existsSync(path.resolve('src/modules/calendar', file)), `src/modules/calendar/${file} must exist`);
  }
  for (const sharedFile of ['oauth.client.ts', 'token.store.ts', 'token.crypto.ts']) {
    assert.ok(fs.existsSync(path.resolve('src/integrations/google', sharedFile)), `src/integrations/google/${sharedFile} must remain shared, unmoved`);
  }
});
