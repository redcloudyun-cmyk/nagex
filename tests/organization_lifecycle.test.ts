// R14 — Organization & Workspace Automated Lifecycle Test Suite
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';
import { OrganizationStore } from '../src/organizations/organization.store.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { IdentityTokenStore } from '../src/identity/identity.tokens.js';
import { IdentityAuditStore } from '../src/identity/identity.audit.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';

function createTestHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-org-test-'));
  const identityStore = new IdentityStore({ dir: path.join(tmpDir, 'identity') });
  const identityTokenStore = new IdentityTokenStore({ dir: path.join(tmpDir, 'tokens') });
  const identityAuditStore = new IdentityAuditStore({ dir: path.join(tmpDir, 'audit') });
  const sessionStore = new SessionStore({ dir: path.join(tmpDir, 'sessions') });
  const organizationStore = new OrganizationStore({ dir: path.join(tmpDir, 'orgs') });

  // Create User A (Owner)
  const { identity: userA } = identityStore.createAccount('usera@example.com', hashPassword('Password123!'));
  const tokenA = identityTokenStore.createToken('EMAIL_VERIFY', userA.userId, 10000);
  identityTokenStore.consumeToken('EMAIL_VERIFY', tokenA.rawToken);
  identityStore.transitionState(userA.userId, 'ACTIVE');
  const sessionA = sessionStore.createAuthSession('ten_test', userA.userId, 'MAIN');

  // Create User B (Member / Second Owner)
  const { identity: userB } = identityStore.createAccount('userb@example.com', hashPassword('Password123!'));
  const tokenB = identityTokenStore.createToken('EMAIL_VERIFY', userB.userId, 10000);
  identityTokenStore.consumeToken('EMAIL_VERIFY', tokenB.rawToken);
  identityStore.transitionState(userB.userId, 'ACTIVE');
  const sessionB = sessionStore.createAuthSession('ten_test', userB.userId, 'MAIN');

  // Create User C (Outsider / Cross-tenant Attacker)
  const { identity: userC } = identityStore.createAccount('userc@example.com', hashPassword('Password123!'));
  const tokenC = identityTokenStore.createToken('EMAIL_VERIFY', userC.userId, 10000);
  identityTokenStore.consumeToken('EMAIL_VERIFY', tokenC.rawToken);
  identityStore.transitionState(userC.userId, 'ACTIVE');
  const sessionC = sessionStore.createAuthSession('ten_test', userC.userId, 'MAIN');

  return {
    tmpDir,
    identityStore,
    identityTokenStore,
    identityAuditStore,
    sessionStore,
    organizationStore,
    userA,
    sessionA,
    userB,
    sessionB,
    userC,
    sessionC,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('R14: Organization Creation & Default Workspace ("General")', () => {
  const h = createTestHarness();
  try {
    const res = h.organizationStore.createOrganization(h.userA.userId, 'Acme Research');
    assert.ok(res.organization.organizationId.startsWith('org_'));
    assert.equal(res.organization.name, 'Acme Research');
    assert.equal(res.organization.slug, 'acme-research');
    assert.equal(res.organization.status, 'ACTIVE');

    assert.equal(res.membership.userId, h.userA.userId);
    assert.equal(res.membership.role, 'OWNER');
    assert.equal(res.membership.status, 'ACTIVE');

    assert.equal(res.workspace.name, 'General');
    assert.equal(res.workspace.slug, 'general');
    assert.equal(res.workspace.status, 'ACTIVE');
  } finally {
    h.cleanup();
  }
});

test('R14: Organization Slug Generation & Duplicate Handling', () => {
  const h = createTestHarness();
  try {
    const org1 = h.organizationStore.createOrganization(h.userA.userId, 'Acme Corp');
    assert.equal(org1.organization.slug, 'acme-corp');

    const org2 = h.organizationStore.createOrganization(h.userA.userId, 'Acme Corp');
    assert.equal(org2.organization.slug, 'acme-corp-2');

    const org3 = h.organizationStore.createOrganization(h.userA.userId, 'Acme Corp');
    assert.equal(org3.organization.slug, 'acme-corp-3');
  } finally {
    h.cleanup();
  }
});

test('R14: Workspace Lifecycle (Create, List, Update, Archive, Restore, Delete)', () => {
  const h = createTestHarness();
  try {
    const { organization: org } = h.organizationStore.createOrganization(h.userA.userId, 'Dev Team');

    // Create Workspace
    const ws1 = h.organizationStore.createWorkspace(org.organizationId, h.userA.userId, 'Mobile App');
    assert.equal(ws1.name, 'Mobile App');
    assert.equal(ws1.slug, 'mobile-app');
    assert.equal(ws1.status, 'ACTIVE');

    // List Workspaces
    const list1 = h.organizationStore.listWorkspaces(org.organizationId);
    assert.equal(list1.length, 2); // General + Mobile App

    // Update Workspace
    const updatedWs = h.organizationStore.updateWorkspace(org.organizationId, ws1.workspaceId, 'Mobile App V2');
    assert.equal(updatedWs.name, 'Mobile App V2');

    // Archive Workspace
    const archivedWs = h.organizationStore.archiveWorkspace(org.organizationId, ws1.workspaceId);
    assert.equal(archivedWs.status, 'ARCHIVED');
    assert.equal(h.organizationStore.listWorkspaces(org.organizationId, false).length, 1);

    // Restore Workspace
    const restoredWs = h.organizationStore.restoreWorkspace(org.organizationId, ws1.workspaceId);
    assert.equal(restoredWs.status, 'ACTIVE');
    assert.equal(h.organizationStore.listWorkspaces(org.organizationId, false).length, 2);

    // Delete Workspace
    const deletedWs = h.organizationStore.deleteWorkspace(org.organizationId, ws1.workspaceId);
    assert.equal(deletedWs.status, 'DELETED');
    assert.equal(h.organizationStore.listWorkspaces(org.organizationId, true).length, 1);
  } finally {
    h.cleanup();
  }
});

test('R14: Invitation Lifecycle & Accept Flow', () => {
  const h = createTestHarness();
  try {
    const { organization: org } = h.organizationStore.createOrganization(h.userA.userId, 'Initech');

    // Create Invitation for User B
    const invRes = h.organizationStore.createInvitation(org.organizationId, h.userA.userId, 'userb@example.com');
    assert.equal(invRes.invitation.email, 'userb@example.com');
    assert.equal(invRes.invitation.status, 'PENDING');
    assert.ok(invRes.rawToken);

    // Duplicate Invitation Rejection
    assert.throws(() => {
      h.organizationStore.createInvitation(org.organizationId, h.userA.userId, 'userb@example.com');
    }, (err: any) => err.code === 'INVITATION_ALREADY_EXISTS');

    // Accept Invitation Email Mismatch Rejection
    assert.throws(() => {
      h.organizationStore.acceptInvitation(invRes.rawToken, h.userC.userId, 'userc@example.com');
    }, (err: any) => err.code === 'EMAIL_MISMATCH');

    // Accept Invitation Success
    const acceptRes = h.organizationStore.acceptInvitation(invRes.rawToken, h.userB.userId, 'userb@example.com');
    assert.equal(acceptRes.membership.userId, h.userB.userId);
    assert.equal(acceptRes.membership.role, 'MEMBER');
    assert.equal(acceptRes.membership.status, 'ACTIVE');
    assert.equal(acceptRes.invitation.status, 'ACCEPTED');

    // Verify User B is now a member of Initech
    const members = h.organizationStore.listMembers(org.organizationId);
    assert.equal(members.length, 2);
  } finally {
    h.cleanup();
  }
});

test('R14: Invitation Revoke', () => {
  const h = createTestHarness();
  try {
    const { organization: org } = h.organizationStore.createOrganization(h.userA.userId, 'Umbrella');
    const invRes = h.organizationStore.createInvitation(org.organizationId, h.userA.userId, 'userb@example.com');

    const revoked = h.organizationStore.revokeInvitation(org.organizationId, invRes.invitation.invitationId);
    assert.equal(revoked.status, 'REVOKED');

    // Accepting revoked token fails
    assert.throws(() => {
      h.organizationStore.acceptInvitation(invRes.rawToken, h.userB.userId, 'userb@example.com');
    }, (err: any) => err.code === 'INVITATION_EXPIRED');
  } finally {
    h.cleanup();
  }
});

test('R14: Owner Transfer & Last Owner Protection', () => {
  const h = createTestHarness();
  try {
    const { organization: org } = h.organizationStore.createOrganization(h.userA.userId, 'Stark Tech');

    // Add User B as Member
    const invRes = h.organizationStore.createInvitation(org.organizationId, h.userA.userId, 'userb@example.com');
    h.organizationStore.acceptInvitation(invRes.rawToken, h.userB.userId, 'userb@example.com');

    // Attempt to remove User A (sole owner) -> Rejection due to Last Owner Protection
    assert.throws(() => {
      h.organizationStore.removeMember(org.organizationId, h.userA.userId, h.userA.userId);
    }, (err: any) => err.code === 'LAST_OWNER_PROTECTION');

    // Attempt User A leave (sole owner) -> Rejection
    assert.throws(() => {
      h.organizationStore.leaveOrganization(org.organizationId, h.userA.userId);
    }, (err: any) => err.code === 'LAST_OWNER_PROTECTION');

    // Transfer Ownership: User A -> User B
    const transferRes = h.organizationStore.transferOwnership(org.organizationId, h.userA.userId, h.userB.userId);
    assert.equal(transferRes.previousOwner.role, 'MEMBER');
    assert.equal(transferRes.newOwner.role, 'OWNER');

    // Now User A (member) can leave
    const leaveRes = h.organizationStore.leaveOrganization(org.organizationId, h.userA.userId);
    assert.equal(leaveRes.status, 'REMOVED');
  } finally {
    h.cleanup();
  }
});

test('R14: Organization Deletion & Grace Period Cancel', () => {
  const h = createTestHarness();
  try {
    const { organization: org } = h.organizationStore.createOrganization(h.userA.userId, 'Cyberdyne');

    // Request deletion
    const pendingOrg = h.organizationStore.requestOrganizationDeletion(org.organizationId);
    assert.equal(pendingOrg.status, 'DELETION_PENDING');

    // Mutation restricted during pending deletion
    assert.throws(() => {
      h.organizationStore.createWorkspace(org.organizationId, h.userA.userId, 'Test WS');
    }, (err: any) => err.code === 'ORG_MUTATION_RESTRICTED');

    // Cancel deletion
    const restoredOrg = h.organizationStore.cancelOrganizationDeletion(org.organizationId);
    assert.equal(restoredOrg.status, 'ACTIVE');
  } finally {
    h.cleanup();
  }
});

test('R14: Tenant Isolation & Cross-Tenant IDOR / URL Tampering Defense', () => {
  const h = createTestHarness();
  try {
    const { organization: orgA } = h.organizationStore.createOrganization(h.userA.userId, 'Org Alpha');
    const { organization: orgB } = h.organizationStore.createOrganization(h.userB.userId, 'Org Beta');

    const wsB = h.organizationStore.createWorkspace(orgB.organizationId, h.userB.userId, 'Beta Core');

    // User C (outsider) cannot access Org A or Org B
    assert.throws(() => {
      h.organizationStore.assertMember(orgA.organizationId, h.userC.userId);
    }, (err: any) => err.code === 'ORG_FORBIDDEN');

    assert.throws(() => {
      h.organizationStore.assertMember(orgB.organizationId, h.userC.userId);
    }, (err: any) => err.code === 'ORG_FORBIDDEN');

    // User A cannot access Org B's workspace
    assert.throws(() => {
      h.organizationStore.assertWorkspaceInOrg(orgA.organizationId, wsB.workspaceId);
    }, (err: any) => err.code === 'WORKSPACE_NOT_FOUND');

    // URL Tampering: Attempting to query workspace WS_B under Org A route returns WORKSPACE_NOT_FOUND
    assert.throws(() => {
      h.organizationStore.assertWorkspaceInOrg(orgA.organizationId, wsB.workspaceId);
    }, (err: any) => err.code === 'WORKSPACE_NOT_FOUND');
  } finally {
    h.cleanup();
  }
});
