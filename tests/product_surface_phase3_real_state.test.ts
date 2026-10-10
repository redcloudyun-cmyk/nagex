import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { KnowledgeEngine } from '../src/context/knowledge.engine.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { VaultStore } from '../src/workspace/vault.store.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { handleNotificationsRoutes } from '../src/http/routes/notifications.routes.js';
import { handleSearchRoutes } from '../src/http/routes/search.routes.js';
import { handleSettingsRoutes } from '../src/http/routes/settings.routes.js';
import { canonicalizeRequestHeaders } from '../src/http/request-identity.js';

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-phase3-${label}-`));
}

function identity(root: string) {
  const identityStore = new IdentityStore({ dir: path.join(root, 'identity') });
  const sessionStore = new SessionStore({ dir: path.join(root, 'sessions') });
  const { identity: user } = identityStore.createAccount(`${path.basename(root)}@example.com`, hashPassword('password123'));
  identityStore.transitionState(user.userId, 'ACTIVE');
  const session = sessionStore.createAuthSession(`ten_${user.userId}`, user.userId, 'MAIN');
  return { identityStore, sessionStore, userId: user.userId, tenantId: `ten_${user.userId}`, cookie: { cookie: `nagex_session=${session.sessionId}` } };
}

describe('Product Surface Phase 3 real-state API contracts', () => {
  it('persists profile, setting groups, and ambient consent revocation through the profile store', async () => {
    const root = tmp('settings');
    const owner = identity(root);
    const deps = { identityStore: owner.identityStore, sessionStore: owner.sessionStore };

    const saved = await handleSettingsRoutes('PATCH', '/api/v1/settings', {
      displayName: 'Redcloud',
      locale: 'ko',
      timezone: 'Asia/Seoul',
      notifications: { desktop: true, proactive: false },
      privacy: { includeMemoryInSearch: false },
      ambientMonitoring: { enabled: true, dailyBrief: true },
      deviceSettings: { allowNewDeviceEnrollment: false },
      connectionSettings: { showUnavailableProviders: false },
    }, owner.cookie, {}, deps);
    assert.equal(saved?.status, 200);

    const consent = await handleSettingsRoutes('POST', '/api/v1/settings/ambient-consent', {
      sourceType: 'CALENDAR',
      provider: 'GOOGLE_CALENDAR',
      accountRef: 'primary',
      connected: true,
      observeAllowed: true,
      contentReadAllowed: true,
      proactiveUseAllowed: true,
      executeAllowed: false,
      scope: 'ALL_CALENDARS',
      purpose: 'PROACTIVE_ASSISTANCE',
      retention: 'EPHEMERAL',
    }, owner.cookie, {}, deps);
    assert.equal(consent?.status, 200);

    const revoked = await handleSettingsRoutes('PATCH', '/api/v1/settings/ambient-consent', {
      sourceType: 'CALENDAR',
      provider: 'GOOGLE_CALENDAR',
      accountRef: 'primary',
      connected: true,
      revoke: true,
    }, owner.cookie, {}, deps);
    assert.equal(revoked?.status, 200);
    assert.equal((revoked?.data as any).consent.connected, true);
    assert.equal((revoked?.data as any).consent.observeAllowed, false);
    assert.equal((revoked?.data as any).consent.contentReadAllowed, false);
    assert.equal((revoked?.data as any).consent.proactiveUseAllowed, false);
    assert.equal((revoked?.data as any).consent.executeAllowed, false);

    const reopened = new IdentityStore({ dir: path.join(root, 'identity') });
    const prefs = reopened.getPreferences(owner.userId);
    assert.equal(reopened.getProfile(owner.userId)?.locale, 'ko');
    assert.equal(prefs.notifications?.desktop, true);
    assert.equal(prefs.privacy?.includeMemoryInSearch, false);
    assert.equal(prefs.ambientMonitoring?.sourceConsents?.['CALENDAR:GOOGLE_CALENDAR:primary'].revokedAt !== null, true);
  });

  it('dismisses notifications as persistent user state without deleting history', async () => {
    const root = tmp('notifications');
    const owner = identity(root);
    const store = new NotificationStore({ dir: path.join(root, 'notifications') });
    const engine = new NotificationEngine({ store, auditLogger: new AuditLogger() });
    const record = await engine.dispatchForCaller({ tenantId: owner.tenantId, principalId: owner.userId }, { type: 'SYSTEM_ALERT', title: 'Phase 3', body: 'Review real notification state.' });

    const headers = canonicalizeRequestHeaders(owner.cookie, { identityStore: owner.identityStore, sessionStore: owner.sessionStore });
    const dismissed = await handleNotificationsRoutes('POST', `/api/v1/notifications/${record.id}/dismiss`, null, headers, {}, { notificationEngine: engine });
    assert.equal(dismissed?.status, 200);
    assert.equal((dismissed?.data as any).dismissed, true);
    assert.equal((dismissed?.data as any).read, true);

    const reopened = new NotificationStore({ dir: path.join(root, 'notifications') });
    const history = reopened.list(owner.tenantId, owner.userId);
    assert.equal(history.length, 1);
    assert.equal(history[0].dismissed, true);
  });

  it('lists, renames, and revokes real enrolled devices with owner-scoped connection status', async () => {
    const root = tmp('devices');
    const owner = identity(root);
    const devices = new DeviceIdentityStore({ dir: path.join(root, 'devices') });
    const connections = new DeviceConnectionStatusStore({ dir: path.join(root, 'device-connections') });
    const device = devices.enroll({ tenantId: owner.tenantId, ownerId: owner.userId, publicKey: 'public-key', agentVersion: '1.2.3', os: 'Android', systemDeviceName: 'Fold3', capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED', 'voice.playback'] });
    connections.markConnected(device.deviceId, owner.tenantId, owner.userId);
    const deps = { deviceAgentTransportEndpoint: {} as any, deviceIdentityStore: devices, deviceConnectionStatusStore: connections, sessionStore: owner.sessionStore };

    const listed = await handleDeviceAgentRoutes('GET', '/api/v1/device-agent/devices', null, owner.cookie, {}, deps);
    assert.equal(listed?.status, 200);
    assert.equal((listed?.data as any).devices[0].connectionState, 'CONNECTED');
    assert.deepEqual((listed?.data as any).devices[0].permissions, ['permission:ACCESSIBILITY_SERVICE:ENABLED']);

    const renamed = await handleDeviceAgentRoutes('PATCH', `/api/v1/device-agent/devices/${device.deviceId}`, { nickname: 'Fold3 cert phone' }, owner.cookie, {}, deps);
    assert.equal(renamed?.status, 200);
    assert.equal((renamed?.data as any).nickname, 'Fold3 cert phone');
    const revoked = await handleDeviceAgentRoutes('POST', `/api/v1/device-agent/devices/${device.deviceId}/revoke`, null, owner.cookie, {}, deps);
    assert.equal(revoked?.status, 200);
    assert.equal((revoked?.data as any).status, 'REVOKED');
  });

  it('global search is owner scoped, local-only, and respects memory/vault search privacy toggles', async () => {
    const root = tmp('search');
    const owner = identity(root);
    const other = identity(path.join(root, 'other'));
    const captureStore = new CaptureStore(path.join(root, 'captures'));
    const taskStore = new TaskStore({ dir: path.join(root, 'tasks') });
    const knowledgeEngine = new KnowledgeEngine(path.join(root, 'knowledge'));
    const memoryEngine = new MemoryEngine({ dir: path.join(root, 'memory') });
    const vaultStore = new VaultStore(path.join(root, 'vault'));
    const artifactStore = new ArtifactStore({ dir: path.join(root, 'artifacts') });
    const activityStore = new ActivityStore({ dir: path.join(root, 'activity') });
    const deps = { sessionStore: owner.sessionStore, identityStore: owner.identityStore, captureStore, taskStore, knowledgeEngine, memoryEngine, vaultStore, artifactStore, activityStore };

    captureStore.createCapture({ tenantId: owner.tenantId, ownerId: owner.userId, type: 'TEXT', content: 'Phase three launch checklist' });
    captureStore.createCapture({ tenantId: other.tenantId, ownerId: other.userId, type: 'TEXT', content: 'Phase three private item from another owner' });
    taskStore.create({ tenantId: owner.tenantId, ownerId: owner.userId, name: 'Prepare phase three', objective: 'Wire real search state', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
    vaultStore.saveItem({ tenantId: owner.tenantId, userId: owner.userId, type: 'DOCUMENT', title: 'Phase three vault note', storageRef: 'local://phase3' });

    let result = await handleSearchRoutes('GET', '/api/v1/search', null, owner.cookie, { q: 'phase three' }, deps);
    assert.equal(result?.status, 200);
    const sources = ((result?.data as any).results as any[]).map((r) => r.source);
    assert.ok(sources.includes('INBOX'));
    assert.ok(sources.includes('TASKS'));
    assert.ok(sources.includes('VAULT'));
    assert.equal(((result?.data as any).results as any[]).some((r) => /another owner/.test(r.snippet)), false);
    assert.equal((result?.data as any).externalSourcesSearched, false);

    await handleSettingsRoutes('PATCH', '/api/v1/settings', { privacy: { includeVaultInSearch: false } }, owner.cookie, {}, { identityStore: owner.identityStore, sessionStore: owner.sessionStore });
    result = await handleSearchRoutes('GET', '/api/v1/search', null, owner.cookie, { q: 'phase three' }, deps);
    assert.equal(((result?.data as any).results as any[]).some((r) => r.source === 'VAULT'), false);
  });
});
