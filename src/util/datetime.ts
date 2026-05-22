// Timezone-aware date helpers. The previous helpers used `new Date()` directly
// which runs in UTC on Cloudflare Workers, so e.g. Sunday evening in PT was
// already Monday in UTC and the math drifted by a day.

const DAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * Today's date and weekday in the given IANA timezone.
 * Returns ISO date string (YYYY-MM-DD) + day index (0=Sun..6=Sat).
 */
function todayInTimezone(timezone: string): { iso: string; day: number } {
  const now = new Date();
  // en-CA gives YYYY-MM-DD format directly.
  const iso = now.toLocaleDateString('en-CA', { timeZone: timezone });
  // toLocaleString with timezone returns a string we can parse to get the day-of-week
  // as it appears in the user's timezone.
  const inTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  return { iso, day: inTz.getDay() };
}

/**
 * Returns the Monday of the user's "active week" — current Monday if today
 * is Mon-Wed, else next Monday. Always in the user's timezone.
 */
export function currentOrNextMondayISO(timezone: string): string {
  const { iso, day } = todayInTimezone(timezone);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  // Use UTC math on the date components to avoid local-tz arithmetic surprises.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (day >= 1 && day <= 3) {
    // Monday → Wednesday: this week's Monday
    date.setUTCDate(date.getUTCDate() - (day - 1));
  } else {
    // Thursday → Sunday: next Monday
    const daysUntilMon = (1 - day + 7) % 7 || 7;
    date.setUTCDate(date.getUTCDate() + daysUntilMon);
  }
  return date.toISOString().slice(0, 10);
}

/** Returns the next Monday (always future, never today even if today is Monday). */
export function nextMondayISO(timezone: string): string {
  const { iso, day } = todayInTimezone(timezone);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const daysUntilMon = (1 - day + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilMon);
  return date.toISOString().slice(0, 10);
}

/**
 * Compute when a meal is to be cooked, anchored to the user's timezone.
 * Returns a UTC ms timestamp of `cookHour:00` local on the meal's day.
 */
export function mealCookTime(
  weekOf: string,
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun',
  cookHour: number,
  timezone: string
): number {
  const dayOffset = DAY_INDEX[day]! - 1; // mon=0..sun=6 (0-indexed from Monday)
  const [y, m, d] = weekOf.split('-').map(Number) as [number, number, number];
  // Construct the local date for that meal day.
  const targetUTC = new Date(Date.UTC(y, m - 1, d + dayOffset));
  const localDateStr = targetUTC.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  // Now compute what UTC ms equals "cookHour:00 local" in the user's timezone
  // for that local date.
  return localDateAtHour(localDateStr, cookHour, timezone);
}

/**
 * Given a YYYY-MM-DD date and an hour (0-23), return UTC ms representing
 * that hour in the given IANA timezone.
 *
 * Works for any IANA timezone — including half-hour (India +5:30) and
 * quarter-hour (Nepal +5:45) offsets. The previous implementation only
 * handled whole-hour offsets because it reasoned in `diffHours`.
 *
 * Strategy: pick `utcGuess` as if the hour were UTC, then read back the
 * full parts (year/month/day/hour/minute) as they appear in the target
 * timezone, build the offset in MINUTES from the diff, and adjust.
 */
export function localDateAtHour(localDate: string, hour: number, timezone: string): number {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const utcGuess = Date.UTC(y, m - 1, d, hour, 0, 0);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcGuess));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl reports hour 24 instead of 0 in some locales when the value is midnight; normalize.
  const tzYear = get('year');
  const tzMonth = get('month');
  const tzDay = get('day');
  const tzHour = get('hour') % 24;
  const tzMinute = get('minute');

  // What the displayed timezone "thinks" utcGuess is, expressed as UTC ms.
  const tzAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, 0);
  // Target: hour:00 on localDate.
  const targetAsUtc = Date.UTC(y, m - 1, d, hour, 0, 0);
  // Offset (minutes) the timezone is from UTC on this date.
  const offsetMinutes = (tzAsUtc - targetAsUtc) / 60_000;
  return utcGuess - offsetMinutes * 60_000;
}

/** Compute next-cron-fire time for the weekly draft alarm. */
export function nextDraftTime(day: string, hour: number, timezone: string): Date {
  const targetDay = DAY_INDEX[day.toLowerCase()] ?? 5;
  const { iso, day: currentDay } = todayInTimezone(timezone);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];

  let daysAhead = (targetDay - currentDay + 7) % 7;
  // Build a candidate at the target hour today.
  const todayCandidate = localDateAtHour(iso, hour, timezone);
  if (daysAhead === 0 && todayCandidate <= Date.now()) daysAhead = 7;

  const targetDate = new Date(Date.UTC(y, m - 1, d + daysAhead));
  const targetIso = targetDate.toISOString().slice(0, 10);
  return new Date(localDateAtHour(targetIso, hour, timezone));
}
