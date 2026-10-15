// "내일 오후 2시": the person's own clock and timezone decide what that means. These tests pin the deterministic date/time layer: the effective timezone, zoned date math across midnight, month and year
// ends, leap days and DST, a person whose timezone differs from the server's, and the Korean / English schedule expressions - including everything it must REFUSE to guess.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays, buildTimeContext, formatUtcOffset, isRealDate, isValidTimeZone, isoDate, resolveEffectiveTimeZone, resolveQueryRange, resolveScheduleText,
  startOfLocalDay, timeContextPromptLines, wallTimeToInstant, zonedParts,
} from '../src/common/time-context.js';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const at = (iso: string) => Date.parse(iso);
const ymd = (slots: ReturnType<typeof resolveScheduleText>) => (slots.date ? isoDate(slots.date) : null);
const hm = (slots: ReturnType<typeof resolveScheduleText>) => (slots.time ? `${String(slots.time.hour).padStart(2, '0')}:${String(slots.time.minute).padStart(2, '0')}` : null);

// Friday 2026-10-16 10:00 in Seoul
const NOW = at('2026-10-16T01:00:00Z');

describe('effective timezone', () => {
  it('a timezone the person set wins; "UTC" is only the placeholder default, so the device timezone is used then', () => {
    assert.deepEqual(resolveEffectiveTimeZone({ profileTimezone: 'Asia/Tokyo', clientTimezone: LA }), { timezone: 'Asia/Tokyo', source: 'PROFILE' });
    assert.deepEqual(resolveEffectiveTimeZone({ profileTimezone: 'UTC', clientTimezone: SEOUL }), { timezone: SEOUL, source: 'CLIENT' });
    assert.deepEqual(resolveEffectiveTimeZone({ clientTimezone: SEOUL }), { timezone: SEOUL, source: 'CLIENT' });
    assert.deepEqual(resolveEffectiveTimeZone({ profileTimezone: 'UTC' }), { timezone: 'UTC', source: 'PROFILE' });
    assert.deepEqual(resolveEffectiveTimeZone({}), { timezone: 'UTC', source: 'DEFAULT' });
  });
  it('an invalid or hostile timezone is ignored, never trusted', () => {
    assert.equal(isValidTimeZone('Asia/Seoul'), true);
    for (const bad of ['Mars/Base', '', '   ', 'x'.repeat(200), null, undefined, 42, '../etc/passwd']) assert.equal(isValidTimeZone(bad), false, String(bad));
    assert.deepEqual(resolveEffectiveTimeZone({ profileTimezone: 'Mars/Base', clientTimezone: '<script>' }), { timezone: 'UTC', source: 'DEFAULT' });
  });
});

describe('zoned date math', () => {
  it('reads the wall clock of any timezone, including the offset', () => {
    const p = zonedParts(NOW, SEOUL);
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday, p.offsetMinutes], [2026, 10, 16, 10, 0, 5, 540]);
    const la = zonedParts(NOW, LA);
    assert.deepEqual([la.month, la.day, la.hour, la.weekday, la.offsetMinutes], [10, 15, 18, 4, -420]);
    assert.equal(formatUtcOffset(540), '+09:00');
    assert.equal(formatUtcOffset(-420), '-07:00');
  });
  it('wall time to instant: Seoul has no DST, New York does; a skipped hour is moved forward, a repeated hour resolves to its first occurrence', () => {
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 10, day: 17, hour: 14, minute: 0 }, SEOUL).ms).toISOString(), '2026-10-17T05:00:00.000Z');
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, NY).ms).toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, NY).ms).toISOString(), '2026-12-01T14:00:00.000Z');
    const gap = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY); // 2:00 -> 3:00 on 2026-03-08
    assert.equal(gap.gap, true);
    assert.equal(zonedParts(gap.ms, NY).hour, 3);
    const repeated = wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY); // 1:30 happens twice on 2026-11-01
    assert.equal(repeated.gap, false);
    assert.equal(new Date(repeated.ms).toISOString(), '2026-11-01T05:30:00.000Z');
  });
  it('calendar days cross month, year and leap days correctly', () => {
    assert.equal(isoDate(addDays({ year: 2026, month: 12, day: 31 }, 1)), '2027-01-01');
    assert.equal(isoDate(addDays({ year: 2028, month: 2, day: 28 }, 2)), '2028-03-01');
    assert.equal(isoDate(addDays({ year: 2028, month: 2, day: 28 }, 1)), '2028-02-29');
    assert.equal(isRealDate({ year: 2027, month: 2, day: 29 }), false);
    assert.equal(isRealDate({ year: 2028, month: 2, day: 29 }), true);
    assert.equal(new Date(startOfLocalDay({ year: 2026, month: 10, day: 17 }, SEOUL)).toISOString(), '2026-10-16T15:00:00.000Z');
  });
  it('the prompt block carries the real local date, weekday, offset and reference dates', () => {
    const ctx = buildTimeContext(NOW, { timezone: SEOUL, source: 'CLIENT' });
    assert.equal(ctx.localDate, '2026-10-16');
    assert.equal(ctx.weekdayKo, '금요일');
    const text = timeContextPromptLines(ctx, NOW).join('\n');
    assert.match(text, /Friday \(금요일\) 2026-10-16 10:00, timezone Asia\/Seoul \(UTC\+09:00\)/);
    assert.match(text, /tomorrow 2026-10-17 \(Saturday \/ 토요일\)/);
    assert.match(text, /next Monday \(the Monday of next week\) 2026-10-19/);
  });
});

describe('the nine scheduling situations', () => {
  it('1. "오늘 일정 알려줘." -> today in the person\'s timezone', () => {
    const r = resolveQueryRange('오늘 일정 알려줘.', NOW, SEOUL)!;
    assert.equal(r.kind, 'DAY');
    assert.equal(new Date(r.startMs).toISOString(), '2026-10-15T15:00:00.000Z');
    assert.equal(new Date(r.endMs).toISOString(), '2026-10-16T14:59:59.999Z');
  });
  it('2. "내일 오후 2시에 회의 잡아줘." -> 2026-10-17 14:00', () => {
    const s = resolveScheduleText('내일 오후 2시에 회의 잡아줘.', NOW, SEOUL);
    assert.equal(ymd(s), '2026-10-17');
    assert.equal(hm(s), '14:00');
    assert.equal(s.time!.inferredMeridiem, false);
  });
  it('3. "다음 주 월요일 오전 10시에 일정 등록해줘." -> Monday of next week 2026-10-19 10:00', () => {
    const s = resolveScheduleText('다음 주 월요일 오전 10시에 일정 등록해줘.', NOW, SEOUL);
    assert.equal(ymd(s), '2026-10-19');
    assert.equal(s.date!.weekday, 1);
    assert.equal(hm(s), '10:00');
  });
  it('4. "이번 주 남은 일정을 정리해줘." -> from now to Sunday night', () => {
    const r = resolveQueryRange('이번 주 남은 일정을 정리해줘.', NOW, SEOUL)!;
    assert.equal(r.kind, 'REST_OF_WEEK');
    assert.equal(r.startMs, NOW);
    assert.equal(new Date(r.endMs).toISOString(), '2026-10-18T14:59:59.999Z'); // Sunday 2026-10-18 23:59:59.999 KST
    const whole = resolveQueryRange('이번 주 일정', NOW, SEOUL)!;
    assert.equal(new Date(whole.startMs).toISOString(), '2026-10-11T15:00:00.000Z'); // Monday 2026-10-12 00:00 KST
    assert.equal(resolveQueryRange('다음 주 일정', NOW, SEOUL)!.kind, 'WEEK');
  });
  it('5. "오늘 해야 할 일을 우선순위로 정리해줘." -> today is known (no date arithmetic left to the model)', () => {
    assert.equal(ymd(resolveScheduleText('오늘 해야 할 일을 우선순위로 정리해줘.', NOW, SEOUL)), '2026-10-16');
  });
  it('6. "일정 시간을 한 시간 늦춰줘." -> a shift of +60 minutes, no date, no invented event', () => {
    const s = resolveScheduleText('일정 시간을 한 시간 늦춰줘.', NOW, SEOUL);
    assert.equal(s.shiftMinutes, 60);
    assert.equal(s.date, undefined);
    assert.equal(s.durationMinutes, undefined, 'a shift is not a duration');
    assert.equal(resolveScheduleText('회의를 30분 당겨줘', NOW, SEOUL).shiftMinutes, -30);
    assert.equal(resolveScheduleText('1시간 30분 미뤄줘', NOW, SEOUL).shiftMinutes, 90);
    assert.equal(resolveScheduleText('push the meeting back an hour', NOW, SEOUL).shiftMinutes, 60);
  });
  it('7. near midnight: 23:50 and 00:10 are different days, and "tomorrow" follows the person\'s clock', () => {
    const lateFriday = at('2026-10-16T14:50:00Z'); // Fri 23:50 KST
    assert.equal(ymd(resolveScheduleText('오늘 오후 11시 55분 알림', lateFriday, SEOUL)), '2026-10-16');
    assert.equal(ymd(resolveScheduleText('내일 오전 9시 회의', lateFriday, SEOUL)), '2026-10-17');
    const justAfter = at('2026-10-16T15:10:00Z'); // Sat 00:10 KST
    assert.equal(ymd(resolveScheduleText('오늘 일정', justAfter, SEOUL)), '2026-10-17');
    assert.equal(ymd(resolveScheduleText('내일 오전 9시 회의', justAfter, SEOUL)), '2026-10-18');
    assert.equal(hm(resolveScheduleText('오후 11시 55분 회의', lateFriday, SEOUL)), '23:55');
  });
  it('8. month and year boundaries', () => {
    const newYearsEve = at('2026-12-31T05:00:00Z'); // Thu 2026-12-31 14:00 KST
    assert.equal(ymd(resolveScheduleText('내일 오후 3시', newYearsEve, SEOUL)), '2027-01-01');
    assert.equal(ymd(resolveScheduleText('다음 주 월요일 오전 10시', newYearsEve, SEOUL)), '2027-01-04');
    assert.equal(ymd(resolveScheduleText('1월 5일 오전 9시', newYearsEve, SEOUL)), '2027-01-05');
    assert.equal(ymd(resolveScheduleText('10일 후', at('2026-10-25T00:00:00Z'), SEOUL)), '2026-11-04');
    assert.equal(ymd(resolveScheduleText('모레', at('2028-02-28T00:00:00Z'), SEOUL)), '2028-03-01');
    assert.equal(ymd(resolveScheduleText('2월 29일 점심', at('2027-01-10T00:00:00Z'), SEOUL)), null, 'a day that does not exist is not scheduled');
    assert.equal(ymd(resolveScheduleText('10월 3일 회의', at('2026-11-20T00:00:00Z'), SEOUL)), '2027-10-03', 'a date already past this year means next year');
  });
  it('9. a person whose timezone differs from the server\'s: the same instant is a different day', () => {
    // 2026-10-16 16:06 UTC: Sat 01:06 in Seoul, Fri 09:06 in Los Angeles
    const instant = at('2026-10-16T16:06:00Z');
    assert.equal(ymd(resolveScheduleText('오늘', instant, SEOUL)), '2026-10-17');
    assert.equal(ymd(resolveScheduleText('오늘', instant, LA)), '2026-10-16');
    assert.equal(ymd(resolveScheduleText('내일 오후 2시', instant, SEOUL)), '2026-10-18');
    assert.equal(ymd(resolveScheduleText('내일 오후 2시', instant, LA)), '2026-10-17');
    assert.equal(new Date(resolveQueryRange('오늘 일정', instant, LA)!.startMs).toISOString(), '2026-10-16T07:00:00.000Z');
  });
});

describe('expressions people write, and what is refused', () => {
  it('times: am/pm words, 24-hour, half hours, noon, English', () => {
    assert.equal(hm(resolveScheduleText('오전 10시 30분에', NOW, SEOUL)), '10:30');
    assert.equal(hm(resolveScheduleText('저녁 7시에', NOW, SEOUL)), '19:00');
    assert.equal(hm(resolveScheduleText('오후 2시 반', NOW, SEOUL)), '14:30');
    assert.equal(hm(resolveScheduleText('새벽 2시', NOW, SEOUL)), '02:00');
    assert.equal(hm(resolveScheduleText('오전 12시', NOW, SEOUL)), '00:00');
    assert.equal(hm(resolveScheduleText('오후 12시', NOW, SEOUL)), '12:00');
    assert.equal(hm(resolveScheduleText('점심 12시', NOW, SEOUL)), '12:00');
    assert.equal(hm(resolveScheduleText('정오에 보자', NOW, SEOUL)), '12:00');
    assert.equal(hm(resolveScheduleText('14:30 회의', NOW, SEOUL)), '14:30');
    assert.equal(hm(resolveScheduleText('meet at 2:15 pm', NOW, SEOUL)), '14:15');
    assert.equal(hm(resolveScheduleText('9am call', NOW, SEOUL)), '09:00');
    assert.equal(hm(resolveScheduleText('at noon', NOW, SEOUL)), '12:00');
  });
  it('a clock time without am/pm is read as business hours but marked as inferred', () => {
    assert.equal(hm(resolveScheduleText('내일 2시에 회의', NOW, SEOUL)), '14:00');
    assert.equal(resolveScheduleText('내일 2시에 회의', NOW, SEOUL).time!.inferredMeridiem, true);
    assert.equal(hm(resolveScheduleText('내일 9시에 회의', NOW, SEOUL)), '09:00');
    assert.equal(resolveScheduleText('내일 15시에 회의', NOW, SEOUL).time!.inferredMeridiem, false);
  });
  it('durations and ranges', () => {
    assert.equal(resolveScheduleText('내일 오후 2시에 1시간 회의', NOW, SEOUL).durationMinutes, 60);
    assert.equal(resolveScheduleText('내일 오후 2시에 30분짜리 미팅', NOW, SEOUL).durationMinutes, 30);
    assert.equal(resolveScheduleText('내일 오후 2시에 한 시간 반', NOW, SEOUL).durationMinutes, 60);
    assert.equal(resolveScheduleText('내일 오후 2시에 2시간 30분 워크숍', NOW, SEOUL).durationMinutes, 150);
    assert.equal(resolveScheduleText('book a 45 minute call tomorrow at 3pm', NOW, SEOUL).durationMinutes, 45);
    assert.equal(resolveScheduleText('30분 뒤에 알려줘', NOW, SEOUL).durationMinutes, undefined, '"in 30 minutes" is an offset, not a length');
    const range = resolveScheduleText('내일 오후 2시부터 4시까지 회의', NOW, SEOUL);
    assert.equal(hm(range), '14:00');
    assert.equal(range.endTime!.hour, 16);
  });
  it('English dates', () => {
    assert.equal(ymd(resolveScheduleText('schedule a meeting tomorrow at 2 PM', NOW, SEOUL)), '2026-10-17');
    assert.equal(ymd(resolveScheduleText('lunch next Monday', NOW, SEOUL)), '2026-10-19');
    assert.equal(ymd(resolveScheduleText('review on Oct 20', NOW, SEOUL)), '2026-10-20');
    assert.equal(ymd(resolveScheduleText('in 3 days', NOW, SEOUL)), '2026-10-19');
    assert.equal(ymd(resolveScheduleText('day after tomorrow', NOW, SEOUL)), '2026-10-18');
    assert.equal(ymd(resolveScheduleText('call on Wednesday', NOW, SEOUL)), '2026-10-21');
    assert.equal(ymd(resolveScheduleText('2026-11-02 09:00', NOW, SEOUL)), '2026-11-02');
  });
  it('it refuses to guess: two dates, two times, a past date, today\'s own weekday, nothing at all', () => {
    const two = resolveScheduleText('내일 또는 모레 오후 2시', NOW, SEOUL);
    assert.equal(two.date, undefined);
    assert.ok(two.ambiguous.includes('MULTIPLE_DATES'));
    const times = resolveScheduleText('내일 오전 9시 혹은 오후 3시', NOW, SEOUL);
    assert.equal(times.time, undefined);
    assert.ok(times.ambiguous.includes('MULTIPLE_TIMES'));
    const past = resolveScheduleText('이번 주 월요일 회의', NOW, SEOUL); // Monday 2026-10-12 is already past
    assert.equal(past.date, undefined);
    assert.ok(past.ambiguous.includes('PAST_DATE'));
    const bare = resolveScheduleText('금요일에 회의', NOW, SEOUL); // today is Friday
    assert.equal(bare.date, undefined);
    assert.ok(bare.ambiguous.includes('BARE_WEEKDAY_IS_TODAY'));
    const none = resolveScheduleText('회의를 잡아줘', NOW, SEOUL);
    assert.deepEqual([none.date, none.time, none.durationMinutes], [undefined, undefined, undefined]);
    assert.equal(resolveScheduleText('', NOW, SEOUL).date, undefined);
  });
  it('words that merely contain date letters are not dates; "1시간" is not 1 o\'clock', () => {
    assert.equal(resolveScheduleText('일정 시간을 정리해줘', NOW, SEOUL).date, undefined);
    assert.equal(resolveScheduleText('오늘날의 기술', NOW, SEOUL).date, undefined);
    assert.equal(resolveScheduleText('내일 1시간 회의', NOW, SEOUL).time, undefined);
    assert.equal(resolveScheduleText('3월', NOW, SEOUL).date, undefined);
  });
});
