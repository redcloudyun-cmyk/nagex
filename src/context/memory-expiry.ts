// "다음 주 금요일까지 부산 출장 중이야" is context with an END. Remembered forever it would turn false on its own ("출장 중" long after the trip), and recalled as current it would mislead. When a statement
// EXPLICITLY bounds itself in time, NAgex records when it ends and stops treating it as current after that (it is kept, visible in the person's history, restorable). Only explicit bounds count:
//   - an end date ("금요일까지", "12월 25일까지", "until Friday", "through next week") -> the end of that local day in the person's timezone;
//   - a duration ("3일 동안", "2주 동안", "for the next 3 days") -> that long from now.
// A preference, a fact or a statement with no stated end never expires, and a date that is already past is not an end date. Pure: the clock and the timezone are handed in.
import { addDays, resolveScheduleText, wallTimeToInstant, zonedParts } from '../common/time-context.js';

export interface MemoryExpiry {
  /** an ISO instant: the memory is current until then */
  expiresAt: string;
  /** the words that bounded it */
  basis: string;
}

const MAX_YEARS = 5;
const DAY_MS = 24 * 3600_000;

const KO_UNTIL = /([^\s,.!?]+(?:\s+[^\s,.!?]+){0,3})\s*까지/;
const EN_UNTIL = /\b(?:until|till|through|thru|by)\s+([^,.!?;]{2,30})/i;
const KO_DURATION = /(\d{1,3})\s*(일|주|개월|달)\s*동안/;
const EN_DURATION = /\bfor\s+(?:the\s+next\s+)?(\d{1,3})\s*(days?|weeks?|months?)\b/i;

function endOfLocalDay(date: { year: number; month: number; day: number }, timezone: string): number {
  const next = addDays(date, 1);
  return wallTimeToInstant({ year: next.year, month: next.month, day: next.day, hour: 0, minute: 0 }, timezone).ms - 1;
}

export function inferMemoryExpiry(text: string, nowMs: number, timezone: string): MemoryExpiry | null {
  const input = (text || '').normalize('NFC');
  if (!input.trim()) return null;
  const limit = nowMs + MAX_YEARS * 365 * DAY_MS;

  const ko = KO_DURATION.exec(input);
  const en = EN_DURATION.exec(input);
  const duration = ko ?? en;
  if (duration) {
    const n = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const days = unit.startsWith('일') || unit.startsWith('day') ? n : unit.startsWith('주') || unit.startsWith('week') ? n * 7 : n * 30;
    const ms = nowMs + days * DAY_MS;
    if (n >= 1 && ms <= limit) return { expiresAt: new Date(ms).toISOString(), basis: duration[0] };
  }

  for (const [match, phrase] of [[KO_UNTIL.exec(input), KO_UNTIL.exec(input)?.[1]], [EN_UNTIL.exec(input), EN_UNTIL.exec(input)?.[1]]] as const) {
    if (!match || !phrase) continue;
    const slots = resolveScheduleText(phrase, nowMs, timezone);
    const date = slots.date;
    // an end date that is not a clear future day is not an end date
    if (!date || date.isPast) continue;
    const today = zonedParts(nowMs, timezone);
    const ms = endOfLocalDay(date, timezone);
    if (ms <= nowMs && !(date.year === today.year && date.month === today.month && date.day === today.day)) continue;
    if (ms > limit) continue;
    return { expiresAt: new Date(ms).toISOString(), basis: match[0].trim() };
  }
  return null;
}
