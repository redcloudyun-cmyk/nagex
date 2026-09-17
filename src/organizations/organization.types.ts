// R14 Organization & Workspace — Domain Types & Contracts

export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'DELETED';
export type WorkspaceStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETION_PENDING' | 'DELETED';
export type MembershipRole = 'OWNER' | 'MEMBER';
export type MembershipStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REMOVED';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export interface OrganizationRecord {
  organizationId: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface WorkspaceRecord {
  workspaceId: string;
  organizationId: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface MembershipRecord {
  membershipId: string;
  organizationId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvitationRecord {
  invitationId: string;
  organizationId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  status: InvitationStatus;
  createdByUserId: string;
  createdAt: string;
}

export type OrganizationAuditEventType =
  | 'organization.created'
  | 'organization.updated'
  | 'organization.deletion.requested'
  | 'organization.deletion.cancelled'
  | 'organization.deleted'
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.archived'
  | 'workspace.restored'
  | 'workspace.deletion.requested'
  | 'invitation.created'
  | 'invitation.accepted'
  | 'invitation.revoked'
  | 'member.joined'
  | 'member.removed'
  | 'member.left'
  | 'owner.transferred';
