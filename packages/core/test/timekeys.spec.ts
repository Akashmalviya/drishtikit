import { addDays, createTimeKeys, dayRange, daysBetween, isValidDay, weekStart } from '../src';

describe('time keys', () => {
  it('uses UTC by default', () => {
    const t = createTimeKeys();
    expect(t.day(Date.UTC(2026, 10, 16, 23, 59, 59))).toBe('2026-11-16');
    expect(t.hour(Date.UTC(2026, 10, 16, 23, 59, 59))).toBe(23);
    expect(t.day(Date.UTC(2026, 10, 17, 0, 0, 0))).toBe('2026-11-17');
    expect(t.hour(Date.UTC(2026, 10, 17, 0, 0, 0))).toBe(0);
  });

  it('moves the day edge in Asia/Kolkata (UTC+5:30)', () => {
    const t = createTimeKeys('Asia/Kolkata');
    // 18:29:59 UTC is 23:59:59 in India; one second later is the next day.
    expect(t.parts(Date.UTC(2026, 10, 16, 18, 29, 59))).toEqual({ day: '2026-11-16', hour: 23 });
    expect(t.parts(Date.UTC(2026, 10, 16, 18, 30, 0))).toEqual({ day: '2026-11-17', hour: 0 });
    // The hour edge is at :30 UTC.
    expect(t.hour(Date.UTC(2026, 10, 16, 5, 29, 59))).toBe(10);
    expect(t.hour(Date.UTC(2026, 10, 16, 5, 30, 0))).toBe(11);
  });

  it('follows summer time in America/New_York', () => {
    const t = createTimeKeys('America/New_York');
    // Summer: UTC-4. 03:59 UTC is 23:59 the day before.
    expect(t.parts(Date.UTC(2026, 6, 1, 3, 59, 0))).toEqual({ day: '2026-06-30', hour: 23 });
    expect(t.parts(Date.UTC(2026, 6, 1, 4, 0, 0))).toEqual({ day: '2026-07-01', hour: 0 });
    // Winter: UTC-5.
    expect(t.parts(Date.UTC(2026, 0, 1, 4, 59, 0))).toEqual({ day: '2025-12-31', hour: 23 });
    expect(t.parts(Date.UTC(2026, 0, 1, 5, 0, 0))).toEqual({ day: '2026-01-01', hour: 0 });
  });

  it('gives the right answer when the cached minute changes', () => {
    const t = createTimeKeys('Asia/Kolkata');
    const a = Date.UTC(2026, 10, 16, 18, 29, 59, 999);
    expect(t.day(a)).toBe('2026-11-16');
    expect(t.day(a + 1)).toBe('2026-11-17');
  });

  it('refuses a time zone that does not exist', () => {
    expect(() => createTimeKeys('Mars/Base')).toThrow(/not a valid IANA time zone/);
  });

  it('works with day keys', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(dayRange('2026-11-14', '2026-11-16')).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(daysBetween('2026-11-10', '2026-11-16')).toBe(6);
    expect(weekStart('2026-11-16')).toBe('2026-11-16'); // a Monday
    expect(weekStart('2026-11-22')).toBe('2026-11-16'); // a Sunday
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('2026-2-3')).toBe(false);
    expect(isValidDay('2026-11-16')).toBe(true);
  });
});
