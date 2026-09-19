import { getCurrentISOString } from '../common/utils.js';
import type { MemoryEngine, MemoryRecord, MemoryType, SensitivityLevel, MemoryProvenance } from './memory.engine.js';

export interface ExtractionInput {
  tenantId: string;
  principalId: string;
  sessionId?: string;
  messageId?: string;
  content: string;
  workspaceId?: string;
  modelProvider?: string;
  modelName?: string;
}

export interface ExtractedCandidate {
  type: MemoryType;
  subject: string;
  predicate: string;
  value: string;
  sensitivity: SensitivityLevel;
  userConfirmed: boolean;
  extractor: 'USER_EXPLICIT' | 'RULE_BASED' | 'MODEL_ASSISTED';
  confidence: number;
}

// Secret detection regex (S3)
const S3_SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/i,
  /bearer\s+[a-zA-Z0-9\._\-]{20,}/i,
  /aws_secret_access_key\s*=/i,
  /-----BEGIN\s+(RSA|EC|PRIVATE)\s+KEY-----/i,
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*['"]?[a-zA-Z0-9\-_]{8,}['"]?/i,
];

// Sensitive detection regex (S2)
const S2_SENSITIVE_PATTERNS = [
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // Credit card
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b01[016789]-?\d{3,4}-?\d{4}\b/, // KR Mobile
  /\b\d{3,6}-\d{2,6}-\d{3,8}\b/, // Generic bank account pattern
];

// One-off temporary query detection
const TEMPORARY_QUERY_PATTERNS = [
  /오늘\s*날씨/i,
  /날씨\s*어때/i,
  /번역해/i,
  /translate/i,
  /2\s*\+\s*2/i,
  /\bwhat\s+is\s+the\s+time\b/i,
  /\bhow\s+is\s+the\s+weather\b/i,
  /\bcalc(ulate)?\b/i,
  /몇\s*시야/i,
];

// Explicit remember intent phrases
const EXPLICIT_REMEMBER_PATTERNS = [
  /기억해줘/i,
  /기억해/i,
  /remember\s+this/i,
  /save\s+this\s+preference/i,
  /기억해\s*두세요/i,
  /기억해둬/i,
];

export class ConversationMemoryExtractor {
  constructor(private readonly memoryEngine: MemoryEngine) {}

  public detectSensitivity(text: string): SensitivityLevel {
    for (const pattern of S3_SECRET_PATTERNS) {
      if (pattern.test(text)) return 'S3';
    }
    for (const pattern of S2_SENSITIVE_PATTERNS) {
      if (pattern.test(text)) return 'S2';
    }
    return 'S1';
  }

  public isTemporaryQuery(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 5) return true;
    for (const pattern of TEMPORARY_QUERY_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
    return false;
  }

  public extractCandidates(input: ExtractionInput): ExtractedCandidate[] {
    const text = input.content.trim();
    if (!text || this.isTemporaryQuery(text)) {
      return [];
    }

    const sensitivity = this.detectSensitivity(text);
    if (sensitivity === 'S3') {
      // DO NOT persist S3 secret context! Candidate must be dropped!
      return [];
    }

    // 1. Explicit memory request check
    let isExplicit = false;
    let explicitText = text;
    for (const pattern of EXPLICIT_REMEMBER_PATTERNS) {
      if (pattern.test(text)) {
        isExplicit = true;
        explicitText = text.replace(pattern, '').replace(/[:;,.]/g, '').trim();
        break;
      }
    }

    if (isExplicit && explicitText.length > 0) {
      return [
        {
          type: 'PREFERENCE',
          subject: 'User Preference',
          predicate: 'preference',
          value: explicitText,
          sensitivity,
          userConfirmed: sensitivity !== 'S2', // S2 must remain unconfirmed
          extractor: 'USER_EXPLICIT',
          confidence: 1.0,
        },
      ];
    }

    // 2. Conservative passive extraction rules
    const candidates: ExtractedCandidate[] = [];

    // Project context / Decision rule
    if (
      /프로젝트|모바일\s*퍼스트|예산|방향|기술\s*스택|프레임워크|arch|architecture|design|first/i.test(text) &&
      /가자|하자|잡자|쓸자|쓰자|선택|결정|방침|must|should|will|use|target/i.test(text)
    ) {
      candidates.push({
        type: 'PROJECT_CONTEXT',
        subject: 'Project Constraint',
        predicate: 'direction',
        value: text,
        sensitivity,
        userConfirmed: false,
        extractor: 'RULE_BASED',
        confidence: 0.85,
      });
    }
    // Negative preference / constraint rule ("보고서는 AI가 쓴 느낌이 나면 안 돼")
    else if (/안\s*돼|하지\s*마|금지|말아줘|마라|don't|never|should\s+not/i.test(text) && /느낌|스타일|어조|톤|보고서|문서|글/i.test(text)) {
      candidates.push({
        type: 'PREFERENCE',
        subject: 'User Preference',
        predicate: 'writing_style',
        value: text,
        sensitivity,
        userConfirmed: false,
        extractor: 'RULE_BASED',
        confidence: 0.9,
      });
    }
    // Relationship / Fact rule ("김대진 대표는 조원씨앤아이 대표야")
    else if (/[가-힣A-Za-z0-9_]+\s*(대표|이사|팀장|직원|님|씨)?\s*(는|은|이|가)\s*.*(대표|회사|소속|직책|팀|역할|대표야|이사야)/i.test(text)) {
      const match = text.match(/([가-힣A-Za-z0-9_]+)\s*(대표|이사|팀장|직원|님|씨)?\s*(는|은|이|가)\s*(.*)/i);
      const subject = match && match[1] ? match[1].trim() : 'Relationship';
      candidates.push({
        type: 'RELATIONSHIP',
        subject,
        predicate: 'role_or_affiliation',
        value: text,
        sensitivity,
        userConfirmed: false,
        extractor: 'RULE_BASED',
        confidence: 0.88,
      });
    }

    return candidates;
  }

  public processMessage(input: ExtractionInput): MemoryRecord[] {
    const settings = this.memoryEngine.getSettings(input.tenantId, input.principalId);
    if (!settings.memoryCaptureEnabled) {
      return [];
    }

    const candidates = this.extractCandidates(input);
    const createdRecords: MemoryRecord[] = [];

    const now = getCurrentISOString();
    for (const candidate of candidates) {
      if (candidate.sensitivity === 'S3') continue;

      const provenance: MemoryProvenance = {
        sourceType: 'CONVERSATION',
        sessionId: input.sessionId,
        messageId: input.messageId,
        extractedAt: now,
        extractor: candidate.extractor,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        confidence: candidate.confidence,
        originalAvailable: true,
      };

      const record = this.memoryEngine.proposeMemory(
        'PERSONAL',
        input.tenantId,
        input.principalId,
        {
          subject: candidate.subject,
          predicate: candidate.predicate,
          value: candidate.value,
        },
        undefined,
        {
          type: candidate.type,
          workspaceId: input.workspaceId,
          confidence: candidate.confidence,
          sensitivity: candidate.sensitivity,
          provenance,
          memoryOrigin: candidate.extractor === 'USER_EXPLICIT' ? 'EXPLICIT_USER' : 'SUGGESTED',
          userConfirmed: candidate.userConfirmed,
        }
      );

      if (record) {
        createdRecords.push(record);
      }
    }

    return createdRecords;
  }
}
