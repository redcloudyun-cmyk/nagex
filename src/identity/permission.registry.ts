import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { PrincipalReference } from '../common/types.js';

export type PermissionRisk = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

const VALID_RISK_LEVELS: ReadonlySet<string> = new Set(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);

// specs/permissions/*.yaml is the canonical source of truth (MASTER.md rule
// #20: Code보다 Contract가 먼저다). This registry loads and parses those
// files once at module init into a flat id -> risk lookup. PDP
// (src/identity/pdp.ts) reads PERMISSION_RISK synchronously on every
// authorization check, so loading must stay eager and cheap rather than
// becoming a per-request file read.
const PERMISSION_SPEC_FILES = [
  'specs/permissions/core.permissions.yaml',
  'specs/permissions/agent.permissions.yaml',
  'specs/permissions/module.permissions.yaml',
];

interface RawPermissionEntry {
  id?: unknown;
  risk?: unknown;
}

interface RawPermissionFile {
  permissions?: unknown;
}

function loadPermissionRiskMap(): Readonly<Record<string, PermissionRisk>> {
  const riskMap: Record<string, PermissionRisk> = {};

  for (const relativePath of PERMISSION_SPEC_FILES) {
    const absolutePath = join(process.cwd(), relativePath);
    const raw = readFileSync(absolutePath, 'utf8');
    const parsed = loadYaml(raw) as RawPermissionFile;

    if (!parsed || !Array.isArray(parsed.permissions)) {
      throw new Error(`Malformed permission spec file (missing "permissions" array): ${relativePath}`);
    }

    for (const entry of parsed.permissions as RawPermissionEntry[]) {
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new Error(`Permission entry missing a valid "id" in ${relativePath}`);
      }
      if (typeof entry.risk !== 'string' || !VALID_RISK_LEVELS.has(entry.risk)) {
        throw new Error(`Permission "${entry.id}" in ${relativePath} has an invalid risk level: ${String(entry.risk)}`);
      }
      riskMap[entry.id] = entry.risk as PermissionRisk;
    }
  }

  return Object.freeze(riskMap);
}

// Fail-closed (MASTER.md rule #3): a missing/malformed permission spec file
// throws at startup rather than silently authorizing requests against an
// incomplete or empty risk map.
export const PERMISSION_RISK: Readonly<Record<string, PermissionRisk>> = loadPermissionRiskMap();

/**
 * Server-side built-in principal authorization mapping.
 *
 * S1 (S0-18): there is NO built-in human admin. Earlier builds granted
 * module:manage / tenant:create / policy:publish to any principal whose id was the
 * literal 'usr_admin_001' or 'admin' — and, because identity then came from a
 * client-supplied header, that was every anonymous caller. Identity now comes only
 * from a server-side session, and only these principals are elevated:
 *   - type 'system' (in-process, never a request principal);
 *   - the registered user ids an operator lists in NAGEX_BUILTIN_ADMIN_PRINCIPALS
 *     (comma separated, empty by default; read on every call, never cached).
 * Everyone else holds only 'agent:execute'.
 *
 * NOTE: this is still a static trust mapping, NOT a role-based access control system.
 * TODO(RBAC-integration): replace with a canonical principal -> role -> permission store.
 */
const BUILT_IN_ADMIN_PERMISSIONS = ['module:manage', 'agent:execute', 'tenant:create', 'policy:publish'];
export const BUILTIN_ADMIN_PRINCIPALS_ENV = 'NAGEX_BUILTIN_ADMIN_PRINCIPALS';

function configuredAdminPrincipalIds(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env[BUILTIN_ADMIN_PRINCIPALS_ENV] ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0));
}

export function resolveBuiltInPrincipalPermissions(principal: PrincipalReference, env: NodeJS.ProcessEnv = process.env): string[] {
  if (principal.type === 'system' || configuredAdminPrincipalIds(env).has(principal.id)) {
    return [...BUILT_IN_ADMIN_PERMISSIONS];
  }
  return ['agent:execute'];
}

