// Windows desktop control, server side: the desktop plan command (DESKTOP_EXECUTE_PLAN v1) is a governed, approval-bound, owner-scoped command - or nothing.
// Real stores, real Ed25519 device keys, the real signed transport (client -> endpoint) and the real route handler; no device executes anything here (that is desktop_plan_executor.test.ts and the
// opt-in real-PC run). What this file pins: nothing is queued without an approval of EXACTLY these fields; the device is told WHAT (never HOW); a command is delivered once; the device's report is
// stored as small, flat evidence; and one person can never see or use another's plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { DeviceCommandService } from '../src/device-agent/device-command.service.js';
import { DeviceCommandStatusStore, sanitizeCommandEvidence } from '../src/device-agent/device-command-status.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { LocalDeviceAgentClient } from '../src/device-agent/local-device-agent-client.js';
import { DESKTOP_WRITE_SAVE_TOOL_ID, desktopWriteAndSaveApprovalPayload, validateDesktopWriteAndSave } from '../src/device-agent/desktop-plan.types.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { SessionStore } from '../src/sessions/session.store.js';

const TEXT = 'NAgex Desktop Agent 실기기 제어 검증 — 2026-10-16';
const CAP = 'desktop:UIA_INTERACTIVE:NOTEPAD';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-plan-'));
const expectCode = (fn: () => unknown, code: string): void => { assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code, `expected ${code}`); };

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

function fetchBridge(endpoint: DeviceAgentTransportEndpoint): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    try { return new Response(JSON.stringify(endpoint.handle({ envelope: body.envelope, payload: body.payload }, `req_${crypto.randomUUID()}`)), { status: 200 }); }
    catch (error) { return new Response(JSON.stringify({ error: { code: (error as { code?: string }).code ?? 'UNKNOWN' } }), { status: 403 }); }
  }) as typeof fetch;
}

function harness(options: { capabilities?: string[]; nowMs?: number } = {}) {
  const dir = tmp();
  const nowMs = options.nowMs ?? Date.now();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const pending = new DevicePendingCommandStore({ dir: path.join(dir, 'pending') });
  const statuses = new DeviceCommandStatusStore({ dir: path.join(dir, 'status') });
  const approvals = new ActionApprovalStore(() => nowMs);
  const transport = new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') });
  const endpoint = new DeviceAgentTransportEndpoint(transport, devices, new DeviceConnectionStatusStore({ dir: path.join(dir, 'conn') }), new DesktopExecutionSessionStore({ dir: path.join(dir, 'sess') }), pending, undefined, undefined, statuses);
  const service = new DeviceCommandService(devices, pending, approvals, () => nowMs);
  const sessions = new SessionStore({ dir: path.join(dir, 'sessions') });
  const k = keys();
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: k.publicKeyPem, agentVersion: 'win-test', capabilityInventory: options.capabilities ?? [CAP] });
  const request = { deviceId: device.deviceId, appId: 'NOTEPAD' as const, text: TEXT, rootAlias: 'DOCUMENTS' as const, fileName: 'NAgex-Test.txt' };
  const approve = (patch: Partial<typeof request> = {}, who = { tenantId: 'ten', principalId: 'usr' }) => {
    const record = approvals.request({ toolId: DESKTOP_WRITE_SAVE_TOOL_ID, ...who, payload: desktopWriteAndSaveApprovalPayload({ ...request, ...patch }) });
    approvals.approve(record.approvalId, who.tenantId, who.principalId);
    return record.approvalId;
  };
  const input = (approvalRef: string, patch: Record<string, unknown> = {}) => ({
    tenantId: 'ten', principalId: 'usr', requestId: 'req_t', deviceId: device.deviceId, approvalRef, planId: `plan_${crypto.randomUUID().slice(0, 8)}`,
    appId: 'NOTEPAD' as const, text: TEXT, rootAlias: 'DOCUMENTS' as const, fileName: 'NAgex-Test.txt', expiresAt: new Date(nowMs + 5 * 60_000).toISOString(), ...patch,
  });
  const client = new LocalDeviceAgentClient({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, privateKeyPem: k.privateKeyPem, serverBaseUrl: 'http://x', agentVersion: 'win-test', fetchFn: fetchBridge(endpoint) });
  const routeDeps = (extra: Record<string, unknown> = {}) => ({ deviceAgentTransportEndpoint: endpoint, deviceCommandService: service, deviceIdentityStore: devices, sessionStore: sessions, deviceCommandStatusStore: statuses, actionApprovals: approvals, ...extra });
  return { dir, nowMs, devices, pending, statuses, approvals, endpoint, service, sessions, device, request, approve, input, client, routeDeps };
}

test('the plan is validated as a plain document write: a single line of text, a plain .txt name, an allowlisted application and folder - nothing else can even be expressed', () => {
  const ok = { deviceId: 'dev_1', appId: 'NOTEPAD', text: TEXT, rootAlias: 'DOCUMENTS', fileName: 'NAgex-Test.txt' } as const;
  assert.deepEqual(validateDesktopWriteAndSave(ok), { ok: true });
  const code = (patch: Record<string, unknown>) => { const v = validateDesktopWriteAndSave({ ...ok, ...patch } as never); return v.ok ? 'OK' : v.code; };
  assert.equal(code({ appId: 'POWERSHELL' }), 'DESKTOP_APP_NOT_ALLOWED');
  assert.equal(code({ appId: 'C:\\Windows\\System32\\cmd.exe' }), 'DESKTOP_APP_NOT_ALLOWED');
  assert.equal(code({ rootAlias: 'C:\\Windows' }), 'DESKTOP_FOLDER_NOT_ALLOWED');
  assert.equal(code({ rootAlias: 'DESKTOP' }), 'DESKTOP_FOLDER_NOT_ALLOWED');
  for (const bad of ['..\\evil.txt', '../evil.txt', 'sub/a.txt', 'C:\\x.txt', 'a.exe', 'a.txt.exe', 'CON.txt', 'nul.txt', 'aux.txt', '.hidden.txt', 'a..b.txt', 'name .txt', 'x'.repeat(120) + '.txt', '']) {
    assert.equal(code({ fileName: bad }), 'DESKTOP_FILE_NAME_INVALID', JSON.stringify(bad));
  }
  assert.equal(code({ text: '' }), 'DESKTOP_TEXT_REQUIRED');
  assert.equal(code({ text: 'two\nlines' }), 'DESKTOP_TEXT_NOT_SINGLE_LINE');
  assert.equal(code({ text: 'tab\there' }), 'DESKTOP_TEXT_NOT_SINGLE_LINE');
  assert.equal(code({ text: ' padded' }), 'DESKTOP_TEXT_EDGE_WHITESPACE');
  assert.equal(code({ text: 'x'.repeat(2001) }), 'DESKTOP_TEXT_TOO_LONG');
  assert.equal(code({ deviceId: '' }), 'DESKTOP_PLAN_DEVICE_REQUIRED');
});

test('a plan with an approval of exactly these fields is queued once as DESKTOP_EXECUTE_PLAN, carries WHAT and never HOW, and is delivered to the device once', () => {
  const h = harness();
  const result = h.service.enqueueDesktopWriteAndSave(h.input(h.approve()));
  assert.equal(result.status, 'QUEUED');
  assert.equal(result.command.commandType, 'DESKTOP_EXECUTE_PLAN');
  assert.equal(result.command.deviceId, h.device.deviceId);
  const data = result.command.data;
  assert.equal(data.commandVersion, 1);
  assert.equal(data.operation, 'WRITE_TEXT_AND_SAVE');
  assert.equal(data.route, 'WINDOWS_UIA_INTERACTIVE');
  assert.equal(data.appId, 'NOTEPAD');
  assert.equal(data.rootAlias, 'DOCUMENTS');
  assert.equal(data.fileName, 'NAgex-Test.txt');
  assert.equal(data.overwrite, false);
  assert.equal(data.text, TEXT);
  assert.equal(data.textSha256, crypto.createHash('sha256').update(TEXT, 'utf8').digest('hex'));
  // WHAT, never HOW: no program path, shell, folder path, step list, coordinate, keystroke
  for (const forbidden of ['appExePath', 'exePath', 'path', 'directory', 'folder', 'command', 'script', 'shell', 'steps', 'keys', 'x', 'y', 'selector']) assert.ok(!(forbidden in data), `no "${forbidden}" in the command`);
  const delivered = h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr');
  assert.equal(delivered?.commandId, result.command.commandId);
  assert.equal(h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr'), null, 'delivered once');
});

test('refused before anything is queued: not enrolled, another person\'s or tenant\'s device, a revoked device, a device that cannot drive the application', () => {
  const h = harness();
  const approval = h.approve();
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(approval, { deviceId: 'dev_never_enrolled' })), 'DEVICE_NOT_FOUND');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(approval, { principalId: 'usr_other' })), 'DEVICE_NOT_FOUND');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(approval, { tenantId: 'ten_other' })), 'DEVICE_NOT_FOUND');
  assert.equal(h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr').length, 0);

  const noCapability = harness({ capabilities: [] });
  expectCode(() => noCapability.service.enqueueDesktopWriteAndSave(noCapability.input(noCapability.approve())), 'DESKTOP_CAPABILITY_UNAVAILABLE');

  const revoked = harness();
  const revokedApproval = revoked.approve();
  revoked.devices.revoke(revoked.device.deviceId, 'ten', 'usr');
  expectCode(() => revoked.service.enqueueDesktopWriteAndSave(revoked.input(revokedApproval)), 'DEVICE_NOT_ACTIVE');
});

test('approval is the authority: pending, rejected, expired, used, for another tool or for different fields - each refused with its own reason, and nothing is queued', () => {
  const h = harness();
  // never approved
  const pendingOnly = h.approvals.request({ toolId: DESKTOP_WRITE_SAVE_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: desktopWriteAndSaveApprovalPayload(h.request) }).approvalId;
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(pendingOnly)), 'APPROVAL_NOT_GRANTED');
  // declined
  const declined = h.approvals.request({ toolId: DESKTOP_WRITE_SAVE_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: desktopWriteAndSaveApprovalPayload(h.request) }).approvalId;
  h.approvals.reject(declined, 'ten', 'usr');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(declined)), 'APPROVAL_NOT_GRANTED');
  // an approval for some other tool
  const otherTool = h.approvals.request({ toolId: 'browser.click', tenantId: 'ten', principalId: 'usr', payload: desktopWriteAndSaveApprovalPayload(h.request) }).approvalId;
  h.approvals.approve(otherTool, 'ten', 'usr');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(otherTool)), 'APPROVAL_TOOL_MISMATCH');
  // someone else's approval is as absent as a made-up one
  const foreign = h.approve({}, { tenantId: 'ten', principalId: 'usr_other' });
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(foreign)), 'APPROVAL_NOT_FOUND');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input('apr_does_not_exist')), 'APPROVAL_NOT_FOUND');
  assert.equal(h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr').length, 0, 'none of these queued anything');

  // approved for these fields, requested with other ones: every approved field is bound
  for (const [label, patch] of [['text', { text: TEXT + ' (changed)' }], ['file name', { fileName: 'Other.txt' }], ['application', { appId: 'NOTEPAD', rootAlias: 'DOCUMENTS', fileName: 'NAgex-Test2.txt' }]] as const) {
    const approvedOnce = h.approve();
    expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(approvedOnce, patch as Record<string, unknown>)), 'APPROVAL_PAYLOAD_MISMATCH');
    // a refused attempt did not burn the approval: the exact approved plan still works
    assert.equal(h.service.enqueueDesktopWriteAndSave(h.input(approvedOnce, { planId: `plan_${label.replace(' ', '_')}` })).status, 'QUEUED', label);
    h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr');
  }

  // an approval granted for one device cannot be used for another
  const other = h.devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: keys().publicKeyPem, agentVersion: 'win-test', capabilityInventory: [CAP] });
  const forFirst = h.approve();
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(forFirst, { deviceId: other.deviceId })), 'APPROVAL_PAYLOAD_MISMATCH');
});

test('an approval is used exactly once: a second plan on the same approval is refused, the same plan id returns the one queued command', () => {
  const h = harness();
  const approval = h.approve();
  const first = h.input(approval, { planId: 'plan_once' });
  assert.equal(h.service.enqueueDesktopWriteAndSave(first).status, 'QUEUED');
  assert.equal(h.service.enqueueDesktopWriteAndSave(first).status, 'DUPLICATE_RETURNED', 'the same plan is not queued twice');
  h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(approval, { planId: 'plan_again' })), 'APPROVAL_ALREADY_CONSUMED');
});

test('a plan that is expired, valid for too long, or queued behind another pending command is refused', () => {
  const h = harness();
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { expiresAt: new Date(h.nowMs - 1000).toISOString() })), 'DESKTOP_PLAN_EXPIRED');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { expiresAt: new Date(h.nowMs + 60 * 60_000).toISOString() })), 'DESKTOP_PLAN_TTL_TOO_LONG');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { expiresAt: 'tomorrow' })), 'DESKTOP_PLAN_EXPIRED');
  assert.equal(h.service.enqueueDesktopWriteAndSave(h.input(h.approve())).status, 'QUEUED');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve())), 'DEVICE_COMMAND_ALREADY_PENDING');
  // and an unauthorized path / application never reaches the approval at all
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { fileName: '..\\..\\Windows\\evil.txt' })), 'DESKTOP_FILE_NAME_INVALID');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { rootAlias: 'SYSTEM' as never })), 'DESKTOP_FOLDER_NOT_ALLOWED');
  expectCode(() => h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { appId: 'CMD' as never })), 'DESKTOP_APP_NOT_ALLOWED');
});

test('the real signed transport: the device receives the command on its heartbeat, reports where it is, and the final report is kept as small flat evidence (no nested data, no long text)', async () => {
  const h = harness();
  const queued = h.service.enqueueDesktopWriteAndSave(h.input(h.approve(), { planId: 'plan_wire' }));
  h.statuses.markQueued({ commandId: queued.command.commandId, tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, executionId: String(queued.command.data.executionId) });
  await h.client.connect();
  const received = await h.client.heartbeat();
  assert.equal(received?.commandId, queued.command.commandId);
  assert.equal(received?.commandType, 'DESKTOP_EXECUTE_PLAN');
  assert.equal(h.statuses.get(queued.command.commandId)?.stage, 'CLAIMED', 'delivered and claimed - not completed');
  assert.equal(await h.client.heartbeat(), null, 'nothing is delivered twice');

  const executionId = String(received!.data.executionId);
  await h.client.reportCommand(received!.commandId, executionId, 'EXECUTING', 'STARTED', { steps: ['ACCEPTED'] });
  assert.equal(h.statuses.get(received!.commandId)?.stage, 'EXECUTING');
  await h.client.reportCommand(received!.commandId, executionId, 'COMPLETED', 'DESKTOP_SAVED_VERIFIED', {
    steps: ['ACCEPTED', 'FILE_READ_BACK_MATCHES_APPROVED_TEXT'], fileSizeBytes: 66, fileMatchesApprovedText: true,
    nested: { secret: 'must not be kept' }, 'bad key!': 1, long: 'x'.repeat(1000),
  });
  const record = h.statuses.get(received!.commandId)!;
  assert.equal(record.stage, 'COMPLETED');
  assert.equal(record.resultCode, 'DESKTOP_SAVED_VERIFIED');
  assert.deepEqual(record.evidence?.steps, ['ACCEPTED', 'FILE_READ_BACK_MATCHES_APPROVED_TEXT']);
  assert.equal(record.evidence?.fileMatchesApprovedText, true);
  assert.ok(!('nested' in (record.evidence ?? {})) && !('bad key!' in (record.evidence ?? {})), 'only plain flat facts are kept');
  assert.equal(String(record.evidence?.long).length, 200, 'long strings are clipped');
});

test('evidence from a device is sanitised: flat facts only, bounded in size and number', () => {
  assert.equal(sanitizeCommandEvidence(null), null);
  assert.equal(sanitizeCommandEvidence('text'), null);
  assert.equal(sanitizeCommandEvidence([1, 2]), null);
  assert.deepEqual(sanitizeCommandEvidence({ a: 1, b: 'x', c: true, d: { no: 1 }, e: [1, 'y', { no: 1 }, false], f: Number.NaN }), { a: 1, b: 'x', c: true, e: [1, 'y', false] });
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
  assert.ok(Object.keys(sanitizeCommandEvidence(many) ?? {}).length <= 24);
  const huge = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${i}`, Array.from({ length: 16 }, () => 'y'.repeat(200))]));
  assert.equal(sanitizeCommandEvidence(huge), null, 'an oversized report is dropped, not stored');
});

test('routes: ask -> approve -> dispatch -> status, all session-authenticated and owner-scoped; the plan is rebuilt from what was approved', async () => {
  const h = harness();
  const mine = h.sessions.createAuthSession('ten', 'usr');
  const someoneElse = h.sessions.createAuthSession('ten', 'usr_other');
  const asMe = { authorization: `Bearer ${mine.sessionId}` };
  const call = (method: string, pathname: string, body: unknown, headers: Record<string, string> = asMe) => handleDeviceAgentRoutes(method, pathname, body as never, headers, {}, h.routeDeps() as never);
  const body = { deviceId: h.device.deviceId, text: TEXT, fileName: 'NAgex-Test.txt' };

  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans', body, {}), (e: unknown) => (e as { code?: string }).code === 'DEVICE_COMMAND_AUTH_REQUIRED');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans', { ...body, fileName: '..\\x.txt' }), (e: unknown) => (e as { code?: string }).code === 'DESKTOP_FILE_NAME_INVALID');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans', { ...body, appId: 'POWERSHELL' }), (e: unknown) => (e as { code?: string }).code === 'DESKTOP_APP_NOT_ALLOWED');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans', body, { authorization: `Bearer ${someoneElse.sessionId}` }), (e: unknown) => (e as { code?: string }).code === 'DEVICE_NOT_FOUND');

  const asked = await call('POST', '/api/v1/device-agent/desktop-plans', body);
  assert.equal(asked?.status, 201);
  const approvalId = (asked!.data as { approvalId: string }).approvalId;
  assert.equal((asked!.data as { status: string }).status, 'PENDING');
  assert.equal((asked!.data as { summary: { onYourScreen: boolean; fileName: string } }).summary.onYourScreen, true, 'the person is told it happens on their screen');

  // not yet approved -> refused, nothing queued
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans/dispatch', { approvalId }), (e: unknown) => (e as { code?: string }).code === 'APPROVAL_NOT_GRANTED');
  assert.equal(h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr').length, 0);
  // someone else cannot dispatch it (or learn it exists)
  h.approvals.approve(approvalId, 'ten', 'usr');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans/dispatch', { approvalId }, { authorization: `Bearer ${someoneElse.sessionId}` }), (e: unknown) => (e as { code?: string }).code === 'APPROVAL_NOT_FOUND');
  // the caller sends nothing but the approval id: whatever else it sends is ignored, the plan is what was approved
  const dispatched = await call('POST', '/api/v1/device-agent/desktop-plans/dispatch', { approvalId, text: 'something else', fileName: 'Other.txt', appExePath: 'C:\\evil.exe' });
  assert.equal(dispatched?.status, 202);
  const commandId = (dispatched!.data as { commandId: string }).commandId;
  const queued = h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].data.text, TEXT);
  assert.equal(queued[0].data.fileName, 'NAgex-Test.txt');
  assert.ok(!('appExePath' in queued[0].data));
  // the same approval cannot be dispatched again
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-plans/dispatch', { approvalId }), (e: unknown) => (e as { code?: string }).code === 'APPROVAL_ALREADY_CONSUMED');

  const status = await call('GET', `/api/v1/device-agent/desktop-plans/${commandId}`, undefined);
  assert.equal(status?.status, 200);
  assert.equal((status!.data as { stage: string }).stage, 'QUEUED');
  await assert.rejects(() => call('GET', `/api/v1/device-agent/desktop-plans/${commandId}`, undefined, { authorization: `Bearer ${someoneElse.sessionId}` }), (e: unknown) => (e as { code?: string }).code === 'DESKTOP_PLAN_NOT_FOUND');
});
