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

// R24.7B — the single source of truth for which artifact types support
// contextual Canvas Ask, and why the others do not. The UI never decides this
// itself: it reads `ask` from the projection (and the Ask route re-checks it
// server-side), so the client can never advertise a capability the server
// does not honor.
//   DOCUMENT_CONTENT  = grounded in the full persisted document Markdown
//   PERSISTED_SUMMARY = grounded in the persisted extractedSummary only
export type ArtifactAskBasis = 'DOCUMENT_CONTENT' | 'PERSISTED_SUMMARY';
export type ArtifactAskUnsupportedReason = 'IMAGE_VISUAL_UNSUPPORTED' | 'RESEARCH_PREVIEW_ONLY' | 'TYPE_NOT_SUPPORTED';
export type ArtifactAskSupport =
  | { supported: true; basis: ArtifactAskBasis }
  | { supported: false; reason: ArtifactAskUnsupportedReason };

export function getArtifactAskSupport(type: ArtifactType): ArtifactAskSupport {
  switch (type) {
    case 'DOCUMENT': return { supported: true, basis: 'DOCUMENT_CONTENT' };
    case 'ANALYSIS': return { supported: true, basis: 'PERSISTED_SUMMARY' };
    // No model path in this stack can inspect image bytes.
    case 'IMAGE': return { supported: false, reason: 'IMAGE_VISUAL_UNSUPPORTED' };
    // A RESEARCH artifact persists only a <=500 character preview of its answer
    // (no full answer, no sources); that is never full-artifact context.
    case 'RESEARCH': return { supported: false, reason: 'RESEARCH_PREVIEW_ONLY' };
    default: return { supported: false, reason: 'TYPE_NOT_SUPPORTED' };
  }
}

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
  ask: ArtifactAskSupport;
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
    ask: getArtifactAskSupport(type),
  };
}

