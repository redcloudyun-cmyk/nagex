// Windows desktop control, the SECOND canonical action (calculate in the Calculator), device side: what the executor on the PC does with a delivered calculation - and what it refuses to do.
//
// HONEST SCOPE: the native controller is replaced here by a scripted FAKE PORT (tests/_fake_calculator_port.ts). This file proves the executor's decisions (identity, version, expiry, replay, that the expected
// result is really the result of the operands, what it verifies, what it reports, how it cleans up) - it does NOT prove that a real application was driven. That is the opt-in run on a real Windows PC
// (desktop_task_real_ui.test.ts). A fake runtime does not satisfy real E2E acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DevicePendingCommand } from '../src/device-agent/device-agent-protocol.js';
import { DESKTOP_PLAN_COMMAND_VERSION, desktopCalculateApprovalPayload, desktopCalculateExpected, parseDesktopCalculatePlan, validateDesktopCalculate } from '../src/device-agent/desktop-plan.types.js';
import { DesktopCommandReplayGuard, DesktopPlanExecutor, desktopCapabilities, parseCalculatorDisplay, type DesktopPlanReport } from '../src/device-agent/desktop-plan-executor.js';
import { FakeCalculator } from './_fake_calculator_port.js';
import { FakeDesktop } from './_fake_desktop_port.js';

const ID = { deviceId: 'dev_pc', tenantId: 'ten', ownerId: 'usr' };

function rig(fake = new FakeCalculator()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-calc-exec-'));
  const reports: DesktopPlanReport[] = [];
  const replayFile = path.join(dir, 'seen.json');
  const make = () => new DesktopPlanExecutor({ controller: fake, identity: ID, replayGuard: new DesktopCommandReplayGuard(replayFile), report: async (_c, report) => { reports.push(report); }, sleep: async () => undefined });
  const command = (patch: Record<string, unknown> = {}, over: Partial<DevicePendingCommand> = {}): DevicePendingCommand => {
    const id = crypto.randomUUID().slice(0, 8);
    const data = {
      commandVersion: DESKTOP_PLAN_COMMAND_VERSION, planId: `plan_${id}`, executionId: `dplan_exec_${id}`, operation: 'CALCULATE', appId: 'CALCULATOR', route: 'WINDOWS_UIA_INTERACTIVE',
      left: 17, op: '*', right: 24, expected: 408, approvalRef: 'apr_1', deviceId: ID.deviceId, principalId: ID.ownerId, tenantId: ID.tenantId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), ...patch,
    };
    return { commandId: `cmd_${id}`, commandType: 'DESKTOP_EXECUTE_PLAN', ...ID, executionSessionId: null, queuedAt: new Date().toISOString(), data, ...over };
  };
  return { fake, reports, executor: make(), make, command };
}

test('the calculation carried out end to end (fake port): the keys are pressed, EVERY entry is read back from the display, the result is read from the display and compared with the approved expectation - then, and only then, COMPLETED', async () => {
  const r = rig();
  const final = await r.executor.handle(r.command());
  assert.equal(final.stage, 'COMPLETED');
  assert.equal(final.resultCode, 'DESKTOP_CALCULATED_VERIFIED');
  assert.equal(final.evidence.observedResult, 408);
  assert.equal(final.evidence.resultMatchesExpected, true);
  assert.equal(final.evidence.leftShownOnDisplay, 17);
  assert.equal(final.evidence.rightShownOnDisplay, 24);
  assert.deepEqual(final.evidence.steps, [
    'ACCEPTED', 'CONTROLLER_STARTED', 'APP_WINDOW_FOUND_BY_HANDLE', 'DISPLAY_IS_ZERO', 'LEFT_OPERAND_ENTERED_AND_READ_BACK', 'OPERATOR_PRESSED', 'RIGHT_OPERAND_ENTERED_AND_READ_BACK',
    'EQUALS_PRESSED', 'RESULT_READ_FROM_DISPLAY_MATCHES_EXPECTED', 'WINDOW_CLOSED',
  ]);
  // the keys NAgex pressed are exactly those of "17 * 24" - the device chose HOW (its own executable, window identity and the display as the anchor); none of it came from the command
  assert.deepEqual(r.fake.pressed, ['clearButton', 'num1Button', 'num7Button', 'multiplyButton', 'num2Button', 'num4Button', 'equalButton']);
  assert.equal(path.basename(r.fake.openAppArgs!.exe).toLowerCase(), 'calc.exe');
  assert.deepEqual(r.fake.openAppArgs!.options, { mode: 'INTERACTIVE', expectClass: 'ApplicationFrameWindow', expectImage: 'ApplicationFrameHost', expectAnchorId: 'CalculatorResults' });
  assert.ok(!r.fake.calls.includes('closeDiscard'));
  assert.deepEqual(r.reports.map((x) => `${x.stage}:${x.resultCode}`), ['EXECUTING:STARTED', 'COMPLETED:DESKTOP_CALCULATED_VERIFIED']);
});

test('addition, subtraction and multiplication each verify against NAgex\'s own computation', async () => {
  for (const [left, op, right] of [[1200, '+', 345], [1000, '-', 1], [999999, '*', 0], [0, '+', 0], [250, '*', 4000]] as const) {
    const r = rig();
    const final = await r.executor.handle(r.command({ left, op, right, expected: desktopCalculateExpected(left, op, right) }));
    assert.equal(final.resultCode, 'DESKTOP_CALCULATED_VERIFIED', `${left} ${op} ${right}`);
    assert.equal(final.evidence.observedResult, desktopCalculateExpected(left, op, right));
  }
});

test('a result that the display does not show as expected is NEVER reported as done: it fails with the facts, and the window the device opened is closed', async () => {
  const r = rig();
  r.fake.wrongResult = 409;
  const final = await r.executor.handle(r.command());
  assert.equal(final.stage, 'FAILED');
  assert.equal(final.resultCode, 'CALC_RESULT_MISMATCH');
  assert.equal(final.evidence.observedResult, 409);
  assert.equal(final.evidence.resultMatchesExpected, false);
  assert.ok(r.fake.calls.includes('closeApp'), 'the window it opened is closed');
});

test('an operand that the display does not show as entered stops the work before the operator is pressed', async () => {
  const r = rig();
  r.fake.misread = { key: 'num7Button', shows: '8' };
  const final = await r.executor.handle(r.command());
  assert.equal(final.resultCode, 'OPERAND_NOT_VERIFIED');
  assert.ok(!r.fake.pressed.includes('multiplyButton') && !r.fake.pressed.includes('equalButton'), 'nothing was pressed after the display disagreed');
  assert.equal(final.evidence.leftShownOnDisplay, 18);
});

test('a display that is not zero after clear stops the work: a fresh calculation is not assumed', async () => {
  const r = rig();
  r.fake.stuckDisplay = '5';
  const final = await r.executor.handle(r.command());
  assert.equal(final.resultCode, 'OPERAND_NOT_VERIFIED');
  assert.deepEqual(r.fake.pressed, ['clearButton']);
});

test('a key the window does not have is reported as that - never guessed around', async () => {
  for (const missing of ['num4Button', 'multiplyButton', 'equalButton', 'clearButton']) {
    const r = rig();
    r.fake.missingKey = missing;
    const final = await r.executor.handle(r.command());
    assert.equal(final.resultCode, 'CALC_CONTROL_NOT_FOUND', missing);
    assert.equal(final.stage, 'FAILED');
  }
});

test('the window is not adopted when it is ambiguous or not found: nothing is pressed', async () => {
  const ambiguous = rig();
  ambiguous.fake.open = { status: 'TARGET_AMBIGUOUS', errorCode: 'MULTIPLE_NEW_WINDOWS', matchCount: 2 };
  assert.equal((await ambiguous.executor.handle(ambiguous.command())).resultCode, 'UNEXPECTED_WINDOW');
  assert.deepEqual(ambiguous.fake.pressed, []);
  const missing = rig();
  missing.fake.open = { status: 'FAILED', errorCode: 'APP_WINDOW_NOT_FOUND_WITHIN_TIMEOUT' };
  assert.equal((await missing.executor.handle(missing.command())).resultCode, 'APP_WINDOW_NOT_FOUND');
  assert.deepEqual(missing.fake.pressed, []);
});

test('a command for another device, user or tenant, an expired plan, an unknown version and a replay are refused before anything is touched', async () => {
  for (const over of [{ deviceId: 'dev_other' }, { tenantId: 'ten_other' }, { ownerId: 'usr_other' }]) {
    const r = rig();
    assert.equal((await r.executor.handle(r.command({}, over))).resultCode, 'IDENTITY_MISMATCH', JSON.stringify(over));
    assert.deepEqual(r.fake.calls, []);
  }
  const r = rig();
  assert.equal((await r.executor.handle(r.command({ principalId: 'usr_other' }))).resultCode, 'IDENTITY_MISMATCH');
  assert.equal((await r.executor.handle(r.command({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).resultCode, 'COMMAND_EXPIRED');
  assert.equal((await r.executor.handle(r.command({ commandVersion: 2 }))).resultCode, 'COMMAND_VERSION_UNSUPPORTED');
  assert.deepEqual(r.fake.calls, [], 'none of these touched the controller');
  const first = r.command();
  assert.equal((await r.executor.handle(first)).resultCode, 'DESKTOP_CALCULATED_VERIFIED');
  assert.equal((await r.executor.handle(first)).resultCode, 'COMMAND_REPLAY', 'the same command is never run twice');
  // ... also after a restart of the device (the record is on disk)
  const restarted = r.make();
  assert.equal((await restarted.handle(first)).resultCode, 'COMMAND_REPLAY');
});

test('a command whose expected result is NOT the result of its operands is refused: the device does not trust a number it was told to look for', async () => {
  const r = rig();
  assert.equal((await r.executor.handle(r.command({ expected: 409 }))).resultCode, 'COMMAND_EXPECTED_MISMATCH');
  assert.deepEqual(r.fake.calls, []);
  // ... nor does it run an operator, an operand or a negative result it does not allow
  assert.equal((await r.executor.handle(r.command({ op: '/', expected: 0 }))).resultCode, 'DESKTOP_CALC_OPERATOR_INVALID');
  assert.equal((await r.executor.handle(r.command({ left: 1_000_000, expected: 24_000_000 }))).resultCode, 'DESKTOP_CALC_OPERAND_INVALID');
  assert.equal((await r.executor.handle(r.command({ left: 3, op: '-', right: 5, expected: -2 }))).resultCode, 'DESKTOP_CALC_NEGATIVE_RESULT');
  assert.equal((await r.executor.handle(r.command({ left: 1.5, expected: 36 }))).resultCode, 'DESKTOP_CALC_OPERAND_INVALID');
  assert.deepEqual(r.fake.calls, []);
});

test('a second command while one is running is refused (one at a time), and the device without the native controller does nothing', async () => {
  const r = rig();
  const slow = r.executor.handle(r.command());
  assert.equal((await r.executor.handle(r.command())).resultCode, 'AGENT_BUSY');
  assert.equal((await slow).resultCode, 'DESKTOP_CALCULATED_VERIFIED');
  const none = rig();
  none.fake.available = false;
  assert.equal((await none.executor.handle(none.command())).resultCode, 'CONTROLLER_UNAVAILABLE');
  assert.deepEqual(none.fake.calls, []);
});

test('what the device reports carries the numbers of the calculation and nothing else: no path, no user name, no window title', async () => {
  const r = rig();
  const final = await r.executor.handle(r.command());
  const reported = JSON.stringify(r.reports);
  assert.ok(!reported.includes(os.homedir()) && !reported.includes(os.userInfo().username), 'no path, no user name');
  assert.ok(!/\\|[A-Za-z]:\//.test(reported), 'no file path');
  assert.deepEqual(Object.keys(final.evidence).sort(), ['appId', 'expected', 'left', 'leftShownOnDisplay', 'mode', 'observedResult', 'op', 'operation', 'resultMatchesExpected', 'right', 'rightShownOnDisplay', 'steps', 'windowClosed']);
});

test('the capability list: both applications when the native controller is present, none when it is not (no claim without an executor)', () => {
  assert.deepEqual(desktopCapabilities(new FakeDesktop()), ['desktop:UIA_INTERACTIVE:NOTEPAD', 'desktop:UIA_INTERACTIVE:CALCULATOR']);
  const absent = new FakeCalculator();
  absent.available = false;
  assert.deepEqual(desktopCapabilities(absent), []);
});

test('the contract: validation, the approval payload (bound to the expected result), and the structural check a device makes of a delivered plan', () => {
  assert.deepEqual(validateDesktopCalculate({ deviceId: 'd', appId: 'CALCULATOR', left: 17, op: '*', right: 24 }), { ok: true });
  assert.equal((validateDesktopCalculate({ deviceId: '', appId: 'CALCULATOR', left: 1, op: '+', right: 1 }) as { code: string }).code, 'DESKTOP_PLAN_DEVICE_REQUIRED');
  assert.equal((validateDesktopCalculate({ deviceId: 'd', appId: 'NOTEPAD' as never, left: 1, op: '+', right: 1 }) as { code: string }).code, 'DESKTOP_APP_NOT_ALLOWED');
  assert.equal((validateDesktopCalculate({ deviceId: 'd', appId: 'CALCULATOR', left: -1, op: '+', right: 1 }) as { code: string }).code, 'DESKTOP_CALC_OPERAND_INVALID');
  assert.equal((validateDesktopCalculate({ deviceId: 'd', appId: 'CALCULATOR', left: 5, op: '/' as never, right: 1 }) as { code: string }).code, 'DESKTOP_CALC_OPERATOR_INVALID');
  const payload = desktopCalculateApprovalPayload({ deviceId: 'd', appId: 'CALCULATOR', left: 17, op: '*', right: 24 });
  assert.equal(payload.expected, 408);
  assert.equal(payload.operation, 'CALCULATE');
  assert.equal(Object.keys(payload).some((key) => /path|shell|script|command|keystroke|coordinate/i.test(key)), false, 'no field can carry HOW');
  assert.equal(parseDesktopCalculatePlan({ ...rig().command().data }).ok, true);
  assert.deepEqual(parseDesktopCalculatePlan({ ...rig().command().data, operation: 'WRITE_TEXT_AND_SAVE' }), { ok: false, code: 'COMMAND_SHAPE_INVALID' });
});

test('reading the display: the number in the accessible text, in any display language, with or without a thousands separator', () => {
  assert.equal(parseCalculatorDisplay('Display is 408'), 408);
  assert.equal(parseCalculatorDisplay('표시는 1,234'), 1234);
  assert.equal(parseCalculatorDisplay('Display is 0'), 0);
  assert.equal(parseCalculatorDisplay('표시는 999,999,000'), 999999000);
  assert.equal(parseCalculatorDisplay('no digits here'), null);
  assert.equal(parseCalculatorDisplay(''), null);
});
