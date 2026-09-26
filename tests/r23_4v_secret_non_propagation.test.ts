import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GMAIL_SCOPES } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GmailService, GMAIL_SEND_EMAIL_TOOL_ID } from '../src/modules/gmail/index.js';

const CANARY = 'R23_4V_CANARY_NON_SECRET_MARKER';

test('R23.4V Phase D audit redaction keeps credential references but removes credential-shaped values', () => {
  const audit = new AuditLogger();
  audit.logEvent({
    actor: { type: 'user', id: 'usr_redact' },
    tenant_id: 'ten_redact',
    action: 'credential.redaction.test',
    resource: { type: 'Test', id: 'redact' },
    result: 'SUCCESS',
    request_id: 'req_redact',
    details: {
      accessToken: CANARY,
      refresh_token: CANARY,
      apiKey: CANARY,
      nested: { client_secret: CANARY, credentialRef: 'cred_safe_reference' },
    },
  });
  const serialized = JSON.stringify(audit.getAuditLogs('ten_redact'));
  assert.doesNotMatch(serialized, new RegExp(CANARY));
  assert.match(serialized, /cred_safe_reference/);
});

test('R23.4V Phase D credential module has no direct model, memory, activity, or approval dependency', () => {
  const files = [
    'src/security/credentials/credential.types.ts',
    'src/security/credentials/credential-broker.service.ts',
    'src/security/credentials/google-credential-access.service.ts',
    'src/security/credentials/index.ts',
  ];
  const joined = files.map((file) => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
  assert.doesNotMatch(joined, /model-gateway|ModelRequest|AiService/);
  assert.doesNotMatch(joined, /memory\.engine|MemoryEngine/);
  assert.doesNotMatch(joined, /activity\.store|ActivityStore/);
  assert.doesNotMatch(joined, /action-approval\.store|ActionApprovalStore/);
});


test('R23.4V Phase D injected Google credential never appears in approval, audit, memory, or execution result', async () => {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const tenantId = 'ten_phase_d';
  const principalId = 'usr_phase_d';

  tokenStore.saveForPrincipal(tenantId, principalId, {
    accessToken: CANARY,
    refreshToken: CANARY,
    expiresAt: Date.now() + 60_000,
    scope: GMAIL_SCOPES.join(' '),
  });

  let injectedAtProviderBoundary = false;
  const fetchFn: typeof fetch = async (_url, init) => {
    injectedAtProviderBoundary = JSON.stringify(init?.headers || {}).includes(CANARY);
    return new Response(JSON.stringify({ id: 'msg_phase_d', threadId: 'thread_phase_d' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const service = new GmailService(
    tokenStore,
    approvals,
    audit,
    memory,
    fetchFn,
    () => ({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost/callback' }),
  );
  const payload = {
    from: 'me',
    to: ['recipient@example.com'],
    cc: [],
    bcc: [],
    subject: 'Phase D',
    body: 'Credential boundary check',
    attachments: [],
    threadId: null,
    replyToMessageId: null,
  };
  const approval = service.requestApproval({
    toolId: GMAIL_SEND_EMAIL_TOOL_ID,
    tenantId,
    principalId,
    payload,
    requestId: 'req_phase_d_1',
  });
  service.approve(approval.approvalId, tenantId, principalId, 'req_phase_d_2');
  const result = await service.executeSendEmail({
    approvalId: approval.approvalId,
    payload: approval.canonicalPayload,
    tenantId,
    principalId,
    requestId: 'req_phase_d_3',
  });

  assert.equal(injectedAtProviderBoundary, true);
  for (const surface of [
    approvals.get(approval.approvalId, tenantId, principalId),
    audit.getAuditLogs(tenantId),
    memory.listMemories(tenantId, principalId),
    result,
  ]) {
    assert.doesNotMatch(JSON.stringify(surface), new RegExp(CANARY));
  }
});
