#!/usr/bin/env node
// Opt-in REAL certification of the document journey: create (real model) -> save -> appear in Recent -> reopen after a "restart" (fresh store instances reading the same files) -> ownership.
// The stores live in a private temp directory (never the server's data directory); the model is the real AiService with the real providers. Facts only: ids, sizes, hashes, provider, model,
// latency - never the document text, a prompt or a credential.
//
//   NAGEX_LIVE_DOCUMENT_ROUNDTRIP=1 node scripts/document-roundtrip-live-cert.mjs        (after `npm run build`)
//
// On a server NAGEX_CERT_ENV_FROM_PID=<pid of the running service> loads ONLY an allow-list of provider variable names from that process (see nemotron-first-live-cert.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

if (process.env.NAGEX_LIVE_DOCUMENT_ROUNDTRIP !== '1') { console.log('REAL_DOCUMENT_ROUNDTRIP=NOT_RUN (set NAGEX_LIVE_DOCUMENT_ROUNDTRIP=1 to make real, paid calls)'); process.exit(0); }
const ALLOWED = new Set(['NEBIUS_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'NAGEX_NEBIUS_MODEL', 'NAGEX_GEMINI_MODEL', 'NAGEX_OPENAI_MODEL', 'NAGEX_NEBIUS_BASE_URL', 'NAGEX_NEBIUS_TIMEOUT_MS', 'NAGEX_NEBIUS_MAX_TOKENS', 'NAGEX_PROVIDER_PRIORITY']);
const pid = process.env.NAGEX_CERT_ENV_FROM_PID;
if (pid) {
  if (!/^[0-9]{1,9}$/.test(pid)) { console.log('REAL_DOCUMENT_ROUNDTRIP=NOT_RUN (invalid pid)'); process.exit(0); }
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0 && ALLOWED.has(entry.slice(0, i)) && !(entry.slice(0, i) in process.env)) process.env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch { console.log('REAL_DOCUMENT_ROUNDTRIP=NOT_RUN (the process environment is not readable)'); process.exit(0); }
}
if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_API_KEY.trim()) { console.log('REAL_DOCUMENT_ROUNDTRIP=NOT_RUN (NEBIUS_API_KEY is not set)'); process.exit(0); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-doc-roundtrip-'));
process.env.NAGEX_DOCUMENTS_DIR = path.join(root, 'documents');
process.env.NAGEX_ARTIFACTS_DIR = path.join(root, 'artifacts');
const { createProviders } = await import('../dist/src/model-gateway/providers.js');
const { UnifiedModelRouter } = await import('../dist/src/model-gateway/unified-model-router.js');
const { AiService } = await import('../dist/src/model-gateway/ai-service.js');
const { DocumentStore } = await import('../dist/src/creation/document.store.js');
const { ArtifactStore } = await import('../dist/src/artifacts/artifact.store.js');
const { DocumentExecutor } = await import('../dist/src/creation/executors/document-executor.js');
const { CreationRuntime } = await import('../dist/src/creation/creation-runtime.js');

const router = new UnifiedModelRouter(createProviders(process.env), { info: () => {}, warn: () => {} });
const service = new AiService(router);
const documentStore = new DocumentStore({ dir: process.env.NAGEX_DOCUMENTS_DIR });
const artifactStore = new ArtifactStore({ dir: process.env.NAGEX_ARTIFACTS_DIR });
const runtime = new CreationRuntime([new DocumentExecutor({ aiService: service, documentStore, artifactStore })]);
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const hangul = (text) => { const h = (String(text).match(/[ㄱ-ㆎ가-힣]/g) || []).length; const l = (String(text).match(/[A-Za-z]/g) || []).length + h; return l ? Math.round((100 * h) / l) : 0; };

const OWNER = { tenantId: 'ten_doc_cert', ownerId: 'usr_doc_cert' };
const STRANGER = { tenantId: 'ten_doc_cert', ownerId: 'usr_doc_cert_other' };
const REQUESTS = [
  { id: 'ko', prompt: '다음 주 제품 출시 회의를 위한 한 페이지 요약 보고서를 작성해줘. 주제는 개인 AI 비서의 승인 기반 실행이야.', locale: 'ko' },
  { id: 'en', prompt: "Write a one-page report for next week's launch meeting about approval-based execution in a personal AI assistant.", locale: 'en' },
];
const rows = [];
for (const req of REQUESTS) {
  const row = { id: req.id, create: 'ERROR', provider: '-', model: '-', latencyMs: 0, chars: 0, hangul: -1, saved: false, inRecent: false, reopenedSame: false, strangerDenied: false, note: '' };
  const started = Date.now();
  try {
    const result = await runtime.create({ creationKind: 'DOCUMENT', prompt: req.prompt, options: { documentKind: 'REPORT', locale: req.locale, format: 'MARKDOWN' }, ...OWNER, requestId: `req_doc_cert_${req.id}` });
    row.latencyMs = Date.now() - started;
    row.create = result.status;
    if (result.status === 'SUCCESS') {
      row.provider = result.metadata?.provider ?? '-';
      row.model = result.metadata?.model ?? '-';
      const stored = documentStore.get(result.creationId, OWNER.tenantId, OWNER.ownerId);
      row.saved = Boolean(stored && stored.content && stored.content.trim().length > 50);
      row.chars = stored?.content?.length ?? 0;
      row.hangul = hangul(stored?.content ?? '');
      const listed = artifactStore.list(OWNER.tenantId, OWNER.ownerId).find((a) => a.sourceId === result.creationId);
      row.inRecent = Boolean(listed && listed.type === 'DOCUMENT' && listed.title);
      // a restart: brand-new store instances over the same files
      const reopened = new DocumentStore({ dir: process.env.NAGEX_DOCUMENTS_DIR }).get(result.creationId, OWNER.tenantId, OWNER.ownerId);
      const reopenedArtifact = new ArtifactStore({ dir: process.env.NAGEX_ARTIFACTS_DIR }).list(OWNER.tenantId, OWNER.ownerId).find((a) => a.sourceId === result.creationId);
      row.reopenedSame = Boolean(reopened && stored && sha(reopened.content) === sha(stored.content) && reopened.title === stored.title && reopenedArtifact);
      row.strangerDenied = !documentStore.get(result.creationId, STRANGER.tenantId, STRANGER.ownerId) && !artifactStore.list(STRANGER.tenantId, STRANGER.ownerId).some((a) => a.sourceId === result.creationId);
      row.note = `sha=${sha(stored?.content ?? '')}`;
    } else {
      row.note = `${result.errorCode ?? ''}`;
    }
  } catch (error) {
    row.note = `${typeof error?.code === 'string' ? error.code : 'ERROR'}`;
    row.latencyMs = Date.now() - started;
  }
  rows.push(row);
}
fs.rmSync(root, { recursive: true, force: true });
const pad = (v, n) => String(v).padEnd(n);
console.log(`\n${pad('id', 5)}${pad('create', 10)}${pad('provider', 9)}${pad('model', 30)}${pad('ms', 8)}${pad('chars', 7)}${pad('hangul%', 8)}${pad('saved', 7)}${pad('recent', 8)}${pad('reopen', 8)}${pad('stranger', 9)}note`);
for (const r of rows) console.log(`${pad(r.id, 5)}${pad(r.create, 10)}${pad(r.provider, 9)}${pad(r.model, 30)}${pad(r.latencyMs, 8)}${pad(r.chars, 7)}${pad(r.hangul, 8)}${pad(r.saved, 7)}${pad(r.inRecent, 8)}${pad(r.reopenedSame, 8)}${pad(r.strangerDenied, 9)}${r.note}`);
const pass = rows.every((r) => r.create === 'SUCCESS' && r.saved && r.inRecent && r.reopenedSame && r.strangerDenied)
  && rows.find((r) => r.id === 'ko').hangul >= 50 && rows.find((r) => r.id === 'en').hangul <= 5;
console.log(`REAL_DOCUMENT_ROUNDTRIP=${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
