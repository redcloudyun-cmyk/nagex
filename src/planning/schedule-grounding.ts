// A model plans "내일 오후 2시에 회의 잡아줘" and gets the date wrong - or, with no clock to read, returns a calendar step with no arguments at all, which can never be scheduled. NAgex owns dates:
// after the model has planned, the calendar steps are completed and checked against the person's real clock and timezone with the deterministic resolver (common/time-context.ts).
//   - A date or time the REQUEST states unambiguously wins over what the model wrote (a model is good at what the person means and poor at which date next Monday is). Where the request is vague,
//     two-valued or has no am/pm, the resolver says nothing and the model's own value is kept.
//   - Start and end are local wall-clock times in the person's effective timezone, sent with that timezone. The length defaults to 60 minutes only when neither the request nor the model gave one,
//     and the step says so, in the same words the person reads before approving.
//   - Reads (list / free slots) get exactly the range the request names, not the broker's "next 7 days".
// Grounding never creates a step, never removes one, never changes the tool, and never touches approval: it only fills in and corrects the arguments of a calendar step the model already planned.
import type { PlanPreview, PlanStep } from '../model-gateway/ai-service.js';
import {
  isoDate, resolveQueryRange, resolveScheduleText, wallClockString, wallTimeToInstant, weekdayName, zonedParts, formatLocalDateTime,
  type CivilDate, type TimeZoneSource,
} from '../common/time-context.js';

export interface ScheduleClock {
  nowMs: number;
  timezone: string;
  timezoneSource: TimeZoneSource;
}

export const CALENDAR_CREATE_TOOL = 'google_calendar.create_event';
const CALENDAR_READ_TOOLS = new Set(['google_calendar.list_events', 'google_calendar.free_slots']);
export const DEFAULT_EVENT_MINUTES = 60;
const MIN_EVENT_MINUTES = 5;
const MAX_EVENT_MINUTES = 24 * 60;

interface ModelWall {
  date: CivilDate;
  hour: number;
  minute: number;
}

// The model was told to send a wall-clock time without offset; if it sent an offset or Z anyway, the instant is kept and read in the person's timezone.
function readModelWall(value: unknown, timezone: string): ModelWall | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
  if (naive) return { date: { year: Number(naive[1]), month: Number(naive[2]), day: Number(naive[3]) }, hour: Number(naive[4]), minute: Number(naive[5]) };
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return null;
    const p = zonedParts(ms, timezone);
    return { date: { year: p.year, month: p.month, day: p.day }, hour: p.hour, minute: p.minute };
  }
  return null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : [];
}

function groundCreate(step: PlanStep, prompt: string, clock: ScheduleClock, locale: 'en' | 'ko'): PlanStep {
  const given = step.parameters && typeof step.parameters === 'object' && !Array.isArray(step.parameters) ? (step.parameters as Record<string, unknown>) : {};
  const slots = resolveScheduleText(prompt, clock.nowMs, clock.timezone);
  const modelStart = readModelWall(given.start, clock.timezone);
  const modelEnd = readModelWall(given.end, clock.timezone);

  const date: CivilDate | null = slots.date ?? modelStart?.date ?? null;
  // a clock time the request states beats the model's; a time that was only inferred (no am/pm) does not override a time the model chose
  const time = slots.time && !(slots.time.inferredMeridiem && modelStart)
    ? { hour: slots.time.hour, minute: slots.time.minute }
    : modelStart ? { hour: modelStart.hour, minute: modelStart.minute } : slots.time ? { hour: slots.time.hour, minute: slots.time.minute } : null;
  // not enough to schedule anything: leave the step exactly as planned, so the plan stays "arguments missing" and the person is asked, instead of an event being invented
  if (!date || !time) return step;

  const start = wallTimeToInstant({ ...date, hour: time.hour, minute: time.minute }, clock.timezone);
  let minutes: number | null = null;
  let lengthFrom: 'REQUEST' | 'MODEL' | 'DEFAULT' = 'DEFAULT';
  if (slots.endTime && slots.time) {
    const end = wallTimeToInstant({ ...date, hour: slots.endTime.hour, minute: slots.endTime.minute }, clock.timezone);
    minutes = Math.round((end.ms - start.ms) / 60000);
    lengthFrom = 'REQUEST';
  } else if (slots.durationMinutes) {
    minutes = slots.durationMinutes;
    lengthFrom = 'REQUEST';
  } else if (modelStart && modelEnd) {
    const modelStartMs = wallTimeToInstant({ ...modelStart.date, hour: modelStart.hour, minute: modelStart.minute }, clock.timezone).ms;
    const modelEndMs = wallTimeToInstant({ ...modelEnd.date, hour: modelEnd.hour, minute: modelEnd.minute }, clock.timezone).ms;
    const diff = Math.round((modelEndMs - modelStartMs) / 60000);
    if (diff >= MIN_EVENT_MINUTES && diff <= MAX_EVENT_MINUTES) { minutes = diff; lengthFrom = 'MODEL'; }
  }
  if (minutes === null || minutes < MIN_EVENT_MINUTES || minutes > MAX_EVENT_MINUTES) { minutes = DEFAULT_EVENT_MINUTES; lengthFrom = 'DEFAULT'; }

  const startParts = zonedParts(start.ms, clock.timezone);
  const endParts = zonedParts(start.ms + minutes * 60000, clock.timezone);
  const summary = typeof given.summary === 'string' && given.summary.trim() ? given.summary.trim() : locale === 'ko' ? '일정' : 'Event';

  const parameters: Record<string, unknown> = {
    calendarId: typeof given.calendarId === 'string' && given.calendarId.trim() ? given.calendarId.trim() : 'primary',
    summary,
    description: typeof given.description === 'string' ? given.description : '',
    start: wallClockString(startParts, startParts.hour, startParts.minute),
    end: wallClockString(endParts, endParts.hour, endParts.minute),
    timezone: clock.timezone,
    attendees: strings(given.attendees),
    ...(typeof given.conferenceData === 'boolean' ? { conferenceData: given.conferenceData } : {}),
  };

  const notes: string[] = [];
  const when = formatLocalDateTime(start.ms, clock.timezone, locale);
  if (slots.date && modelStart && isoDate(modelStart.date) !== isoDate(slots.date)) {
    notes.push(locale === 'ko'
      ? `날짜를 요청의 "${slots.date.matched}"에 맞춰 ${isoDate(slots.date)}(${weekdayName(slots.date.weekday, 'ko').slice(0, 1)})로 바로잡았습니다 (${clock.timezone} 기준).`
      : `The date was set to ${isoDate(slots.date)} (${weekdayName(slots.date.weekday, 'en').slice(0, 3)}) from "${slots.date.matched}" in your timezone ${clock.timezone}.`);
  }
  if (start.gap) notes.push(locale === 'ko' ? '요청한 시각은 서머타임으로 존재하지 않아 가장 가까운 다음 시각으로 옮겼습니다.' : 'That local time does not exist (clocks go forward); it was moved to the next valid time.');
  if (lengthFrom === 'DEFAULT') notes.push(locale === 'ko' ? `길이를 말씀하지 않아 기본 ${DEFAULT_EVENT_MINUTES}분으로 잡았습니다.` : `No length was given, so the default of ${DEFAULT_EVENT_MINUTES} minutes is used.`);
  if (slots.time?.inferredMeridiem && !modelStart) notes.push(locale === 'ko' ? `오전/오후가 없어 ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}로 해석했습니다.` : `No am/pm was given; read as ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}.`);
  if (start.ms < clock.nowMs - 5 * 60_000) notes.push(locale === 'ko' ? '이 시각은 이미 지났습니다.' : 'This time has already passed.');
  const base = (step.reasoning || '').trim();
  const reasoning = [base, locale === 'ko' ? `일정: ${when} (${clock.timezone}), ${minutes}분.` : `Event: ${when} (${clock.timezone}), ${minutes} minutes.`, ...notes].filter(Boolean).join(' ');
  return { ...step, parameters, reasoning };
}

function groundRead(step: PlanStep, prompt: string, clock: ScheduleClock): PlanStep {
  const given = step.parameters && typeof step.parameters === 'object' && !Array.isArray(step.parameters) ? (step.parameters as Record<string, unknown>) : {};
  const range = resolveQueryRange(prompt, clock.nowMs, clock.timezone);
  if (!range) return step;
  return { ...step, parameters: { ...given, timeMin: new Date(range.startMs).toISOString(), timeMax: new Date(range.endMs).toISOString() } };
}

/**
 * Completes and checks the calendar steps of a plan against the person's clock. A plan without calendar steps, or a request that names no date, comes back unchanged (same object).
 */
export function groundScheduleSteps(plan: PlanPreview, prompt: string, clock: ScheduleClock, locale: 'en' | 'ko'): PlanPreview {
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return plan;
  let changed = false;
  const steps = plan.steps.map((step) => {
    const tool = typeof step.tool === 'string' ? step.tool : '';
    let next = step;
    if (tool === CALENDAR_CREATE_TOOL) next = groundCreate(step, prompt, clock, locale);
    else if (CALENDAR_READ_TOOLS.has(tool)) next = groundRead(step, prompt, clock);
    if (next !== step) changed = true;
    return next;
  });
  return changed ? { ...plan, steps } : plan;
}
