// Puts the desktop plan executor behind the Local Device Agent runtime: the device's own identity (from its enrolled credential), the native controller, the replay record, and the report path.
// Kept separate from the Electron shell so the very same wiring runs in the desktop app and in a plain Node process (tests, diagnostics).
import path from 'node:path';
import type { DevicePendingCommand } from './device-agent-protocol.js';
import { DesktopCommandReplayGuard, DesktopPlanExecutor, desktopCapabilities, type DesktopAutomationPort, type RootResolver } from './desktop-plan-executor.js';
import type { LocalDeviceCredentialStore } from './local-device-credential.store.js';
import { WindowsIsolatedDesktopController } from './windows-isolated-desktop-controller.js';

export interface DesktopPlanWiringOptions {
  credentialStore: LocalDeviceCredentialStore;
  /** a folder this device owns (e.g. ~/.nagex/desktop): the record of commands already taken on is kept here */
  dataDir: string;
  controller?: DesktopAutomationPort;
  resolveRoot?: RootResolver;
  /** folders a document may never be saved in; the default (application-data and temp folders of this user) is right for a real device and is overridden only by tests */
  volatileRoots?: string[];
  /** delivers a report to the server; resolves false when it could not */
  report: (commandId: string, executionId: string | null, stage: 'EXECUTING' | 'COMPLETED' | 'FAILED', resultCode: string, evidence: Record<string, unknown>) => Promise<boolean>;
  log?: (event: Record<string, unknown>) => void;
}

export interface DesktopPlanWiring {
  /** null while the device is not enrolled: there is nobody to act for */
  executor: DesktopPlanExecutor | null;
  /** what this device honestly reports it can do (empty when the native controller is not present) */
  capabilityInventory: string[];
  onPendingCommand: ((command: DevicePendingCommand) => void) | undefined;
}

export function createDesktopPlanWiring(options: DesktopPlanWiringOptions): DesktopPlanWiring {
  const controller = options.controller ?? new WindowsIsolatedDesktopController();
  const capabilityInventory = desktopCapabilities(controller);
  const credential = options.credentialStore.load();
  if (!credential) return { executor: null, capabilityInventory, onPendingCommand: undefined };

  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const executor = new DesktopPlanExecutor({
    controller,
    identity: { deviceId: credential.deviceId, tenantId: credential.tenantId, ownerId: credential.ownerId },
    replayGuard: new DesktopCommandReplayGuard(path.join(options.dataDir, 'desktop-plan-seen.json')),
    ...(options.resolveRoot ? { resolveRoot: options.resolveRoot } : {}),
    ...(options.volatileRoots ? { volatileRoots: options.volatileRoots } : {}),
    report: async (command, report) => {
      const executionId = typeof command.data.executionId === 'string' ? command.data.executionId : null;
      const delivered = await options.report(command.commandId, executionId, report.stage, report.resultCode, report.evidence);
      if (!delivered) log({ event: 'desktop_plan_report_undelivered', stage: report.stage, resultCode: report.resultCode });
    },
  });
  return {
    executor,
    capabilityInventory,
    onPendingCommand: (command) => {
      // only desktop plans are this executor's business; anything else delivered to a desktop is left alone
      if (command.commandType !== 'DESKTOP_EXECUTE_PLAN') return;
      void executor.handle(command);
    },
  };
}
