// DC2 REAL ASTRA HOST ACCEPTANCE.
//
// This is the ONLY test file in this repository permitted to make a real,
// live network call to a real model provider — strictly gated behind
// process.env.OPENAI_API_KEY actually being present. Every object here is
// the real, production-wired class: real PlaywrightBrowserRuntime, real
// BrowserToolService (real evidence write + real readEvidenceOwned()),
// real AstraVisualExecutionModelAdapter (default fetch, no fetchFn
// override), real DeviceControlService. Never FakeVisualExecutionModelAdapter.
// Never a mocked fetch. Never Astra's own native computer-use tool (the
// adapter's own request body never sets a `tools` field at all — confirmed
// by source, see astra-visual-execution-model.adapter.ts).
//
// In this session's own dev/test environment OPENAI_API_KEY is unset
// (confirmed via `node -e`, not assumed) — this suite SKIPS itself
// entirely in that case rather than faking a result. It is designed to
// run for real only on a host (or session) that actually carries the real
// production secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { DeviceExecutionSessionStore } from '../src/device-control/device-execution-session.store.js';
import { DeviceControlService } from '../src/device-control/device-control.service.js';
import { AstraVisualExecutionModelAdapter } from '../src/device-control/astra-visual-execution-model.adapter.js';

const REAL_KEY = process.env.OPENAI_API_KEY;
const HAS_REAL_KEY = Boolean(REAL_KEY);
const SKIP_REASON = 'OPENAI_API_KEY is not set in this environment — this suite makes a real network call and only runs where the real production secret is present.';

test(
  'REAL_ASTRA_HOST_ACCEPTANCE: a real, end-to-end, production-wired Astra proposal against a real page, exercised harmlessly',
  { skip: HAS_REAL_KEY ? false : SKIP_REASON },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-astra-real-acceptance-'));
    const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
    const browserSessions = new BrowserSessionStore({ dir: path.join(dir, 'browser-sessions') });
    const approvals = new ActionApprovalStore();
    const audit = new AuditLogger();
    const memory = new MemoryEngine();
    const browserService = new BrowserToolService(runtime, browserSessions, approvals, audit, memory, undefined, path.join(dir, 'evidence'));
    const sessions = new DeviceExecutionSessionStore({ dir: path.join(dir, 'device-sessions') });

    // The real adapter — real fetch (no fetchFn override), real key, real model.
    const adapter = new AstraVisualExecutionModelAdapter({
      apiKey: REAL_KEY,
      model: process.env.NAGEX_ASTRA_MODEL,
      auditLogger: audit,
      // Routes through the real, ownership-scoped DC1-R1 read-back —
      // never a bare evidenceId lookup.
      readScreenshot: (evidenceId, tenantId, ownerId, requestId) => browserService.readEvidenceOwned(evidenceId, tenantId, ownerId, requestId),
    });
    assert.equal(adapter.status().configured, true, 'a real key must report configured=true');

    const service = new DeviceControlService(sessions, browserService, adapter);

    const TENANT = 'ten_astra_real_acceptance';
    const OWNER = 'usr_astra_real_acceptance';

    try {
      // allowedActions restricted to OBSERVE/STOP only — this is the real
      // safety guarantee for this acceptance run: regardless of what the
      // real model actually proposes, nothing beyond a read-only
      // observation can ever execute (the existing, already-proven
      // DEVICE_ACTION_NOT_ALLOWED enforcement blocks anything else), so
      // "do not execute a consequential action" holds structurally, not
      // just by hoping the model behaves.
      const outcome = await service.startSession({
        tenantId: TENANT,
        ownerId: OWNER,
        requestId: 'req_astra_real_acceptance',
        goal: 'Observe this page and then stop. Do not click, type, scroll, or navigate anywhere — this is a read-only verification of your observation ability only.',
        allowedDomains: ['example.com'],
        allowedActions: ['OBSERVE', 'STOP'],
        maxSteps: 3,
        maxDurationMs: 60_000,
      });

      // REAL_ASTRA_API_CALL / REAL_ASTRA_STRUCTURED_OUTPUT / REAL_ASTRA_PROPOSAL_VALIDATION —
      // a real network failure, a real schema-invalid response, or a real
      // refusal would all surface as DEVICE_MODEL_PROPOSAL_FAILED (the
      // only place device-control.service.ts routes a thrown
      // ModelProviderError) — explicitly asserted absent.
      if (outcome.kind === 'TERMINATED') {
        assert.ok(!outcome.terminationReason.startsWith('DEVICE_MODEL_PROPOSAL_FAILED'), `a real Astra call must succeed, not fail: ${outcome.terminationReason}`);
      }

      // REAL_ASTRA_POLICY_GATE — every acceptable outcome here is harmless
      // by construction: COMPLETED (STOP), a bounded max-steps cutoff, or
      // NAgex's own existing enforcement blocking a real model proposing
      // something outside OBSERVE/STOP. Anything else is a genuine failure.
      const harmless =
        outcome.kind === 'COMPLETED' ||
        (outcome.kind === 'TERMINATED' && (outcome.terminationReason === 'DEVICE_MAX_STEPS_EXCEEDED' || outcome.terminationReason.startsWith('DEVICE_ACTION_NOT_ALLOWED')));
      assert.ok(harmless, `expected a harmless, policy-gated outcome (COMPLETED / max-steps / blocked-action), got: ${JSON.stringify(outcome)}`);

      // REAL_ASTRA_IMAGE_INPUT / REAL_ASTRA_EVIDENCE_OWNERSHIP — a real
      // screenshot was genuinely captured and is genuinely readable back
      // through the real ownership-scoped path.
      const finalSession = sessions.getOwned(outcome.deviceExecutionSessionId, TENANT, OWNER);
      assert.ok(finalSession?.lastObservationRef, 'a real screenshot evidenceId must have been recorded during the run');
      const evidenceBytes = browserService.readEvidenceOwned(finalSession!.lastObservationRef!, TENANT, OWNER, 'req_verify_evidence');
      assert.ok(evidenceBytes.length > 0, 'the real evidence bytes must be non-empty');
      assert.deepEqual(evidenceBytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'the real evidence must be a real PNG');
      // And the same evidence must be genuinely unreadable by a wrong identity.
      assert.throws(() => browserService.readEvidenceOwned(finalSession!.lastObservationRef!, 'ten_wrong', OWNER, 'req_wrong'), (err: unknown) => (err as { code?: string }).code === 'BROWSER_EVIDENCE_NOT_FOUND');

      // REAL_ASTRA_SECRET_NOT_LOGGED — the real key must never appear in
      // any audit event produced by this real run.
      const logs = audit.getRecentLogs(100);
      const serializedLogs = JSON.stringify(logs);
      assert.ok(!serializedLogs.includes(REAL_KEY!), 'the real API key must never appear in any audit log entry');
    } finally {
      await runtime.shutdown();
    }
  },
);
