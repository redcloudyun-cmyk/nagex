export type ArtifactType = 'RESEARCH' | 'ANALYSIS' | 'DOCUMENT' | 'IMAGE' | 'PRESENTATION' | 'VIDEO';
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

export type ArtifactPreviewKind = 'IMAGE' | 'TEXT' | 'PLANNED' | 'UNKNOWN';

export interface ArtifactUxProjection {
  artifactId: string;
  artifactType: ArtifactType;
  title: string;
  summary: string;
  status: ArtifactStatus;
  previewKind: ArtifactPreviewKind;
  previewTarget: string | null;
  openTarget: string;
  canvasTarget: string;
  updatedAt: string;
}

export function toArtifactUxProjection(record: ArtifactRecord): ArtifactUxProjection {
  const type = record.type;
  let previewKind: ArtifactPreviewKind = 'UNKNOWN';
  let previewTarget: string | null = null;
  let canvasTarget = `/canvas?artifactId=${encodeURIComponent(record.artifactId)}&type=${encodeURIComponent(type)}`;

  if (type === 'IMAGE') {
    previewKind = 'IMAGE';
    // For IMAGE, openTarget is the canonical authorized NAgex binary URL
    previewTarget = record.openTarget;
  } else if (type === 'DOCUMENT' || type === 'RESEARCH' || type === 'ANALYSIS') {
    previewKind = 'TEXT';
    previewTarget = null;
  } else if (type === 'PRESENTATION' || type === 'VIDEO') {
    previewKind = 'PLANNED';
    previewTarget = null;
    canvasTarget = ''; // non-routable for planned/future extension
  } else {
    previewKind = 'UNKNOWN';
    previewTarget = null;
    canvasTarget = '';
  }

  return {
    artifactId: record.artifactId,
    artifactType: type,
    title: record.title,
    summary: record.preview,
    status: record.status,
    previewKind,
    previewTarget,
    openTarget: record.openTarget,
    canvasTarget,
    updatedAt: record.updatedAt,
  };
}

