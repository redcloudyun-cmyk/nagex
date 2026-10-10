export type InputModality =
  | 'TEXT'
  | 'VOICE'
  | 'SCREEN'
  | 'IMAGE'
  | 'FILE'
  | 'SHARE'
  | 'MULTIMODAL'
  | 'VIDEO'
  | 'EVENT'
  | 'CLIPBOARD';

export interface CommandInputArtifact {
  artifactId: string;
  modality: InputModality;
  kind: string;
  filename?: string;
  mimeType?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export type CanonicalIntent = 'SEND_MESSAGE' | 'UNKNOWN';

export interface CommandContext {
  commandId: string;
  executionThreadId: string;
  principalId: string;
  tenantId: string;
  originDeviceId: string | null;
  originDeviceType: string | null;
  originSurface: string;
  inputModality: InputModality;
  inputArtifacts: CommandInputArtifact[];
  foregroundApp: string | null;
  activeWindow: string | null;
  selectedText: string | null;
  sharedFiles: CommandInputArtifact[];
  screenContext: Record<string, unknown> | null;
  audioTranscript: string | null;
  rawUserIntent: string;
  normalizedIntent: CanonicalIntent;
  entities: Record<string, unknown>;
  constraints: Record<string, unknown>;
  preferredExecutionDeviceId: string | null;
  resolvedExecutionDeviceId: string | null;
  resolvedExecutionRoute: string | null;
  confidence: number;
  evidence: Array<Record<string, unknown>>;
  createdAt: string;
}

export type ExecutionRailTechnicalState =
  | 'PENDING_APPROVAL'
  | 'WAITING_FOR_PRECONDITION'
  | 'EXECUTING'
  | 'OUTCOME_OBSERVED'
  | 'VERIFIED_SUCCESS'
  | 'FAILED';

export type ExecutionRailUserState =
  | 'Needs approval'
  | 'Working'
  | 'Waiting for you'
  | 'Verifying'
  | 'Completed'
  | 'Failed';

export function mapExecutionRailState(state: ExecutionRailTechnicalState): ExecutionRailUserState {
  switch (state) {
    case 'PENDING_APPROVAL':
      return 'Needs approval';
    case 'WAITING_FOR_PRECONDITION':
      return 'Waiting for you';
    case 'EXECUTING':
      return 'Working';
    case 'OUTCOME_OBSERVED':
      return 'Verifying';
    case 'VERIFIED_SUCCESS':
      return 'Completed';
    case 'FAILED':
      return 'Failed';
  }
}
