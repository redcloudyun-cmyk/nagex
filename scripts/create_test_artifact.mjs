import { IdentityStore } from '../dist/src/identity/identity.store.js';
import { SessionStore } from '../dist/src/sessions/session.store.js';
import { ImageStore } from '../dist/src/creation/image.store.js';
import { ArtifactStore } from '../dist/src/artifacts/artifact.store.js';
import fs from 'node:fs';

const idStore = new IdentityStore();
let identity = idStore.getByEmail('test@nagex.ai');
if (!identity) {
  const account = idStore.createAccount('test@nagex.ai', 'password123');
  identity = account.identity;
}

const tenantId = 'ten_production_01';
const ownerId = 'usr_admin_001';

const sessionStore = new SessionStore();
const session = sessionStore.getOrCreateMain(tenantId, ownerId);

const imgStore = new ImageStore();
const imageId = 'img_test_canvas_123';
// create fake image byte
if (!fs.existsSync(imgStore['bytesDir'])) fs.mkdirSync(imgStore['bytesDir'], { recursive: true });
fs.copyFileSync('public/assets/nagex-app-icon.png', imgStore['bytesDir'] + '/' + imageId + '.png');

imgStore['recordStore'].write(imageId, {
  imageId, tenantId, ownerId,
  title: 'Real Canvas Test Image', prompt: 'test prompt', mimeType: 'image/png',
  width: 1, height: 1, binaryStoragePath: imgStore['bytesDir'] + '/' + imageId + '.png',
  revisionIndex: 0, sourceRefs: [],
  providerExecutionMetadata: { providerName: 'test', durationMs: 0 },
  createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z'
});

const artStore = new ArtifactStore();
const artifactId = 'art_test_canvas_123';
artStore['records'].write(artifactId, {
  artifactId, tenantId, ownerId, type: 'IMAGE', status: 'COMPLETED',
  title: 'Real Canvas Test Image', preview: 'A real image injected via script',
  sourceType: 'CAPTURE', sourceId: imageId, openTarget: '/api/v1/creations/images/' + imageId,
  createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z'
});

console.log(session.sessionId + '|' + artifactId);
