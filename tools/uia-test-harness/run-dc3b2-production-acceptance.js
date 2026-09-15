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

  // DC3-B2-R4 — real first-class CANCEL through the actual capability
  // surface: request one more mutation, then CANCEL it through
  // capabilityBroker.execute with action='CANCEL' — no approval, per the
  // real production design (cancel is a user safety/control action, not
  // a mutation). Cancel itself performs the full graceful teardown
  // (close app + shut down the isolated desktop), so no separate
  // CLOSE_APP call follows it.
  const nextMutationProposed = await capabilityBroker.execute({
    capabilityId: 'device.desktop.execute',
    tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
    payload: { appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'NagexTestCheckbox', executionSessionId, deviceId },
  });
  log('NEXT_MUTATION_PROPOSE_STATUS', nextMutationProposed.status);
  const nextMutationApprovalId = nextMutationProposed.approval?.approvalId;

  const cancelResult = await capabilityBroker.execute({
    capabilityId: 'device.desktop.execute',
    tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
    payload: { appId: 'NAGEX_TEST_HARNESS', action: 'CANCEL', executionSessionId, deviceId },
  });
  log('CANCEL_STATUS', cancelResult.status);
  log('CANCEL_OUTCOME_KIND', cancelResult.result?.kind);
  log('WINDOWS_DC3B2_CANCEL_CAPABILITY', cancelResult.status === 'EXECUTED' && cancelResult.result?.kind === 'TERMINATED' && cancelResult.result?.status === 'CANCELLED' ? 'PASS' : 'FAIL');

  // Prove the cancel actually prevents the previously-proposed mutation
  // from ever resuming, even though its approval was never touched by
  // cancel processing.
  if (nextMutationApprovalId) {
    actionApprovals.approve(nextMutationApprovalId, tenantId, ownerId);
    const blockedResume = await capabilityBroker.execute({
      capabilityId: 'device.desktop.execute',
      tenantId, principalId: ownerId, requestId: 'req_' + Math.random().toString(36).slice(2),
      approvalId: nextMutationApprovalId,
      payload: { appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'NagexTestCheckbox', executionSessionId, deviceId },
    });
    log('BLOCKED_RESUME_OUTCOME_KIND', blockedResume.result?.kind);
    log('WINDOWS_DC3B2_CANCEL_PREVENTS_NEXT_MUTATION', blockedResume.result?.kind === 'TERMINATED' && blockedResume.result?.status !== 'COMPLETED' ? 'PASS' : 'FAIL');
  } else {
    log('WINDOWS_DC3B2_CANCEL_PREVENTS_NEXT_MUTATION', 'FAIL (no approval was proposed to test against)');
  }

  const activityItems = activityStore.list(tenantId, ownerId, 50).filter((a) => a.type === 'desktop_execution');
  log('WINDOWS_DC3B2_ACTIVITY', activityItems.length > 0 ? 'PASS' : 'FAIL');
  log('ACTIVITY_ITEM_COUNT', activityItems.length);
  log('ACTIVITY_LAST_STATUS', activityItems[0]?.status);
  log('WINDOWS_DC3B2_CANCEL_ACTIVITY', activityItems[0]?.status === 'FAILED' ? 'PASS' : 'FAIL'); // CANCELLED maps onto the real ActivityStatus enum's FAILED value

  await new Promise((r) => setTimeout(r, 1000));
  const fgAfter = getForegroundWindow();
  log('FOREGROUND_AFTER', fgAfter);

  const closeUserAppResult = closeWindowByPid(userProc.pid);
  log('USER_APP_CLOSE_RESULT', closeUserAppResult);
  await new Promise((r) => setTimeout(r, 1000));

  const residual = countResidualProcesses();
  log('WINDOWS_DC3B2_CLEANUP', residual === '0' ? 'PASS' : `FAIL (residual=${residual})`);
  log('WINDOWS_DC3B2_CANCEL_CLEANUP', residual === '0' ? 'PASS' : `FAIL (residual=${residual})`);
  log('WINDOWS_DC3B2_CANCEL_NO_RESIDUAL_PROCESS', residual === '0' ? 'PASS' : `FAIL (residual=${residual})`);

  console.log('=== ACCEPTANCE COMPLETE ===');
}

main()
  .catch((err) => { console.error('ACCEPTANCE_FAILED:', err); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode || 0));
