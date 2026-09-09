import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { getCurrentISOString } from '../common/utils.js';
import { AuditLogger } from '../governance/audit.logger.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { CapabilityRegistry, capabilityRegistry } from './capability.registry.js';
import { CapabilityPolicy } from './capability-policy.js';
import {
  CapabilityRequest,
  CapabilityBrokerResult,
  CapabilityDefinition,
} from './capability.types.js';
import { GoogleCalendarService } from '../tools/google-calendar.service.js';
import { GmailService } from '../tools/gmail.service.js';
import { BrowserToolService } from '../tools/browser.service.js';

export interface CapabilityIdempotencyRecord {
  key: string;
  capabilityId: string;
  payloadHash: string;
  result: CapabilityBrokerResult;
  createdAt: string;
}

export function isCapabilityIdempotencyRecord(value: unknown): value is CapabilityIdempotencyRecord {
  const r = value as Partial<CapabilityIdempotencyRecord> | null;
  return Boolean(
    r &&
      typeof r.key === 'string' &&
      typeof r.capabilityId === 'string' &&
      typeof r.payloadHash === 'string' &&
      typeof r.createdAt === 'string' &&
      r.result &&
      typeof (r.result as any).status === 'string'
  );
}

const NATIVE_APPROVAL_CAPABILITIES = new Set([
  'google_calendar.create_event',
  'google_calendar.update_event',
  'google_calendar.cancel_event',
  'google_calendar.respond_to_event',
  'gmail.send_email',
  'gmail.reply',
  'gmail.create_draft',
  'browser.click',
]);

export class CapabilityBroker {
  private readonly idempotencyStore: FileRecordStore<CapabilityIdempotencyRecord>;

  constructor(
    private readonly calendarService: GoogleCalendarService,
    private readonly gmailService: GmailService,
    private readonly browserService: BrowserToolService,
    private readonly auditLogger: AuditLogger,
    private readonly registry: CapabilityRegistry = capabilityRegistry,
    idempotencyDirName: string = 'capabilities_idempotency',
    idempotencyEnvVar: string = 'NAGEX_CAPABILITIES_IDEMPOTENCY_DIR'
  ) {
    const dataDir = resolveNagexDataDir(idempotencyDirName, idempotencyEnvVar);
    this.idempotencyStore = new FileRecordStore<CapabilityIdempotencyRecord>(
      dataDir,
      isCapabilityIdempotencyRecord
    );
  }

  public async execute(request: CapabilityRequest): Promise<CapabilityBrokerResult> {
    const def = this.registry.get(request.capabilityId);

    // 1. Audit capability requested (metadata only)
    this.auditLogger.logEvent({
      actor: { type: 'user', id: request.principalId || 'unknown' },
      tenant_id: request.tenantId || 'unknown',
      action: 'capability.requested',
      resource: { type: 'Capability', id: request.capabilityId },
      result: 'SUCCESS',
      request_id: request.requestId,
      details: {
        capabilityId: request.capabilityId,
        provider: def?.provider,
        risk: def?.risk,
        source: request.source,
        requestId: request.requestId,
      },
    });

    // 2. Idempotency Check
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(request.payload ?? {}))
      .digest('hex');

    let idempotencyKey: string | null = null;
    if (request.idempotencyKey || request.requestId) {
      idempotencyKey = request.idempotencyKey
        ? `${request.tenantId}:${request.principalId}:${request.idempotencyKey}`
        : `${request.tenantId}:${request.principalId}:${request.requestId}:${request.capabilityId}`;

      const existing = this.idempotencyStore.read(idempotencyKey);
      if (existing) {
        if (existing.payloadHash === payloadHash) {
          return existing.result;
        }
        throw new NagexError({
          code: 'CAPABILITY_IDEMPOTENCY_CONFLICT',
          category: 'CONFLICT',
          message: 'Payload mismatch for reused idempotency key.',
          request_id: request.requestId,
        });
      }
    }

    // 3. Evaluate Policy
    const providerAvailable = this.isProviderAvailable(def?.provider);
    const policyResult = CapabilityPolicy.evaluate(request, def, providerAvailable);

    if (!policyResult.allowed) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: request.principalId || 'unknown' },
        tenant_id: request.tenantId || 'unknown',
        action: 'capability.blocked',
        resource: { type: 'Capability', id: request.capabilityId },
        result: 'DENIED',
        reason_code: policyResult.reasonCode,
        request_id: request.requestId,
        details: {
          capabilityId: request.capabilityId,
          provider: def?.provider,
          risk: def?.risk,
          source: request.source,
          requestId: request.requestId,
        },
      });

      const blockedResult: CapabilityBrokerResult = {
        status: 'BLOCKED',
        capabilityId: request.capabilityId,
        reasonCode: policyResult.reasonCode || 'CAPABILITY_POLICY_FAILED',
      };

      if (idempotencyKey) {
        this.saveIdempotency(idempotencyKey, request.capabilityId, payloadHash, blockedResult);
      }

      return blockedResult;
    }

    // Policy Allowed
    this.auditLogger.logEvent({
      actor: { type: 'user', id: request.principalId },
      tenant_id: request.tenantId,
      action: 'capability.allowed',
      resource: { type: 'Capability', id: request.capabilityId },
      result: 'SUCCESS',
      request_id: request.requestId,
      details: {
        capabilityId: request.capabilityId,
        provider: def!.provider,
        risk: def!.risk,
        source: request.source,
        requestId: request.requestId,
      },
    });

    this.auditLogger.logEvent({
      actor: { type: 'user', id: request.principalId },
      tenant_id: request.tenantId,
      action: 'capability.dispatched',
      resource: { type: 'Capability', id: request.capabilityId },
      result: 'SUCCESS',
      request_id: request.requestId,
      details: {
        capabilityId: request.capabilityId,
        provider: def!.provider,
        risk: def!.risk,
        source: request.source,
        requestId: request.requestId,
      },
    });

    // 4. Dispatch Execution or Approval
    let result: CapabilityBrokerResult;
    try {
      result = await this.dispatch(request, def!, policyResult.effectiveApproval);
    } catch (err) {
      if (err instanceof NagexError) {
        throw err;
      }
      throw new NagexError({
        code: 'CAPABILITY_POLICY_FAILED',
        category: 'INTERNAL',
        message: err instanceof Error ? err.message : 'Capability dispatch failed.',
        request_id: request.requestId,
      });
    }

    // 5. Store Idempotency Result
    if (idempotencyKey) {
      this.saveIdempotency(idempotencyKey, request.capabilityId, payloadHash, result);
    }

    return result;
  }

  private isProviderAvailable(provider?: string): boolean {
    if (!provider) return false;
    if (provider === 'GOOGLE_CALENDAR') return Boolean(this.calendarService);
    if (provider === 'GMAIL') return Boolean(this.gmailService);
    if (provider === 'BROWSER') return Boolean(this.browserService);
    return false;
  }

  private saveIdempotency(
    key: string,
    capabilityId: string,
    payloadHash: string,
    result: CapabilityBrokerResult
  ): void {
    this.idempotencyStore.write(key, {
      key,
      capabilityId,
      payloadHash,
      result,
      createdAt: getCurrentISOString(),
    });
  }

  private async dispatch(
    request: CapabilityRequest,
    def: CapabilityDefinition,
    effectiveApproval: 'NONE' | 'CONDITIONAL' | 'REQUIRED'
  ): Promise<CapabilityBrokerResult> {
    const payload = (request.payload ?? {}) as Record<string, any>;

    // Fix B — Enforce effectiveApproval:
    // If safety policy requires action approval (effectiveApproval === 'REQUIRED')
    // but the requested capability has no native approval continuation, BLOCK with CAPABILITY_SAFETY_APPROVAL_REQUIRED.
    if (effectiveApproval === 'REQUIRED' && !NATIVE_APPROVAL_CAPABILITIES.has(request.capabilityId)) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: request.principalId },
        tenant_id: request.tenantId,
        action: 'capability.blocked',
        resource: { type: 'Capability', id: request.capabilityId },
        result: 'DENIED',
        reason_code: 'CAPABILITY_SAFETY_APPROVAL_REQUIRED',
        request_id: request.requestId,
        details: {
          capabilityId: request.capabilityId,
          provider: def.provider,
          risk: def.risk,
          source: request.source,
          requestId: request.requestId,
        },
      });
      return {
        status: 'BLOCKED',
        capabilityId: request.capabilityId,
        reasonCode: 'CAPABILITY_SAFETY_APPROVAL_REQUIRED',
      };
    }

    // Handle Google Calendar Capabilities
    if (def.provider === 'GOOGLE_CALENDAR') {
      if (request.capabilityId === 'google_calendar.create_event') {
        const approval = this.calendarService.requestCreateEventApproval({
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }

      if (request.capabilityId === 'google_calendar.update_event') {
        const approval = this.calendarService.requestUpdateEventApproval({
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }

      if (request.capabilityId === 'google_calendar.cancel_event') {
        const approval = this.calendarService.requestCancelEventApproval({
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }

      if (request.capabilityId === 'google_calendar.respond_to_event') {
        const approval = this.calendarService.requestRespondToEventApproval({
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }

      if (request.capabilityId === 'google_calendar.free_slots') {
        const res = await this.calendarService.getFreeSlots({
          tenantId: request.tenantId,
          calendarId: payload.calendarId || 'primary',
          timeMin: payload.timeMin,
          timeMax: payload.timeMax,
          requestId: request.requestId,
        });
        return {
          status: 'EXECUTED',
          capabilityId: request.capabilityId,
          result: res,
        };
      }
    }

    // Handle Gmail Capabilities
    if (def.provider === 'GMAIL') {
      if (request.capabilityId === 'gmail.search') {
        const res = await this.gmailService.search({
          tenantId: request.tenantId,
          query: payload.query || '',
          requestId: request.requestId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: res };
      }

      if (request.capabilityId === 'gmail.read_thread') {
        const res = await this.gmailService.readThread({
          tenantId: request.tenantId,
          threadId: payload.threadId,
          requestId: request.requestId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: res };
      }

      if (request.capabilityId === 'gmail.send_email') {
        const approval = this.gmailService.requestApproval({
          toolId: 'gmail.send_email',
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }

      if (request.capabilityId === 'gmail.reply') {
        const approval = this.gmailService.requestApproval({
          toolId: 'gmail.reply',
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }

      if (request.capabilityId === 'gmail.create_draft') {
        const approval = this.gmailService.requestApproval({
          toolId: 'gmail.create_draft',
          tenantId: request.tenantId,
          principalId: request.principalId,
          payload: request.payload,
          requestId: request.requestId,
        });
        this.logApprovalRequired(request, def);
        return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval };
      }
    }

    // Handle Browser Capabilities
    if (def.provider === 'BROWSER') {
      const input = {
        tenantId: request.tenantId,
        ownerId: request.principalId,
        requestId: request.requestId,
      };

      if (request.capabilityId === 'browser.open') {
        const session = await this.browserService.open(input);
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: session };
      }

      if (request.capabilityId === 'browser.close') {
        await this.browserService.close({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { closed: true } };
      }

      if (request.capabilityId === 'browser.navigate') {
        const snapshot = await this.browserService.navigate({
          ...input,
          browserSessionId: payload.browserSessionId,
          url: payload.url,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: snapshot };
      }

      if (request.capabilityId === 'browser.tabs') {
        const tabs = await this.browserService.tabs({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: tabs };
      }

      if (request.capabilityId === 'browser.snapshot') {
        const snapshot = await this.browserService.snapshot({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: snapshot };
      }

      if (request.capabilityId === 'browser.structured_snapshot') {
        const snapshot = await this.browserService.structuredSnapshot({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: snapshot };
      }

      if (request.capabilityId === 'browser.find') {
        const res = await this.browserService.find({
          ...input,
          browserSessionId: payload.browserSessionId,
          query: payload.query,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: res };
      }

      if (request.capabilityId === 'browser.extract') {
        const res = await this.browserService.extract({
          ...input,
          browserSessionId: payload.browserSessionId,
          target: payload.target,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: res };
      }

      if (request.capabilityId === 'browser.back') {
        const snapshot = await this.browserService.back({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: snapshot };
      }

      if (request.capabilityId === 'browser.forward') {
        const snapshot = await this.browserService.forward({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: snapshot };
      }

      if (request.capabilityId === 'browser.reload') {
        const snapshot = await this.browserService.reload({
          ...input,
          browserSessionId: payload.browserSessionId,
        });
        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: snapshot };
      }

      if (request.capabilityId === 'browser.click') {
        const clickRes = await this.browserService.click({
          ...input,
          browserSessionId: payload.browserSessionId,
          selector: payload.selector || payload.targetId || '',
          forceApproval: effectiveApproval === 'REQUIRED',
        });

        if (clickRes.status === 'APPROVAL_REQUIRED') {
          this.logApprovalRequired(request, def);
          return { status: 'APPROVAL_REQUIRED', capabilityId: request.capabilityId, approval: clickRes.approval };
        }

        return { status: 'EXECUTED', capabilityId: request.capabilityId, result: clickRes };
      }
    }

    throw new NagexError({
      code: 'CAPABILITY_NOT_FOUND',
      category: 'NOT_FOUND',
      message: `No execution handler for capability "${request.capabilityId}".`,
      request_id: request.requestId,
    });
  }

  private logApprovalRequired(request: CapabilityRequest, def: CapabilityDefinition): void {
    this.auditLogger.logEvent({
      actor: { type: 'user', id: request.principalId },
      tenant_id: request.tenantId,
      action: 'capability.approval_required',
      resource: { type: 'Capability', id: request.capabilityId },
      result: 'PENDING_APPROVAL',
      request_id: request.requestId,
      details: {
        capabilityId: request.capabilityId,
        provider: def.provider,
        risk: def.risk,
        source: request.source,
        requestId: request.requestId,
      },
    });
  }
}
