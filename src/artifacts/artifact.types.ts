export type ArtifactType = 'RESEARCH' | 'ANALYSIS';
export type ArtifactStatus = 'COMPLETED' | 'FAILED';

export interface ArtifactRecord {
  artifactId: string;
  tenantId: string;
  ownerId: string;
  type: ArtifactType;
  status: ArtifactStatus;
  title: string;
  preview: string;
  sourceType: 'RESEARCH_RESULT' | 'CAPTURE';
  sourceId: string;
  openTarget: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveCompletedArtifactInput {
  tenantId: string;
  ownerId: string;
  type: ArtifactType;
  title: string;
  preview: string;
  sourceType: ArtifactRecord['sourceType'];
  sourceId: string;
  openTarget: string;
}
