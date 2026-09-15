// DC3-B1-R1-R1 — deterministic public asset resolution for the Electron
// host, fixing the real bug found on real Windows: desktop-app.ts resolved
// icon paths as `path.join(__dirname, '../../public/assets/X')`, which
// only works if `public/` sits at a fixed depth relative to the COMPILED
// output. It doesn't: `tsc` compiles .ts -> dist/src/**, it never copies
// public/ into dist/public/ at all, so `dist/public/assets/X` never
// existed — off by one directory level, not a missing copy step.
//
// The real fix: never count __dirname levels. Electron's own
// app.getAppPath() returns the app's root directory in BOTH dev mode
// (the project root, since package.json's `main` lives there) and a
// packaged build (electron-builder's `files` config in package.json
// bundles `public/**/*` alongside `dist/**/*` at the SAME relative
// structure as the source tree — confirmed against this repo's own
// electron-builder config, not assumed) — so `<appPath>/public/<rel>` is
// correct in both cases, with zero __dirname-relative counting.
//
// Deliberately takes appPath/isPackaged as plain parameters rather than
// importing `electron` here — this module is fully testable under plain
// Node; only desktop-app.ts (Electron-only, untestable) passes the real
// `app.getAppPath()`/`app.isPackaged` values in.
import fs from 'node:fs';
import path from 'node:path';

export interface AssetPathResolverOptions {
  appPath: string;
  isPackaged: boolean;
}

export function resolvePublicAsset(options: AssetPathResolverOptions, relativeAssetPath: string): string {
  return path.join(options.appPath, 'public', relativeAssetPath);
}

// Returns the first candidate that genuinely exists on disk, or null if
// none do — callers decide how to fail safely/truthfully (never silently
// returned a path that doesn't resolve to a real file).
export function resolveExistingPublicAsset(options: AssetPathResolverOptions, candidateRelativePaths: string[]): string | null {
  for (const relativeAssetPath of candidateRelativePaths) {
    const resolved = resolvePublicAsset(options, relativeAssetPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}
