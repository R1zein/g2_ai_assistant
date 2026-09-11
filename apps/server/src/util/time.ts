/** Timezone-aware helpers. Everything the assistant shows the user is relative. */

export function nowIso(): string {
  return new Date().toISOString();
}

/** "in 2h 15m", "in 3 days", "now", "2h ago". */
export function relativeTime(target: Date, from: Date = new Date()): string {
  const deltaMs = target.getTime() - from.getTime();
  const past = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return 'now';

  let text: string;
  if (minutes < 60) {
    text = `${minutes}m`;
  } else if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    text = m === 0 ? `${h}h` : `${h}h ${m}m`;
  } else {
    const days = Math.round(minutes / (60 * 24));
    text = days === 1 ? '1 day' : `${days} days`;
  }
  return past ? `${text} ago` : `in ${text}`;
}

/**
 * Format an instant in a specific IANA timezone. Returns e.g. "Tue 14 Oct, 15:40".
 * Falls back to the raw ISO string when the zone is unknown to the runtime.
 */
export function formatInZone(iso: string, timeZone: string, withDate = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      ...(withDate ? { weekday: 'short', day: '2-digit', month: 'short' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Current wall-clock time in a zone, as an ISO-like string for the model prompt. */
export function localNow(timeZone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${parts.weekday})`;
  } catch {
    return new Date().toISOString();
  }
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds that `timeZone` is ahead of UTC at the given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/**
 * Interpret a timezone-less local timestamp ("2026-09-14T15:00:00") as wall-clock
 * time in `timeZone` and return the corresponding instant.
 *
 * Two passes so a DST boundary between the guess and the answer still lands
 * correctly. Timestamps that already carry an offset are returned as-is.
 */
export function zonedLocalToInstant(local: string, timeZone: string): Date | null {
  const trimmed = local.trim();
  if (!trimmed) return null;

  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const direct = new Date(trimmed);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }

  const naive = Date.parse(`${trimmed.replace(' ', 'T')}Z`);
  if (Number.isNaN(naive)) return null;
  if (!isValidTimeZone(timeZone)) return new Date(naive);

  let instant = new Date(naive);
  for (let i = 0; i < 2; i++) {
    instant = new Date(naive - zoneOffsetMs(instant, timeZone));
  }
  return instant;
}
