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
 * NOTE: This is a static server-side built-in trust mapping for system principals
 * and known admin IDs. It is NOT a full role-based access control (RBAC) system
 * or dynamic principal -> role -> permission store.
 *
 * TODO(RBAC-integration): Replace this static mapping with a canonical, durable
 * principal -> role -> permission binding store when a dynamic identity/role subsystem
 * is specified and implemented.
 *
 * Fail-closed behavior: Unknown principals receive no module administration ('module:manage')
 * permissions.
 */
export function resolveBuiltInPrincipalPermissions(principal: PrincipalReference): string[] {
  if (
    principal.type === 'system' ||
    principal.id === 'usr_admin_001' ||
    principal.id === 'admin'
  ) {
    return ['module:manage', 'agent:execute', 'tenant:create', 'policy:publish'];
  }
  return ['agent:execute'];
}

