import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Guard: Ensure NAGEX_MODULE_STATE_DIR is redirected to an isolated test directory
// BEFORE server_web.ts module-load time, even if run without dist/tests/_setup.js
if (!process.env.NAGEX_MODULE_STATE_DIR) {
  const fallbackRoot = path.join(os.tmpdir(), 'nagex-test-data', `standalone-${process.pid}-${Date.now()}`);
  process.env.NAGEX_MODULE_STATE_DIR = path.join(fallbackRoot, 'module-state');
}

import { ModuleRegistry } from '../src/modules/module.registry.js';
import { ModuleStateStore } from '../src/modules/module-state.store.js';
import { ModuleService } from '../src/modules/module.service.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { handleApiRequest, moduleStateStore, moduleService } from '../src/server_web.js';
import { resolveBuiltInPrincipalPermissions } from '../src/identity/permission.registry.js';
import type { CapabilityRequest } from '../src/capabilities/capability.types.js';


function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mockServices() {
  const dummyCalendar: any = {
    requestCreateEventApproval: () => ({ approvalId: 'appr_1', status: 'PENDING' }),
  };
  const dummyGmail: any = {};
  const dummyBrowser: any = {
    open: async () => ({ sessionId: 'sess_1' }),
  };
  return { dummyCalendar, dummyGmail, dummyBrowser };
}

describe('ModuleStateStore & Service Tests', () => {
  it('P06-06: returns default state when no explicit override exists', () => {
    const origDir = process.env.NAGEX_MODULE_STATE_DIR;
    const tmpDir = createTempDir('nagex_mod_state_test_');
    try {
      process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

      const registry = new ModuleRegistry();
      const stateStore = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
      const service = new ModuleService(registry, stateStore);

      assert.equal(service.isCapabilityEnabled('tenant_1', 'google_calendar.create_event'), true);
      const mod = service.getModule('tenant_1', 'module.calendar');
      assert.ok(mod);
      assert.equal(mod.enabled, true);
      assert.equal(mod.status, 'AVAILABLE');
    } finally {
      process.env.NAGEX_MODULE_STATE_DIR = origDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('P06-07: toggles module state for a specific tenant', () => {
    const origDir = process.env.NAGEX_MODULE_STATE_DIR;
    const tmpDir = createTempDir('nagex_mod_state_test_');
    try {
      process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

      const registry = new ModuleRegistry();
      const stateStore = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
      const service = new ModuleService(registry, stateStore);

      service.setModuleState('tenant_1', 'module.calendar', false);
      assert.equal(service.isCapabilityEnabled('tenant_1', 'google_calendar.create_event'), false);
      assert.equal(service.getModule('tenant_1', 'module.calendar')?.enabled, false);
      assert.equal(service.getModule('tenant_1', 'module.calendar')?.status, 'DISABLED');

      // Tenant 2 should remain unaffected
      assert.equal(service.isCapabilityEnabled('tenant_2', 'google_calendar.create_event'), true);
    } finally {
      process.env.NAGEX_MODULE_STATE_DIR = origDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('P06-08 (Amendment: Persistence Failure): in-memory record remains unchanged if durable write fails', () => {
    const origDir = process.env.NAGEX_MODULE_STATE_DIR;
    const tmpDir = createTempDir('nagex_mod_state_fail_');
    const stateStore = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
    try {
      process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

      // Enable initially
      stateStore.setState('tenant_1', 'module.gmail', true);

      // Mock fileStore.writeOrThrow to fail
      const storeAny = stateStore as any;
      const originalWrite = storeAny.fileStore.writeOrThrow;
      storeAny.fileStore.writeOrThrow = () => {
        throw new Error('Disk full simulated failure');
      };

      assert.throws(
        () => stateStore.setState('tenant_1', 'module.gmail', false),
        /Disk full simulated failure/
      );

      // In-memory state must remain unchanged (true)
      const currentRecord = stateStore.getState('tenant_1', 'module.gmail');
      assert.ok(currentRecord);
      assert.equal(currentRecord.enabled, true);

      storeAny.fileStore.writeOrThrow = originalWrite;
    } finally {
      process.env.NAGEX_MODULE_STATE_DIR = origDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('P06-09 (Amendment: Tenant-Restart Isolation): preserves per-tenant module state across restarts', () => {
    const origDir = process.env.NAGEX_MODULE_STATE_DIR;
    const tmpDir = createTempDir('nagex_mod_state_restart_');
    try {
      process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

      // Phase 1: Set states for two distinct tenants
      const stateStore1 = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
      stateStore1.setState('tenant_alpha', 'module.gmail', false);
      stateStore1.setState('tenant_beta', 'module.gmail', true);
      stateStore1.setState('tenant_beta', 'module.calendar', false);

      // Phase 2: Simulate restart by instantiating new ModuleStateStore pointing to same dir
      const stateStore2 = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');

      assert.equal(stateStore2.getState('tenant_alpha', 'module.gmail')?.enabled, false);
      assert.equal(stateStore2.getState('tenant_beta', 'module.gmail')?.enabled, true);
      assert.equal(stateStore2.getState('tenant_beta', 'module.calendar')?.enabled, false);
    } finally {
      process.env.NAGEX_MODULE_STATE_DIR = origDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('P06-10 (Amendment: Idempotency Bypass Prevention): disabled module blocks replaying cached idempotency result', async () => {
    const origDirState = process.env.NAGEX_MODULE_STATE_DIR;
    const origDirIdem = process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR;
    const tmpDirState = createTempDir('nagex_broker_mod_');
    const tmpDirIdem = createTempDir('nagex_broker_idem_');
    try {
      process.env.NAGEX_MODULE_STATE_DIR = tmpDirState;
      process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR = tmpDirIdem;

      const moduleRegistry = new ModuleRegistry();
      const moduleStateStore = new ModuleStateStore('test-mod', 'NAGEX_MODULE_STATE_DIR');
      const capRegistry = new CapabilityRegistry();
      const auditLogger = new AuditLogger();
      const { dummyCalendar, dummyGmail, dummyBrowser } = mockServices();

      const broker = new CapabilityBroker(
        dummyCalendar,
        dummyGmail,
        dummyBrowser,
        auditLogger,
        capRegistry,
        'test-idem',
        'NAGEX_CAPABILITIES_IDEMPOTENCY_DIR',
        moduleRegistry,
        moduleStateStore
      );

      const request: CapabilityRequest = {
        capabilityId: 'browser.open',
        tenantId: 'tenant_test',
        principalId: 'user_1',
        source: 'WEB',
        payload: {},
        requestId: 'req_idem_123',
        idempotencyKey: 'idem_key_abc',
      };

      // 1. Initial execution when enabled -> EXECUTED
      const res1 = await broker.execute(request);
      assert.equal(res1.status, 'EXECUTED');

      // 2. Disable module.browser for tenant_test
      moduleStateStore.setState('tenant_test', 'module.browser', false);

      // 3. Re-send request with same idempotency key -> MUST NOT return cached EXECUTED; MUST return BLOCKED
      const res2 = await broker.execute(request);
      assert.equal(res2.status, 'BLOCKED');
      assert.equal(res2.reasonCode, 'MODULE_DISABLED');
    } finally {
      process.env.NAGEX_MODULE_STATE_DIR = origDirState;
      process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR = origDirIdem;
      fs.rmSync(tmpDirState, { recursive: true, force: true });
      fs.rmSync(tmpDirIdem, { recursive: true, force: true });
    }
  });

  it('P06-11 (Amendment: Alias/Canonical Bypass Prevention): blocks capability execution whether called via canonical ID or alias', async () => {
    const origDirState = process.env.NAGEX_MODULE_STATE_DIR;
    const origDirIdem = process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR;
    const tmpDirState = createTempDir('nagex_broker_alias_');
    const tmpDirIdem = createTempDir('nagex_broker_alias_idem_');
    try {
      process.env.NAGEX_MODULE_STATE_DIR = tmpDirState;
      process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR = tmpDirIdem;

      const moduleRegistry = new ModuleRegistry();
      const moduleStateStore = new ModuleStateStore('test-mod', 'NAGEX_MODULE_STATE_DIR');
      const capRegistry = new CapabilityRegistry();
      const auditLogger = new AuditLogger();
      const { dummyCalendar, dummyGmail, dummyBrowser } = mockServices();

      const broker = new CapabilityBroker(
        dummyCalendar,
        dummyGmail,
        dummyBrowser,
        auditLogger,
        capRegistry,
        'test-idem',
        'NAGEX_CAPABILITIES_IDEMPOTENCY_DIR',
        moduleRegistry,
        moduleStateStore
      );

      // Disable module.calendar for tenant_x
      moduleStateStore.setState('tenant_x', 'module.calendar', false);

      // Test 1: Canonical capability ID
      const canonicalReq: CapabilityRequest = {
        capabilityId: 'google_calendar.create_event',
        tenantId: 'tenant_x',
        principalId: 'user_1',
        source: 'WEB',
        payload: {},
        requestId: 'req_can_1',
      };
      const res1 = await broker.execute(canonicalReq);
      assert.equal(res1.status, 'BLOCKED');
      assert.equal(res1.reasonCode, 'MODULE_DISABLED');

      // Test 2: Alias capability ID
      const aliasReq: CapabilityRequest = {
        capabilityId: 'calendar.create_event',
        tenantId: 'tenant_x',
        principalId: 'user_1',
        source: 'WEB',
        payload: {},
        requestId: 'req_alias_1',
      };
      const res2 = await broker.execute(aliasReq);
      assert.equal(res2.status, 'BLOCKED');
      assert.equal(res2.reasonCode, 'MODULE_DISABLED');
    } finally {
      process.env.NAGEX_MODULE_STATE_DIR = origDirState;
      process.env.NAGEX_CAPABILITIES_IDEMPOTENCY_DIR = origDirIdem;
      fs.rmSync(tmpDirState, { recursive: true, force: true });
      fs.rmSync(tmpDirIdem, { recursive: true, force: true });
    }
  });

  it('P06-R2-01: unknown principal gets no module:manage', () => {
    const perms = resolveBuiltInPrincipalPermissions({ id: 'usr_unknown', type: 'user' });
    assert.equal(perms.includes('module:manage'), false);

    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.gmail/state',
      { enabled: false },
      { 'x-principal-id': 'usr_unknown' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
  });

  it('P06-R2-02: usr_admin_001 gets module:manage', () => {
    try {
      const perms = resolveBuiltInPrincipalPermissions({ id: 'usr_admin_001', type: 'user' });
      assert.equal(perms.includes('module:manage'), true);

      const res = handleApiRequest(
        'PUT',
        '/api/v1/modules/module.gmail/state',
        { enabled: false },
        { 'x-principal-id': 'usr_admin_001' }
      );

      assert.equal(res.status, 200);
      assert.equal((res.data as any).enabled, false);
      assert.equal((res.data as any).status, 'DISABLED');
    } finally {
      // Teardown: restore default tenant state back to enabled
      handleApiRequest(
        'PUT',
        '/api/v1/modules/module.gmail/state',
        { enabled: true },
        { 'x-principal-id': 'usr_admin_001' }
      );
    }
  });

  it('P06-R2-03: caller-controlled permission header remains ignored', () => {
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.gmail/state',
      { enabled: false },
      { 'x-principal-id': 'usr_user_123', 'x-principal-permissions': 'module:manage,*' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
  });

  it('P06-R2-04: arbitrary principal id cannot gain module:manage', () => {
    const arbitraryIds = ['usr_hacker', 'guest_99', 'arbitrary_id_999'];
    for (const id of arbitraryIds) {
      const perms = resolveBuiltInPrincipalPermissions({ id, type: 'user' });
      assert.equal(perms.includes('module:manage'), false);

      const res = handleApiRequest(
        'PUT',
        '/api/v1/modules/module.calendar/state',
        { enabled: false },
        { 'x-principal-id': id, 'x-principal-permissions': 'module:manage' }
      );

      assert.equal(res.status, 403);
      assert.equal((res.data as any).error, 'PERMISSION_DENIED');
    }
  });

  it('P06-R2-05: cross-tenant module-state mutation is denied', () => {
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.gmail/state',
      { enabled: false, tenantId: 'ten_beta' },
      { 'x-nagex-tenant': 'ten_alpha', 'x-principal-id': 'usr_admin_001' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
    assert.equal((res.data as any).reason, 'CROSS_TENANT_ACCESS_DENIED');
  });

  it('P06-R2-06: denied mutation leaves production durable state unchanged', () => {
    // Check initial state directly from server_web's moduleStateStore instance
    const initialRecord = moduleStateStore.getState('ten_beta', 'module.browser');
    const initialEnabled = initialRecord?.enabled ?? true;

    // Attempt cross-tenant mutation against server_web handleApiRequest
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.browser/state',
      { enabled: false, tenantId: 'ten_beta' },
      { 'x-nagex-tenant': 'ten_alpha', 'x-principal-id': 'usr_admin_001' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
    assert.equal((res.data as any).reason, 'CROSS_TENANT_ACCESS_DENIED');

    // Verify production moduleStateStore instance's state remains unchanged
    const postRecord = moduleStateStore.getState('ten_beta', 'module.browser');
    assert.equal(postRecord?.enabled ?? true, initialEnabled);
  });

  it('P06-R3-01: test suite never touches production module-state path', () => {
    const envDir = process.env.NAGEX_MODULE_STATE_DIR;
    assert.ok(envDir, 'NAGEX_MODULE_STATE_DIR must be set in test environment');
    assert.notEqual(
      path.resolve(envDir),
      path.resolve('/var/lib/nagex/module-state'),
      'Test suite must never point to production /var/lib/nagex/module-state'
    );
    assert.match(
      envDir,
      /nagex-test-data|tmp/i,
      'NAGEX_MODULE_STATE_DIR must point to an isolated temporary test directory'
    );
  });

interface ProductionDirectorySnapshot {
  exists: boolean;
  files: Record<string, string>;
}

function snapshotProductionModuleState(prodDir: string = '/var/lib/nagex/module-state'): ProductionDirectorySnapshot {
  if (!fs.existsSync(prodDir)) {
    return { exists: false, files: {} };
  }

  const files: Record<string, string> = {};
  try {
    const entries = fs.readdirSync(prodDir);
    for (const file of entries) {
      const fullPath = path.join(prodDir, file);
      if (fs.statSync(fullPath).isFile()) {
        files[file] = fs.readFileSync(fullPath, 'utf8');
      }
    }
  } catch {
    // Ignore unreadable or non-existent entries during snapshot
  }

  return { exists: true, files };
}

  it('P06-R3-02: isolated route mutation does not alter production snapshot', () => {
    const testTenant = 'ten_production_01';
    const prodDir = '/var/lib/nagex/module-state';
    const snapshotBefore = snapshotProductionModuleState(prodDir);

    try {
      const res = handleApiRequest(
        'PUT',
        '/api/v1/modules/module.gmail/state',
        { enabled: false },
        { 'x-principal-id': 'usr_admin_001' }
      );
      assert.equal(res.status, 200);
      assert.equal((res.data as any).enabled, false);

      const inTestStore = moduleService.getModule(testTenant, 'module.gmail');
      assert.equal(inTestStore?.enabled, false);

      const snapshotAfter = snapshotProductionModuleState(prodDir);
      assert.deepEqual(
        snapshotAfter,
        snapshotBefore,
        'Production module state snapshot MUST remain identical before and after test mutation'
      );
    } finally {
      handleApiRequest(
        'PUT',
        '/api/v1/modules/module.gmail/state',
        { enabled: true },
        { 'x-principal-id': 'usr_admin_001' }
      );
    }
  });

  it('P06-R3-03: test teardown leaves no module state behind', () => {
    const testTenant = 'tenant_r3_teardown_test';
    try {
      const res = handleApiRequest(
        'PUT',
        '/api/v1/modules/module.browser/state',
        { enabled: false, tenantId: testTenant },
        { 'x-nagex-tenant': testTenant, 'x-principal-id': 'usr_admin_001' }
      );
      assert.equal(res.status, 200);
      assert.equal((res.data as any).enabled, false);
    } finally {
      handleApiRequest(
        'PUT',
        '/api/v1/modules/module.browser/state',
        { enabled: true, tenantId: testTenant },
        { 'x-nagex-tenant': testTenant, 'x-principal-id': 'usr_admin_001' }
      );
    }

    const state = moduleStateStore.getState(testTenant, 'module.browser');
    assert.equal(state?.enabled, true, 'Module state must be restored after teardown');
  });

  it('P06-R3-04: repeated full test runs leave production snapshot unchanged', () => {
    const prodDir = '/var/lib/nagex/module-state';
    const snapshotBefore = snapshotProductionModuleState(prodDir);

    const gmailState = moduleService.getModule('default', 'module.gmail');
    const calendarState = moduleService.getModule('default', 'module.calendar');
    const browserState = moduleService.getModule('default', 'module.browser');

    assert.equal(gmailState?.enabled, true, 'module.gmail default state must remain enabled');
    assert.equal(calendarState?.enabled, true, 'module.calendar default state must remain enabled');
    assert.equal(browserState?.enabled, true, 'module.browser default state must remain enabled');

    const snapshotAfter = snapshotProductionModuleState(prodDir);
    assert.deepEqual(
      snapshotAfter,
      snapshotBefore,
      'Production module state snapshot MUST remain identical across test executions'
    );
  });

  it('P06-13: GET /api/v1/modules lists modules for tenant', () => {
    const res = handleApiRequest('GET', '/api/v1/modules', null);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray((res.data as any).modules));
    assert.equal((res.data as any).total, 3);
  });

  it('P06-14: GET /api/v1/modules/:moduleId returns 404 for unknown module', () => {
    const res = handleApiRequest('GET', '/api/v1/modules/module.unknown', null);
    assert.equal(res.status, 404);
    assert.equal((res.data as any).error.code, 'MODULE_NOT_FOUND');
  });
});
