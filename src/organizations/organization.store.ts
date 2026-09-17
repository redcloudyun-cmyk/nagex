// R14 Organization & Workspace — Store & Business Logic Layer
import crypto from 'node:crypto';
import { generateResourceId } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { NagexError } from '../common/errors.js';
import type {
  OrganizationRecord,
  WorkspaceRecord,
  MembershipRecord,
  InvitationRecord,
} from './organization.types.ts';

export function isOrganizationRecord(value: unknown): value is OrganizationRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.organizationId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.slug === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdByUserId === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspaceId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.slug === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdByUserId === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isMembershipRecord(value: unknown): value is MembershipRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.membershipId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.role === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function isInvitationRecord(value: unknown): value is InvitationRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.invitationId === 'string' &&
    typeof v.organizationId === 'string' &&
    typeof v.email === 'string' &&
    typeof v.tokenHash === 'string' &&
    typeof v.expiresAt === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdByUserId === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'organization';
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface OrganizationStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class OrganizationStore {
  private readonly orgFileStore: FileRecordStore<OrganizationRecord>;
  private readonly wsFileStore: FileRecordStore<WorkspaceRecord>;
  private readonly memFileStore: FileRecordStore<MembershipRecord>;
  private readonly invFileStore: FileRecordStore<InvitationRecord>;

  private readonly orgs = new Map<string, OrganizationRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly invitations = new Map<string, InvitationRecord>();

  private readonly now: () => string;

  constructor(options: OrganizationStoreOptions = {}) {
    const env = options.env ?? process.env;
    const baseDir = options.dir ?? resolveNagexDataDir('organizations', 'NAGEX_ORGANIZATION_DIR', env);
    this.now = options.now ?? (() => new Date().toISOString());

    this.orgFileStore = new FileRecordStore<OrganizationRecord>(`${baseDir}/organizations`, isOrganizationRecord);
    this.wsFileStore = new FileRecordStore<WorkspaceRecord>(`${baseDir}/workspaces`, isWorkspaceRecord);
    this.memFileStore = new FileRecordStore<MembershipRecord>(`${baseDir}/memberships`, isMembershipRecord);
    this.invFileStore = new FileRecordStore<InvitationRecord>(`${baseDir}/invitations`, isInvitationRecord);

    this.loadAll();
  }

  private loadAll(): void {
    for (const org of this.orgFileStore.readAll()) {
      this.orgs.set(org.organizationId, org);
    }
    for (const ws of this.wsFileStore.readAll()) {
      this.workspaces.set(ws.workspaceId, ws);
    }
    for (const mem of this.memFileStore.readAll()) {
      this.memberships.set(mem.membershipId, mem);
    }
    for (const inv of this.invFileStore.readAll()) {
      this.invitations.set(inv.invitationId, inv);
    }
  }

  private saveOrg(org: OrganizationRecord): void {
    this.orgs.set(org.organizationId, org);
    this.orgFileStore.write(org.organizationId, org);
  }

  private saveWorkspace(ws: WorkspaceRecord): void {
    this.workspaces.set(ws.workspaceId, ws);
    this.wsFileStore.write(ws.workspaceId, ws);
  }

  private saveMembership(mem: MembershipRecord): void {
    this.memberships.set(mem.membershipId, mem);
    this.memFileStore.write(mem.membershipId, mem);
  }

  private saveInvitation(inv: InvitationRecord): void {
    this.invitations.set(inv.invitationId, inv);
    this.invFileStore.write(inv.invitationId, inv);
  }

  // ── Organization Slug Generator ──
  private generateUniqueOrgSlug(name: string): string {
    const baseSlug = slugify(name);
    let candidate = baseSlug;
    let counter = 2;
    const existingSlugs = new Set(Array.from(this.orgs.values()).map((o) => o.slug));
    while (existingSlugs.has(candidate)) {
      candidate = `${baseSlug}-${counter}`;
      counter++;
    }
    return candidate;
  }

  private generateUniqueWorkspaceSlug(orgId: string, name: string): string {
    const baseSlug = slugify(name);
    let candidate = baseSlug;
    let counter = 2;
    const existingSlugs = new Set(
      Array.from(this.workspaces.values())
        .filter((w) => w.organizationId === orgId)
        .map((w) => w.slug)
    );
    while (existingSlugs.has(candidate)) {
      candidate = `${baseSlug}-${counter}`;
      counter++;
    }
    return candidate;
  }

  // ── Organization CRUD ──
  public createOrganization(
    userId: string,
    name: string
  ): { organization: OrganizationRecord; membership: MembershipRecord; workspace: WorkspaceRecord } {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Organization name is required.' });
    }
    const cleanName = name.trim();
    const timestamp = this.now();
    const orgId = generateResourceId('org');
    const slug = this.generateUniqueOrgSlug(cleanName);

    const organization: OrganizationRecord = {
      organizationId: orgId,
      name: cleanName,
      slug,
      status: 'ACTIVE',
      createdByUserId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const membership: MembershipRecord = {
      membershipId: generateResourceId('mbr'),
      organizationId: orgId,
      userId,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const workspace: WorkspaceRecord = {
      workspaceId: generateResourceId('ws'),
      organizationId: orgId,
      name: 'General',
      slug: 'general',
      status: 'ACTIVE',
      createdByUserId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.saveOrg(organization);
    this.saveMembership(membership);
    this.saveWorkspace(workspace);

    return { organization, membership, workspace };
  }

  public getOrganization(orgId: string): OrganizationRecord | null {
    const org = this.orgs.get(orgId);
    if (!org || org.status === 'DELETED') return null;
    return { ...org };
  }

  public listOrganizationsForUser(userId: string): OrganizationRecord[] {
    const activeOrgIds = new Set(
      Array.from(this.memberships.values())
        .filter((m) => m.userId === userId && m.status === 'ACTIVE')
        .map((m) => m.organizationId)
    );

    return Array.from(this.orgs.values())
      .filter((o) => activeOrgIds.has(o.organizationId) && o.status !== 'DELETED')
      .map((o) => ({ ...o }));
  }

  public updateOrganization(orgId: string, name: string): OrganizationRecord {
    const org = this.orgs.get(orgId);
    if (!org || org.status === 'DELETED') {
      throw new NagexError({ code: 'ORG_NOT_FOUND', category: 'NOT_FOUND', message: 'Organization not found.' });
    }
    if (org.status === 'DELETION_PENDING') {
      throw new NagexError({ code: 'ORG_MUTATION_RESTRICTED', category: 'POLICY', message: 'Organization is pending deletion.' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Organization name is required.' });
    }

    const cleanName = name.trim();
    org.name = cleanName;
    org.slug = this.generateUniqueOrgSlug(cleanName);
    org.updatedAt = this.now();

    this.saveOrg(org);
    return { ...org };
  }

  public requestOrganizationDeletion(orgId: string): OrganizationRecord {
    const org = this.orgs.get(orgId);
    if (!org || org.status === 'DELETED') {
      throw new NagexError({ code: 'ORG_NOT_FOUND', category: 'NOT_FOUND', message: 'Organization not found.' });
    }
    org.status = 'DELETION_PENDING';
    org.updatedAt = this.now();
    this.saveOrg(org);
    return { ...org };
  }

  public cancelOrganizationDeletion(orgId: string): OrganizationRecord {
    const org = this.orgs.get(orgId);
    if (!org || org.status !== 'DELETION_PENDING') {
      throw new NagexError({ code: 'INVALID_STATE', category: 'POLICY', message: 'Organization is not pending deletion.' });
    }
    org.status = 'ACTIVE';
    org.updatedAt = this.now();
    this.saveOrg(org);
    return { ...org };
  }

  // ── Workspace Operations ──
  public createWorkspace(orgId: string, userId: string, name: string): WorkspaceRecord {
    const org = this.getOrganization(orgId);
    if (!org) {
      throw new NagexError({ code: 'ORG_NOT_FOUND', category: 'NOT_FOUND', message: 'Organization not found.' });
    }
    if (org.status === 'DELETION_PENDING') {
      throw new NagexError({ code: 'ORG_MUTATION_RESTRICTED', category: 'POLICY', message: 'Cannot create workspace while organization deletion is pending.' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Workspace name is required.' });
    }

    const cleanName = name.trim();
    const timestamp = this.now();
    const ws: WorkspaceRecord = {
      workspaceId: generateResourceId('ws'),
      organizationId: orgId,
      name: cleanName,
      slug: this.generateUniqueWorkspaceSlug(orgId, cleanName),
      status: 'ACTIVE',
      createdByUserId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.saveWorkspace(ws);
    return { ...ws };
  }

  public getWorkspace(wsId: string): WorkspaceRecord | null {
    const ws = this.workspaces.get(wsId);
    if (!ws || ws.status === 'DELETED') return null;
    return { ...ws };
  }

  public listWorkspaces(orgId: string, includeArchived = false): WorkspaceRecord[] {
    return Array.from(this.workspaces.values())
      .filter((w) => w.organizationId === orgId && w.status !== 'DELETED' && (includeArchived || w.status === 'ACTIVE'))
      .map((w) => ({ ...w }));
  }

  public updateWorkspace(orgId: string, wsId: string, name: string): WorkspaceRecord {
    const ws = this.assertWorkspaceInOrg(orgId, wsId);
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new NagexError({ code: 'INVALID_INPUT', category: 'VALIDATION', message: 'Workspace name is required.' });
    }

    const cleanName = name.trim();
    ws.name = cleanName;
    ws.slug = this.generateUniqueWorkspaceSlug(orgId, cleanName);
    ws.updatedAt = this.now();

    this.saveWorkspace(ws);
    return { ...ws };
  }

  public archiveWorkspace(orgId: string, wsId: string): WorkspaceRecord {
    const ws = this.assertWorkspaceInOrg(orgId, wsId);
    if (ws.status !== 'ACTIVE') {
      throw new NagexError({ code: 'INVALID_STATE', category: 'POLICY', message: 'Only active workspaces can be archived.' });
    }
    ws.status = 'ARCHIVED';
    ws.updatedAt = this.now();
    this.saveWorkspace(ws);
    return { ...ws };
  }

  public restoreWorkspace(orgId: string, wsId: string): WorkspaceRecord {
    const ws = this.assertWorkspaceInOrg(orgId, wsId);
    if (ws.status !== 'ARCHIVED') {
      throw new NagexError({ code: 'INVALID_STATE', category: 'POLICY', message: 'Only archived workspaces can be restored.' });
    }
    ws.status = 'ACTIVE';
    ws.updatedAt = this.now();
    this.saveWorkspace(ws);
    return { ...ws };
  }

  public deleteWorkspace(orgId: string, wsId: string): WorkspaceRecord {
    const ws = this.assertWorkspaceInOrg(orgId, wsId);
    ws.status = 'DELETED';
    ws.deletedAt = this.now();
    ws.updatedAt = this.now();
    this.saveWorkspace(ws);
    return { ...ws };
  }

  // ── Invitation Operations ──
  public createInvitation(
    orgId: string,
    createdByUserId: string,
    email: string
  ): { invitation: InvitationRecord; rawToken: string } {
    const org = this.getOrganization(orgId);
    if (!org) {
      throw new NagexError({ code: 'ORG_NOT_FOUND', category: 'NOT_FOUND', message: 'Organization not found.' });
    }
    if (org.status === 'DELETION_PENDING') {
      throw new NagexError({ code: 'ORG_MUTATION_RESTRICTED', category: 'POLICY', message: 'Cannot create invitations while organization deletion is pending.' });
    }

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      throw new NagexError({ code: 'INVALID_EMAIL', category: 'VALIDATION', message: 'A valid email address is required.' });
    }
    const cleanEmail = email.toLowerCase().trim();

    const existingPendingInv = Array.from(this.invitations.values()).find(
      (i) => i.organizationId === orgId && i.email === cleanEmail && i.status === 'PENDING'
    );
    if (existingPendingInv) {
      throw new NagexError({ code: 'INVITATION_ALREADY_EXISTS', category: 'CONFLICT', message: 'An active invitation already exists for this email address.' });
    }

    const rawToken = `inv_tok_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(rawToken);
    const timestamp = this.now();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const invitation: InvitationRecord = {
      invitationId: generateResourceId('inv'),
      organizationId: orgId,
      email: cleanEmail,
      tokenHash,
      expiresAt,
      status: 'PENDING',
      createdByUserId,
      createdAt: timestamp,
    };

    this.saveInvitation(invitation);
    return { invitation, rawToken };
  }

  public listInvitations(orgId: string): InvitationRecord[] {
    return Array.from(this.invitations.values())
      .filter((i) => i.organizationId === orgId)
      .map((i) => ({ ...i }));
  }

  public revokeInvitation(orgId: string, invitationId: string): InvitationRecord {
    const inv = this.invitations.get(invitationId);
    if (!inv || inv.organizationId !== orgId) {
      throw new NagexError({ code: 'INVITATION_NOT_FOUND', category: 'NOT_FOUND', message: 'Invitation not found.' });
    }
    if (inv.status !== 'PENDING') {
      throw new NagexError({ code: 'INVALID_STATE', category: 'POLICY', message: 'Only pending invitations can be revoked.' });
    }

    inv.status = 'REVOKED';
    this.saveInvitation(inv);
    return { ...inv };
  }

  public acceptInvitation(
    rawToken: string,
    userId: string,
    userEmail: string
  ): { membership: MembershipRecord; invitation: InvitationRecord } {
    const tokenHash = hashToken(rawToken);
    const inv = Array.from(this.invitations.values()).find((i) => i.tokenHash === tokenHash);
    if (!inv) {
      throw new NagexError({ code: 'INVALID_TOKEN', category: 'VALIDATION', message: 'Invalid or expired invitation token.' });
    }
    if (inv.status !== 'PENDING') {
      throw new NagexError({ code: 'INVITATION_EXPIRED', category: 'POLICY', message: `Invitation is no longer valid (status: ${inv.status}).` });
    }
    if (new Date(inv.expiresAt).getTime() < Date.now()) {
      inv.status = 'EXPIRED';
      this.saveInvitation(inv);
      throw new NagexError({ code: 'INVITATION_EXPIRED', category: 'POLICY', message: 'Invitation has expired.' });
    }

    if (userEmail.toLowerCase().trim() !== inv.email.toLowerCase().trim()) {
      throw new NagexError({ code: 'EMAIL_MISMATCH', category: 'AUTHORIZATION', message: 'Your email does not match the invitation email address.' });
    }

    const existingMem = Array.from(this.memberships.values()).find(
      (m) => m.organizationId === inv.organizationId && m.userId === userId && m.status === 'ACTIVE'
    );
    if (existingMem) {
      inv.status = 'ACCEPTED';
      this.saveInvitation(inv);
      return { membership: existingMem, invitation: inv };
    }

    const timestamp = this.now();
    const membership: MembershipRecord = {
      membershipId: generateResourceId('mbr'),
      organizationId: inv.organizationId,
      userId,
      role: 'MEMBER',
      status: 'ACTIVE',
      joinedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    inv.status = 'ACCEPTED';
    this.saveMembership(membership);
    this.saveInvitation(inv);

    return { membership, invitation: inv };
  }

  // ── Membership & Owner Operations ──
  public listMembers(orgId: string): MembershipRecord[] {
    return Array.from(this.memberships.values())
      .filter((m) => m.organizationId === orgId && m.status === 'ACTIVE')
      .map((m) => ({ ...m }));
  }

  public getMembership(orgId: string, userId: string): MembershipRecord | null {
    const mem = Array.from(this.memberships.values()).find(
      (m) => m.organizationId === orgId && m.userId === userId && m.status === 'ACTIVE'
    );
    return mem ? { ...mem } : null;
  }

  public removeMember(orgId: string, targetUserId: string, _requestingUserId: string): MembershipRecord {
    const mem = Array.from(this.memberships.values()).find(
      (m) => m.organizationId === orgId && m.userId === targetUserId && m.status === 'ACTIVE'
    );
    if (!mem) {
      throw new NagexError({ code: 'MEMBER_NOT_FOUND', category: 'NOT_FOUND', message: 'Active member not found.' });
    }

    if (mem.role === 'OWNER') {
      const activeOwners = Array.from(this.memberships.values()).filter(
        (m) => m.organizationId === orgId && m.role === 'OWNER' && m.status === 'ACTIVE'
      );
      if (activeOwners.length <= 1) {
        throw new NagexError({ code: 'LAST_OWNER_PROTECTION', category: 'POLICY', message: 'Cannot remove the last owner of an organization.' });
      }
    }

    mem.status = 'REMOVED';
    mem.updatedAt = this.now();
    this.saveMembership(mem);
    return { ...mem };
  }

  public leaveOrganization(orgId: string, userId: string): MembershipRecord {
    const mem = Array.from(this.memberships.values()).find(
      (m) => m.organizationId === orgId && m.userId === userId && m.status === 'ACTIVE'
    );
    if (!mem) {
      throw new NagexError({ code: 'MEMBER_NOT_FOUND', category: 'NOT_FOUND', message: 'You are not an active member of this organization.' });
    }

    if (mem.role === 'OWNER') {
      const activeOwners = Array.from(this.memberships.values()).filter(
        (m) => m.organizationId === orgId && m.role === 'OWNER' && m.status === 'ACTIVE'
      );
      if (activeOwners.length <= 1) {
        throw new NagexError({ code: 'LAST_OWNER_PROTECTION', category: 'POLICY', message: 'Cannot leave as the last owner. Please transfer ownership first.' });
      }
    }

    mem.status = 'REMOVED';
    mem.updatedAt = this.now();
    this.saveMembership(mem);
    return { ...mem };
  }

  public transferOwnership(
    orgId: string,
    currentOwnerUserId: string,
    targetUserId: string
  ): { previousOwner: MembershipRecord; newOwner: MembershipRecord } {
    const currentOwnerMem = Array.from(this.memberships.values()).find(
      (m) => m.organizationId === orgId && m.userId === currentOwnerUserId && m.status === 'ACTIVE' && m.role === 'OWNER'
    );
    if (!currentOwnerMem) {
      throw new NagexError({ code: 'OWNER_REQUIRED', category: 'AUTHORIZATION', message: 'Only an owner can transfer ownership.' });
    }

    const targetMem = Array.from(this.memberships.values()).find(
      (m) => m.organizationId === orgId && m.userId === targetUserId && m.status === 'ACTIVE'
    );
    if (!targetMem) {
      throw new NagexError({ code: 'MEMBER_NOT_FOUND', category: 'NOT_FOUND', message: 'Target user is not an active member of this organization.' });
    }

    const timestamp = this.now();
    targetMem.role = 'OWNER';
    targetMem.updatedAt = timestamp;

    currentOwnerMem.role = 'MEMBER';
    currentOwnerMem.updatedAt = timestamp;

    this.saveMembership(targetMem);
    this.saveMembership(currentOwnerMem);

    return { previousOwner: { ...currentOwnerMem }, newOwner: { ...targetMem } };
  }

  // ── Guards & Assertions ──
  public assertMember(orgId: string, userId: string): MembershipRecord {
    const mem = this.getMembership(orgId, userId);
    if (!mem) {
      throw new NagexError({ code: 'ORG_FORBIDDEN', category: 'AUTHORIZATION', message: 'You do not have access to this organization.' });
    }
    return mem;
  }

  public assertOwner(orgId: string, userId: string): MembershipRecord {
    const mem = this.assertMember(orgId, userId);
    if (mem.role !== 'OWNER') {
      throw new NagexError({ code: 'OWNER_REQUIRED', category: 'AUTHORIZATION', message: 'Owner permission is required for this action.' });
    }
    return mem;
  }

  public assertWorkspaceInOrg(orgId: string, wsId: string): WorkspaceRecord {
    const ws = this.getWorkspace(wsId);
    if (!ws || ws.organizationId !== orgId || ws.status === 'DELETED') {
      throw new NagexError({ code: 'WORKSPACE_NOT_FOUND', category: 'NOT_FOUND', message: 'Workspace not found in this organization.' });
    }
    return ws;
  }
}
