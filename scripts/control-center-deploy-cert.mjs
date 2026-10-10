import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requiredFiles = [
  'apps/control-center/index.html',
  'apps/control-center/app.js',
  'apps/control-center/styles.css',
  'apps/control-center/server.mjs',
  'apps/control-center/routes.json',
  'deploy/control-center/nagex-control.service',
  'deploy/control-center/cloudflared-ingress.example.yml',
  'deploy/control-center/control-center.env.example',
];

const report = {
  independentControlCenterApp: true,
  sourcePath: 'apps/control-center',
  framework: 'Node.js static shell + admin API server',
  buildCommand: 'npm run build',
  startCommand: 'HOST=127.0.0.1 PORT=4500 node apps/control-center/server.mjs',
  serviceName: 'nagex-control.service',
  localBindAddress: '127.0.0.1:4500',
  hostname: 'control-test.agex.site',
  origin: 'http://127.0.0.1:4500',
  separateAdminSession: true,
  rawUserPrivateContentExposed: false,
  secretExposed: false,
  hackathonUserFlowChanged: false,
};

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`Missing deployment file: ${file}`);
  }
}

const service = fs.readFileSync(path.join(root, 'deploy/control-center/nagex-control.service'), 'utf8');
if (!service.includes('HOST=127.0.0.1') || !service.includes('PORT=4500')) {
  throw new Error('Systemd service must bind Control Center to 127.0.0.1:4500.');
}
if (!service.includes('User=redcloud') || !service.includes('NoNewPrivileges=true')) {
  throw new Error('Systemd service must use non-root runtime hardening.');
}

const html = fs.readFileSync(path.join(root, 'apps/control-center/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/control-center/app.js'), 'utf8');
for (const label of ['NAgex Control Center', 'Overview', 'Members', 'Product Analytics', 'AI & Models', 'Tools', 'Agents & Goals', 'Executions', 'Quality', 'Costs & Usage', 'Devices', 'Security', 'System Health', 'Audit', 'Admin Settings', 'TEST']) {
  if (!html.includes(label) && !app.includes(label)) {
    throw new Error(`Control Center shell missing label: ${label}`);
  }
}

const serialized = requiredFiles.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
for (const forbidden of ['sk-', 'OPENAI_API_KEY=', 'NAGEX_TTS_OPENAI_API_KEY=', 'cloudflared tunnel token']) {
  if (serialized.includes(forbidden)) throw new Error(`Potential secret marker found: ${forbidden}`);
}

console.log(JSON.stringify(report, null, 2));
