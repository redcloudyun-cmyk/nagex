import type { SensitivityLevel } from './memory.engine.js';

// Secret detection regex (S3)
const S3_SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9\-_]{20,}/i,
  /bearer\s+[a-zA-Z0-9\._\-]{20,}/i,
  /aws_secret_access_key\s*=/i,
  /-----BEGIN\s+(RSA|EC|PRIVATE)\s+KEY-----/i,
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*['"]?[a-zA-Z0-9\-_]{8,}['"]?/i,
  /sec_[a-zA-Z0-9\-_]{16,}/i,
  /token[_-]?secret/i,
];

// Sensitive detection regex (S2)
const S2_SENSITIVE_PATTERNS = [
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, // Email
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // Credit card
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b01[016789]-?\d{3,4}-?\d{4}\b/, // KR Mobile
  /\b\d{3,6}-\d{2,6}-\d{3,8}\b/, // Generic bank account pattern
  /전화번호/i,
  /주민등록번호/i,
  /계좌번호/i,
  /신용카드/i,
];

export function sanitizeTextForSearchQuery(query: string): string {
  let q = query || '';
  // Strip S3 secrets
  for (const pattern of S3_SECRET_PATTERNS) {
    q = q.replace(new RegExp(pattern.source, pattern.flags + 'g'), '');
  }
  // Strip S2 sensitive items (emails, phone numbers, SSNs, credit cards)
  for (const pattern of S2_SENSITIVE_PATTERNS) {
    q = q.replace(new RegExp(pattern.source, pattern.flags + 'g'), '');
  }
  // Strip explicit S2 user markers e.g. "for user Jane Smith", "User Profile: Jane Smith"
  q = q.replace(/(?:for\s+user|user\s+profile:?|user)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/gi, '');
  return q.replace(/\s+/g, ' ').trim();
}

export function detectContentSensitivity(content: unknown): SensitivityLevel {
  const text = typeof content === 'string'
    ? content
    : JSON.stringify(content || '');

  for (const pattern of S3_SECRET_PATTERNS) {
    if (pattern.test(text)) return 'S3';
  }
  for (const pattern of S2_SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return 'S2';
  }
  return 'S1';
}

export function resolveEffectiveSensitivity(content: unknown, callerSensitivity?: SensitivityLevel): SensitivityLevel {
  const detected = detectContentSensitivity(content);

  if (detected === 'S3') return 'S3';
  if (detected === 'S2') {
    if (callerSensitivity === 'S3') return 'S3';
    return 'S2';
  }

  // Caller requested higher sensitivity is allowed, but downgrade (S2/S3 -> S1) is prevented
  if (callerSensitivity === 'S3') return 'S3';
  if (callerSensitivity === 'S2') return 'S2';
  if (callerSensitivity === 'S0') return 'S0';

  return 'S1';
}
