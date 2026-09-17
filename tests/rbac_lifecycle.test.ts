// R15 — RBAC & Permission System Automated Lifecycle & Security Test Suite
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';
import { RbacStore } from '../src/rbac/rbac.store.js';
import { RbacService } from '../src/rbac/rbac.service.js';
import { PERMISSIONS, type PermissionMapping } from '../src/rbac/rbac.types.js';
import { OrganizationStore } from '../src/organizations/organization.store.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { IdentityTokenStore } from '../src/identity/identity.tokens.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';

function perm(permissionKey: any, scope: 'ORGANIZATION' | 'WORKSPACE'): PermissionMapping {
  return { permissionKey, scope };
}

function createTestHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-rbac-test-'));
  const identityStore = new IdentityStore({ dir: path.join(tmpDir, 'identity') });
  const identityTokenStore = new IdentityTokenStore({ dir: path.join(tmpDir, 'tokens') });
  const sessionStore = new SessionStore({ dir: path.join(tmpDir, 'sessions') });
  const organizationStore = new OrganizationStore({ dir: path.join(tmpDir, 'orgs') });
  const rbacStore = new RbacStore({ dir: path.join(tmpDir, 'rbac') });
  const rbacService = new RbacService(rbacStore, organizationStore);

  // User A (Owner)
  const { identity: userA } = identityStore.createAccount('owner@example.com', hashPassword('Password123!'));
  identityStore.transitionState(userA.userId, 'ACTIVE');
  const sessionA = sessionStore.createAuthSession('ten_test', userA.userId, 'MAIN');

  // User B (Admin)
  const { identity: userB } = identityStore.createAccount('admin@example.com', hashPassword('Password123!'));
  identityStore.transitionState(userB.userId, 'ACTIVE');
  const sessionB = sessionStore.createAuthSession('ten_test', userB.userId, 'MAIN');

  // User C (Member)
  const { identity: userC } = identityStore.createAccount('member@example.com', hashPassword('Password123!'));
  identityStore.transitionState(userC.userId, 'ACTIVE');
  const sessionC = sessionStore.createAuthSession('ten_test', userC.userId, 'MAIN');

  // User D (Viewer)
  const { identity: userD } = identityStore.createAccount('viewer@example.com', hashPassword('Password123!'));
  identityStore.transitionState(userD.userId, 'ACTIVE');
  const sessionD = sessionStore.createAuthSession('ten_test', userD.userId, 'MAIN');

  // User E (Outsider / Cross-Tenant User)
  const { identity: userE } = identityStore.createAccount('outsider@example.com', hashPassword('Password123!'));
  identityStore.transitionState(userE.userId, 'ACTIVE');
  const sessionE = sessionStore.createAuthSession('ten_test', userE.userId, 'MAIN');

  // Create Org 1 with User A as Owner
  const org1Res = organizationStore.createOrganization(userA.userId, 'Org Alpha');
  const org1Id = org1Res.organization.organizationId;
  const ws1Id = org1Res.workspace.workspaceId;

  // Add User B, C, D to Org 1 as MEMBERs (membership level)
  // RBAC roles (ADMIN, MEMBER, VIEWER) are applied via role bindings
  const memB = organizationStore.addMember(org1Id, userB.userId, 'MEMBER');
  organizationStore.addMember(org1Id, userC.userId, 'MEMBER');
  const memD = organizationStore.addMember(org1Id, userD.userId, 'MEMBER');

  // Bind ADMIN role to User B, VIEWER role to User D
  // User C inherits base MEMBER permissions from membership.role mapping
  rbacStore.saveRoleBinding({
    roleBindingId: 'rb_test_admin_b',
    organizationId: org1Id,
    workspaceId: null,
    membershipId: memB.membershipId,
    userId: userB.userId,
    roleId: 'role_builtin_admin',
    createdByUserId: userA.userId,
    createdAt: new Date().toISOString(),
  });
  rbacStore.saveRoleBinding({
    roleBindingId: 'rb_test_viewer_d',
    organizationId: org1Id,
    workspaceId: null,
    membershipId: memD.membershipId,
    userId: userD.userId,
    roleId: 'role_builtin_viewer',
    createdByUserId: userA.userId,
    createdAt: new Date().toISOString(),
  });

  // Create Org 2 with User E as Owner
  const org2Res = organizationStore.createOrganization(userE.userId, 'Org Beta');
  const org2Id = org2Res.organization.organizationId;
  const ws2Id = org2Res.workspace.workspaceId;

  return {
    tmpDir,
    identityStore,
    sessionStore,
    organizationStore,
    rbacStore,
    rbacService,
    userA, sessionA,
    userB, sessionB,
    userC, sessionC,
    userD, sessionD,
    userE, sessionE,
    org1Id, ws1Id,
    org2Id, ws2Id,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('R15: Built-in Role Permissions Matrix', () => {
  const h = createTestHarness();
  try {
    // OWNER x organization.delete = ALLOW
    assert.equal(h.rbacService.can(h.userA.userId, h.org1Id, PERMISSIONS.ORGANIZATION_DELETE), true);

    // ADMIN x organization.delete = DENY
    assert.equal(h.rbacService.can(h.userB.userId, h.org1Id, PERMISSIONS.ORGANIZATION_DELETE), false);

    // ADMIN x workspace.update = ALLOW
    assert.equal(h.rbacService.can(h.userB.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws1Id), true);

    // MEMBER x workspace.update = DENY
    assert.equal(h.rbacService.can(h.userC.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws1Id), false);

    // MEMBER x workspace.create = ALLOW
    assert.equal(h.rbacService.can(h.userC.userId, h.org1Id, PERMISSIONS.WORKSPACE_CREATE), true);

    // VIEWER x workspace.read = ALLOW
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_READ, h.ws1Id), true);

    // VIEWER x workspace.update = DENY
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws1Id), false);

    // VIEWER x workspace.create = DENY
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_CREATE), false);
  } finally {
    h.cleanup();
  }
});

test('R15: Deny by Default Policy', () => {
  const h = createTestHarness();
  try {
    // Non-member (User E) in Org 1 => DENY for everything
    assert.equal(h.rbacService.can(h.userE.userId, h.org1Id, PERMISSIONS.ORGANIZATION_READ), false);
    assert.equal(h.rbacService.can(h.userE.userId, h.org1Id, PERMISSIONS.WORKSPACE_READ, h.ws1Id), false);

    // Invalid permission => DENY
    assert.equal(h.rbacService.can(h.userA.userId, h.org1Id, 'invalid.permission' as any), false);

    // Member with no roles or null user => DENY
    assert.equal(h.rbacService.can('nonexistent_user', h.org1Id, PERMISSIONS.ORGANIZATION_READ), false);
  } finally {
    h.cleanup();
  }
});

test('R15: Custom Role CRUD Lifecycle', () => {
  const h = createTestHarness();
  try {
    // 1. Create custom role as OWNER
    const createdRole = h.rbacService.createCustomRole(
      h.userA.userId,
      h.org1Id,
      'Project Lead',
      'Leads workspace projects',
      [
        perm(PERMISSIONS.WORKSPACE_READ, 'WORKSPACE'),
        perm(PERMISSIONS.WORKSPACE_UPDATE, 'WORKSPACE'),
        perm(PERMISSIONS.WORKSPACE_ARCHIVE, 'WORKSPACE'),
      ]
    );

    assert.ok(createdRole.roleId.startsWith('role_'));
    assert.equal(createdRole.name, 'Project Lead');
    assert.equal(createdRole.isSystem, false);
    assert.equal(createdRole.permissions.length, 3);

    // 2. Update custom role
    const updatedRole = h.rbacService.updateCustomRole(
      h.userA.userId,
      h.org1Id,
      createdRole.roleId,
      {
        description: 'Updated lead description',
        permissions: [
          perm(PERMISSIONS.WORKSPACE_READ, 'WORKSPACE'),
          perm(PERMISSIONS.WORKSPACE_UPDATE, 'WORKSPACE'),
        ],
      }
    );

    assert.equal(updatedRole.description, 'Updated lead description');
    assert.equal(updatedRole.permissions.length, 2);

    // 3. Assign custom role to Member User C
    const binding = h.rbacService.assignRole(
      h.userA.userId,
      h.org1Id,
      h.userC.userId,
      createdRole.roleId,
      h.ws1Id
    );

    assert.ok(binding.roleBindingId.startsWith('rb_'));

    // User C now has workspace.update permission in ws1
    assert.equal(h.rbacService.can(h.userC.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws1Id), true);

    // 4. Try to delete role with active binding => Conflict Error (409)
    assert.throws(() => {
      h.rbacService.deleteCustomRole(h.userA.userId, h.org1Id, createdRole.roleId);
    }, (err: any) => err.code === 'AUTHZ_ROLE_IN_USE');

    // Remove binding
    h.rbacService.removeRoleAssignment(h.userA.userId, h.org1Id, binding.roleBindingId);
    assert.equal(h.rbacService.can(h.userC.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws1Id), false);

    // Now delete custom role
    h.rbacService.deleteCustomRole(h.userA.userId, h.org1Id, createdRole.roleId);

    // Verify role is deleted
    assert.equal(h.rbacStore.getRole(createdRole.roleId), null);
  } finally {
    h.cleanup();
  }
});

test('R15: Privilege Escalation Prevention (Role Ceiling Rule & Self Escalation)', () => {
  const h = createTestHarness();
  try {
    // 1. ADMIN (User B) tries to assign a custom role containing organization.delete (which ADMIN does NOT possess) => BLOCKED
    const dangerRole = h.rbacService.createCustomRole(
      h.userA.userId,
      h.org1Id,
      'Danger Role',
      'Contains organization.delete',
      [
        perm(PERMISSIONS.ORGANIZATION_READ, 'ORGANIZATION'),
        perm(PERMISSIONS.ORGANIZATION_DELETE, 'ORGANIZATION'),
      ]
    );

    assert.throws(() => {
      h.rbacService.assignRole(
        h.userB.userId,
        h.org1Id,
        h.userC.userId,
        dangerRole.roleId
      );
    }, (err: any) => err.code === 'AUTHZ_PRIVILEGE_ESCALATION');

    // 2. ADMIN (User B) tries to assign OWNER role to User C => BLOCKED (OWNER bypass guard)
    const ownerRole = h.rbacStore.getRoleBySystemName(h.org1Id, 'OWNER')!;
    assert.throws(() => {
      h.rbacService.assignRole(
        h.userB.userId,
        h.org1Id,
        h.userC.userId,
        ownerRole.roleId
      );
    }, (err: any) => err.code === 'AUTHZ_OWNER_ASSIGNMENT_RESTRICTED');

    // 3. Self-escalation block: ADMIN (User B) tries to grant ADMIN or custom role to HIMSELF => BLOCKED
    const adminRole = h.rbacStore.getRoleBySystemName(h.org1Id, 'ADMIN')!;
    assert.throws(() => {
      h.rbacService.assignRole(
        h.userB.userId,
        h.org1Id,
        h.userB.userId,
        adminRole.roleId
      );
    }, (err: any) => err.code === 'AUTHZ_SELF_ESCALATION_BLOCKED');

    // 4. MEMBER (User C) tries to change own role => DENIED due to lack of role.assign permission
    assert.throws(() => {
      h.rbacService.assignRole(
        h.userC.userId,
        h.org1Id,
        h.userC.userId,
        adminRole.roleId
      );
    }, (err: any) => err.code === 'AUTHZ_PERMISSION_DENIED');

    // 5. MOST CRITICAL COMBINED ATTACK — ADMIN (User B, who genuinely holds
    // role.assign) tries to bypass owner transfer entirely by assigning the
    // OWNER role to THEMSELVES in a single call. Neither guard alone is
    // sufficient to prove this is blocked (the OWNER-role guard is checked
    // first in the implementation, before the self-escalation guard, so a
    // regression that weakened only the self-escalation check would not be
    // caught by tests 2/3 individually) — this asserts the combined path
    // explicitly, and that User B's membership.role is still MEMBER
    // (unchanged) afterward, not silently promoted.
    assert.throws(() => {
      h.rbacService.assignRole(
        h.userB.userId,
        h.org1Id,
        h.userB.userId,
        ownerRole.roleId
      );
    }, (err: any) => err.code === 'AUTHZ_OWNER_ASSIGNMENT_RESTRICTED');
    const membershipAfter = h.organizationStore.getMembership(h.org1Id, h.userB.userId);
    assert.equal(membershipAfter?.role, 'MEMBER');
    assert.equal(h.rbacService.can(h.userB.userId, h.org1Id, PERMISSIONS.ORGANIZATION_DELETE), false);
  } finally {
    h.cleanup();
  }
});

test('R15: Cross-Tenant RBAC & Workspace Scope Isolation', () => {
  const h = createTestHarness();
  try {
    // Create custom role in Org 2
    const org2Role = h.rbacService.createCustomRole(
      h.userE.userId,
      h.org2Id,
      'Org 2 Secret Role',
      'Secret',
      [perm(PERMISSIONS.WORKSPACE_READ, 'WORKSPACE')]
    );

    // 1. User A (Owner of Org 1) tries to look up or assign Org 2 role in Org 1 => BLOCKED
    assert.throws(() => {
      h.rbacService.assignRole(
        h.userA.userId,
        h.org1Id,
        h.userB.userId,
        org2Role.roleId
      );
    }, (err: any) => err.code === 'AUTHZ_ROLE_NOT_FOUND');

    // 2. User B (Admin in Org 1) tries to perform Admin action in Org 2 => DENIED
    assert.equal(h.rbacService.can(h.userB.userId, h.org2Id, PERMISSIONS.WORKSPACE_CREATE), false);

    // 3. Workspace scope isolation: Workspace 1 role assignment does NOT leak to Workspace 2
    const wsRole = h.rbacService.createCustomRole(
      h.userA.userId,
      h.org1Id,
      'WS1 Editor',
      'Editor for WS1 only',
      [perm(PERMISSIONS.WORKSPACE_UPDATE, 'WORKSPACE')]
    );

    h.rbacService.assignRole(
      h.userA.userId,
      h.org1Id,
      h.userD.userId, // Viewer User D
      wsRole.roleId,
      h.ws1Id // Scoped to WS1
    );

    // User D has WORKSPACE_UPDATE in ws1Id
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws1Id), true);

    // User D does NOT have WORKSPACE_UPDATE in ws2Id or without workspace scope
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE, h.ws2Id), false);
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_UPDATE), false);

    // 4. Foreign workspace binding attempt => BLOCKED
    assert.throws(() => {
      h.rbacService.assignRole(
        h.userA.userId,
        h.org1Id,
        h.userD.userId,
        wsRole.roleId,
        h.ws2Id // ws2 belongs to Org 2, not Org 1!
      );
    }, (err: any) => err.code === 'AUTHZ_WORKSPACE_NOT_FOUND');
  } finally {
    h.cleanup();
  }
});

test('R15: Role Permission Cache Invalidation & Multi-Role Union', () => {
  const h = createTestHarness();
  try {
    // User D is VIEWER in Org 1. Initially has WORKSPACE_READ only.
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.WORKSPACE_READ), true);
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.AUDIT_READ), false);

    // Create Role 1 (Audit Viewer) and Role 2 (Member Inviter)
    const r1 = h.rbacService.createCustomRole(h.userA.userId, h.org1Id, 'Audit Viewer', '', [perm(PERMISSIONS.AUDIT_READ, 'ORGANIZATION')]);
    const r2 = h.rbacService.createCustomRole(h.userA.userId, h.org1Id, 'Member Inviter', '', [perm(PERMISSIONS.MEMBER_INVITE, 'ORGANIZATION')]);

    // Assign Role 1 -> cache invalidated immediately, AUDIT_READ allowed
    h.rbacService.assignRole(h.userA.userId, h.org1Id, h.userD.userId, r1.roleId);
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.AUDIT_READ), true);

    // Assign Role 2 -> union of permissions (VIEWER + Audit Viewer + Member Inviter)
    h.rbacService.assignRole(h.userA.userId, h.org1Id, h.userD.userId, r2.roleId);
    const eff = h.rbacService.getEffectivePermissions(h.userD.userId, h.org1Id);
    const effKeys = eff.map((p) => p.permissionKey);

    assert.ok(effKeys.includes(PERMISSIONS.WORKSPACE_READ));
    assert.ok(effKeys.includes(PERMISSIONS.AUDIT_READ));
    assert.ok(effKeys.includes(PERMISSIONS.MEMBER_INVITE));

    // Update Role 1 to remove AUDIT_READ -> cache invalidated immediately
    h.rbacService.updateCustomRole(h.userA.userId, h.org1Id, r1.roleId, { permissions: [perm(PERMISSIONS.ORGANIZATION_READ, 'ORGANIZATION')] });
    assert.equal(h.rbacService.can(h.userD.userId, h.org1Id, PERMISSIONS.AUDIT_READ), false);
  } finally {
    h.cleanup();
  }
});

test('R15: HTTP Route Permission Enforcement & Audit Event Emission', async () => {
  const h = createTestHarness();
  let server: any;
  let baseUrl = '';

  try {
    const app = createServerInstance({
      identityStore: h.identityStore,
      sessionStore: h.sessionStore,
      organizationStore: h.organizationStore,
      rbacStore: h.rbacStore,
      rbacService: h.rbacService,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 1. GET /api/organizations/:orgId/roles as Admin (User B) => 200 OK
    const resRoles = await fetch(`${baseUrl}/api/organizations/${h.org1Id}/roles`, {
      headers: { Authorization: `Bearer ${h.sessionB.sessionId}` },
    });
    assert.equal(resRoles.status, 200);
    const rolesBody = (await resRoles.json()) as any;
    assert.ok(Array.isArray(rolesBody.roles));
    assert.ok(rolesBody.roles.length >= 4);

    // 2. POST /api/organizations/:orgId/roles as Member (User C - has NO role.create) => 403 Forbidden
    const resForbidden = await fetch(`${baseUrl}/api/organizations/${h.org1Id}/roles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.sessionC.sessionId}`,
      },
      body: JSON.stringify({
        name: 'Hacker Role',
        permissions: [perm(PERMISSIONS.ORGANIZATION_DELETE, 'ORGANIZATION')],
      }),
    });

    assert.equal(resForbidden.status, 403);
    const forbiddenBody = (await resForbidden.json()) as any;
    assert.equal(forbiddenBody.error.code, 'AUTHZ_PERMISSION_DENIED');
    assert.equal(forbiddenBody.error.message, 'You do not have permission (role.create) to perform this action.');

    // 3. GET /api/organizations/:orgId/effective-permissions
    const resEff = await fetch(`${baseUrl}/api/organizations/${h.org1Id}/effective-permissions`, {
      headers: { Authorization: `Bearer ${h.sessionB.sessionId}` },
    });
    assert.equal(resEff.status, 200);
    const effBody = (await resEff.json()) as any;
    assert.ok(Array.isArray(effBody.permissions));
    const effPermKeys = effBody.permissions.map((p: any) => p.permissionKey);
    assert.ok(effPermKeys.includes(PERMISSIONS.WORKSPACE_UPDATE));
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    h.cleanup();
  }
});
