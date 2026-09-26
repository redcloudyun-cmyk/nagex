import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger } from '../src/governance/audit.logger.js';

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
