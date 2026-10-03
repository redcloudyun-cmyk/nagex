// R23.7C-C — Artifact Delivery Identity Contract (migrated for Security Gate S1).
//
// S1: identity comes ONLY from a server-side session. Before S1 a request with no
// valid session fell back to X-NAgex-Tenant/X-Principal-Id or a default admin; that
// fallback is gone, so the former "header/default compatibility" cases (E, F, H, P)
// now assert the opposite: no session means no identity and the route refuses.
//
// Certifies the shared caller-identity resolver (src/http/request-identity.ts):
// a real, valid nagex_session (R13) cookie is authoritative
// for both POST /api/v1/creations/generate and GET
// /api/v1/creations/images/:imageId, so a native same-origin <img> request
// — which can never attach a custom header, only same-origin cookies —
// resolves to the same real identity that created the image. Caller-
// supplied X-NAgex-Tenant/X-Principal-Id headers can never override a
// valid session (closes the impersonation gap). With no valid session,
// resolution falls back to the pre-existing header/default behavior
// unchanged, field-for-field (demo mode and the existing admin/default
// single-tenant flow are preserved exactly).
//
// No real provider call — uses the same deterministic fake image provider
// as r23_7c_c_canonical_image_serving.test.ts. The pre-existing
// img_93b85a5d7a103e7bdaaeff97 record from the old identity path is never
// touched by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageExecutor } from '../src/creation/executors/image-executor.js';
import { ImageStore } from '../src/creation/image.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import type { ImageProviderPort, ImageProviderCapabilities } from '../src/creation/providers/creation-provider.types.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { CreationStore } from '../src/creation/creation.store.js';
import { CreationService } from '../src/creation/creation.service.js';
import { handleCreationRoutes } from '../src/http/routes/creation.routes.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { canonicalizeRequestHeaders, tryGetCallerIdentity } from '../src/http/request-identity.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { ensureTestAccount } from './_s1_session_auth.js';

const KNOWN_IMAGE_BYTES = Buffer.from('deterministic-known-png-bytes-for-r23-7c-c-identity');
const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

function createFakeProvider(): ImageProviderPort {
  const caps: ImageProviderCapabilities = {
    textToImage: true, imageToImage: true, editingInpainting: true, referenceImageConditioning: true,
    transparentBackground: true, textRendering: true, supportedAspectRatios: ['1:1'], maxReferenceImages: 3,
  };
  return {
    providerId: 'fake-openai',
    getStatus: () => 'AVAILABLE',
    getCapabilities: () => caps,
    generateImage: async () => ({
      status: 'COMPLETED',
      output: { imageBuffer: KNOWN_IMAGE_BYTES, mimeType: 'image/png', temporaryUrl: 'https://fake-provider.com/temp/image.png' },
      metadata: { providerId: 'fake-openai', createdAt: new Date().toISOString() },
    }),
  };
}

function setup(imagesDir?: string, sessionsDir?: string) {
  const imageStore = new ImageStore(imagesDir ? { metaDir: imagesDir, bytesDir: imagesDir } : undefined);
  const artifactStore = new ArtifactStore();
  const providerRouter = new CreationProviderRouter();
  const auditLogger = new AuditLogger();
  providerRouter.registerImageProvider(createFakeProvider());
  const imageExecutor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });
  // Isolated per-setup() directory: CreationStore's default constructor
  // persists to a stable, non-isolated on-disk location shared across
  // process runs (like ImageStore/ArtifactStore), which is harmless for
  // tests A-K (image generation never touches CreationStore — it goes
  // through imageExecutor) but would silently accumulate cross-run/
  // cross-test creations for tests L-P, which assert exact list() counts.
  const creationStore = new CreationStore({ dir: tempDir('nagex-identity-creations-') });
  const creationService = new CreationService(creationStore, auditLogger);
  const sessionStore = new SessionStore({ dir: sessionsDir ?? tempDir('nagex-identity-sessions-') });
  const identityStore = new IdentityStore({ dir: tempDir('nagex-identity-accounts-') });
  return { imageStore, artifactStore, imageExecutor, creationService, sessionStore, identityStore };
}

// The server canonicalizes headers once, at its HTTP entry points, before any route sees them.
// These tests call the route module directly, so they do the same step explicitly.
function canon(deps: ReturnType<typeof setup>, headers: Record<string, string>): Record<string, string> {
  return canonicalizeRequestHeaders(headers, { sessionStore: deps.sessionStore, identityStore: deps.identityStore }) as Record<string, string>;
}

// A real account + session for (tenantId, principalId); returns browser-style cookie headers.
function signIn(deps: ReturnType<typeof setup>, tenantId: string, principalId: string): Record<string, string> {
  ensureTestAccount(principalId, deps.identityStore);
  const session = deps.sessionStore.createAuthSession(tenantId, principalId, 'MAIN');
  return { cookie: cookieHeader(session.sessionId) };
}

function cookieHeader(sessionId: string) {
  return `nagex_session=${encodeURIComponent(sessionId)}`;
}

async function generate(deps: ReturnType<typeof setup>, headers: Record<string, string>) {
  return handleCreationRoutes(
    'POST',
    '/api/v1/creations/generate',
    { prompt: 'Artifact delivery identity test', type: 'IMAGE' },
    canon(deps, headers),
    {},
    { creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore },
  );
}

async function getImage(deps: ReturnType<typeof setup>, imageUrl: string, headers: Record<string, string>) {
  return handleCreationRoutes('GET', imageUrl, null, canon(deps, headers), {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

test('A. valid session: creation identity equals retrieval identity', async () => {
  const deps = setup();
  const session = (ensureTestAccount('usr_alice', deps.identityStore), deps.sessionStore.createAuthSession('ten_alice', 'usr_alice', 'MAIN'));
  const headers = { cookie: cookieHeader(session.sessionId) };

  const created = await generate(deps, headers);
  assert.equal(created!.status, 201);
  const imageUrl = (created!.data as any).imageUrl as string;

  const fetched = await getImage(deps, imageUrl, headers);
  assert.equal(fetched!.status, 200);
  assert.ok((fetched!.data as Buffer).equals(KNOWN_IMAGE_BYTES));
});

test('B. native image GET with a valid same-origin session cookie: 200, correct MIME, exact bytes, no custom header needed', async () => {
  const deps = setup();
  const session = (ensureTestAccount('usr_bob', deps.identityStore), deps.sessionStore.createAuthSession('ten_bob', 'usr_bob', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(session.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;

  // Simulates a native <img src="..."> request: only the cookie travels,
  // no X-NAgex-Tenant/X-Principal-Id header at all.
  const res = await getImage(deps, imageUrl, { cookie: cookieHeader(session.sessionId) });
  assert.equal(res!.status, 200);
  assert.equal((res as any).isBinary, true);
  assert.equal((res as any).contentType, 'image/png');
  assert.ok((res!.data as Buffer).equals(KNOWN_IMAGE_BYTES));
});

test('C. wrong authenticated user (different session, same tenant) is denied: 404, no disclosure', async () => {
  const deps = setup();
  const owner = (ensureTestAccount('usr_owner', deps.identityStore), deps.sessionStore.createAuthSession('ten_shared', 'usr_owner', 'MAIN'));
  const intruder = (ensureTestAccount('usr_intruder', deps.identityStore), deps.sessionStore.createAuthSession('ten_shared', 'usr_intruder', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(owner.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;

  const res = await getImage(deps, imageUrl, { cookie: cookieHeader(intruder.sessionId) });
  assert.equal(res!.status, 404);
  assert.equal((res as any).isBinary, undefined);
});

test('D. wrong tenant (different session, different tenant) is denied: 404', async () => {
  const deps = setup();
  const owner = (ensureTestAccount('usr_x', deps.identityStore), deps.sessionStore.createAuthSession('ten_owner_co', 'usr_x', 'MAIN'));
  const victimTenant = (ensureTestAccount('usr_x', deps.identityStore), deps.sessionStore.createAuthSession('ten_other_co', 'usr_x', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(owner.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;

  const res = await getImage(deps, imageUrl, { cookie: cookieHeader(victimTenant.sessionId) });
  assert.equal(res!.status, 404);
});

test('E. an invalid or missing session establishes NO identity: the route refuses (S1: no header/default fallback)', async () => {
  const deps = setup();
  const owner = (ensureTestAccount('usr_secure', deps.identityStore), deps.sessionStore.createAuthSession('ten_secure', 'usr_secure', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(owner.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;

  const refused = (e: unknown) => (e as { code?: string }).code === 'AUTHENTICATION_REQUIRED';
  // An unknown session id establishes no identity at all.
  await assert.rejects(() => getImage(deps, imageUrl, { cookie: 'nagex_session=not-a-real-session-id' }), refused);
  // A malformed credential is the same: controlled refusal, never an exception from the parser.
  await assert.rejects(() => getImage(deps, imageUrl, { cookie: 'nagex_session=%E0%A4%A' }), refused);
  // No credential at all.
  await assert.rejects(() => getImage(deps, imageUrl, {}), refused);
});

test('F. S1: identity headers alone carry no authority — creating and reading an image both refuse', async () => {
  const deps = setup();
  const forged = { 'x-nagex-tenant': 'ten_legacy', 'x-principal-id': 'usr_legacy' };
  const refused = (e: unknown) => (e as { code?: string }).code === 'AUTHENTICATION_REQUIRED';
  await assert.rejects(() => generate(deps, forged), refused);
  await assert.rejects(() => getImage(deps, '/api/v1/creations/images/img_anything', forged), refused);
});

test('G. a valid session cannot be overridden by caller-supplied identity headers (impersonation denial)', async () => {
  const deps = setup();
  const alice = (ensureTestAccount('usr_alice2', deps.identityStore), deps.sessionStore.createAuthSession('ten_alice2', 'usr_alice2', 'MAIN'));

  // Alice's own valid session, but headers CLAIM to be a totally different
  // tenant/user. If headers could override a valid session, this would
  // resolve as an impersonation of ten_victim/usr_victim.
  const identity = tryGetCallerIdentity(canon(deps, { cookie: cookieHeader(alice.sessionId), 'x-nagex-tenant': 'ten_victim', 'x-principal-id': 'usr_victim' }))!;
  assert.equal(identity.source, 'SESSION');
  assert.equal(identity.tenantId, 'ten_alice2');
  assert.equal(identity.principalId, 'usr_alice2');

  // End-to-end: an image generated under Alice's session, then fetched
  // with the SAME valid session but spoofed headers, still succeeds as
  // Alice (headers ignored) — it does not leak into pretending to be
  // ten_victim/usr_victim's identity.
  const created = await generate(deps, { cookie: cookieHeader(alice.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;
  const res = await getImage(deps, imageUrl, {
    cookie: cookieHeader(alice.sessionId),
    'x-nagex-tenant': 'ten_victim',
    'x-principal-id': 'usr_victim',
  });
  assert.equal(res!.status, 200, 'session identity must win over spoofed headers, still serving Alice\'s own image');
});

test('H. ImageStore strict tenant+owner equality authorization is unchanged by this resolver', async () => {
  const deps = setup();
  const created = await generate(deps, signIn(deps, 'ten_h', 'usr_h'));
  const imageId = (created!.data as any).creationId as string;
  const rightOwner = deps.imageStore.get(imageId, 'ten_h', 'usr_h');
  const wrongOwner = deps.imageStore.get(imageId, 'ten_h', 'usr_not_h');
  assert.ok(rightOwner);
  assert.equal(wrongOwner, null);
});

test('I. no cross-tenant artifact disclosure (session path)', async () => {
  const deps = setup();
  const a = (ensureTestAccount('usr_i', deps.identityStore), deps.sessionStore.createAuthSession('ten_i_a', 'usr_i', 'MAIN'));
  const b = (ensureTestAccount('usr_i', deps.identityStore), deps.sessionStore.createAuthSession('ten_i_b', 'usr_i', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(a.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;
  const res = await getImage(deps, imageUrl, { cookie: cookieHeader(b.sessionId) });
  assert.equal(res!.status, 404);
  assert.equal(JSON.stringify(res!.data).includes('ten_i_a'), false, 'denial response must never disclose the real tenant');
});

test('J. no cross-owner artifact disclosure (session path)', async () => {
  const deps = setup();
  const a = (ensureTestAccount('usr_j_a', deps.identityStore), deps.sessionStore.createAuthSession('ten_j', 'usr_j_a', 'MAIN'));
  const b = (ensureTestAccount('usr_j_b', deps.identityStore), deps.sessionStore.createAuthSession('ten_j', 'usr_j_b', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(a.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;
  const res = await getImage(deps, imageUrl, { cookie: cookieHeader(b.sessionId) });
  assert.equal(res!.status, 404);
  assert.equal(JSON.stringify(res!.data).includes('usr_j_a'), false, 'denial response must never disclose the real owner');
});

test('K. restart persistence: a fresh SessionStore/ImageStore pointed at the same directories still resolve identity and serve the image', async () => {
  const imagesDir = tempDir('nagex-identity-images-');
  const sessionsDir = tempDir('nagex-identity-sessions-restart-');
  const deps = setup(imagesDir, sessionsDir);
  const session = (ensureTestAccount('usr_restart', deps.identityStore), deps.sessionStore.createAuthSession('ten_restart', 'usr_restart', 'MAIN'));
  const created = await generate(deps, { cookie: cookieHeader(session.sessionId) });
  const imageUrl = (created!.data as any).imageUrl as string;

  // Fresh instances, same on-disk directories — simulates a service restart.
  const restarted = setup(imagesDir, sessionsDir);
  ensureTestAccount('usr_restart', restarted.identityStore);
  const res = await handleCreationRoutes('GET', imageUrl, null, canon(restarted, { cookie: cookieHeader(session.sessionId) }), {}, {
    creationService: restarted.creationService, imageExecutor: restarted.imageExecutor, imageStore: restarted.imageStore, sessionStore: restarted.sessionStore,
  });
  assert.equal(res!.status, 200);
  assert.ok((res!.data as Buffer).equals(KNOWN_IMAGE_BYTES));
});

// ---------------------------------------------------------------------
// Route-identity-consistency completion: LIST, generic GET, and VARIATION
// were migrated to the same resolveRequestIdentity() resolver as generate
// and image-GET above. These use plain (non-image) creations via
// creationService.generateCreation() — deterministic, local, no provider
// call — so the shared resolver's session/header/default precedence can be
// exercised on these three remaining routes without duplicating the
// image-specific fixtures already covered by tests A-K.
// ---------------------------------------------------------------------

async function generateText(deps: ReturnType<typeof setup>, headers: Record<string, string>) {
  return handleCreationRoutes(
    'POST',
    '/api/v1/creations/generate',
    { prompt: 'Route identity consistency test (text)' },
    canon(deps, headers),
    {},
    { creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore },
  );
}

async function list(deps: ReturnType<typeof setup>, headers: Record<string, string>) {
  return handleCreationRoutes('GET', '/api/v1/creations', null, canon(deps, headers), {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

async function getGeneric(deps: ReturnType<typeof setup>, creationId: string, headers: Record<string, string>) {
  return handleCreationRoutes('GET', `/api/v1/creations/${creationId}`, null, canon(deps, headers), {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

async function postVariation(deps: ReturnType<typeof setup>, creationId: string, headers: Record<string, string>) {
  return handleCreationRoutes('POST', `/api/v1/creations/${creationId}/variation`, { promptModifier: 'add sparkles' }, canon(deps, headers), {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

test('L. LIST (GET /api/v1/creations) uses session identity, never leaking another session\'s creations', async () => {
  const deps = setup();
  const alice = (ensureTestAccount('usr_list_a', deps.identityStore), deps.sessionStore.createAuthSession('ten_list_a', 'usr_list_a', 'MAIN'));
  const bob = (ensureTestAccount('usr_list_b', deps.identityStore), deps.sessionStore.createAuthSession('ten_list_b', 'usr_list_b', 'MAIN'));
  await generateText(deps, { cookie: cookieHeader(alice.sessionId) });
  await generateText(deps, { cookie: cookieHeader(bob.sessionId) });

  const aliceList = await list(deps, { cookie: cookieHeader(alice.sessionId) });
  const bobList = await list(deps, { cookie: cookieHeader(bob.sessionId) });
  assert.equal((aliceList!.data as any).creations.length, 1);
  assert.equal((bobList!.data as any).creations.length, 1);
  assert.notEqual((aliceList!.data as any).creations[0].creationId, (bobList!.data as any).creations[0].creationId);
});

test('M. generic GET (GET /api/v1/creations/:id) uses session identity: right session succeeds, wrong session denies (404, no disclosure)', async () => {
  const deps = setup();
  const owner = (ensureTestAccount('usr_get_owner', deps.identityStore), deps.sessionStore.createAuthSession('ten_get_owner', 'usr_get_owner', 'MAIN'));
  const intruder = (ensureTestAccount('usr_get_intruder', deps.identityStore), deps.sessionStore.createAuthSession('ten_get_owner', 'usr_get_intruder', 'MAIN'));
  const created = await generateText(deps, { cookie: cookieHeader(owner.sessionId) });
  const creationId = (created!.data as any).creationId as string;

  const rightful = await getGeneric(deps, creationId, { cookie: cookieHeader(owner.sessionId) });
  assert.equal(rightful!.status, 200);
  assert.equal((rightful!.data as any).creation.creationId, creationId);

  const denied = await getGeneric(deps, creationId, { cookie: cookieHeader(intruder.sessionId) });
  assert.equal(denied!.status, 404);
  assert.equal((denied!.data as any).error, 'CREATION_NOT_FOUND');
});

test('N. VARIATION (POST /api/v1/creations/:id/variation) uses session identity: right session succeeds, wrong session denies', async () => {
  const deps = setup();
  const owner = (ensureTestAccount('usr_var_owner', deps.identityStore), deps.sessionStore.createAuthSession('ten_var_owner', 'usr_var_owner', 'MAIN'));
  const intruder = (ensureTestAccount('usr_var_intruder', deps.identityStore), deps.sessionStore.createAuthSession('ten_var_owner', 'usr_var_intruder', 'MAIN'));
  const created = await generateText(deps, { cookie: cookieHeader(owner.sessionId) });
  const creationId = (created!.data as any).creationId as string;

  const rightful = await postVariation(deps, creationId, { cookie: cookieHeader(owner.sessionId) });
  assert.equal(rightful!.status, 201);
  assert.equal((rightful!.data as any).parentCreationId, creationId);

  const denied = await postVariation(deps, creationId, { cookie: cookieHeader(intruder.sessionId) });
  assert.equal(denied!.status, 404);
  assert.equal((denied!.data as any).error, 'CREATION_NOT_FOUND');
});

test('O. spoofed identity headers cannot override a valid session on LIST, generic GET, or VARIATION', async () => {
  const deps = setup();
  const alice = (ensureTestAccount('usr_spoof_a', deps.identityStore), deps.sessionStore.createAuthSession('ten_spoof_a', 'usr_spoof_a', 'MAIN'));
  const created = await generateText(deps, { cookie: cookieHeader(alice.sessionId) });
  const creationId = (created!.data as any).creationId as string;
  const spoofedHeaders = { cookie: cookieHeader(alice.sessionId), 'x-nagex-tenant': 'ten_victim', 'x-principal-id': 'usr_victim' };

  const listRes = await list(deps, spoofedHeaders);
  assert.equal((listRes!.data as any).creations.length, 1, 'LIST must still resolve as Alice, not the spoofed victim identity');
  assert.equal((listRes!.data as any).creations[0].creationId, creationId);

  const getRes = await getGeneric(deps, creationId, spoofedHeaders);
  assert.equal(getRes!.status, 200, 'generic GET must still resolve as Alice, not the spoofed victim identity');

  const varRes = await postVariation(deps, creationId, spoofedHeaders);
  assert.equal(varRes!.status, 201, 'VARIATION must still resolve as Alice, not the spoofed victim identity');
});

test('P. S1: header-only callers are refused on GENERATE, LIST, generic GET and VARIATION (no legacy compatibility)', async () => {
  const deps = setup();
  const headers = { 'x-nagex-tenant': 'ten_legacy_p', 'x-principal-id': 'usr_legacy_p' };
  const refused = (e: unknown) => (e as { code?: string }).code === 'AUTHENTICATION_REQUIRED';
  await assert.rejects(() => generateText(deps, headers), refused);
  await assert.rejects(() => list(deps, headers), refused);
  await assert.rejects(() => getGeneric(deps, 'cr_anything', headers), refused);
  await assert.rejects(() => postVariation(deps, 'cr_anything', headers), refused);
});
