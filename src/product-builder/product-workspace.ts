// The isolated workspace of a project: a directory this module owns, into which GENERATED files are written - and nothing else ever happens to them on the NAgex host.
//
// What makes it isolated (and what does not): generated content is only ever (a) written here as plain files after strict checks, (b) opened by a headless browser whose network is limited to this
// workspace (browser sandbox; see site-tester.ts), (c) served to the owner inside a sandboxed frame with a restrictive Content-Security-Policy, and (d) uploaded to a deployment target the person
// approved. It is NEVER executed by Node on this host: no install scripts, no build scripts, no shell. A project that needs those cannot be built by this module - it ends in BLOCKED (SANDBOX).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateResourceId } from '../common/utils.js';
import type { WorkspaceFile } from './product-builder.types.js';

export const WORKSPACE_LIMITS = Object.freeze({ maxFiles: 40, maxFileBytes: 400_000, maxTotalBytes: 2_000_000, maxPathLength: 120 });
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.md', '.ico', '.png', '.webmanifest']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

export type WorkspacePathCheck = { ok: true; normalized: string } | { ok: false; code: 'PATH_EMPTY' | 'PATH_TOO_LONG' | 'PATH_NOT_RELATIVE' | 'PATH_TRAVERSAL' | 'PATH_SEGMENT_INVALID' | 'EXTENSION_NOT_ALLOWED' };

export function checkWorkspacePath(raw: unknown): WorkspacePathCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, code: 'PATH_EMPTY' };
  if (raw.length > WORKSPACE_LIMITS.maxPathLength) return { ok: false, code: 'PATH_TOO_LONG' };
  if (raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) return { ok: false, code: 'PATH_NOT_RELATIVE' };
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return { ok: false, code: 'PATH_TRAVERSAL' };
    if (!SEGMENT.test(segment)) return { ok: false, code: 'PATH_SEGMENT_INVALID' };
  }
  const ext = path.posix.extname(segments[segments.length - 1]).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return { ok: false, code: 'EXTENSION_NOT_ALLOWED' };
  return { ok: true, normalized: segments.join('/') };
}

export interface GeneratedFile { path: string; content: string | Buffer }

export type WorkspaceWriteResult = { ok: true; files: WorkspaceFile[] } | { ok: false; code: string; detail: string };

export class ProductWorkspaceStore {
  constructor(private readonly baseDir: string) {}

  public dirFor(projectId: string, workspaceId: string): string {
    if (!/^pbp_[0-9a-f]{12,}$/.test(projectId) || !/^ws_[0-9a-f]{12,}$/.test(workspaceId)) throw new Error('INVALID_WORKSPACE_ID');
    return path.join(this.baseDir, projectId, workspaceId);
  }

  /** where the pictures of the isolated test run are kept (next to, not inside, the files that are deployed) */
  public shotsDir(projectId: string, workspaceId: string): string {
    return `${this.dirFor(projectId, workspaceId)}.shots`;
  }

  public create(projectId: string): { workspaceId: string; dir: string } {
    const workspaceId = generateResourceId('ws');
    const dir = this.dirFor(projectId, workspaceId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { workspaceId, dir };
  }

  /** Writes the whole set or nothing: any violation rejects every file (and removes what was written). */
  public write(projectId: string, workspaceId: string, files: GeneratedFile[]): WorkspaceWriteResult {
    const dir = this.dirFor(projectId, workspaceId);
    if (!Array.isArray(files) || files.length === 0) return { ok: false, code: 'NO_FILES', detail: 'The generator produced no files.' };
    if (files.length > WORKSPACE_LIMITS.maxFiles) return { ok: false, code: 'TOO_MANY_FILES', detail: `At most ${WORKSPACE_LIMITS.maxFiles} files.` };
    const seen = new Set<string>();
    const prepared: Array<{ rel: string; data: Buffer }> = [];
    let total = 0;
    for (const file of files) {
      const checked = checkWorkspacePath(file?.path);
      if (!checked.ok) return { ok: false, code: checked.code, detail: `A generated file has an unacceptable path.` };
      if (seen.has(checked.normalized.toLowerCase())) return { ok: false, code: 'DUPLICATE_PATH', detail: 'Two generated files have the same path.' };
      seen.add(checked.normalized.toLowerCase());
      const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? ''), 'utf8');
      if (data.length > WORKSPACE_LIMITS.maxFileBytes) return { ok: false, code: 'FILE_TOO_LARGE', detail: `A generated file is larger than ${WORKSPACE_LIMITS.maxFileBytes} bytes.` };
      total += data.length;
      if (total > WORKSPACE_LIMITS.maxTotalBytes) return { ok: false, code: 'WORKSPACE_TOO_LARGE', detail: `The generated files are larger than ${WORKSPACE_LIMITS.maxTotalBytes} bytes in total.` };
      prepared.push({ rel: checked.normalized, data });
    }
    const written: string[] = [];
    try {
      for (const entry of prepared) {
        const target = path.join(dir, ...entry.rel.split('/'));
        // belt and braces: the resolved target is inside the workspace directory
        const resolved = path.resolve(target);
        if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error('ESCAPE');
        fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
        fs.writeFileSync(resolved, entry.data, { mode: 0o600 });
        written.push(resolved);
      }
    } catch {
      for (const file of written) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } }
      return { ok: false, code: 'WRITE_FAILED', detail: 'The files could not be written.' };
    }
    return { ok: true, files: prepared.map((entry) => ({ path: entry.rel, bytes: entry.data.length, sha256: crypto.createHash('sha256').update(entry.data).digest('hex') })) };
  }

  /** The bytes of one file of a workspace, or null. The path is re-checked with the same rules; the caller has already established who owns the project. */
  public read(projectId: string, workspaceId: string, relativePath: string): Buffer | null {
    const checked = checkWorkspacePath(relativePath);
    if (!checked.ok) return null;
    try {
      const dir = path.resolve(this.dirFor(projectId, workspaceId));
      const target = path.resolve(path.join(dir, ...checked.normalized.split('/')));
      if (!target.startsWith(dir + path.sep)) return null;
      // a symlink that would lead out of the workspace is not followed
      const real = fs.realpathSync(target);
      if (!real.startsWith(fs.realpathSync(dir) + path.sep)) return null;
      return fs.readFileSync(real);
    } catch { return null; }
  }

  public has(projectId: string, workspaceId: string): boolean {
    try { return fs.statSync(this.dirFor(projectId, workspaceId)).isDirectory(); } catch { return false; }
  }

  public remove(projectId: string, workspaceId: string): void {
    try { fs.rmSync(this.dirFor(projectId, workspaceId), { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(this.shotsDir(projectId, workspaceId), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function contentTypeFor(file: string): string {
  switch (path.posix.extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': case '.webmanifest': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    default: return 'text/plain; charset=utf-8';
  }
}
