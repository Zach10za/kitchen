// Timezone-aware date helpers. The previous helpers used `new Date()` directly
// which runs in UTC on Cloudflare Workers, so e.g. Sunday evening in PT was
// already Monday in UTC and the math drifted by a day.

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

/** Today's local date as a YYYY-MM-DD string in the given timezone. The day
 *  key the daily `meals` table and the noon-suggestion alarm both partition by. */
export function todayISO(timezone: string): string {
  return todayInTimezone(timezone).iso;
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

/**
 * Next fire time for the daily suggestion alarm: today at `hour:00` local if
 * that's still in the future, otherwise tomorrow at `hour:00`. Anchored to the
 * user's timezone so DST shifts don't drift the ping.
 */
export function nextDailyTime(hour: number, timezone: string): Date {
  const { iso } = todayInTimezone(timezone);
  const todayCandidate = localDateAtHour(iso, hour, timezone);
  if (todayCandidate > Date.now()) return new Date(todayCandidate);

  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const tomorrowIso = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return new Date(localDateAtHour(tomorrowIso, hour, timezone));
}
