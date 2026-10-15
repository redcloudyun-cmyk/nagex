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

// One visible, interactive element of the page (see element-map.ts): what it is called (accessible name), what kind it is, whether it can be used, and a selector verified to select exactly it.
// All text is page content: untrusted, bounded, never an instruction. A password field's content is never read.
export interface InteractiveElementSummary {
  index: number;
  role: string;
  name: string;
  selector: string;
  enabled: boolean;
  type?: string;
  context?: string;
  checked?: boolean;
  expanded?: boolean;
  // set when the control is in a same-origin iframe (the selector of that frame) or inside an open shadow root
  frame?: string;
  inShadow?: boolean;
}

export interface StructuredBrowserSnapshot {
  url: string;
  title: string;
  text: string;
  links: StructuredLink[];
  buttons: StructuredButton[];
  inputs: StructuredInput[];
  forms: StructuredForm[];
  // Additive: the interactive element map. Absent from a runtime that does not provide it.
  interactive?: InteractiveElementSummary[];
  // Where the map stopped short, if it did: SCAN_TRUNCATED, CROSS_ORIGIN_FRAMES:n, OPAQUE_ORIGIN_FRAMES:n, FRAME_COUNT_LIMIT, FRAME_DEPTH_LIMIT, FRAME_NOT_ADDRESSABLE. Absent = nothing was left out.
  interactiveLimits?: string[];
}

export interface ElementMatchCandidate {
  selector: string;
  role: string;
  text: string;
  isFormControl: boolean;
  score: number;
  // Additive (element map): the accessible name, the nearest context text that tells identical controls apart, and whether the control can be used right now.
  name?: string;
  context?: string;
  enabled?: boolean;
  inViewport?: boolean;
  type?: string;
  frame?: string;
  inShadow?: boolean;
}

export interface FindResult {
  query: string;
  candidates: ElementMatchCandidate[];
  bestMatch?: ElementMatchCandidate;
  // Additive: how many matching elements were left out because they are not visible (a hidden duplicate is not a target).
  hiddenMatches?: number;
  // Where the search stopped short, if it did (see StructuredBrowserSnapshot.interactiveLimits): a control that is not found there may be in a frame or beyond a bound that NAgex did not enter.
  limits?: string[];
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
