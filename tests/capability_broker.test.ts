import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger, type AuditEventRecord } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService } from '../src/tools/google-calendar.service.js';
import { GmailService } from '../src/tools/gmail.service.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry, capabilityRegistry } from '../src/capabilities/capability.registry.js';
import { CapabilityPolicy } from '../src/capabilities/capability-policy.js';
import { SafetyDecision } from '../src/governance/safety.types.js';
import type { BrowserRuntime, BrowserSnapshot } from '../src/modules/browser/browser.runtime.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex_test_${prefix}_`));
}

describe('Capability Broker Mandatory Tests', () => {
  let auditLogger: AuditLogger;
  let loggedEvents: AuditEventRecord[];
  let actionApprovals: ActionApprovalStore;
  let executionStore: ExecutionStore;
  let memoryEngine: MemoryEngine;
  let calendarService: GoogleCalendarService;
  let gmailService: GmailService;
  let browserService: BrowserToolService;
  let sessionStore: BrowserSessionStore;
  let capabilityBroker: CapabilityBroker;
  let registry: CapabilityRegistry;
  let mockBrowserRuntime: BrowserRuntime;
  let snapshotMap: Map<string, BrowserSnapshot>;

  beforeEach(() => {
    loggedEvents = [];
    auditLogger = new AuditLogger();
    auditLogger.logEvent = (event: AuditEventRecord) => {
      loggedEvents.push(event);
      return event;
    };

    const tokenStore: any = {
      getValidAccessToken: async () => 'mock_token',
    };
    const getConfig: any = () => ({
      clientId: 'mock',
      clientSecret: 'mock',
      redirectUri: 'mock',
    });

    actionApprovals = new ActionApprovalStore();
    executionStore = new ExecutionStore();
    memoryEngine = new MemoryEngine();

    calendarService = new GoogleCalendarService(
      tokenStore,
      actionApprovals,
      auditLogger,
      memoryEngine,
      async (url: any, opts: any) => {
        if (typeof url === 'string' && url.includes('freeBusy')) {
          return new Response(
            JSON.stringify({
              calendars: {
                primary: {
                  busy: [{ start: '2026-09-10T09:00:00Z', end: '2026-09-10T10:00:00Z' }],
                },
              },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ id: 'evt_123', htmlLink: 'https://calendar.google.com' }), { status: 200 });
      },
      getConfig,
      executionStore
    );

    gmailService = new GmailService(
      tokenStore,
      actionApprovals,
      auditLogger,
      memoryEngine,
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ id: 'msg_1', threadId: 'th_1', snippet: 'Hello world' }],
            id: 'msg_1',
            threadId: 'th_1',
          }),
          { status: 200 }
        ),
      getConfig,
      executionStore
    );

    const sessionStoreDir = createTempDir('browser_sessions');
    sessionStore = new BrowserSessionStore({ dir: sessionStoreDir });

    snapshotMap = new Map();
    mockBrowserRuntime = {
      isAvailable: async () => true,
      hasSession: (id: string) => snapshotMap.has(id),
      shutdown: async () => {},
      openSession: async (id: string) => {
        const snap: BrowserSnapshot = {
          url: 'https://example.com',
          title: 'Example Domain',
          text: 'Welcome to Example Domain',
          truncated: false,
          totalCharacters: 25,
          returnedCharacters: 25,
        };
        snapshotMap.set(id, snap);
        return { url: snap.url, title: snap.title };
      },
      closeSession: async (id: string) => {
        snapshotMap.delete(id);
      },
      navigate: async (id: string, url: string) => {
        const snap = snapshotMap.get(id) || {
          url,
          title: 'Example',
          text: 'Example content',
          truncated: false,
          totalCharacters: 15,
          returnedCharacters: 15,
        };
        snap.url = url;
        snapshotMap.set(id, snap);
        return { url, title: snap.title };
      },
      listTabs: async () => [{ index: 0, url: 'https://example.com', title: 'Example' }],
      snapshot: async (id: string) =>
        snapshotMap.get(id) || {
          url: 'https://example.com',
          title: 'Example',
          text: 'Example content',
          truncated: false,
          totalCharacters: 15,
          returnedCharacters: 15,
        },
      structuredSnapshot: async (id: string) => ({
        url: 'https://example.com',
        title: 'Example',
        text: 'Example content',
        links: [],
        buttons: [],
        inputs: [],
        forms: [],
        elements: [],
      }),
      find: async () => ({ query: 'test', candidates: [] }),
      extract: async () => ({
        url: 'https://example.com',
        title: 'Example',
        target: 'all',
        extracted: { text: 'Example text' },
        timestamp: new Date().toISOString(),
      }),
      back: async (id: string) => ({ url: 'https://example.com', title: 'Example' }),
      forward: async (id: string) => ({ url: 'https://example.com', title: 'Example' }),
      reload: async (id: string) => ({ url: 'https://example.com', title: 'Example' }),
      clearProfile: async () => {},
      screenshot: async () => Buffer.from('png_bytes'),
      scroll: async () => {},
      wait: async () => {},
      type: async () => {},
      select: async () => {},
      resolveSelector: async (id: string, selector: string) => {
        const text = selector.toLowerCase();
        const isConsequential = ['submit', 'pay', 'buy', 'delete'].some((kw) => text.includes(kw));
        return {
          count: 1,
          text: isConsequential ? 'Submit Order' : 'Next Page',
          isFormControl: isConsequential,
          role: 'button',
        };
      },
      click: async (id: string) => {},
    };

    browserService = new BrowserToolService(
      mockBrowserRuntime,
      sessionStore,
      actionApprovals,
      auditLogger,
      memoryEngine,
      executionStore,
      createTempDir('evidence'),
      () => true
    );

    registry = new CapabilityRegistry();
    const idempotencyDir = createTempDir('idempotency');
    process.env.NAGEX_TEST_IDEMPOTENCY_DIR = idempotencyDir;
    capabilityBroker = new CapabilityBroker(
      calendarService,
      gmailService,
      browserService,
      auditLogger,
      registry,
      'test_idempotency',
      'NAGEX_TEST_IDEMPOTENCY_DIR'
    );
  });

  it('1. known Calendar/Gmail/Browser capabilities resolve', () => {
    assert.equal(registry.has('google_calendar.create_event'), true);
    assert.equal(registry.has('gmail.search'), true);
    assert.equal(registry.has('browser.snapshot'), true);
    assert.equal(registry.has('browser.click'), true);

    const calDef = registry.get('google_calendar.create_event');
    assert.equal(calDef?.risk, 'CONSEQUENTIAL');
    assert.equal(calDef?.approval, 'REQUIRED');

    const gmailReadDef = registry.get('gmail.search');
    assert.equal(gmailReadDef?.risk, 'READ_ONLY');
    assert.equal(gmailReadDef?.approval, 'NONE');
  });

  it('2. unknown capability fails closed', async () => {
    const res = await capabilityBroker.execute({
      capabilityId: 'unknown.capability',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_unknown',
      payload: {},
      source: 'WEB',
    });
    assert.equal(res.status, 'BLOCKED');
    if (res.status === 'BLOCKED') {
      assert.equal(res.reasonCode, 'CAPABILITY_NOT_FOUND');
    }
  });

  it('3. disabled capability fails closed', async () => {
    registry.setEnabled('gmail.search', false);
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.search',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_disabled',
      payload: { query: 'test' },
      source: 'WEB',
    });
    assert.equal(res.status, 'BLOCKED');
    if (res.status === 'BLOCKED') {
      assert.equal(res.reasonCode, 'CAPABILITY_DISABLED');
    }
  });

  it('4. tenant/principal/requestId validation', async () => {
    const reqNoTenant: any = {
      capabilityId: 'gmail.search',
      tenantId: '',
      principalId: 'usr_01',
      requestId: 'req_1',
      payload: {},
      source: 'WEB',
    };
    const res1 = await capabilityBroker.execute(reqNoTenant);
    assert.equal(res1.status, 'BLOCKED');

    const reqNoPrincipal: any = {
      capabilityId: 'gmail.search',
      tenantId: 'ten_01',
      principalId: '',
      requestId: 'req_2',
      payload: {},
      source: 'WEB',
    };
    const res2 = await capabilityBroker.execute(reqNoPrincipal);
    assert.equal(res2.status, 'BLOCKED');

    const reqNoReqId: any = {
      capabilityId: 'gmail.search',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: '',
      payload: {},
      source: 'WEB',
    };
    const res3 = await capabilityBroker.execute(reqNoReqId);
    assert.equal(res3.status, 'BLOCKED');
  });

  it('5. Gmail read allowed when safe', async () => {
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.search',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_gmail_read',
      payload: { query: 'label:inbox' },
      source: 'WEB',
    });
    assert.equal(res.status, 'EXECUTED');
    if (res.status === 'EXECUTED') {
      assert.ok(res.result);
    }
  });

  it('6. Gmail send requires approval', async () => {
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_gmail_send',
      payload: {
        from: 'user@example.com',
        to: ['alice@example.com'],
        subject: 'Meeting',
        body: 'Hello Alice',
      },
      source: 'WEB',
    });
    assert.equal(res.status, 'APPROVAL_REQUIRED');
    if (res.status === 'APPROVAL_REQUIRED') {
      assert.ok(res.approval);
      assert.equal((res.approval as any).toolId, 'gmail.send_email');
    }
  });

  it('7. Calendar create/cancel requires approval', async () => {
    const createRes = await capabilityBroker.execute({
      capabilityId: 'google_calendar.create_event',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_cal_create',
      payload: {
        calendarId: 'primary',
        summary: 'Sync',
        description: 'Weekly sync',
        start: '2026-09-10T10:00:00Z',
        end: '2026-09-10T11:00:00Z',
        timezone: 'UTC',
        attendees: ['bob@example.com'],
      },
      source: 'WEB',
    });
    assert.equal(createRes.status, 'APPROVAL_REQUIRED');

    const cancelRes = await capabilityBroker.execute({
      capabilityId: 'google_calendar.cancel_event',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_cal_cancel',
      payload: {
        calendarId: 'primary',
        eventId: 'evt_99',
        summary: 'Sync',
      },
      source: 'WEB',
    });
    assert.equal(cancelRes.status, 'APPROVAL_REQUIRED');
  });

  it('8. Browser snapshot read-only', async () => {
    const openRes = await capabilityBroker.execute({
      capabilityId: 'browser.open',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_open',
      payload: {},
      source: 'WEB',
    });
    assert.equal(openRes.status, 'EXECUTED');
    const sessionId = (openRes as any).result.browserSessionId;

    const snapRes = await capabilityBroker.execute({
      capabilityId: 'browser.snapshot',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_snap',
      payload: { browserSessionId: sessionId },
      source: 'WEB',
    });
    assert.equal(snapRes.status, 'EXECUTED');
  });

  it('9. harmless click may execute', async () => {
    const openRes = await capabilityBroker.execute({
      capabilityId: 'browser.open',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_open2',
      payload: {},
      source: 'WEB',
    });
    const sessionId = (openRes as any).result.browserSessionId;

    const clickRes = await capabilityBroker.execute({
      capabilityId: 'browser.click',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_click_harmless',
      payload: { browserSessionId: sessionId, selector: 'a#next-link' },
      source: 'WEB',
    });
    assert.equal(clickRes.status, 'EXECUTED');
  });

  it('10. consequential click requires approval', async () => {
    const openRes = await capabilityBroker.execute({
      capabilityId: 'browser.open',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_open3',
      payload: {},
      source: 'WEB',
    });
    const sessionId = (openRes as any).result.browserSessionId;

    const clickRes = await capabilityBroker.execute({
      capabilityId: 'browser.click',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_click_consequential',
      payload: { browserSessionId: sessionId, selector: 'button#submit-payment' },
      source: 'WEB',
    });
    assert.equal(clickRes.status, 'APPROVAL_REQUIRED');
  });

  it('11. CAPTCHA/MFA blocking preserved', async () => {
    const openRes = await capabilityBroker.execute({
      capabilityId: 'browser.open',
      tenantId: 'ten_captcha_01',
      principalId: 'usr_captcha_01',
      requestId: 'req_b_open_captcha',
      payload: {},
      source: 'WEB',
    });
    const sessionId = (openRes as any).result.browserSessionId;

    snapshotMap.set(sessionId, {
      url: 'https://example.com/login',
      title: 'Security Check',
      text: 'Please verify you are human (CAPTCHA)',
      truncated: false,
      totalCharacters: 30,
      returnedCharacters: 30,
    });

    await assert.rejects(
      async () => {
        await capabilityBroker.execute({
          capabilityId: 'browser.navigate',
          tenantId: 'ten_captcha_01',
          principalId: 'usr_captcha_01',
          requestId: 'req_b_nav_captcha',
          payload: { browserSessionId: sessionId, url: 'https://example.com/login' },
          source: 'WEB',
        });
      },
      (err: any) => Boolean(err && (err.code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED' || String(err).includes('CAPTCHA')))
    );
  });

  it('12. unsafe browser URL blocking preserved', async () => {
    const openRes = await capabilityBroker.execute({
      capabilityId: 'browser.open',
      tenantId: 'ten_unsafe_01',
      principalId: 'usr_unsafe_01',
      requestId: 'req_b_open_unsafe',
      payload: {},
      source: 'WEB',
    });
    const sessionId = (openRes as any).result.browserSessionId;

    await assert.rejects(
      async () => {
        await capabilityBroker.execute({
          capabilityId: 'browser.navigate',
          tenantId: 'ten_unsafe_01',
          principalId: 'usr_unsafe_01',
          requestId: 'req_b_nav_unsafe_file',
          payload: { browserSessionId: sessionId, url: 'file:///etc/passwd' },
          source: 'WEB',
        });
      },
      (err: any) => Boolean(err && (err.code === 'BROWSER_UNSAFE_URL' || err.code === 'UNSAFE_URL' || String(err).includes('Unsafe scheme')))
    );
  });

  it('13. R2/R3/R4 execution blocked', async () => {
    const safetyDecision: SafetyDecision = {
      decisionId: 'sd_1',
      tenantId: 'ten_01',
      userId: 'usr_01',
      riskLevel: 'R3',
      categories: ['CYBER_ABUSE'],
      responseMode: 'REFUSE',
      responseAllowed: false,
      planningAllowed: false,
      executionAllowed: false,
      requiresActionApproval: true,
      requiresHumanReview: true,
      reasonCodes: ['HIGH_RISK_HARMFUL'],
      userFacingExplanation: 'Safety blocked high risk action.',
      policyVersion: '1.0',
      classifierVersion: '1.0',
      createdAt: new Date().toISOString(),
    };

    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.search',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_safety_blocked',
      payload: { query: 'test' },
      source: 'WEB',
      safetyDecision,
    });

    assert.equal(res.status, 'BLOCKED');
    if (res.status === 'BLOCKED') {
      assert.equal(res.reasonCode, 'CAPABILITY_BLOCKED_BY_SAFETY');
    }
  });

  it('14. safety can strengthen but never weaken approval', async () => {
    const readDef = registry.get('gmail.search');
    assert.equal(readDef?.approval, 'NONE');

    const safetyStrengthened: SafetyDecision = {
      decisionId: 'sd_2',
      tenantId: 'ten_01',
      userId: 'usr_01',
      riskLevel: 'R1',
      categories: [],
      responseMode: 'LIMITED',
      responseAllowed: true,
      planningAllowed: true,
      executionAllowed: true,
      requiresActionApproval: true,
      requiresHumanReview: false,
      reasonCodes: ['ELEVATED_RISK'],
      userFacingExplanation: 'Requires approval',
      policyVersion: '1.0',
      classifierVersion: '1.0',
      createdAt: new Date().toISOString(),
    };

    const evalResult1 = CapabilityPolicy.evaluate(
      {
        capabilityId: 'gmail.search',
        tenantId: 'ten_01',
        principalId: 'usr_01',
        requestId: 'req_s1',
        payload: {},
        source: 'WEB',
        safetyDecision: safetyStrengthened,
      },
      readDef,
      true
    );
    assert.equal(evalResult1.effectiveApproval, 'REQUIRED');

    const sendDef = registry.get('gmail.send_email');
    assert.equal(sendDef?.approval, 'REQUIRED');

    const safetyWeakened: SafetyDecision = {
      decisionId: 'sd_3',
      tenantId: 'ten_01',
      userId: 'usr_01',
      riskLevel: 'R0',
      categories: [],
      responseMode: 'NORMAL',
      responseAllowed: true,
      planningAllowed: true,
      executionAllowed: true,
      requiresActionApproval: false,
      requiresHumanReview: false,
      reasonCodes: [],
      userFacingExplanation: 'Safe',
      policyVersion: '1.0',
      classifierVersion: '1.0',
      createdAt: new Date().toISOString(),
    };

    const evalResult2 = CapabilityPolicy.evaluate(
      {
        capabilityId: 'gmail.send_email',
        tenantId: 'ten_01',
        principalId: 'usr_01',
        requestId: 'req_s2',
        payload: {},
        source: 'WEB',
        safetyDecision: safetyWeakened,
      },
      sendDef,
      true
    );
    assert.equal(evalResult2.effectiveApproval, 'REQUIRED');
  });

  it('15. direct consequential write cannot bypass approval', async () => {
    const validSendPayload = { from: 'user@example.com', to: ['test@example.com'], subject: 'Test', body: 'Body' };
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_direct_write',
      payload: validSendPayload,
      source: 'WEB',
    });
    assert.equal(res.status, 'APPROVAL_REQUIRED');

    const approvalId = ((res as any).approval as any).approvalId;
    assert.ok(approvalId);

    // Attempting executeSendEmail without approving first fails
    await assert.rejects(
      async () => {
        await gmailService.executeSendEmail({
          approvalId,
          payload: validSendPayload,
          tenantId: 'ten_01',
          principalId: 'usr_01',
          requestId: 'req_direct_exec',
        });
      },
      (err: any) => Boolean(err)
    );
  });

  it('16. payload tampering after approval is rejected', async () => {
    const validSendPayload = { from: 'user@example.com', to: ['alice@example.com'], subject: 'Original', body: 'Hello' };
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_tamper_init',
      payload: validSendPayload,
      source: 'WEB',
    });
    const approvalId = ((res as any).approval as any).approvalId;
    gmailService.approve(approvalId, 'usr_01', 'req_approve');

    // Attempt to execute with tampered payload
    await assert.rejects(
      async () => {
        await gmailService.executeSendEmail({
          approvalId,
          payload: { from: 'user@example.com', to: ['hacker@example.com'], subject: 'Original', body: 'Hello' },
          tenantId: 'ten_01',
          principalId: 'usr_01',
          requestId: 'req_exec_tampered',
        });
      },
      (err: any) => Boolean(err && (err.code === 'APPROVAL_PAYLOAD_MISMATCH' || String(err).includes('mismatch')))
    );
  });

  it('17. approval replay remains rejected', async () => {
    const validSendPayload = { from: 'user@example.com', to: ['bob@example.com'], subject: 'Replay Test', body: 'Message' };
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_replay_init',
      payload: validSendPayload,
      source: 'WEB',
    });
    const approvalId = ((res as any).approval as any).approvalId;
    gmailService.approve(approvalId, 'usr_01', 'req_appr');

    await gmailService.executeSendEmail({
      approvalId,
      payload: validSendPayload,
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_exec_1',
    });

    // Replay attempt
    await assert.rejects(
      async () => {
        await gmailService.executeSendEmail({
          approvalId,
          payload: validSendPayload,
          tenantId: 'ten_01',
          principalId: 'usr_01',
          requestId: 'req_exec_2',
        });
      },
      (err: any) => Boolean(err && (err.code === 'APPROVAL_ALREADY_CONSUMED' || String(err).includes('CONSUMED')))
    );
  });

  it('18. duplicate retry does not duplicate approval (Idempotency)', async () => {
    const reqPayload = { from: 'user@example.com', to: ['charlie@example.com'], subject: 'Idempotency', body: 'Check' };

    const res1 = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_idempotent_01',
      payload: reqPayload,
      source: 'WEB',
      idempotencyKey: 'idem_key_100',
    });
    assert.equal(res1.status, 'APPROVAL_REQUIRED');
    const approvalId1 = (res1 as any).approval.approvalId;

    // Retry with identical key & payload
    const res2 = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_idempotent_02',
      payload: reqPayload,
      source: 'WEB',
      idempotencyKey: 'idem_key_100',
    });
    assert.equal(res2.status, 'APPROVAL_REQUIRED');
    const approvalId2 = (res2 as any).approval.approvalId;
    assert.equal(approvalId1, approvalId2);

    // Reuse idempotency key with different payload
    await assert.rejects(
      async () => {
        await capabilityBroker.execute({
          capabilityId: 'gmail.send_email',
          tenantId: 'ten_01',
          principalId: 'usr_01',
          requestId: 'req_idempotent_03',
          payload: { from: 'user@example.com', to: ['different@example.com'], subject: 'Different', body: 'Changed' },
          source: 'WEB',
          idempotencyKey: 'idem_key_100',
        });
      },
      (err: any) => Boolean(err && (err.code === 'CAPABILITY_IDEMPOTENCY_CONFLICT' || String(err).includes('CONFLICT')))
    );
  });

  it('19. tenant/principal isolation', async () => {
    const validSendPayload = { from: 'user@example.com', to: ['user@example.com'], subject: 'Iso', body: 'Text' };
    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'tenant_A',
      principalId: 'user_A',
      requestId: 'req_iso_1',
      payload: validSendPayload,
      source: 'WEB',
      safetyDecision: {
        decisionId: 'sd_iso_1',
        tenantId: 'tenant_A',
        userId: 'user_A',
        riskLevel: 'R0',
        categories: [],
        responseMode: 'NORMAL',
        responseAllowed: true,
        planningAllowed: true,
        executionAllowed: true,
        requiresActionApproval: false,
        requiresHumanReview: false,
        reasonCodes: [],
        userFacingExplanation: '',
        policyVersion: '1.0',
        classifierVersion: '1.0',
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(res.status, 'APPROVAL_REQUIRED');

    // Attempting to execute policy with mismatched tenantId fails policy
    const resCross = await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'tenant_B',
      principalId: 'user_B',
      requestId: 'req_iso_cross',
      payload: validSendPayload,
      source: 'WEB',
      safetyDecision: {
        decisionId: 'sd_iso_2',
        tenantId: 'tenant_A',
        userId: 'user_A',
        riskLevel: 'R0',
        categories: [],
        responseMode: 'NORMAL',
        responseAllowed: true,
        planningAllowed: true,
        executionAllowed: true,
        requiresActionApproval: false,
        requiresHumanReview: false,
        reasonCodes: [],
        userFacingExplanation: '',
        policyVersion: '1.0',
        classifierVersion: '1.0',
        createdAt: new Date().toISOString(),
      },
    });

    assert.equal(resCross.status, 'BLOCKED');
    if (resCross.status === 'BLOCKED') {
      assert.equal(resCross.reasonCode, 'CAPABILITY_POLICY_FAILED');
    }
  });

  it('20. broker audit is metadata-only', async () => {
    const secretBody = 'CONFIDENTIAL_SECRET_PASSWORD_12345';
    await capabilityBroker.execute({
      capabilityId: 'gmail.send_email',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_audit_privacy',
      payload: { from: 'user@example.com', to: ['secret@example.com'], subject: 'Secret Subject', body: secretBody },
      source: 'WEB',
    });

    const brokerEvents = loggedEvents.filter((e) => e.action.startsWith('capability.'));
    assert.ok(brokerEvents.length > 0);

    for (const ev of brokerEvents) {
      const dump = JSON.stringify(ev);
      assert.equal(dump.includes(secretBody), false, `Secret body found in audit log event ${ev.action}`);
    }
  });

  it('21. google_calendar.free_slots returns real computed free slots', async () => {
    const res = await capabilityBroker.execute({
      capabilityId: 'google_calendar.free_slots',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_free_slots_1',
      payload: {
        calendarId: 'primary',
        timeMin: '2026-09-10T08:00:00Z',
        timeMax: '2026-09-10T12:00:00Z',
      },
      source: 'WEB',
    });
    assert.equal(res.status, 'EXECUTED');
    if (res.status === 'EXECUTED') {
      assert.ok(res.result);
      const resData = res.result as any;
      assert.equal(resData.calendarId, 'primary');
      assert.ok(Array.isArray(resData.slots));
    }
  });

  it('22. google_calendar.free_slots fails when disconnected', async () => {
    const disconnectedTokenStore: any = {
      getValidAccessToken: async () => null,
    };
    const discCalService = new GoogleCalendarService(
      disconnectedTokenStore,
      actionApprovals,
      auditLogger,
      memoryEngine,
      async () => new Response('{}', { status: 401 }),
      () => ({ clientId: 'm', clientSecret: 'm', redirectUri: 'm' }),
      executionStore
    );
    const discBroker = new CapabilityBroker(
      discCalService,
      gmailService,
      browserService,
      auditLogger,
      registry,
      'test_idempotency_disc',
      'NAGEX_TEST_IDEMPOTENCY_DIR'
    );
    await assert.rejects(
      async () => {
        await discBroker.execute({
          capabilityId: 'google_calendar.free_slots',
          tenantId: 'ten_01',
          principalId: 'usr_01',
          requestId: 'req_free_slots_disc',
          payload: { calendarId: 'primary', timeMin: '2026-09-10T08:00:00Z', timeMax: '2026-09-10T12:00:00Z' },
          source: 'WEB',
        });
      },
      (err: any) => Boolean(err && (err.code === 'GOOGLE_CALENDAR_DISCONNECTED' || String(err).includes('not connected')))
    );
  });

  it('23. safety requiring approval blocks read-only tool (CAPABILITY_SAFETY_APPROVAL_REQUIRED)', async () => {
    const safetyReqApproval: SafetyDecision = {
      decisionId: 'sd_read_appr',
      tenantId: 'ten_01',
      userId: 'usr_01',
      riskLevel: 'R1',
      categories: [],
      responseMode: 'LIMITED',
      responseAllowed: true,
      planningAllowed: true,
      executionAllowed: true,
      requiresActionApproval: true,
      requiresHumanReview: false,
      reasonCodes: ['ELEVATED_RISK'],
      userFacingExplanation: 'Requires approval',
      policyVersion: '1.0',
      classifierVersion: '1.0',
      createdAt: new Date().toISOString(),
    };

    const res = await capabilityBroker.execute({
      capabilityId: 'gmail.search',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_gmail_search_safety_appr',
      payload: { query: 'test' },
      source: 'WEB',
      safetyDecision: safetyReqApproval,
    });

    assert.equal(res.status, 'BLOCKED');
    if (res.status === 'BLOCKED') {
      assert.equal(res.reasonCode, 'CAPABILITY_SAFETY_APPROVAL_REQUIRED');
    }
  });

  it('24. safety requiring approval forces approval on harmless browser.click', async () => {
    const openRes = await capabilityBroker.execute({
      capabilityId: 'browser.open',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_open_safety_force',
      payload: {},
      source: 'WEB',
    });
    const sessionId = (openRes as any).result.browserSessionId;

    const safetyReqApproval: SafetyDecision = {
      decisionId: 'sd_click_appr',
      tenantId: 'ten_01',
      userId: 'usr_01',
      riskLevel: 'R1',
      categories: [],
      responseMode: 'LIMITED',
      responseAllowed: true,
      planningAllowed: true,
      executionAllowed: true,
      requiresActionApproval: true,
      requiresHumanReview: false,
      reasonCodes: ['ELEVATED_RISK'],
      userFacingExplanation: 'Requires approval',
      policyVersion: '1.0',
      classifierVersion: '1.0',
      createdAt: new Date().toISOString(),
    };

    const res = await capabilityBroker.execute({
      capabilityId: 'browser.click',
      tenantId: 'ten_01',
      principalId: 'usr_01',
      requestId: 'req_b_click_safety_appr',
      payload: { browserSessionId: sessionId, selector: 'a#next-link' },
      source: 'WEB',
      safetyDecision: safetyReqApproval,
    });

    assert.equal(res.status, 'APPROVAL_REQUIRED');
    if (res.status === 'APPROVAL_REQUIRED') {
      assert.ok(res.approval);
      assert.equal((res.approval as any).toolId, 'browser.click');
    }
  });
});
