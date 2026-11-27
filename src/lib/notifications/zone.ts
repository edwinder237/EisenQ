// Calendar dates and wall-clock times in a named IANA zone, for the
// notification rules (./derive.ts). Client-safe: no server imports. The same
// algorithm as ~/server/timezone.ts.
//
// Every function takes an optional `timeZone`. Without one it uses the
// runtime's own zone: in the browser, the person's. The server always passes
// the person's zone, because it runs in UTC.

function parts(ms: number, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(p.find((x) => x.type === type)?.value ?? 0);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of an instant, as seen in the zone. */
export function ymdIn(date: Date, timeZone?: string): string {
  if (!timeZone)
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const p = parts(date.getTime(), timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Minutes since local midnight, as seen in the zone. */
export function minutesIn(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  const p = parts(date.getTime(), timeZone);
  return p.h * 60 + p.mi;
}

/** The instant the zone's clocks read `ymd hour:minute`. DST-safe. */
export function atWallTime(
  ymd: string,
  hour: number,
  minute: number,
  timeZone?: string,
): Date {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  if (!timeZone) return new Date(y, m - 1, d, hour, minute, 0, 0);
  const offset = (ms: number) => {
    const p = parts(ms, timeZone);
    return (
      Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
    );
  };
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let result = guess - offset(guess);
  const corrected = guess - offset(result);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/** Calendar arithmetic on "YYYY-MM-DD", the same in every zone. */
export function addDaysYmd(ymd: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export function weekdayOfYmd(ymd: string): number {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
