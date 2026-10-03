// R24.7B — shared real-server harness for the Canvas Ask browser tests (not a test file).
//
// Starts the REAL production server in-process (createServerInstance), with the
// artifact/document data dirs pointed at a private temp dir. Seeds real
// ArtifactStore / DocumentStore / CaptureStore records for disposable accounts
// created through the production Identity/Session stores. No model is faked here:
// the server uses whatever providers its own environment configures, and
// `scrubProviders` removes every provider credential so the server has NONE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import type { ArtifactType } from '../src/artifacts/artifact.types.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';

export const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NEBIUS_API_KEY', 'NVIDIA_API_KEY',
  'NAGEX_OPENAI_MODEL', 'NAGEX_GEMINI_MODEL', 'NAGEX_NEBIUS_MODEL', 'NAGEX_ASTRA_MODEL', 'NAGEX_PROVIDER_PRIORITY',
];

export interface DisposableUser { userId: string; tenantId: string; sessionId: string }

export interface CanvasAskHarness {
  origin: string;
  browser: Browser;
  dataDir: string;
  artifactStore: ArtifactStore;
  documentStore: DocumentStore;
  newContext(kind: 'desktop' | 'mobile', user?: DisposableUser, locale?: 'en' | 'ko'): Promise<BrowserContext>;
  user(label: string): DisposableUser;
  // An authenticated account's profile.locale is the canonical language (it overrides localStorage on load).
  setLocale(user: DisposableUser, locale: 'en' | 'ko'): void;
  seedDocument(owner: { userId: string; tenantId: string }, opts: { title: string; content: string; at?: string; revision?: number }): { artifactId: string; documentId: string };
  seedAnalysis(owner: { userId: string; tenantId: string }, opts: { title: string; summary: string; at?: string }): { artifactId: string; captureId: string };
  seedOther(owner: { userId: string; tenantId: string }, type: ArtifactType, opts: { title: string; preview: string; at?: string }): { artifactId: string };
  documentFileHash(documentId: string): string;
  close(): Promise<void>;
}

export async function startCanvasAskHarness(opts: { scrubProviders: boolean }): Promise<CanvasAskHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r247b-browser-'));
  process.env.NAGEX_ARTIFACTS_DIR = path.join(dataDir, 'artifacts');
  process.env.NAGEX_DOCUMENTS_DIR = path.join(dataDir, 'documents');
  if (opts.scrubProviders) for (const key of PROVIDER_ENV_KEYS) delete process.env[key];

  // Dynamic import AFTER the environment is prepared: the production composition root runs at module load.
  const server = await import('../src/server_web.js');
  const { captureStore } = await import('../src/workspace/capture.store.js');
  const instance = server.createServerInstance();
  await new Promise<void>((resolve, reject) => { instance.listen(0, '127.0.0.1', () => resolve()); instance.once('error', reject); });
  const origin = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true });

  const artifactStoreFor = (at?: string) => new ArtifactStore({ dir: process.env.NAGEX_ARTIFACTS_DIR, now: at ? () => at : undefined });
  const documentStore = new DocumentStore({ dir: process.env.NAGEX_DOCUMENTS_DIR });
  let counter = 0;
  const RUN = `${Date.now()}`;

  return {
    origin, browser, dataDir,
    artifactStore: artifactStoreFor(),
    documentStore,
    async newContext(kind, user, locale = 'en') {
      const ctx = await browser.newContext(kind === 'mobile'
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: locale === 'ko' ? 'ko-KR' : 'en-US' }
        : { viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
      if (user) await ctx.addCookies([{ name: 'nagex_session', value: user.sessionId, url: origin }]);
      await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
      return ctx;
    },
    user(label) {
      const { identity } = server.identityStore.createAccount(`r247b_${label}_${RUN}_${++counter}@example.invalid`, hashPassword('Disposable-Pass-1!'));
      server.identityStore.transitionState(identity.userId, 'ACTIVE');
      const tenantId = `ten_${identity.userId}`;
      const session = server.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN');
      return { userId: identity.userId, tenantId, sessionId: session.sessionId };
    },
    setLocale(user, locale) { server.identityStore.updateProfile(user.userId, { locale }); },
    seedDocument(owner, o) {
      const documentId = `doc_r247b_${RUN}_${++counter}`;
      const at = o.at ?? new Date().toISOString();
      documentStore.save({ documentId, tenantId: owner.tenantId, ownerId: owner.userId, title: o.title, summary: 'summary', content: o.content, documentKind: 'REPORT', locale: 'en', format: 'MARKDOWN', sourceRefs: [], revisionIndex: o.revision ?? 1, createdAt: at, updatedAt: at });
      const rec = artifactStoreFor(at).saveCompleted({ tenantId: owner.tenantId, ownerId: owner.userId, type: 'DOCUMENT', title: o.title, preview: 'summary', sourceType: 'CAPTURE', sourceId: documentId, openTarget: `/api/v1/creations/documents/${documentId}` });
      return { artifactId: rec.artifactId, documentId };
    },
    seedAnalysis(owner, o) {
      const at = o.at ?? new Date().toISOString();
      const cap = captureStore.createCapture({ ownerId: owner.userId, tenantId: owner.tenantId, type: 'FILE', content: 'object-storage/private/key.pdf', metadata: { originalName: 'private-name.pdf', extractedTitle: o.title, extractedSummary: o.summary, extractedTags: ['r247b'] } });
      const rec = artifactStoreFor(at).saveCompleted({ tenantId: owner.tenantId, ownerId: owner.userId, type: 'ANALYSIS', title: o.title, preview: o.summary, sourceType: 'CAPTURE', sourceId: cap.captureId, openTarget: `#inbox/${cap.captureId}` });
      return { artifactId: rec.artifactId, captureId: cap.captureId };
    },
    seedOther(owner, type, o) {
      const at = o.at ?? new Date().toISOString();
      const sourceId = `src_${type}_${RUN}_${++counter}`;
      const openTarget = type === 'IMAGE' ? `/api/v1/creations/images/${sourceId}` : `/api/v1/artifacts/by-source/${sourceId}`;
      const rec = artifactStoreFor(at).saveCompleted({ tenantId: owner.tenantId, ownerId: owner.userId, type, title: o.title, preview: o.preview, sourceType: type === 'RESEARCH' ? 'RESEARCH_RESULT' : 'CAPTURE', sourceId, openTarget });
      return { artifactId: rec.artifactId };
    },
    documentFileHash(documentId) {
      const dir = process.env.NAGEX_DOCUMENTS_DIR!;
      const files = fs.readdirSync(dir).filter((f) => f.includes(documentId));
      return crypto.createHash('sha256').update(files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('|')).digest('hex');
    },
    async close() {
      await browser.close();
      if (typeof (instance as any).closeIdleConnections === 'function') (instance as any).closeIdleConnections();
      await new Promise<void>((res) => instance.close(() => res()));
    },
  };
}
