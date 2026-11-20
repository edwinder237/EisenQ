// Date logic for the routine card: which past occurrences were missed, and how
// to say how often something repeats. Dates are local "YYYY-MM-DD" strings.

export interface RoutineItemLike {
  frequency: "daily" | "weekly";
  daysOfWeek?: number[];
  completedDates: string[];
  carryOver?: boolean;
  caughtUpThrough?: string;
  createdAt: string;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// How far back a miss can still be carried. Older ones are let go.
export const CARRY_LOOKBACK_DAYS = 28;

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d);
}

function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return toYmd(d);
}

/** Weekly and daily items differ: missing a weekly one matters, a daily one rolls over. */
export function carriesOver(item: Pick<RoutineItemLike, "frequency" | "carryOver">): boolean {
  return item.carryOver ?? item.frequency === "weekly";
}

function isScheduledOn(item: RoutineItemLike, ymd: string): boolean {
  if (item.frequency === "daily") return true;
  return item.daysOfWeek?.includes(parseYmd(ymd).getDay()) ?? false;
}

/**
 * Scheduled days before today that weren't done, newest first. Starts no
 * earlier than the day the item was created, after the last resolved miss, and
 * within the lookback window.
 */
export function missedDates(item: RoutineItemLike, today: string, lookbackDays = CARRY_LOOKBACK_DAYS): string[] {
  const created = toYmd(new Date(item.createdAt));
  const out: string[] = [];
  for (let i = 1; i <= lookbackDays; i++) {
    const day = addDays(today, -i);
    if (day < created) break;
    if (item.caughtUpThrough && day <= item.caughtUpThrough) break;
    if (isScheduledOn(item, day) && !item.completedDates.includes(day)) out.push(day);
  }
  return out;
}

/** "yesterday", "Sun" within the past week, otherwise "Nov 2". */
export function relativeDayLabel(ymd: string, today: string): string {
  if (ymd === addDays(today, -1)) return "yesterday";
  const d = parseYmd(ymd);
  if (ymd >= addDays(today, -6)) return DAY_SHORT[d.getDay()]!;
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/** "Missed Sun", or "Missed 3×" when several piled up. */
export function missedLabel(missed: string[], today: string): string {
  if (missed.length === 1) return `Missed ${relativeDayLabel(missed[0]!, today)}`;
  return `Missed ${missed.length}×`;
}

/** Repeat cadence of a maintenance interval, in words. */
export function intervalLabel(days: number): string {
  const named: Record<number, string> = {
    1: "Daily", 7: "Weekly", 14: "Every 2 wks",
    28: "Monthly", 30: "Monthly", 31: "Monthly",
    60: "Every 2 mo", 61: "Every 2 mo",
    90: "Quarterly", 91: "Quarterly", 92: "Quarterly",
    180: "Every 6 mo", 182: "Every 6 mo", 183: "Every 6 mo",
    365: "Yearly", 366: "Yearly",
  };
  if (named[days]) return named[days];
  if (days % 365 === 0) return `Every ${days / 365} yrs`;
  if (days % 7 === 0) return `Every ${days / 7} wks`;
  return `Every ${days}d`;
}

/** Cadence of a weekly routine item: "Sun", "Mon · Thu". Daily items need none. */
export function weeklyLabel(daysOfWeek: number[] | undefined): string | null {
  if (!daysOfWeek?.length) return null;
  if (daysOfWeek.length === 7) return "Daily";
  return [...daysOfWeek].sort((a, b) => a - b).map(d => DAY_SHORT[d]).join(" · ");
}
