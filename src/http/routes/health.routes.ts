// R10.2-D — health/vcs read-only utility routes, extracted verbatim from
// server_web.ts (the directive's own suggested "safest first slice", §19).
// GET /api/v1/health and GET /api/v1/vcs/status are pure reads: no
// approval, no tenant/principal requirement, no mutation. Registered from
// BOTH handleAsyncApiRequest and handleApiRequest in server_web.ts — the
// pre-refactor code had two independent, byte-identical inline copies of
// the vcs/status check (one per function); this registrar removes that
// real duplication while preserving both call sites' exact behavior.
import { execFileSync } from 'node:child_process';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

interface VcsFileChange { path: string; status: string; }
interface VcsCommit { hash: string; author: string; date: string; message: string; }
export interface VcsStatus { available: boolean; branch: string | null; changed_files: VcsFileChange[]; commits: VcsCommit[]; error?: string; }

export function getVcsStatus(): VcsStatus {
  const cwd = process.cwd();
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const statusRaw = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1'], { cwd, encoding: 'utf8' });
    const changed_files: VcsFileChange[] = statusRaw.split('\n').filter((l) => l.trim().length > 0).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
    const logRaw = execFileSync('git', ['log', '-20', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--date=iso-strict'], { cwd, encoding: 'utf8' });
    const commits: VcsCommit[] = logRaw.split('\n').filter((l) => l.trim().length > 0).map((l) => { const [hash, author, date, message] = l.split('\x1f'); return { hash, author, date, message }; });
    return { available: true, branch, changed_files, commits };
  } catch (err) {
    return { available: false, branch: null, changed_files: [], commits: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export interface HealthRouteDeps {
  executionCount: () => number;
}

export const handleHealthRoutes: SyncRouteRegistrar<HealthRouteDeps> = (method, pathname, _body, _headers, _query, deps): ApiResult | undefined => {
  if (pathname === '/api/v1/health' && method === 'GET') {
    return { status: 200, data: { status: 'UP', service: 'NAgex Personal AI Platform API', version: '0.1.0', runtime_active: true, active_executions: deps.executionCount(), uptime_seconds: Math.floor(process.uptime()) } };
  }
  if (pathname === '/api/v1/vcs/status' && method === 'GET') {
    return { status: 200, data: getVcsStatus() };
  }
  return undefined;
};
