/** Day and hour keys in an IANA time zone, for example `Asia/Kolkata`. */

export interface TimeKeys {
  readonly timeZone: string;
  /** Day key `YYYY-MM-DD` for an epoch time in ms. */
  day(ms: number): string;
  /** Hour of the day, 0 to 23. */
  hour(ms: number): number;
  /** Both at once. */
  parts(ms: number): { day: string; hour: number };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Make day keys for a time zone. The formatter is made once.
 * The last answer is kept for one minute, so a busy server does not format each call.
 * (No time zone changes its offset inside a minute.)
 */
export function createTimeKeys(timeZone = 'UTC'): TimeKeys {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
  } catch {
    throw new RangeError(`Drishtikit: "${timeZone}" is not a valid IANA time zone.`);
  }

  let cachedMinute = -1;
  let cached = { day: '', hour: 0 };

  const parts = (ms: number): { day: string; hour: number } => {
    const minute = Math.floor(ms / 60_000);
    if (minute === cachedMinute) return cached;
    let year = '';
    let month = '';
    let day = '';
    let hour = '0';
    for (const part of formatter.formatToParts(ms)) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
      else if (part.type === 'hour') hour = part.value;
    }
    cached = { day: `${year}-${month}-${day}`, hour: Number(hour) % 24 };
    cachedMinute = minute;
    return cached;
  };

  return {
    timeZone,
    parts,
    day: (ms) => parts(ms).day,
    hour: (ms) => parts(ms).hour,
  };
}

/** Add days to a day key. */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** All day keys from `from` to `to`, both included. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Number of days from `a` to `b` (b minus a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The Monday of the week of a day key. */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(day, -offset);
}

/** A day key as a Date at 00:00 UTC. Stores use it for time-to-live (TTL) indexes. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
