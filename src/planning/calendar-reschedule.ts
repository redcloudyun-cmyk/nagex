// "방금 만든 회의를 한 시간 늦춰줘" - moving an event the person already has. A model cannot do this: it does not know which event is meant, which event id that is, or what the new time works out to. NAgex
// does it from the person's own words, with nothing invented:
//   1. the request is read for WHAT changes (a shift - "한 시간 늦춰", "30분 앞당겨" - or a new date / time - "3시로 옮겨", "내일로 미뤄") and for WHICH event ("방금 만든", a title, a day, a time);
//   2. the event is found among the events NAgex created lately and the person's calendar window; exactly one match is used, several are listed and the person is asked, none is said plainly;
//   3. the new time is computed here (the length is kept, the event's own timezone is used) and the plan shows the exact before -> after; the change is only a proposal until the person approves it.
// Pure: no network, no clock of its own, no model. The candidates are handed in.
import { detectRequestLanguage } from '../common/request-language.js';
import type { PlanPreview } from '../model-gateway/ai-service.js';
import { formatLocalDateTime, pad2, resolveScheduleText, wallClockString, wallTimeToInstant, zonedParts, type CivilDate } from '../common/time-context.js';
import type { ScheduleClock } from './schedule-grounding.js';

export const CALENDAR_UPDATE_TOOL = 'google_calendar.update_event';

export interface KnownCalendarEvent {
  calendarId: string;
  eventId: string;
  summary: string;
  startMs: number;
  endMs: number;
  /** the event's own timezone (the person's, when the calendar did not say) */
  timezone: string;
  source: 'NAGEX_CREATED' | 'CALENDAR';
  /** when NAgex created it (NAGEX_CREATED only) */
  createdAtMs?: number;
}

export interface RescheduleRequest {
  language: 'ko' | 'en';
  shiftMinutes?: number;
  targetDate?: CivilDate;
  targetTime?: { hour: number; minute: number };
  /** "방금 만든 ..." / "the one I just created" */
  justCreated: boolean;
  /** the request names an event ("회의", "meeting") or says "just created" */
  hasReferenceWord: boolean;
  /** the part of the request that says WHICH event (the new time removed) */
  selectorText: string;
}

const CHANGE_VERB = /(옮겨|옮기|옮길|미뤄|미루|당겨|당기|앞당겨|늦춰|늦추|변경|바꿔|바꾸|조정|이동|연기|리스케줄)|\b(move|push|delay|postpone|reschedule|shift|bring\s+(?:it\s+|the\s+\w+\s+)?(?:forward|up)|put\s+(?:it\s+)?(?:back|off)|change)\b/i;
const EVENT_NOUN = /(회의|미팅|일정|약속|이벤트|면담|인터뷰|세미나|워크숍|발표|수업|점심|저녁|식사|통화)|\b(meeting|event|appointment|call|lunch|dinner|interview|standup|sync|session|class|review)\b/i;
const JUST_CREATED = /(방금|아까|조금\s*전|막\s*(?:만든|잡은|추가한|등록한)|새로\s*(?:만든|잡은|등록한))|\bjust\s+(?:created|made|scheduled|added|booked|set\s+up)\b|\b(?:the\s+one|that\s+(?:meeting|event))\s+(?:I|we)\s+(?:just\s+)?(?:created|made|scheduled|added)\b/i;

const KO_TARGET = /(?:으)?로\s*(?:옮겨|옮기|변경|바꿔|바꾸|미뤄|당겨|앞당겨|조정|이동)/;
const EN_TARGET = /\b(?:move|push|reschedule|shift|change|bring|put)\b[\s\S]*?\s(?:to|until)\s+([^.?!]+?)\s*(?:please)?\s*[.?!]*$/i;

function split(prompt: string, language: 'ko' | 'en'): { selector: string; target: string | null } {
  if (language === 'ko') {
    const hit = KO_TARGET.exec(prompt);
    if (!hit) return { selector: prompt, target: null };
    const before = prompt.slice(0, hit.index);
    // the new time follows the last object particle: "프로젝트 리뷰 회의를 [내일 오후 3시]로 옮겨줘"
    const cut = Math.max(before.lastIndexOf('를 '), before.lastIndexOf('을 '), before.lastIndexOf('는 '), before.lastIndexOf('은 '));
    return cut >= 0 ? { selector: before.slice(0, cut + 1), target: before.slice(cut + 2).trim() } : { selector: '', target: before.trim() };
  }
  const hit = EN_TARGET.exec(prompt);
  if (!hit || hit.index === undefined) return { selector: prompt, target: null };
  const toAt = prompt.toLowerCase().lastIndexOf(` ${/\buntil\b/i.test(hit[0]) ? 'until' : 'to'} `, prompt.length - hit[1].length);
  return { selector: toAt >= 0 ? prompt.slice(0, toAt) : prompt, target: hit[1].trim() };
}

export function parseRescheduleRequest(prompt: string, clock: ScheduleClock): RescheduleRequest | null {
  const text = (prompt || '').normalize('NFC').trim();
  if (!text || !CHANGE_VERB.test(text)) return null;
  const language: 'ko' | 'en' = detectRequestLanguage(text) === 'ko' ? 'ko' : 'en';
  const whole = resolveScheduleText(text, clock.nowMs, clock.timezone);
  const { selector, target } = split(text, language);
  const targetSlots = target ? resolveScheduleText(target, clock.nowMs, clock.timezone) : null;
  const shiftMinutes = whole.shiftMinutes;
  const targetDate = targetSlots?.date ? { year: targetSlots.date.year, month: targetSlots.date.month, day: targetSlots.date.day } : undefined;
  const targetTime = targetSlots?.time ? { hour: targetSlots.time.hour, minute: targetSlots.time.minute } : undefined;
  // nothing that says how the time changes: this is not a reschedule ("move it to the cloud")
  if (shiftMinutes === undefined && !targetDate && !targetTime) return null;
  const justCreated = JUST_CREATED.test(text);
  return {
    language,
    ...(shiftMinutes !== undefined && !target ? { shiftMinutes } : {}),
    ...(targetDate ? { targetDate } : {}),
    ...(targetTime ? { targetTime } : {}),
    justCreated,
    hasReferenceWord: justCreated || EVENT_NOUN.test(text),
    selectorText: target ? selector : text,
  };
}

// ---- which event -------------------------------------------------------------------------------------------------------------------------------------------

export type EventReference =
  | { status: 'RESOLVED'; event: KnownCalendarEvent }
  | { status: 'AMBIGUOUS'; candidates: KnownCalendarEvent[] }
  | { status: 'NONE' };

const JUST_CREATED_WINDOW_MS = 6 * 3600_000;
/** two events created this close together are both "the one I just made" */
const JUST_CREATED_TIE_MS = 10 * 60_000;
const GENERIC_WORDS = new Set(['그', '이', '저', '내', '제', '우리', '나의', '회의', '미팅', '일정', '약속', '이벤트', 'the', 'my', 'a', 'an', 'that', 'this', 'meeting', 'event', 'appointment', 'call', 'it', 'one', 'please', 'to', 'by', 'at', 'on', 'for', 'back', 'forward', 'later', 'earlier', 'hour', 'hours', 'minutes', 'minute', 'an', 'push', 'move', 'delay', 'shift', 'reschedule', 'postpone', 'bring']);

function titleTokens(selector: string): string[] {
  return selector
    .toLowerCase()
    .replace(/\d{1,2}\s*(?:시|분|am|pm)|\d{1,2}:\d{2}|오전|오후|내일|모레|오늘|다음\s*주|이번\s*주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|tomorrow|today|next\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => (t.length >= 3 ? t.replace(/(을|를|은|는|이|가|의|에|도|만|랑|과|와)$/u, '') : t))
    .filter((t) => t.length >= 2 && !GENERIC_WORDS.has(t) && !/^(늦춰|미뤄|당겨|앞당겨|옮겨|바꿔|변경|조정|줘|해줘|주세요|해주세요|한|두|세|시간|방금|아까|만든)/.test(t));
}

function sameLocalDate(ms: number, date: CivilDate, timezone: string): boolean {
  const p = zonedParts(ms, timezone);
  return p.year === date.year && p.month === date.month && p.day === date.day;
}

export function resolveEventReference(request: RescheduleRequest, events: KnownCalendarEvent[], clock: ScheduleClock): EventReference {
  const live = events.filter((e) => e.endMs >= clock.nowMs - 24 * 3600_000 && e.endMs > e.startMs);
  if (request.justCreated) {
    const recent = live
      .filter((e) => e.source === 'NAGEX_CREATED' && typeof e.createdAtMs === 'number' && clock.nowMs - e.createdAtMs <= JUST_CREATED_WINDOW_MS)
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    if (recent.length === 0) return { status: 'NONE' };
    if (recent.length === 1) return { status: 'RESOLVED', event: recent[0] };
    const close = recent.filter((e) => (recent[0].createdAtMs ?? 0) - (e.createdAtMs ?? 0) <= JUST_CREATED_TIE_MS);
    return close.length === 1 ? { status: 'RESOLVED', event: recent[0] } : { status: 'AMBIGUOUS', candidates: close.slice(0, 5) };
  }

  const slots = resolveScheduleText(request.selectorText, clock.nowMs, clock.timezone);
  let pool = live;
  if (slots.date) pool = pool.filter((e) => sameLocalDate(e.startMs, { year: slots.date!.year, month: slots.date!.month, day: slots.date!.day }, e.timezone));
  if (slots.time) {
    const t = slots.time;
    pool = pool.filter((e) => {
      const p = zonedParts(e.startMs, e.timezone);
      // without am/pm "2시" may be 02:00 or 14:00; both are the same event
      return p.minute === t.minute && (p.hour === t.hour || (t.inferredMeridiem && (p.hour === t.hour % 12 || p.hour === (t.hour % 12) + 12)));
    });
  }
  const tokens = titleTokens(request.selectorText);
  if (tokens.length > 0) {
    const scored = pool.map((e) => ({ e, score: tokens.filter((t) => e.summary.toLowerCase().includes(t)).length }));
    const best = Math.max(0, ...scored.map((s) => s.score));
    pool = best === 0 ? [] : scored.filter((s) => s.score === best).map((s) => s.e);
  }
  pool = [...pool].sort((a, b) => a.startMs - b.startMs);
  if (pool.length === 0) return { status: 'NONE' };
  if (pool.length === 1) return { status: 'RESOLVED', event: pool[0] };
  return { status: 'AMBIGUOUS', candidates: pool.slice(0, 5) };
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------------------

export type ReschedulePlanResult =
  | { kind: 'NOT_RESCHEDULE' }
  | { kind: 'PLAN'; plan: PlanPreview; event: KnownCalendarEvent; newStartMs: number; newEndMs: number }
  | { kind: 'NEEDS_DETAIL'; reason: 'NO_EVENT' | 'AMBIGUOUS' | 'NO_CHANGE' | 'CALENDAR_UNAVAILABLE' | 'NEEDS_TARGET'; language: 'ko' | 'en'; message: { ko: string; en: string }; candidates?: Array<{ eventId: string; label: string }> };

function rangeLabel(startMs: number, endMs: number, timezone: string, locale: 'ko' | 'en'): string {
  const e = zonedParts(endMs, timezone);
  return `${formatLocalDateTime(startMs, timezone, locale)}–${pad2(e.hour)}:${pad2(e.minute)}`;
}

function wall(ms: number, timezone: string): string {
  const p = zonedParts(ms, timezone);
  return wallClockString(p, p.hour, p.minute);
}

export function buildCalendarReschedulePlan(input: {
  prompt: string;
  clock: ScheduleClock;
  /** events NAgex created lately plus the person's calendar window */
  candidates: KnownCalendarEvent[];
  /** the connection state of the calendar read (CONNECTED / NOT_CONNECTED / ...) */
  calendarState: string;
}): ReschedulePlanResult {
  const request = parseRescheduleRequest(input.prompt, input.clock);
  if (!request) return { kind: 'NOT_RESCHEDULE' };
  const { language } = request;
  const tokens = titleTokens(request.selectorText);
  // a request that names no event, says nothing about "just created" and matches no known title is not about the calendar
  const matchesATitle = tokens.length > 0 && input.candidates.some((e) => tokens.some((t) => e.summary.toLowerCase().includes(t)));
  if (!request.hasReferenceWord && !matchesATitle) return { kind: 'NOT_RESCHEDULE' };

  const reference = resolveEventReference(request, input.candidates, input.clock);
  const listed = (events: KnownCalendarEvent[]) => events.map((e) => ({ eventId: e.eventId, label: `${e.summary} (${formatLocalDateTime(e.startMs, e.timezone, language)})` }));

  if (reference.status === 'NONE') {
    if (input.calendarState !== 'CONNECTED' && input.candidates.length === 0) {
      return { kind: 'NEEDS_DETAIL', reason: 'CALENDAR_UNAVAILABLE', language, message: {
        ko: '캘린더를 읽을 수 없어 어느 일정인지 찾지 못했어요. Google 캘린더 연결을 확인해 주세요. 아무것도 바꾸지 않았어요.',
        en: 'I cannot read your calendar, so I could not find which event you mean. Please check the Google Calendar connection. Nothing was changed.',
      } };
    }
    return { kind: 'NEEDS_DETAIL', reason: 'NO_EVENT', language, message: {
      ko: request.justCreated
        ? '최근에 NAgex로 만든 일정을 찾지 못했어요. 일정 제목이나 날짜를 함께 알려 주세요. (예: "내일 오후 2시 프로젝트 리뷰를 한 시간 늦춰줘") 아무것도 바꾸지 않았어요.'
        : '어느 일정인지 찾지 못했어요. 일정 제목이나 날짜를 함께 알려 주세요. (예: "내일 오후 2시 프로젝트 리뷰를 한 시간 늦춰줘") 아무것도 바꾸지 않았어요.',
      en: request.justCreated
        ? 'I could not find an event that NAgex created recently. Tell me the title or the day too (for example "push tomorrow\'s 2 pm project review back an hour"). Nothing was changed.'
        : 'I could not find which event you mean. Tell me the title or the day too (for example "push tomorrow\'s 2 pm project review back an hour"). Nothing was changed.',
    } };
  }
  if (reference.status === 'AMBIGUOUS') {
    const candidates = listed(reference.candidates);
    const lines = candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
    return { kind: 'NEEDS_DETAIL', reason: 'AMBIGUOUS', language, candidates, message: {
      ko: `어느 일정인가요?\n${lines}\n제목이나 날짜·시각을 함께 말씀해 주세요. 아무것도 바꾸지 않았어요.`,
      en: `Which event do you mean?\n${lines}\nTell me the title, day or time too. Nothing was changed.`,
    } };
  }

  const event = reference.event;
  const tz = event.timezone;
  const durationMs = event.endMs - event.startMs;
  let newStartMs: number;
  if (request.shiftMinutes !== undefined) {
    newStartMs = event.startMs + request.shiftMinutes * 60_000;
  } else {
    const old = zonedParts(event.startMs, tz);
    const date: CivilDate = request.targetDate ?? { year: old.year, month: old.month, day: old.day };
    const time = request.targetTime ?? { hour: old.hour, minute: old.minute };
    newStartMs = wallTimeToInstant({ ...date, hour: time.hour, minute: time.minute }, tz).ms;
  }
  if (newStartMs === event.startMs) {
    return { kind: 'NEEDS_DETAIL', reason: 'NO_CHANGE', language, message: {
      ko: `"${event.summary}"는 이미 그 시각이에요. 아무것도 바꾸지 않았어요.`,
      en: `"${event.summary}" is already at that time. Nothing was changed.`,
    } };
  }
  const newEndMs = newStartMs + durationMs;
  const before = rangeLabel(event.startMs, event.endMs, tz, language);
  const after = rangeLabel(newStartMs, newEndMs, tz, language);
  const minutes = Math.round(durationMs / 60_000);
  const passed = newStartMs < input.clock.nowMs - 5 * 60_000;
  const parameters = {
    calendarId: event.calendarId,
    eventId: event.eventId,
    start: wall(newStartMs, tz),
    end: wall(newEndMs, tz),
    timezone: tz,
    before: { summary: event.summary, start: wall(event.startMs, tz), end: wall(event.endMs, tz), timezone: tz },
  };
  const plan: PlanPreview = {
    goal: language === 'ko' ? '일정 시간 변경' : 'Change the time of an event',
    summary: language === 'ko'
      ? `"${event.summary}": ${before} → ${after} (${tz}). 승인하기 전에는 캘린더가 바뀌지 않아요.`
      : `"${event.summary}": ${before} → ${after} (${tz}). Your calendar is not changed until you approve.`,
    reasoningSummary: language === 'ko'
      ? `${event.source === 'NAGEX_CREATED' ? 'NAgex로 만든 일정' : '캘린더의 일정'}을 찾았어요. 길이(${minutes}분)는 그대로 두고 시작과 끝만 옮겨요.${passed ? ' 이 시각은 이미 지났어요.' : ''}`
      : `Found the event ${event.source === 'NAGEX_CREATED' ? 'NAgex created' : 'on your calendar'}. The length (${minutes} minutes) stays; only the start and end move.${passed ? ' This time has already passed.' : ''}`,
    kind: 'ACTION',
    suggestions: [],
    steps: [{
      step: 1,
      title: language === 'ko' ? `"${event.summary}" 시간 변경` : `Move "${event.summary}"`,
      reasoning: language === 'ko' ? `변경 전: ${before}. 변경 후: ${after} (${tz}).` : `Before: ${before}. After: ${after} (${tz}).`,
      skill: 'skill.scheduling',
      tool: CALENDAR_UPDATE_TOOL,
      requiresApproval: true,
      necessity: 'REQUIRED',
      dependsOn: [],
      parameters,
    }],
  };
  return { kind: 'PLAN', plan, event, newStartMs, newEndMs };
}
