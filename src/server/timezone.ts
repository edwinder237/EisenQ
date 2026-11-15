// Wall-clock time in a named IANA zone, without a timezone library.
//
// The server runs in UTC but the person lives in their own zone: "due Friday"
// from an AI connector has to mean 9:00 on *their* Friday, the same rule the
// dashboard's quick-schedule menu applies in the browser.

export const DEFAULT_TIME_ZONE = "UTC";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsInZone(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

// How far the zone is ahead of UTC at a given instant, in ms.
function offsetMs(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DD" of an instant, as seen in `tz`. */
export function ymdInZone(date: Date, tz: string): string {
  const p = partsInZone(date.getTime(), tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * The UTC instant at which the clocks in `tz` read `ymd hour:minute`.
 * Re-checks the offset once at the result, so a date across a DST change lands
 * on the right side of it.
 */
export function zonedWallTimeToUtc(ymd: string, hour: number, minute: number, tz: string): Date {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let result = guess - offsetMs(guess, tz);
  const corrected = guess - offsetMs(result, tz);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/** Short human form in the person's zone, e.g. "Fri, Nov 20, 9:00 AM". */
export function formatInZone(date: Date, tz: string): string {
  return date.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
