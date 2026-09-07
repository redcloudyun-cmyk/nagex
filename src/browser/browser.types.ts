import type { BrowserSessionRecord, BrowserSessionStatus } from './browser-session.store.js';

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
