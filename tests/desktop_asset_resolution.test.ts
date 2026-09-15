// DC3-B1-R1-R1 — deterministic asset path resolution for the Electron host.
//
// Proves the real fix: resolution never depends on __dirname-relative
// counting from the COMPILED output (which broke — tsc never copies
// public/ into dist/public/, so the old `path.join(__dirname,
// '../../public/assets/X')` was off by one directory level and always
// resolved to a nonexistent dist/public/). resolvePublicAsset() instead
// resolves relative to an explicit `appPath` (Electron's own
// app.getAppPath() in production) — proven here for both the dev shape
// (the real project root) and the packaged shape (an arbitrary directory
// with no dist/ at all, mirroring how electron-builder's own `files`
// config bundles public/ alongside dist/ at the app root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePublicAsset, resolveExistingPublicAsset } from '../src/desktop/asset-path.resolver.js';

test('ELECTRON_DEV_ASSET_PATH_RESOLVES: the real project root resolves a real, existing asset with zero __dirname-relative counting', () => {
  const appPath = process.cwd(); // matches Electron's app.getAppPath() in dev mode (nearest package.json)
  const resolved = resolvePublicAsset({ appPath, isPackaged: false }, 'assets/nagex-app-icon.png');
  assert.equal(resolved, path.join(appPath, 'public', 'assets', 'nagex-app-icon.png'));
  assert.ok(fs.existsSync(resolved), 'the real dev-mode asset must actually exist on disk at the resolved path');
});

test('ELECTRON_PACKAGED_ASSET_PATH_RESOLVES: an arbitrary app root with no dist/ at all still resolves correctly', () => {
  const packagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-packaged-app-'));
  fs.mkdirSync(path.join(packagedRoot, 'public', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(packagedRoot, 'public', 'assets', 'nagex-app-icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // Deliberately NO dist/ directory exists under packagedRoot at all —
  // proves resolution is genuinely independent of the compiled-output
  // directory structure, not just coincidentally correct in dev.
  assert.ok(!fs.existsSync(path.join(packagedRoot, 'dist')));

  const resolved = resolvePublicAsset({ appPath: packagedRoot, isPackaged: true }, 'assets/nagex-app-icon.png');
  assert.ok(fs.existsSync(resolved));
});

test('resolveExistingPublicAsset falls through candidates and returns null (never a guessed nonexistent path) when none exist', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-empty-app-'));
  const result = resolveExistingPublicAsset({ appPath: emptyRoot, isPackaged: false }, ['assets/favicon.png', 'assets/nagex-app-icon.png']);
  assert.equal(result, null);
});

test('resolveExistingPublicAsset resolves the real repository favicon.png as the primary candidate', () => {
  const appPath = process.cwd();
  const result = resolveExistingPublicAsset({ appPath, isPackaged: false }, ['assets/favicon.png', 'assets/nagex-app-icon.png']);
  assert.equal(result, path.join(appPath, 'public', 'assets', 'favicon.png'));
});
