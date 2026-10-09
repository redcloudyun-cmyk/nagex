import { PronunciationLexicon } from './pronunciation-lexicon.js';

export class SpeechNormalizer {
  constructor(private readonly lexicon = PronunciationLexicon.canonical()) {}

  public normalize(text: string, locale: 'ko-KR' | 'en-US' = 'ko-KR'): string {
    if (locale !== 'ko-KR') return this.lexicon.apply(text, locale);
    let output = text;
    output = output.replace(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (_m, _year, month, day) => `${Number(month)}\uC6D4 ${Number(day)}\uC77C`);
    output = output.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_m, hour, minute) => this.normalizeTime(Number(hour), Number(minute)));
    output = output.replace(/(?:₩|KRW\s?)([\d,]+)/gi, (_m, amount) => this.normalizeWon(Number(String(amount).replace(/,/g, ''))));
    output = output.replace(/\b(\d{1,3}(?:,\d{3})+)\s?\uC6D0/g, (_m, amount) => `${this.normalizeWon(Number(String(amount).replace(/,/g, '')))}\uC785\uB2C8\uB2E4`);
    output = output.replace(/\b(\d+)%/g, (_m, value) => `${Number(value)}\uD37C\uC13C\uD2B8`);
    output = output.replace(/\b(\d+)\s?\uBA85/g, (_m, value) => `${Number(value)}\uBA85`);
    output = output.replace(/\b(\d+)\s?\uBD84/g, (_m, value) => `${Number(value)}\uBD84`);
    output = this.lexicon.apply(output, locale);
    return output.replace(/\s+/g, ' ').trim();
  }

  private normalizeTime(hour: number, minute: number): string {
    const period = hour < 12 ? '\uC624\uC804' : '\uC624\uD6C4';
    const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    if (minute === 0) return `${period} ${hour12}\uC2DC`;
    return `${period} ${hour12}\uC2DC ${minute}\uBD84`;
  }

  private normalizeWon(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) return '0\uC6D0';
    const man = Math.floor(amount / 10_000);
    const remainder = amount % 10_000;
    const cheon = Math.floor(remainder / 1_000);
    const rest = remainder % 1_000;
    const parts: string[] = [];
    if (man) parts.push(`${man}\uB9CC`);
    if (cheon) parts.push(`${cheon}\uCC9C`);
    if (rest) parts.push(String(rest));
    return `${parts.join(' ')}\uC6D0`;
  }
}
