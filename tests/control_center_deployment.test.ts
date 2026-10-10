import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { CONTROL_CENTER_BOUNDARY, CONTROL_CENTER_NAV, CONTROL_CENTER_ROUTES } from '../src/control-center/index.js';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

test('Control Center deployment app is independent from user-facing app', () => {
  assert.equal(CONTROL_CENTER_BOUNDARY.appBoundary, 'apps/control-center');
  assert.equal(CONTROL_CENTER_BOUNDARY.productPlaneNavigation, false);
  assert.equal(fs.existsSync('apps/control-center/index.html'), true);
  assert.equal(fs.existsSync('apps/control-center/server.mjs'), true);
  assert.equal(fs.existsSync('public/index.html'), true);
});

test('test shell exposes required operator navigation and TEST environment', () => {
  const html = read('apps/control-center/index.html');
  const app = read('apps/control-center/app.js');
  assert.ok(html.includes('NAgex Control Center'));
  assert.ok(html.includes('TEST'));
  for (const label of CONTROL_CENTER_NAV) {
    assert.ok(app.includes(label), `missing nav label ${label}`);
  }
});

test('route manifest matches Control Center route contract', () => {
  const manifest = JSON.parse(read('apps/control-center/routes.json')) as { adminApiNamespace: string; routes: string[] };
  assert.equal(manifest.adminApiNamespace, CONTROL_CENTER_BOUNDARY.adminApiNamespace);
  assert.deepEqual(manifest.routes, [...CONTROL_CENTER_ROUTES]);
});

test('server uses loopback admin API boundary and no external app route', () => {
  const server = read('apps/control-center/server.mjs');
  assert.ok(server.includes("process.env.HOST ?? '127.0.0.1'"));
  assert.ok(server.includes("process.env.PORT ?? '4500'"));
  assert.ok(server.includes('/admin/api/health'));
  assert.ok(server.includes("url.pathname.startsWith('/admin/api/')"));
  assert.ok(server.includes('ADMIN_AUTH_REQUIRED'));
  assert.equal(server.includes('ACTION_VIEW'), false);
});

test('admin session is separate and narrowly scoped', () => {
  const server = read('apps/control-center/server.mjs');
  assert.ok(server.includes('__Host-nagex_admin_session'));
  assert.ok(server.includes('Path=/admin'));
  assert.ok(server.includes('HttpOnly'));
  assert.ok(server.includes('Secure'));
  assert.ok(server.includes('SameSite=Strict'));
  assert.equal(server.includes('Domain=.agex.site'), false);
});

test('baseline security headers are emitted by the app server', () => {
  const server = read('apps/control-center/server.mjs');
  for (const header of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'X-Frame-Options']) {
    assert.ok(server.includes(header), `missing ${header}`);
  }
  assert.ok(server.includes("frame-ancestors 'none'"));
});

test('systemd service is dedicated, non-root and loopback-only', () => {
  const service = read('deploy/control-center/nagex-control.service');
  assert.ok(service.includes('Description=NAgex Control Center'));
  assert.ok(service.includes('User=redcloud'));
  assert.ok(service.includes('WorkingDirectory=/home/redcloud/services/nagex/source'));
  assert.ok(service.includes('apps/control-center/server.mjs'));
  assert.ok(service.includes('Environment=HOST=127.0.0.1'));
  assert.ok(service.includes('Environment=PORT=4500'));
  assert.ok(service.includes('NoNewPrivileges=true'));
  assert.equal(service.includes('User=root'), false);
});

test('Cloudflare ingress template adds only the expected hostname and origin', () => {
  const ingress = read('deploy/control-center/cloudflared-ingress.example.yml');
  assert.ok(ingress.includes('control-test.agex.site'));
  assert.ok(ingress.includes('http://127.0.0.1:4500'));
  assert.equal(ingress.includes('0.0.0.0'), false);
});

test('deployment artifacts do not contain committed secrets', () => {
  const files = [
    'apps/control-center/server.mjs',
    'deploy/control-center/control-center.env.example',
    'deploy/control-center/README.md',
    'deploy/control-center/nagex-control.service',
  ];
  const combined = files.map(read).join('\n');
  assert.equal(combined.includes('sk-'), false);
  assert.equal(combined.includes('OPENAI_API_KEY='), false);
  assert.equal(combined.includes('NAGEX_TTS_OPENAI_API_KEY='), false);
  assert.equal(combined.includes('cloudflared tunnel token'), false);
});

test('deployment cert script records safety properties', () => {
  const cert = read('scripts/control-center-deploy-cert.mjs');
  assert.ok(cert.includes('independentControlCenterApp: true'));
  assert.ok(cert.includes("hostname: 'control-test.agex.site'"));
  assert.ok(cert.includes('hackathonUserFlowChanged: false'));
  assert.ok(cert.includes('rawUserPrivateContentExposed: false'));
});
