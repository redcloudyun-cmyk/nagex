// P06-06 ~ P06-22 & P06-R1 Tests: Module State Store, Service, CapabilityBroker Integration, PDP Authorization
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ModuleRegistry } from '../src/modules/module.registry.js';
import { ModuleStateStore } from '../src/modules/module-state.store.js';
import { ModuleService } from '../src/modules/module.service.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { handleApiRequest } from '../src/server_web.js';
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
    const tmpDir = createTempDir('nagex_mod_state_test_');
    process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

    const registry = new ModuleRegistry();
    const stateStore = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
    const service = new ModuleService(registry, stateStore);

    assert.equal(service.isCapabilityEnabled('tenant_1', 'google_calendar.create_event'), true);
    const mod = service.getModule('tenant_1', 'module.calendar');
    assert.ok(mod);
    assert.equal(mod.enabled, true);
    assert.equal(mod.status, 'AVAILABLE');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P06-07: toggles module state for a specific tenant', () => {
    const tmpDir = createTempDir('nagex_mod_state_test_');
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

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P06-08 (Amendment: Persistence Failure): in-memory record remains unchanged if durable write fails', () => {
    const tmpDir = createTempDir('nagex_mod_state_fail_');
    process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

    const stateStore = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P06-09 (Amendment: Tenant-Restart Isolation): preserves per-tenant module state across restarts', () => {
    const tmpDir = createTempDir('nagex_mod_state_restart_');
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

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P06-10 (Amendment: Idempotency Bypass Prevention): disabled module blocks replaying cached idempotency result', async () => {
    const tmpDirState = createTempDir('nagex_broker_mod_');
    const tmpDirIdem = createTempDir('nagex_broker_idem_');
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

    fs.rmSync(tmpDirState, { recursive: true, force: true });
    fs.rmSync(tmpDirIdem, { recursive: true, force: true });
  });

  it('P06-11 (Amendment: Alias/Canonical Bypass Prevention): blocks capability execution whether called via canonical ID or alias', async () => {
    const tmpDirState = createTempDir('nagex_broker_alias_');
    const tmpDirIdem = createTempDir('nagex_broker_alias_idem_');
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

    fs.rmSync(tmpDirState, { recursive: true, force: true });
    fs.rmSync(tmpDirIdem, { recursive: true, force: true });
  });

  it('P06-R1-01: no permission header does NOT grant wildcard access', () => {
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.gmail/state',
      { enabled: false },
      { 'x-principal-id': 'usr_unauthorized' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
  });

  it('P06-R1-02: caller-supplied x-principal-permissions:* cannot self-elevate', () => {
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.gmail/state',
      { enabled: false },
      { 'x-principal-id': 'usr_unauthorized', 'x-principal-permissions': '*' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
  });

  it('P06-R1-03: unauthorized principal cannot disable a module', () => {
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.calendar/state',
      { enabled: false },
      { 'x-principal-id': 'usr_unauthorized' }
    );

    assert.equal(res.status, 403);
    assert.equal((res.data as any).error, 'PERMISSION_DENIED');
  });

  it('P06-R1-04: authorized principal can change module state', () => {
    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.gmail/state',
      { enabled: false },
      { 'x-principal-id': 'usr_admin_001' }
    );

    assert.equal(res.status, 200);
    assert.equal((res.data as any).enabled, false);
    assert.equal((res.data as any).status, 'DISABLED');
  });

  it('P06-R1-05: cross-tenant module-state mutation is denied', () => {
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

  it('P06-R1-06: denied mutation leaves durable state unchanged', () => {
    const tmpDir = createTempDir('nagex_mod_state_r1_06_');
    process.env.NAGEX_MODULE_STATE_DIR = tmpDir;

    const stateStore = new ModuleStateStore('test-mod-state', 'NAGEX_MODULE_STATE_DIR');
    const initialRecord = stateStore.getState('ten_beta', 'module.browser');
    assert.equal(initialRecord?.enabled ?? true, true);

    const res = handleApiRequest(
      'PUT',
      '/api/v1/modules/module.browser/state',
      { enabled: false, tenantId: 'ten_beta' },
      { 'x-nagex-tenant': 'ten_alpha', 'x-principal-id': 'usr_admin_001' }
    );

    assert.equal(res.status, 403);

    const postRecord = stateStore.getState('ten_beta', 'module.browser');
    assert.equal(postRecord?.enabled ?? true, true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
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
