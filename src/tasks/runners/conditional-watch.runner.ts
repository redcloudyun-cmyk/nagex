import type { AiService } from '../../model-gateway/ai-service.js';
import { NagexError } from '../../common/errors.js';
import { getCurrentISOString } from '../../common/utils.js';
import type { CapabilityExecutorPort } from '../../contracts/capability.port.js';
import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';

// Conditional Watch (MASTER.md Section 14.5 item 07): on each heartbeat
// (task.store.ts's listDue + task.scheduler.ts's computeNextRunAt drive the
// cadence via trigger.checkIntervalMinutes), opens a fresh, read-only
// Browser Agent session, navigates to trigger.watchUrl, and asks the model
// whether trigger.condition is now true given the real page content —
// never a fabricated judgment, and never anything beyond a plain read.
// All browser operations are routed through the CapabilityBroker for governance.
export class ConditionalWatchTaskRunner implements TaskRunner {
  constructor(
    private readonly capabilityBroker: CapabilityExecutorPort,
    private readonly aiService: AiService,
  ) {}

  public async run(task: TaskRecord, requestId: string): Promise<TaskRunOutcome> {
    const trigger = task.trigger;
    if (trigger.type !== 'CONDITION' || !trigger.condition?.trim() || !trigger.watchUrl?.trim()) {
      return { status: 'FAILED', errorCode: 'CONDITION_WATCH_MISCONFIGURED', conditionMet: false };
    }

    let browserSessionId: string | null = null;
    const runReqId = `${requestId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      const openRes = await this.capabilityBroker.execute({
        capabilityId: 'browser.open',
        tenantId: task.tenantId,
        principalId: task.ownerId,
        requestId: `${runReqId}_open`,
        payload: {},
        source: 'TASK',
      });
      if (openRes.status !== 'EXECUTED' || !openRes.result) {
        throw new NagexError({ code: 'BROWSER_OPEN_FAILED', category: 'RUNTIME', message: 'Failed to open browser session via CapabilityBroker', request_id: requestId });
      }
      browserSessionId = (openRes.result as { browserSessionId: string }).browserSessionId;

      const navRes = await this.capabilityBroker.execute({
        capabilityId: 'browser.navigate',
        tenantId: task.tenantId,
        principalId: task.ownerId,
        requestId: `${runReqId}_nav`,
        payload: { browserSessionId, url: trigger.watchUrl },
        source: 'TASK',
      });
      if (navRes.status !== 'EXECUTED') {
        throw new NagexError({ code: 'BROWSER_NAVIGATE_FAILED', category: 'RUNTIME', message: 'Failed to navigate browser via CapabilityBroker', request_id: requestId });
      }

      const snapRes = await this.capabilityBroker.execute({
        capabilityId: 'browser.snapshot',
        tenantId: task.tenantId,
        principalId: task.ownerId,
        requestId: `${runReqId}_snap`,
        payload: { browserSessionId },
        source: 'TASK',
      });
      if (snapRes.status !== 'EXECUTED' || !snapRes.result) {
        throw new NagexError({ code: 'BROWSER_SNAPSHOT_FAILED', category: 'RUNTIME', message: 'Failed to snapshot page via CapabilityBroker', request_id: requestId });
      }

      const snapshot = snapRes.result as { url: string; title: string; text: string };
      const judgment = await this.judge(trigger.condition, snapshot, requestId);
      return {
        status: 'SUCCEEDED',
        conditionMet: judgment.met,
        result: { kind: 'CONDITION_CHECK', met: judgment.met, reason: judgment.reason, url: snapshot.url, checkedAt: getCurrentISOString() },
      };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'CONDITION_CHECK_FAILED';
      return { status: 'FAILED', errorCode: code, conditionMet: false };
    } finally {
      if (browserSessionId) {
        await this.capabilityBroker.execute({
          capabilityId: 'browser.close',
          tenantId: task.tenantId,
          principalId: task.ownerId,
          requestId: `${runReqId}_close`,
          payload: { browserSessionId },
          source: 'TASK',
        }).catch(() => {});
      }
    }
  }

  private async judge(condition: string, snapshot: { url: string; title: string; text: string }, requestId: string): Promise<{ met: boolean; reason: string }> {
    const prompt = [
      'You are checking whether a watched condition has become true, based only on the real webpage content shown below — never assume or invent anything not present in it.',
      '',
      `Condition to check: "${condition}"`,
      '',
      `Page URL: ${snapshot.url}`,
      `Page title: ${snapshot.title}`,
      'Page content:',
      '"""',
      snapshot.text,
      '"""',
      '',
      'Respond with EXACTLY two lines, nothing else:',
      'MET: true',
      'or',
      'MET: false',
      'REASON: <one sentence, grounded only in the page content above>',
    ].join('\n');

    const response = await this.aiService.chat({ message: prompt, mode: 'auto', requestId });
    const text = response.data.message || '';
    const metMatch = /MET:\s*(true|false)/i.exec(text);
    const reasonMatch = /REASON:\s*(.+)/i.exec(text);
    // Fail-safe: any ambiguity in the model's response defaults to NOT met
    // — AC-11 requires never notifying while unmet, so an unparseable
    // judgment must never be treated as "met".
    const met = metMatch ? metMatch[1].toLowerCase() === 'true' : false;
    const reason = reasonMatch ? reasonMatch[1].trim() : 'Could not confidently determine condition status from the page content.';
    return { met, reason };
  }
}
