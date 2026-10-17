// Windows desktop control, server side, the SECOND canonical action: a calculation in the Calculator is a governed, approval-bound, owner-scoped command - or nothing.
// Real stores, real Ed25519 device keys, the real signed transport and the real route handler; no device executes anything here (that is desktop_calculate_executor.test.ts and the opt-in real-PC run).
// What this file pins: nothing is queued without an approval of EXACTLY these fields (operands, operator, the expected result, the device); the approval of one action cannot start the other; the device is
// told WHAT (never HOW); one person can never see or use another's plan; and the same reading of the person's words feeds the card, never an authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { DeviceCommandService } from '../src/device-agent/device-command.service.js';
import { DeviceCommandStatusStore } from '../src/device-agent/device-command-status.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DESKTOP_CALCULATE_TOOL_ID, DESKTOP_CALCULATOR_CAPABILITY, DESKTOP_WRITE_SAVE_TOOL_ID, desktopCalculateApprovalPayload, desktopWriteAndSaveApprovalPayload } from '../src/device-agent/desktop-plan.types.js';
import { interpretDesktopCalculateRequest, isDesktopCalculateRequest, isDesktopWriteRequest } from '../src/device-agent/desktop-request-interpreter.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { decideRouting } from '../src/workspace/input-router.js';

const NOTEPAD_CAP = 'desktop:UIA_INTERACTIVE:NOTEPAD';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-calc-'));
const expectCode = (fn: () => unknown, code: string): void => { assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code, `expected ${code}`); };
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

function harness(options: { capabilities?: string[] } = {}) {
  const dir = tmp();
  const nowMs = Date.now();
  const devices = new DeviceIdentityStore({ dir: path.join(dir, 'devices') });
  const pending = new DevicePendingCommandStore({ dir: path.join(dir, 'pending') });
  const statuses = new DeviceCommandStatusStore({ dir: path.join(dir, 'status') });
  const approvals = new ActionApprovalStore(() => nowMs);
  const transport = new DeviceTransportSecurity(devices, { dir: path.join(dir, 'replay') });
  const endpoint = new DeviceAgentTransportEndpoint(transport, devices, new DeviceConnectionStatusStore({ dir: path.join(dir, 'conn') }), new DesktopExecutionSessionStore({ dir: path.join(dir, 'sess') }), pending, undefined, undefined, statuses);
  const service = new DeviceCommandService(devices, pending, approvals, () => nowMs);
  const sessions = new SessionStore({ dir: path.join(dir, 'sessions') });
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), agentVersion: 'win-test', capabilityInventory: options.capabilities ?? [NOTEPAD_CAP, DESKTOP_CALCULATOR_CAPABILITY] });
  const calc = { deviceId: device.deviceId, appId: 'CALCULATOR' as const, left: 17, op: '*' as const, right: 24 };
  const approve = (patch: Partial<typeof calc> = {}, who = { tenantId: 'ten', principalId: 'usr' }) => {
    const record = approvals.request({ toolId: DESKTOP_CALCULATE_TOOL_ID, ...who, payload: desktopCalculateApprovalPayload({ ...calc, ...patch }) });
    approvals.approve(record.approvalId, who.tenantId, who.principalId);
    return record.approvalId;
  };
  const input = (approvalRef: string, patch: Record<string, unknown> = {}) => ({
    tenantId: 'ten', principalId: 'usr', requestId: 'req_t', deviceId: device.deviceId, approvalRef, planId: `plan_${crypto.randomUUID().slice(0, 8)}`,
    appId: 'CALCULATOR' as const, left: 17, op: '*' as const, right: 24, expiresAt: new Date(nowMs + 5 * 60_000).toISOString(), ...patch,
  });
  const routeDeps = (extra: Record<string, unknown> = {}) => ({ deviceAgentTransportEndpoint: endpoint, deviceCommandService: service, deviceIdentityStore: devices, sessionStore: sessions, deviceCommandStatusStore: statuses, actionApprovals: approvals, ...extra });
  return { dir, devices, pending, statuses, approvals, service, sessions, device, calc, approve, input, routeDeps };
}

test('a calculation with an approval of exactly these fields is queued once as DESKTOP_EXECUTE_PLAN, carries WHAT (operands, operator, the expected result) and never HOW', () => {
  const h = harness();
  const result = h.service.enqueueDesktopCalculate(h.input(h.approve()));
  assert.equal(result.status, 'QUEUED');
  assert.equal(result.command.commandType, 'DESKTOP_EXECUTE_PLAN');
  const data = result.command.data;
  assert.equal(data.commandVersion, 1);
  assert.equal(data.operation, 'CALCULATE');
  assert.equal(data.route, 'WINDOWS_UIA_INTERACTIVE');
  assert.equal(data.appId, 'CALCULATOR');
  assert.deepEqual([data.left, data.op, data.right, data.expected], [17, '*', 24, 408]);
  for (const forbidden of ['appExePath', 'exePath', 'path', 'command', 'script', 'shell', 'steps', 'keys', 'x', 'y', 'selector', 'automationId']) assert.ok(!(forbidden in data), `no "${forbidden}" in the command`);
  assert.equal(h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr')?.commandId, result.command.commandId);
  assert.equal(h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr'), null, 'delivered once');
});

test('refused before anything is queued: another person\'s or tenant\'s device, a device that cannot drive the Calculator, an operator or operand the contract does not allow', () => {
  const h = harness();
  const approval = h.approve();
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(approval, { deviceId: 'dev_never_enrolled' })), 'DEVICE_NOT_FOUND');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(approval, { principalId: 'usr_other' })), 'DEVICE_NOT_FOUND');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(approval, { tenantId: 'ten_other' })), 'DEVICE_NOT_FOUND');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(approval, { op: '/' })), 'DESKTOP_CALC_OPERATOR_INVALID');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(approval, { left: 1_000_000 })), 'DESKTOP_CALC_OPERAND_INVALID');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(approval, { expiresAt: new Date(Date.now() - 1000).toISOString() })), 'DESKTOP_PLAN_EXPIRED');
  assert.equal(h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr').length, 0);
  const notepadOnly = harness({ capabilities: [NOTEPAD_CAP] });
  expectCode(() => notepadOnly.service.enqueueDesktopCalculate(notepadOnly.input(notepadOnly.approve())), 'DESKTOP_CAPABILITY_UNAVAILABLE');
});

test('the approval is the gate: not granted, declined, another tool\'s approval, a changed operand or operator, a used approval - each refused with its own code, and a refused attempt does not burn the approval', () => {
  const h = harness();
  const pendingRecord = h.approvals.request({ toolId: DESKTOP_CALCULATE_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: desktopCalculateApprovalPayload(h.calc) });
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(pendingRecord.approvalId)), 'APPROVAL_NOT_GRANTED');
  const declined = h.approvals.request({ toolId: DESKTOP_CALCULATE_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: desktopCalculateApprovalPayload(h.calc) });
  h.approvals.reject(declined.approvalId, 'ten', 'usr', 'req_decline');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(declined.approvalId)), 'APPROVAL_NOT_GRANTED');

  // an approval to write a file in Notepad cannot start a calculation, and the other way round
  const write = h.approvals.request({ toolId: DESKTOP_WRITE_SAVE_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: desktopWriteAndSaveApprovalPayload({ deviceId: h.device.deviceId, appId: 'NOTEPAD', text: 'hello', rootAlias: 'DOCUMENTS', fileName: 'a.txt' }) });
  h.approvals.approve(write.approvalId, 'ten', 'usr');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(write.approvalId)), 'APPROVAL_TOOL_MISMATCH');
  const calcApproval = h.approve();
  expectCode(() => h.service.enqueueDesktopWriteAndSave({ tenantId: 'ten', principalId: 'usr', requestId: 'r', deviceId: h.device.deviceId, approvalRef: calcApproval, planId: 'p1', appId: 'NOTEPAD', text: 'hello', rootAlias: 'DOCUMENTS', fileName: 'a.txt', expiresAt: new Date(Date.now() + 60_000).toISOString() }), 'APPROVAL_TOOL_MISMATCH');

  // what was approved is 17 * 24: another operand, another operator are not what was approved
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(calcApproval, { right: 25 })), 'APPROVAL_PAYLOAD_MISMATCH');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(calcApproval, { op: '+' })), 'APPROVAL_PAYLOAD_MISMATCH');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(calcApproval, { left: 18 })), 'APPROVAL_PAYLOAD_MISMATCH');
  assert.equal(h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr').length, 0, 'nothing was queued by a refused attempt');
  assert.equal(h.service.enqueueDesktopCalculate(h.input(calcApproval)).status, 'QUEUED', 'the refused attempts did not burn the approval');
  assert.ok(h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr'), 'the device took the first command');
  expectCode(() => h.service.enqueueDesktopCalculate(h.input(calcApproval)), 'APPROVAL_ALREADY_CONSUMED');
});

test('routes: ask (from the person\'s own words) -> approve -> dispatch -> status; session-authenticated, owner-scoped, rebuilt from what was approved', async () => {
  const h = harness();
  const mine = h.sessions.createAuthSession('ten', 'usr');
  const someoneElse = h.sessions.createAuthSession('ten', 'usr_other');
  const asMe = { authorization: `Bearer ${mine.sessionId}` };
  const call = (method: string, pathname: string, body: unknown, headers: Record<string, string> = asMe) => handleDeviceAgentRoutes(method, pathname, body as never, headers, {}, h.routeDeps() as never);

  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations', { prompt: '계산기로 17 곱하기 24 계산해줘' }, {}), (e: unknown) => codeOf(e) === 'DEVICE_COMMAND_AUTH_REQUIRED');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations', { prompt: '계산기로 17 곱하기 24 계산해줘' }, { authorization: `Bearer ${someoneElse.sessionId}` }), (e: unknown) => codeOf(e) === 'DESKTOP_DEVICE_UNAVAILABLE');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations', { prompt: '계산기를 열어줘' }), (e: unknown) => codeOf(e) === 'DESKTOP_REQUEST_UNCLEAR_EXPRESSION');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations', { left: 5, op: '/', right: 1 }), (e: unknown) => codeOf(e) === 'DESKTOP_CALC_OPERATOR_INVALID');

  const asked = await call('POST', '/api/v1/device-agent/desktop-calculations', { prompt: '계산기로 17 곱하기 24 계산해줘' });
  assert.equal(asked?.status, 201);
  const data = asked!.data as { approvalId: string; status: string; summary: Record<string, unknown> };
  assert.equal(data.status, 'PENDING');
  assert.deepEqual([data.summary.operation, data.summary.left, data.summary.op, data.summary.right, data.summary.expected, data.summary.onYourScreen], ['CALCULATE', 17, '*', 24, 408, true]);

  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations/dispatch', { approvalId: data.approvalId }), (e: unknown) => codeOf(e) === 'APPROVAL_NOT_GRANTED');
  h.approvals.approve(data.approvalId, 'ten', 'usr');
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations/dispatch', { approvalId: data.approvalId }, { authorization: `Bearer ${someoneElse.sessionId}` }), (e: unknown) => codeOf(e) === 'APPROVAL_NOT_FOUND');
  // the caller sends nothing but the approval id: whatever else it sends is ignored - the plan is what was approved
  const dispatched = await call('POST', '/api/v1/device-agent/desktop-calculations/dispatch', { approvalId: data.approvalId, left: 1, right: 1, op: '+', appExePath: 'C:\\evil.exe' });
  assert.equal(dispatched?.status, 202);
  const queued = h.pending.listPendingForDevice(h.device.deviceId, 'ten', 'usr');
  assert.equal(queued.length, 1);
  assert.deepEqual([queued[0].data.left, queued[0].data.op, queued[0].data.right, queued[0].data.expected], [17, '*', 24, 408]);
  assert.ok(!('appExePath' in queued[0].data));
  await assert.rejects(() => call('POST', '/api/v1/device-agent/desktop-calculations/dispatch', { approvalId: data.approvalId }), (e: unknown) => codeOf(e) === 'APPROVAL_ALREADY_CONSUMED');

  // the status route is the same one the write-and-save plans use; another person sees nothing
  const commandId = (dispatched!.data as { commandId: string }).commandId;
  const status = await call('GET', `/api/v1/device-agent/desktop-plans/${commandId}`, undefined);
  assert.equal(status?.status, 200);
  await assert.rejects(() => call('GET', `/api/v1/device-agent/desktop-plans/${commandId}`, undefined, { authorization: `Bearer ${someoneElse.sessionId}` }), (e: unknown) => codeOf(e) === 'DESKTOP_PLAN_NOT_FOUND');
});

test('a PC that cannot drive the Calculator is not asked: no approval is even created for something that cannot happen', async () => {
  const h = harness({ capabilities: [NOTEPAD_CAP] });
  const session = h.sessions.createAuthSession('ten', 'usr');
  await assert.rejects(() => handleDeviceAgentRoutes('POST', '/api/v1/device-agent/desktop-calculations', { prompt: '계산기로 17 곱하기 24 계산해줘' } as never, { authorization: `Bearer ${session.sessionId}` }, {}, h.routeDeps() as never), (e: unknown) => codeOf(e) === 'DESKTOP_DEVICE_UNAVAILABLE');
  await assert.rejects(() => handleDeviceAgentRoutes('POST', '/api/v1/device-agent/desktop-calculations', { deviceId: h.device.deviceId, left: 17, op: '*', right: 24 } as never, { authorization: `Bearer ${session.sessionId}` }, {}, h.routeDeps() as never), (e: unknown) => codeOf(e) === 'DESKTOP_CAPABILITY_UNAVAILABLE');
});

test('reading the person\'s words: Korean and English, infix and spoken forms; a question, a missing number, an unsupported operator or too large a number is NOT a request', () => {
  const read = (text: string) => interpretDesktopCalculateRequest(text);
  const expectOk = (text: string, left: number, op: string, right: number) => assert.deepEqual(read(text), { ok: true, appId: 'CALCULATOR', left, op, right }, text);
  expectOk('계산기로 17 곱하기 24 계산해줘', 17, '*', 24);
  expectOk('계산기를 열어서 17×24 계산해줘', 17, '*', 24);
  expectOk('계산기로 17 * 24', 17, '*', 24);
  expectOk('계산기로 1,200 더하기 345 계산해줘', 1200, '+', 345);
  expectOk('계산기로 100 - 37 계산해줘', 100, '-', 37);
  expectOk('계산기로 100 빼기 37', 100, '-', 37);
  expectOk('계산기로 17과 24를 곱해줘', 17, '*', 24);
  expectOk('Use the Calculator to work out 17 times 24', 17, '*', 24);
  expectOk('open calculator and calculate 17 * 24', 17, '*', 24);
  expectOk('Calculator: 250 plus 4', 250, '+', 4);
  assert.deepEqual(read('17 곱하기 24 계산해줘'), { ok: false, missing: 'APP' }, 'no application named: not this action');
  assert.equal(read('계산기를 열어줘').ok, false);
  assert.equal(read('계산기로 17 곱하기').ok, false);
  assert.equal(read('계산기로 17 나누기 24').ok, false, 'division is not supported in version 1');
  assert.equal(read('계산기로 1000000 + 1').ok, false, 'six digits at most');
  assert.equal(read('계산기로 3 - 5').ok, false, 'a result below zero is not calculated in version 1');
  assert.equal(isDesktopCalculateRequest('How do I use the calculator to work out 17 * 24?'), false, 'a question about how is not a request');
  assert.equal(isDesktopCalculateRequest('계산기로 17 곱하기 24 계산하는 방법 알려줘'), false);
  assert.equal(isDesktopCalculateRequest('계산기로 17 곱하기 24 계산해줘'), true);
  assert.equal(isDesktopWriteRequest('계산기로 17 곱하기 24 계산해줘'), false, 'and it is not the Notepad action');
  assert.equal(isDesktopCalculateRequest('메모장을 열고 "17*24"를 입력한 다음 a.txt로 저장해줘'), false, 'the Notepad action keeps its own requests');
});

test('routing: a calculation request is a desktop task only when an enrolled PC can drive the Calculator - otherwise it says so; it never falls through to a chat answer', () => {
  const text = '계산기로 17 곱하기 24 계산해줘';
  const available = decideRouting(text, { desktopCalculatorAvailable: true });
  assert.equal(available.kind, 'ACTION_PLAN');
  assert.ok(available.reasonCodes.includes('DESKTOP_TASK') && available.reasonCodes.includes('DESKTOP_CALCULATE') && available.reasonCodes.includes('APPROVAL_REQUIRED'));
  const unavailable = decideRouting(text, { desktopCalculatorAvailable: false });
  assert.equal(unavailable.kind, 'UNSUPPORTED');
  assert.ok(unavailable.reasonCodes.includes('DESKTOP_DEVICE_UNAVAILABLE'));
  // the Notepad request is untouched by the new option
  const notepad = decideRouting('메모장을 열고 "hello"를 입력한 다음 a.txt로 저장해줘', { desktopTaskAvailable: true });
  assert.ok(notepad.reasonCodes.includes('DESKTOP_TASK') && !notepad.reasonCodes.includes('DESKTOP_CALCULATE'));
  // a person who said NOT to do it
  assert.notEqual(decideRouting('계산기로 17 곱하기 24 계산하지 마', { desktopCalculatorAvailable: true }).reasonCodes.includes('DESKTOP_CALCULATE'), true);
});
