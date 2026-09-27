import type { BrowserSessionRecord, BrowserSessionStatus } from './browser-session.store.js';

export type BrowserContentTrustLevel = 'UNTRUSTED_EXTERNAL';

export interface BrowserContentTrustMetadata {
  level: BrowserContentTrustLevel;
  source: 'BROWSER';
  origin: string | null;
  canGrantPermission: false;
  canApproveAction: false;
  canAuthorizeCredentialUse: false;
  canOverridePolicy: false;
  canWritePersistentMemory: false;
}

export function createBrowserContentTrustMetadata(url: string): BrowserContentTrustMetadata {
  let origin: string | null = null;
  try {
    const parsed = new URL(url);
    origin = parsed.origin === 'null' ? null : parsed.origin.toLowerCase();
  } catch {
    origin = null;
  }
  return {
    level: 'UNTRUSTED_EXTERNAL',
    source: 'BROWSER',
    origin,
    canGrantPermission: false,
    canApproveAction: false,
    canAuthorizeCredentialUse: false,
    canOverridePolicy: false,
    canWritePersistentMemory: false,
  };
}

export function isUntrustedBrowserContentTrust(value: unknown): value is BrowserContentTrustMetadata {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.level === 'UNTRUSTED_EXTERNAL'
    && v.source === 'BROWSER'
    && v.canGrantPermission === false
    && v.canApproveAction === false
    && v.canAuthorizeCredentialUse === false
    && v.canOverridePolicy === false
    && v.canWritePersistentMemory === false;
}

export interface StructuredLink {
  text: string;
  href: string;
}

export interface StructuredButton {
  text: string;
  id?: string;
  role?: string;
}

export interface StructuredInput {
  label?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  value?: string;
}

export interface StructuredForm {
  action?: string;
  method?: string;
  inputCount: number;
}

export interface StructuredBrowserSnapshot {
  url: string;
  title: string;
  text: string;
  links: StructuredLink[];
  buttons: StructuredButton[];
  inputs: StructuredInput[];
  forms: StructuredForm[];
}

export interface ElementMatchCandidate {
  selector: string;
  role: string;
  text: string;
  isFormControl: boolean;
  score: number;
}

export interface FindResult {
  query: string;
  candidates: ElementMatchCandidate[];
  bestMatch?: ElementMatchCandidate;
}

export interface ExtractResult {
  url: string;
  title: string;
  target: 'text' | 'links' | 'buttons' | 'inputs' | 'all';
  extracted: {
    text?: string;
    links?: StructuredLink[];
    buttons?: StructuredButton[];
    inputs?: StructuredInput[];
    summary?: string;
  };
  timestamp: string;
}

export interface BrowserEvidenceArtifact {
  evidenceId: string;
  url: string;
  title: string;
  filePath: string;
  capturedAt: string;
}

export { BrowserSessionRecord, BrowserSessionStatus };


export type UntrustedStructuredBrowserSnapshot = StructuredBrowserSnapshot & {
  trust: BrowserContentTrustMetadata;
};

export type UntrustedFindResult = FindResult & {
  trust: BrowserContentTrustMetadata;
};

export type UntrustedExtractResult = ExtractResult & {
  trust: BrowserContentTrustMetadata;
};
