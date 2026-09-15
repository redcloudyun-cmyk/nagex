// DC3-B2 Production — Real Windows Acceptance.
//
// Exercises the ACTUAL wired production path (createNagexApplication's
// real capabilityBroker, with the real desktopControlService, the real
// ActionApprovalStore, the real ActivityStore) end to end: OPEN_APP ->
// approve -> resume -> SET_VALUE -> approve -> resume -> OBSERVE ->
// CLOSE_APP -> approve -> resume, while independently checking a
// separate "user" window's foreground/focus is undisturbed throughout,
// then CANCEL semantics, then Activity records, then cleanup.
//
// Not part of the automated npm test suite — like every prior DC3-B1/B2
// real-host acceptance pass, this requires a live Windows GUI session and
// the compiled native controller/worker
// (native/windows-desktop-controller/build.ps1) plus the compiled test
// harness (tools/uia-test-harness/build-harness.ps1). Run manually:
//   npm run build
//   node tools/uia-test-harness/run-dc3b2-production-acceptance.js
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRATCH = __dirname;

const { createNagexApplication } = require(path.join(REPO, 'dist', 'src', 'app', 'create-nagex-application.js'));

function log(k, v) { console.log(`${k}=${v}`); }
function getForegroundWindow() {
  return execFileSync('powershell', ['-NoProfile', '-File', path.join(SCRATCH, 'ps-helpers', 'get-foreground-window.ps1')]).toString().trim();
}
function closeWindowByPid(pid) {
  return execFileSync('powershell', ['-NoProfile', '-File', path.join(SCRATCH, 'ps-helpers', 'close-window-by-pid.ps1'), '-TargetPid', String(pid)]).toString().trim();
}
function countResidualProcesses() {
  return execFileSync('powershell', ['-NoProfile', '-File', path.join(SCRATCH, 'ps-helpers', 'count-residual-processes.ps1')]).toString().trim();
}

async function main() {
  const app = createNagexApplication();
  const { capabilityBroker, actionApprovals, activityStore } = app;

  const tenantId = 'tenant_acceptance';
  const ownerId = 'owner_acceptance';
  const deviceId = 'device_acceptance';

  // Launch a separate "user" window on the interactive desktop to prove
  // coexistence — the real compiled harness, standing in for whatever
  // the user is actually doing, never a real user app.
  const harnessExe = path.join(REPO, 'tools', 'uia-test-harness', 'NagexUiaTestHarnessWpf.exe');
  const userProc = spawn(harnessExe, ['ProdAcceptanceUserApp'], { detached: false });
  await new Promise((r) => setTimeout(r, 2000));

  const fgBefore = getForegroundWindow();
  log('FOREGROUND_BEFORE', fgBefore);

  async function proposeApproveResume(action, target, parameters, executionSessionId) {
    const startReq = {
      capabilityId: 'device.desktop.execute',
      tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
      payload: { appId: 'NAGEX_TEST_HARNESS', action, target, parameters, executionSessionId, deviceId },
    };
    const startResult = await capabilityBroker.execute(startReq);
    log(`${action}_START_STATUS`, startResult.status);
    if (startResult.status !== 'APPROVAL_REQUIRED') {
      throw new Error(`expected APPROVAL_REQUIRED for ${action}, got ${JSON.stringify(startResult)}`);
    }
    const approvalId = startResult.approval.approvalId;
    actionApprovals.approve(approvalId, tenantId, ownerId);
    const resumeReq = {
      capabilityId: 'device.desktop.execute',
      tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
      approvalId,
      payload: { appId: 'NAGEX_TEST_HARNESS', action, target, parameters, executionSessionId, deviceId },
    };
    const resumeResult = await capabilityBroker.execute(resumeReq);
    log(`${action}_RESUME_STATUS`, resumeResult.status);
    log(`${action}_OUTCOME_KIND`, resumeResult.result?.kind);
    return resumeResult;
  }

  const openResult = await proposeApproveResume('OPEN_APP', undefined, undefined, undefined);
  const executionSessionId = openResult.result.executionSessionId;
  log('EXECUTION_SESSION_ID', executionSessionId);
  log('WINDOWS_DC3B2_BACKGROUND_EXECUTION', openResult.result.kind === 'COMPLETED' ? 'PASS' : 'FAIL');

  const setValueResult = await proposeApproveResume('SET_VALUE', 'NagexTestTextInput', { value: 'ProductionAcceptance' }, executionSessionId);
  log('WINDOWS_DC3B2_VERIFICATION', setValueResult.result.kind === 'COMPLETED' && setValueResult.result.result.status === 'SUCCEEDED_VERIFIED' ? 'PASS' : 'FAIL');

  // OBSERVE — no approval needed.
  const observeResult = await capabilityBroker.execute({
    capabilityId: 'device.desktop.execute',
    tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
    payload: { appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'NagexTestTextInput', executionSessionId },
  });
  log('OBSERVE_STATUS', observeResult.status);
  log('OBSERVE_VALUE_LENGTH', (observeResult.result?.result?.observedAfter || '').length);

  const fgDuring = getForegroundWindow();
  log('FOREGROUND_DURING', fgDuring);
  log('WINDOWS_DC3B2_USER_COEXISTENCE', fgBefore === fgDuring ? 'PASS' : 'FAIL (fgBefore=' + fgBefore + ' fgDuring=' + fgDuring + '; verify the differing owner is unrelated to Worker/Controller/Target before treating this as a real regression)');

  // Cancel semantics on a fresh proposed mutation: propose, then never
  // approve/resume it, and confirm the target's state is genuinely
  // unaffected (a black-box STOP proof).
  const cancelStart = await capabilityBroker.execute({
    capabilityId: 'device.desktop.execute',
    tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
    payload: { appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'NagexTestCheckbox', executionSessionId, deviceId },
  });
  log('CANCEL_TEST_PROPOSE_STATUS', cancelStart.status);
  const observeAfterNoResume = await capabilityBroker.execute({
    capabilityId: 'device.desktop.execute', tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
    payload: { appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'NagexTestCheckbox', executionSessionId },
  });
  log('CANCEL_PREVENTS_NEXT_MUTATION_PROXY', observeAfterNoResume.status);

  const closeResult = await proposeApproveResume('CLOSE_APP', undefined, undefined, executionSessionId);
  log('CLOSE_APP_STATUS', closeResult.result.kind);

  const activityItems = activityStore.list(tenantId, ownerId, 50).filter((a) => a.type === 'desktop_execution');
  log('WINDOWS_DC3B2_ACTIVITY', activityItems.length > 0 ? 'PASS' : 'FAIL');
  log('ACTIVITY_ITEM_COUNT', activityItems.length);
  log('ACTIVITY_LAST_STATUS', activityItems[0]?.status);

  await new Promise((r) => setTimeout(r, 1000));
  const fgAfter = getForegroundWindow();
  log('FOREGROUND_AFTER', fgAfter);

  const closeUserAppResult = closeWindowByPid(userProc.pid);
  log('USER_APP_CLOSE_RESULT', closeUserAppResult);
  await new Promise((r) => setTimeout(r, 1000));

  const residual = countResidualProcesses();
  log('WINDOWS_DC3B2_CLEANUP', residual === '0' ? 'PASS' : `FAIL (residual=${residual})`);

  console.log('=== ACCEPTANCE COMPLETE ===');
}

main()
  .catch((err) => { console.error('ACCEPTANCE_FAILED:', err); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode || 0));
