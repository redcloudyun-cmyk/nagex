// "내일 오후 2시에 회의 잡아줘": a model has no clock and no timezone. Planning used to get neither, so a calendar step came back with empty parameters (or a date from the model's training years) and could
// never be scheduled. This module is NAgex's own, deterministic notion of "now" for ONE person:
//   - the effective timezone (a timezone the person set > the timezone of the device they are using > UTC),
//   - local date / weekday / time math that is correct across midnight, month and year ends, leap days and DST,
//   - a bounded resolver for the date / time / duration expressions people actually write (Korean and English),
//   - the text block that tells a model the real date, so it never has to guess it.
// The resolver is a cross-check and a fallback for the model, not a replacement of it: it returns nothing when the text is ambiguous (two dates, a bare weekday that is today, a clock time with no
// am/pm), and the caller then keeps whatever the model said or asks. No model call, no network, no storage. Pure functions of (text, instant, timezone).

export type TimeZoneSource = 'PROFILE' | 'CLIENT' | 'DEFAULT';

export interface EffectiveTimeZone {
  timezone: string;
  source: TimeZoneSource;
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Profile timezone defaults to the placeholder "UTC" for every account, so "UTC" cannot be told apart from a deliberate choice. A profile timezone other than UTC is the person's own choice and wins; otherwise
 * the timezone of the device that is sending the request (validated IANA name) is used; otherwise UTC.
 */
export function resolveEffectiveTimeZone(input: { profileTimezone?: unknown; clientTimezone?: unknown }): EffectiveTimeZone {
  const profile = isValidTimeZone(input.profileTimezone) ? input.profileTimezone : null;
  const client = isValidTimeZone(input.clientTimezone) ? input.clientTimezone : null;
  if (profile && profile.toUpperCase() !== 'UTC' && profile.toUpperCase() !== 'ETC/UTC') return { timezone: profile, source: 'PROFILE' };
  if (client) return { timezone: client, source: 'CLIENT' };
  return { timezone: profile ?? 'UTC', source: profile ? 'PROFILE' : 'DEFAULT' };
}

// ------------------------------------------------------------------------------------------------ zoned date math

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
  offsetMinutes: number;
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = FORMATTER_CACHE.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    FORMATTER_CACHE.set(timezone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(instantMs: number, timezone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timezone).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
  return { year, month, day, hour, minute, second, weekday: WEEKDAY_INDEX[parts.weekday] ?? 0, offsetMinutes };
}

export function addDays(date: CivilDate, days: number): CivilDate & { weekday: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function isRealDate(date: CivilDate): boolean {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return d.getUTCFullYear() === date.year && d.getUTCMonth() === date.month - 1 && d.getUTCDate() === date.day;
}

/**
 * The instant at which the wall clock of `timezone` reads the given date and time. A wall time that does not exist (the hour skipped when clocks go forward) is moved to the first valid minute after
 * the gap and reported through `gap`; a wall time that happens twice (clocks go back) resolves to its first occurrence.
 */
export function wallTimeToInstant(wall: CivilDate & { hour: number; minute: number }, timezone: string): { ms: number; gap: boolean } {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const candidates = new Set<number>();
  for (const probe of [naive - 24 * 3600_000, naive, naive + 24 * 3600_000]) candidates.add(zonedParts(probe, timezone).offsetMinutes);
  const matches: number[] = [];
  for (const offset of candidates) {
    const t = naive - offset * 60_000;
    const back = zonedParts(t, timezone);
    if (back.year === wall.year && back.month === wall.month && back.day === wall.day && back.hour === wall.hour && back.minute === wall.minute) matches.push(t);
  }
  if (matches.length > 0) return { ms: Math.min(...matches), gap: false };
  // nonexistent local time: take the offset in force before the gap and land on the first valid minute after it
  const before = zonedParts(naive - 24 * 3600_000, timezone).offsetMinutes;
  return { ms: naive - before * 60_000, gap: true };
}

export function startOfLocalDay(date: CivilDate, timezone: string): number {
  return wallTimeToInstant({ ...date, hour: 0, minute: 0 }, timezone).ms;
}

/** The last millisecond of the person's current local day. */
export function endOfLocalDayMs(nowMs: number, timezone: string): number {
  return startOfLocalDay(addDays(zonedParts(nowMs, timezone), 1), timezone) - 1;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoDate(date: CivilDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** 'YYYY-MM-DDTHH:mm:00' - a wall-clock time without offset, to be read in the timezone sent beside it. */
export function wallClockString(date: CivilDate, hour: number, minute: number): string {
  return `${isoDate(date)}T${pad2(hour)}:${pad2(minute)}:00`;
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
export const weekdayName = (weekday: number, locale: 'en' | 'ko'): string => (locale === 'ko' ? WEEKDAY_KO : WEEKDAY_EN)[weekday] ?? '';

// ------------------------------------------------------------------------------------------------ the context a model is given

export interface TimeContext {
  nowIso: string;
  timezone: string;
  timezoneSource: TimeZoneSource;
  utcOffset: string;
  localDate: string;
  localTime: string;
  weekdayEn: string;
  weekdayKo: string;
}

export function buildTimeContext(nowMs: number, zone: EffectiveTimeZone): TimeContext {
  const p = zonedParts(nowMs, zone.timezone);
  return {
    nowIso: new Date(nowMs).toISOString(),
    timezone: zone.timezone,
    timezoneSource: zone.source,
    utcOffset: formatUtcOffset(p.offsetMinutes),
    localDate: isoDate(p),
    localTime: `${pad2(p.hour)}:${pad2(p.minute)}`,
    weekdayEn: weekdayName(p.weekday, 'en'),
    weekdayKo: weekdayName(p.weekday, 'ko'),
  };
}

/** The lines added to a planning / chat prompt so relative dates are resolved against the person's real clock. */
export function timeContextPromptLines(ctx: TimeContext, nowMs: number, scope: 'chat' | 'plan' = 'plan'): string[] {
  const today = zonedParts(nowMs, ctx.timezone);
  const next = (days: number) => { const d = addDays(today, days); return `${isoDate(d)} (${weekdayName(d.weekday, 'en')} / ${weekdayName(d.weekday, 'ko')})`; };
  const mondayOffset = ((1 - today.weekday + 7) % 7) || 7;
  const lines = [
    `Current date and time for this person: ${ctx.weekdayEn} (${ctx.weekdayKo}) ${ctx.localDate} ${ctx.localTime}, timezone ${ctx.timezone} (UTC${ctx.utcOffset}). The server clock is the only source of "now"; do not use any other date.`,
    `Reference dates in that timezone: today ${next(0)}; tomorrow ${next(1)}; day after tomorrow ${next(2)}; next Monday (the Monday of next week) ${next(mondayOffset)}. Weeks run Monday to Sunday.`,
    'Resolve every relative date or time in the request (today, tomorrow, next Monday, 오늘, 내일, 모레, 다음 주 월요일, 오후 2시, ...) against this clock and timezone. Never use a date from your training data.',
    'For a calendar step write "start" and "end" as local wall-clock times "YYYY-MM-DDTHH:mm:00" WITHOUT any offset or Z, and "timezone" as the IANA name above. If the request gives a start time but no length, leave "end" out.',
    'For a read of events set "timeMin" and "timeMax" as ISO instants (with Z) that cover exactly the day or range asked for in that timezone.',
  ];
  return scope === 'chat' ? lines.slice(0, 3) : lines;
}

// ------------------------------------------------------------------------------------------------ date / time / duration expressions

export interface ResolvedDate extends CivilDate {
  weekday: number;
  /** what in the text produced it, for the audit trail and tests */
  matched: string;
  isPast: boolean;
}

export interface ResolvedTime {
  hour: number;
  minute: number;
  matched: string;
  /** true when the text gave no am/pm and a business-hours reading was used (1-6 -> pm, 7-11 -> am) */
  inferredMeridiem: boolean;
}

export interface ScheduleSlots {
  date?: ResolvedDate;
  time?: ResolvedTime;
  endTime?: ResolvedTime;
  durationMinutes?: number;
  /** "한 시간 늦춰줘" = +60, "30분 당겨줘" = -30 */
  shiftMinutes?: number;
  /** why a field was left out */
  ambiguous: string[];
}

const KO_WEEKDAY: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const EN_WEEKDAY: Record<string, number> = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const EN_MONTH: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const KO_NUM: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };

function weekdayInWeek(today: ZonedParts, weekOffset: number, weekday: number): CivilDate & { weekday: number } {
  // weeks run Monday..Sunday: days since this week's Monday
  const sinceMonday = (today.weekday + 6) % 7;
  const targetIndex = (weekday + 6) % 7;
  return addDays(today, weekOffset * 7 - sinceMonday + targetIndex);
}

function toResolved(date: CivilDate & { weekday?: number }, today: ZonedParts, matched: string): ResolvedDate {
  const weekday = date.weekday ?? weekdayOf(date);
  const key = (d: CivilDate) => d.year * 10000 + d.month * 100 + d.day;
  return { year: date.year, month: date.month, day: date.day, weekday, matched, isPast: key(date) < key(today) };
}

function sameDate(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function findDates(text: string, today: ZonedParts): ResolvedDate[] {
  const found: ResolvedDate[] = [];
  const push = (d: (CivilDate & { weekday?: number }) | null, matched: string) => { if (d && isRealDate(d)) found.push(toResolved(d, today, matched)); };
  let rest = text;
  const take = (re: RegExp, handler: (m: RegExpExecArray) => void) => {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    rest = rest.replace(global, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      (match as unknown as { index: number }).index = args[args.length - 2] as number;
      handler(match);
      return ' '.repeat(String(args[0]).length);
    });
  };

  // absolute: 2026-10-20, 2026/10/20, 2026.10.20
  take(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/, (m) => push({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, m[0]));
  // Korean month/day with optional year: 10월 20일, 2027년 1월 5일
  take(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/, (m) => {
    const month = Number(m[2]);
    const day = Number(m[3]);
    let year = m[1] ? Number(m[1]) : today.year;
    if (!m[1] && (month < today.month || (month === today.month && day < today.day))) year += 1; // "10월 3일" said in November means next year
    push({ year, month, day }, m[0].trim());
  });
  // 이번 달 / 다음 달 N일
  take(/(이번|다음|지난)\s*달\s*(\d{1,2})\s*일/, (m) => {
    const offset = m[1] === '이번' ? 0 : m[1] === '다음' ? 1 : -1;
    const base = new Date(Date.UTC(today.year, today.month - 1 + offset, 1));
    push({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: Number(m[2]) }, m[0]);
  });
  // 다음 주 월요일 / 이번 주 금요일 / 다다음 주 화요일
  take(/(다다음|다음|이번|담|지난)\s*주\s*(?:에\s*)?(월|화|수|목|금|토|일)\s*요일/, (m) => {
    const weekOffset = m[1] === '다다음' ? 2 : m[1] === '다음' || m[1] === '담' ? 1 : m[1] === '지난' ? -1 : 0;
    push(weekdayInWeek(today, weekOffset, KO_WEEKDAY[m[2]]), m[0]);
  });
  // relative: N일 뒤, N주 뒤, 일주일 뒤
  take(/(\d{1,3})\s*일\s*(?:뒤|후)/, (m) => push(addDays(today, Number(m[1])), m[0]));
  take(/(\d{1,2})\s*주\s*(?:뒤|후)/, (m) => push(addDays(today, 7 * Number(m[1])), m[0]));
  take(/일\s*주일\s*(?:뒤|후)/, (m) => push(addDays(today, 7), m[0]));
  // 그저께 어제 오늘 내일 모레 글피
  take(/(?<![가-힣])(그저께|엊그제|어제|오늘|내일모레|모레|내일|글피)(?![가-힣]{2,})/, (m) => {
    const days: Record<string, number> = { 그저께: -2, 엊그제: -2, 어제: -1, 오늘: 0, 내일: 1, 모레: 2, 내일모레: 2, 글피: 3 };
    push(addDays(today, days[m[1]]), m[1]);
  });
  // bare Korean weekday: 금요일 (the next one; today's weekday is ambiguous and is left out below)
  take(/(?<![가-힣])(월|화|수|목|금|토|일)요일/, (m) => {
    const wd = KO_WEEKDAY[m[1]];
    const ahead = (wd - today.weekday + 7) % 7;
    if (ahead === 0) { found.push({ ...toResolved(today, today, m[0]), matched: `${m[0]}!bare-today` }); return; }
    push(addDays(today, ahead), m[0]);
  });

  const lower = rest.toLowerCase();
  const takeEn = (re: RegExp, handler: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(lower)) !== null) handler(m);
  };
  takeEn(/\b(day after tomorrow)\b/i, (m) => push(addDays(today, 2), m[0]));
  takeEn(/\b(?<!day after )(tomorrow)\b/i, (m) => push(addDays(today, 1), m[0]));
  takeEn(/\b(today|tonight)\b/i, (m) => push(addDays(today, 0), m[0]));
  takeEn(/\bin\s+(\d{1,3})\s+days?\b/i, (m) => push(addDays(today, Number(m[1])), m[0]));
  takeEn(/\bin\s+(\d{1,2})\s+weeks?\b/i, (m) => push(addDays(today, 7 * Number(m[1])), m[0]));
  takeEn(/\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)\b/i, (m) => push(weekdayInWeek(today, m[1] === 'next' ? 1 : 0, EN_WEEKDAY[m[2]]), m[0]));
  takeEn(/\b(?<!next |this )(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i, (m) => {
    const wd = EN_WEEKDAY[m[1]];
    const ahead = (wd - today.weekday + 7) % 7;
    if (ahead === 0) { found.push({ ...toResolved(today, today, m[0]), matched: `${m[0]}!bare-today` }); return; }
    push(addDays(today, ahead), m[0]);
  });
  takeEn(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i, (m) => {
    const month = EN_MONTH[m[1]];
    const day = Number(m[2]);
    let year = m[3] ? Number(m[3]) : today.year;
    if (!m[3] && (month < today.month || (month === today.month && day < today.day))) year += 1;
    push({ year, month, day }, m[0]);
  });
  return found;
}

function meridiemHour(period: string | undefined, hour: number): { hour: number; inferred: boolean; ok: boolean } {
  if (hour > 24) return { hour, inferred: false, ok: false };
  if (!period) {
    if (hour >= 13 && hour <= 24) return { hour: hour % 24, inferred: false, ok: true };
    if (hour === 12) return { hour: 12, inferred: false, ok: true };
    if (hour === 0) return { hour: 0, inferred: false, ok: true };
    return { hour: hour <= 6 ? hour + 12 : hour, inferred: true, ok: true };
  }
  if (period === '오전' || period === '아침' || period === '새벽' || period === 'am') return { hour: hour === 12 ? 0 : hour, inferred: false, ok: hour >= 1 && hour <= 12 };
  if (period === '점심') return { hour: hour >= 11 ? hour : hour + 12, inferred: false, ok: (hour >= 11 && hour <= 12) || (hour >= 1 && hour <= 2) };
  if (period === '밤') return { hour: hour === 12 ? 0 : hour + 12, inferred: false, ok: hour >= 6 && hour <= 12 };
  // 오후 저녁 pm
  return { hour: hour === 12 ? 12 : hour + 12, inferred: false, ok: hour >= 1 && hour <= 12 };
}

function findTimes(text: string): ResolvedTime[] {
  const found: ResolvedTime[] = [];
  const masked = text.replace(/(\d+)\s*시간/g, (m) => ' '.repeat(m.length));
  let rest = masked;
  const take = (re: RegExp, handler: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    rest = rest.replace(g, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      handler(match);
      return ' '.repeat(String(args[0]).length);
    });
  };
  take(/(?<![가-힣])정오/, (m) => found.push({ hour: 12, minute: 0, matched: m[0], inferredMeridiem: false }));
  take(/(?<![가-힣])자정/, (m) => found.push({ hour: 0, minute: 0, matched: m[0], inferredMeridiem: false }));
  take(/(오전|오후|아침|점심|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?!간)(?:\s*(?:(\d{1,2})\s*분|(반)))?/, (m) => {
    const resolved = meridiemHour(m[1] === '저녁' ? '오후' : m[1], Number(m[2]));
    if (!resolved.ok) return;
    found.push({ hour: resolved.hour, minute: m[4] ? 30 : m[3] ? Number(m[3]) : 0, matched: m[0].trim(), inferredMeridiem: resolved.inferred });
  });
  // "2:15 pm" is read before the 24-hour form, which would otherwise take it for 02:15
  take(/(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i, (m) => {
    const hour = Number(m[1]);
    if (hour < 1 || hour > 12) return;
    const pm = m[3].toLowerCase().startsWith('p');
    found.push({ hour: pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour, minute: m[2] ? Number(m[2]) : 0, matched: m[0], inferredMeridiem: false });
  });
  take(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/, (m) => found.push({ hour: Number(m[1]), minute: Number(m[2]), matched: m[0], inferredMeridiem: false }));
  const lower = rest.toLowerCase();
  if (/\bnoon\b/.test(lower)) found.push({ hour: 12, minute: 0, matched: 'noon', inferredMeridiem: false });
  if (/\bmidnight\b/.test(lower)) found.push({ hour: 0, minute: 0, matched: 'midnight', inferredMeridiem: false });
  return found;
}

function koCount(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : KO_NUM[token] ?? NaN;
}

function findDuration(text: string): number | undefined {
  // "1시간 30분", "한 시간", "두 시간짜리", "30분짜리", "반 시간", "2 hours", "45 minutes" - but not "30분 뒤" (an offset) and not a shift ("한 시간 늦춰")
  const re = /(?<![가-힣\d])(\d+(?:\.\d+)?|한|두|세|네|다섯|여섯)\s*시간(?:\s*(\d{1,2})\s*분)?(?!\s*(?:뒤|후|전|늦|미뤄|미루|당겨|앞당|빨리))|(?<![가-힣\d])(\d{1,3})\s*분(?!\s*(?:뒤|후|전|늦|미뤄|미루|당겨|앞당|빨리))(?:짜리|동안|간)?|반\s*시간(?!\s*(?:뒤|후|전|늦|미뤄|미루|당겨|앞당|빨리))|\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b(?:\s*(?:and\s*)?(\d{1,2})\s*(?:minutes?|mins?))?|\b(\d{1,3})\s*(?:minutes?|mins?)\b(?!\s*(?:later|from now|ago))/i;
  const m = re.exec(text);
  if (!m) return undefined;
  let minutes: number;
  if (m[0].startsWith('반')) minutes = 30;
  else if (m[1] !== undefined) {
    const hours = /^\d+(?:\.\d+)?$/.test(m[1]) ? Number(m[1]) : koCount(m[1]);
    minutes = Math.round(hours * 60) + (m[2] ? Number(m[2]) : 0);
  } else if (m[3] !== undefined) minutes = Number(m[3]);
  else if (m[4] !== undefined) minutes = Math.round(Number(m[4]) * 60) + (m[5] ? Number(m[5]) : 0);
  else if (m[6] !== undefined) minutes = Number(m[6]);
  else return undefined;
  return Number.isFinite(minutes) && minutes >= 5 && minutes <= 24 * 60 ? minutes : undefined;
}

function findShift(text: string): number | undefined {
  // "한 시간 늦춰줘" (+60), "30분 미뤄줘" (+30), "1시간 당겨줘" (-60), "push it back an hour"
  const ko = /(?<![가-힣\d])(\d+(?:\.\d+)?|한|두|세)\s*시간\s*(?:(\d{1,2})\s*분\s*)?(?:(?:더|좀|조금|만)\s*)?(늦|미뤄|미루|뒤로)|(?<![가-힣\d])(\d{1,3})\s*분\s*(?:(?:더|좀|조금|만)\s*)?(늦|미뤄|미루|뒤로)|(?<![가-힣\d])(\d+(?:\.\d+)?|한|두|세)\s*시간\s*(?:(\d{1,2})\s*분\s*)?(?:(?:더|좀|조금|만)\s*)?(당겨|앞당|앞으로|빨리)|(?<![가-힣\d])(\d{1,3})\s*분\s*(?:(?:더|좀|조금|만)\s*)?(당겨|앞당|앞으로|빨리)/.exec(text);
  if (ko) {
    if (ko[3] !== undefined) return (Math.round((/^\d/.test(ko[1]) ? Number(ko[1]) : koCount(ko[1])) * 60) + (ko[2] ? Number(ko[2]) : 0));
    if (ko[5] !== undefined) return Number(ko[4]);
    if (ko[8] !== undefined) return -(Math.round((/^\d/.test(ko[6]) ? Number(ko[6]) : koCount(ko[6])) * 60) + (ko[7] ? Number(ko[7]) : 0));
    if (ko[10] !== undefined) return -Number(ko[9]);
  }
  const en = /\b(?:push|move|delay|shift)\b[^.]*?\b(?:back|later|forward)\b[^.]*?\b(an?|one|\d+)\s*(hour|hours|minutes?|mins?)\b|\b(?:push|move|bring)\b[^.]*?\b(?:up|earlier)\b[^.]*?\b(an?|one|\d+)\s*(hour|hours|minutes?|mins?)\b/i.exec(text);
  if (en) {
    const later = en[1] !== undefined;
    const amountToken = (later ? en[1] : en[3]).toLowerCase();
    const unit = (later ? en[2] : en[4]).toLowerCase();
    const amount = amountToken === 'a' || amountToken === 'an' || amountToken === 'one' ? 1 : Number(amountToken);
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    return later ? minutes : -minutes;
  }
  return undefined;
}

/**
 * Reads the schedule words of a request. `now` is the server clock, `timezone` the person's effective timezone. A field is returned only when the text is clear about it.
 */
export function resolveScheduleText(text: string, nowMs: number, timezone: string): ScheduleSlots {
  const input = (text || '').normalize('NFC');
  const today = zonedParts(nowMs, timezone);
  const slots: ScheduleSlots = { ambiguous: [] };

  const dates = findDates(input, today);
  const bare = dates.filter((d) => d.matched.endsWith('!bare-today'));
  const concrete = dates.filter((d) => !d.matched.endsWith('!bare-today'));
  const distinct = concrete.filter((d, i) => concrete.findIndex((o) => sameDate(o, d)) === i);
  if (distinct.length === 1 && bare.length === 0) {
    if (distinct[0].isPast) slots.ambiguous.push('PAST_DATE');
    else slots.date = distinct[0];
  } else if (distinct.length > 1) slots.ambiguous.push('MULTIPLE_DATES');
  else if (bare.length > 0) slots.ambiguous.push('BARE_WEEKDAY_IS_TODAY');

  const times = findTimes(input);
  const distinctTimes = times.filter((t, i) => times.findIndex((o) => o.hour === t.hour && o.minute === t.minute) === i);
  if (distinctTimes.length === 1) slots.time = distinctTimes[0];
  else if (distinctTimes.length === 2 && /(부터|~|–|-|\bto\b|\buntil\b|\bfrom\b)/i.test(input)) {
    const [a, b] = distinctTimes;
    slots.time = a;
    slots.endTime = b;
    if (b.hour * 60 + b.minute <= a.hour * 60 + a.minute) { slots.endTime = undefined; slots.ambiguous.push('END_BEFORE_START'); }
  } else if (distinctTimes.length > 1) slots.ambiguous.push('MULTIPLE_TIMES');

  // the minutes of a clock time ("11시 30분", "14:30") are not a length
  const withoutClockTimes = input.replace(/(?:오전|오후|아침|점심|저녁|밤|새벽)?\s*\d{1,2}\s*시(?!간)(?:\s*(?:\d{1,2}\s*분|반))?/g, ' ').replace(/\d{1,2}:\d{2}/g, ' ');
  const duration = findDuration(withoutClockTimes);
  if (duration !== undefined && !slots.endTime) slots.durationMinutes = duration;
  const shift = findShift(input);
  if (shift !== undefined) slots.shiftMinutes = shift;
  return slots;
}

export interface LocalRange {
  startMs: number;
  endMs: number;
  /** 'DAY' | 'WEEK' | 'REST_OF_DAY' | 'REST_OF_WEEK' */
  kind: string;
  label: string;
}

/** The time range a "what is on my calendar ..." request asks about, in the person's timezone. Nothing when the text names none. */
export function resolveQueryRange(text: string, nowMs: number, timezone: string): LocalRange | null {
  const input = (text || '').normalize('NFC').toLowerCase();
  const today = zonedParts(nowMs, timezone);
  const remaining = /(남은|남아|remaining|rest of)/.test(input);
  const endOf = (date: CivilDate) => startOfLocalDay(addDays(date, 1), timezone) - 1;

  const weekMatch = /(다다음|다음|이번|담)\s*주(?!\s*(?:월|화|수|목|금|토|일)\s*요일)|\b(next|this)\s+week\b/.exec(input);
  if (weekMatch) {
    const offset = weekMatch[1] === '다다음' ? 2 : weekMatch[1] === '다음' || weekMatch[1] === '담' || weekMatch[2] === 'next' ? 1 : 0;
    const monday = weekdayInWeek(today, offset, 1);
    const sunday = addDays(monday, 6);
    if (offset === 0 && remaining) return { startMs: nowMs, endMs: endOf(sunday), kind: 'REST_OF_WEEK', label: `${isoDate(today)} ~ ${isoDate(sunday)}` };
    return { startMs: startOfLocalDay(monday, timezone), endMs: endOf(sunday), kind: 'WEEK', label: `${isoDate(monday)} ~ ${isoDate(sunday)}` };
  }
  const slots = resolveScheduleText(text, nowMs, timezone);
  if (slots.date) {
    const d: CivilDate = slots.date;
    if (sameDate(d, today) && remaining) return { startMs: nowMs, endMs: endOf(d), kind: 'REST_OF_DAY', label: isoDate(d) };
    return { startMs: startOfLocalDay(d, timezone), endMs: endOf(d), kind: 'DAY', label: isoDate(d) };
  }
  return null;
}

/** Local wall time of an instant for display: "2026-10-17 (토) 14:00" */
export function formatLocalDateTime(ms: number, timezone: string, locale: 'en' | 'ko'): string {
  const p = zonedParts(ms, timezone);
  return `${isoDate(p)} (${locale === 'ko' ? WEEKDAY_KO[p.weekday].slice(0, 1) : WEEKDAY_EN[p.weekday].slice(0, 3)}) ${pad2(p.hour)}:${pad2(p.minute)}`;
}
