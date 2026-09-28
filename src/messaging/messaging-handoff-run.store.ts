import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { isMessagingHandoffRun, type MessagingHandoffRun } from './messaging-handoff.types.js';
import type { MessagingRouteCapabilities } from './send-message-action.types.js';

export class MessagingHandoffRunStore {
  private readonly records: FileRecordStore<MessagingHandoffRun>;
  private readonly now: () => string;
  constructor(options: { dir?: string; env?: NodeJS.ProcessEnv; now?: () => string } = {}) {
    this.records = new FileRecordStore(options.dir ?? resolveNagexDataDir('messaging-handoff-runs', 'NAGEX_MESSAGING_HANDOFF_RUNS_DIR', options.env ?? process.env), isMessagingHandoffRun);
    this.now = options.now ?? getCurrentISOString;
  }
  create(input: { tenantId: string; ownerId: string; deviceId: string; requestId: string; intendedRecipientRef: string; message: string; routeCapabilities: MessagingRouteCapabilities }): MessagingHandoffRun {
    const timestamp = this.now();
    const run: MessagingHandoffRun = { runId: generateResourceId('mhr'), ...input, channel: 'KAKAOTALK', executionRoute: 'KAKAOTALK_SHARE', status: 'READY', failureReason: null, approvalId: null, executionId: null, createdAt: timestamp, updatedAt: timestamp };
    this.records.write(run.runId, run); return run;
  }
  getOwned(runId: string, tenantId: string, ownerId: string): MessagingHandoffRun | undefined { const r = this.records.read(runId); return r && r.tenantId === tenantId && r.ownerId === ownerId ? r : undefined; }
  save(run: MessagingHandoffRun): MessagingHandoffRun { const updated = { ...run, updatedAt: this.now() }; this.records.write(run.runId, updated); return updated; }
}
