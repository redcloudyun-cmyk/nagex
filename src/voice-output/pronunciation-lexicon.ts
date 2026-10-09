export type PronunciationCategory = 'PRODUCT' | 'BRAND' | 'PROVIDER' | 'TRANSPORT' | 'TECH' | 'PERSONAL_CUSTOM';

export interface PronunciationEntry {
  term: string;
  spoken: string;
  category: PronunciationCategory;
  locale: 'ko-KR' | 'en-US';
}

export class PronunciationLexicon {
  private readonly entries = new Map<string, PronunciationEntry>();

  public static canonical(): PronunciationLexicon {
    const lexicon = new PronunciationLexicon();
    for (const entry of CANONICAL_PRONUNCIATIONS) lexicon.add(entry);
    return lexicon;
  }

  public add(entry: PronunciationEntry): void {
    this.entries.set(this.key(entry.term, entry.locale), entry);
  }

  public lookup(term: string, locale: 'ko-KR' | 'en-US' = 'ko-KR'): PronunciationEntry | null {
    return this.entries.get(this.key(term, locale)) ?? null;
  }

  public apply(text: string, locale: 'ko-KR' | 'en-US' = 'ko-KR'): string {
    let output = text;
    const entries = [...this.entries.values()].filter((entry) => entry.locale === locale);
    entries.sort((a, b) => b.term.length - a.term.length);
    for (const entry of entries) {
      output = output.replace(new RegExp(escapeRegExp(entry.term), 'g'), entry.spoken);
    }
    return output;
  }

  public list(): PronunciationEntry[] {
    return [...this.entries.values()];
  }

  private key(term: string, locale: string): string {
    return `${locale}:${term.toLowerCase()}`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CANONICAL_PRONUNCIATIONS: PronunciationEntry[] = [
  { term: 'NAgex', spoken: '\uB124\uC774\uC81D\uC2A4', category: 'PRODUCT', locale: 'ko-KR' },
  { term: 'NAVER', spoken: '\uB124\uC774\uBC84', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'KORAIL', spoken: '\uCF54\uB808\uC77C', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'KakaoTalk', spoken: '\uCE74\uCE74\uC624\uD1A1', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'Google', spoken: '\uAD6C\uAE00', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'Calendar', spoken: '\uCE98\uB9B0\uB354', category: 'TECH', locale: 'ko-KR' },
  { term: 'Microsoft', spoken: '\uB9C8\uC774\uD06C\uB85C\uC18C\uD504\uD2B8', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'Outlook', spoken: '\uC544\uC6C3\uB8E9', category: 'TECH', locale: 'ko-KR' },
  { term: 'YouTube', spoken: '\uC720\uD29C\uBE0C', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'Hotels.com', spoken: '\uD638\uD154\uC2A4\uB2F7\uCEF4', category: 'PROVIDER', locale: 'ko-KR' },
  { term: 'KTX', spoken: '\uCF00\uC774\uD2F0\uC5D1\uC2A4', category: 'TRANSPORT', locale: 'ko-KR' },
];
