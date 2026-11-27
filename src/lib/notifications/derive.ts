// Which notifications exist right now, from data the app already has.
//
// Pure, no I/O. The mock client runs it in the browser; the backend can run
// the same function on the server (cron for the digest, or on GET) so both
// sides agree on the rules. Read / snoozed / dismissed state is layered on
// top by the caller, keyed by each item's stable `id`.

import { friendlyAppName } from "~/lib/task-source";
import {
  REMINDER_LEAD_DAYS,
  type AppNotification,
  type NotificationPreferences,
  type ReminderLead,
} from "./types";

export interface DeriveTask {
  _id: string;
  title: string;
  quadrant: "urgent-important" | "important-not-urgent" | "urgent-not-important" | "not-urgent-not-important";
  status: string;
  dueDate?: string;
  archivedAt?: string;
  parentTaskId?: string;
  createdAt: string;
  source?: { kind: string; title?: string };
}

export interface DeriveMaintenance {
  _id: string;
  title: string;
  /** Local "YYYY-MM-DD". */
  nextDueDate: string;
  lastCompletedDate?: string;
}

export interface DeriveMissedRoutine {
  _id: string;
  title: string;
  /** Local "YYYY-MM-DD" dates that were missed, newest first or any order. */
  missed: string[];
}

export interface DeriveInput {
  now: Date;
  tasks: DeriveTask[];
  maintenance: DeriveMaintenance[];
  missedRoutines: DeriveMissedRoutine[];
  prefs: NotificationPreferences;
  /** Per-item heads-up overrides, keyed "maintenance:<id>". */
  itemLeads?: Record<string, ReminderLead | null>;
}

const QUADRANT = {
  "urgent-important": { name: "Do First", tone: "do-first" },
  "important-not-urgent": { name: "Schedule", tone: "schedule" },
  "urgent-not-important": { name: "Delegate", tone: "delegate" },
  "not-urgent-not-important": { name: "Eliminate", tone: "eliminate" },
} as const;

const DAY = 86_400_000;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d);
}
/** Whole calendar days from a to b (b later is positive). */
function dayDiff(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / DAY);
}
function weekday(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short" });
}
function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function time(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function base(n: Omit<AppNotification, "readAt" | "snoozedUntil">): AppNotification {
  return { ...n, readAt: null, snoozedUntil: null };
}

export function deriveNotifications(input: DeriveInput): AppNotification[] {
  const { now, prefs } = input;
  const today = ymd(now);
  const out: AppNotification[] = [];

  // --- Tasks: due today and overdue -------------------------------------
  if (prefs.events.due.inApp) {
    for (const t of input.tasks) {
      if (!t.dueDate || t.status === "completed" || t.archivedAt || t.parentTaskId) continue;
      const due = new Date(t.dueDate);
      const q = QUADRANT[t.quadrant];
      const late = dayDiff(ymd(due), today);
      if (late > 0) {
        out.push(base({
          id: `task_overdue:${t._id}`,
          kind: "task_overdue",
          group: "needs",
          subject: t.title,
          text: `{subject} is ${plural(late, "day")} overdue`,
          meta: `${q.name} · was due ${late < 7 ? weekday(due) : shortDate(due)}`,
          target: { type: "task", id: t._id },
          createdAt: due.toISOString(),
          tone: q.tone,
        }));
      } else if (late === 0) {
        out.push(base({
          id: `task_due_today:${t._id}:${today}`,
          kind: "task_due_today",
          group: "needs",
          subject: t.title,
          text: due.getTime() < now.getTime() ? "{subject} was due earlier today" : "{subject} is due today",
          meta: `${q.name} · ${time(due)}`,
          target: { type: "task", id: t._id },
          createdAt: parseYmd(today).toISOString(),
          tone: q.tone,
        }));
      }
    }
  }

  // --- Maintenance: coming up within its heads-up, or overdue -----------
  if (prefs.events.upcoming.inApp) {
    for (const m of input.maintenance) {
      if (m.lastCompletedDate === today) continue;
      const lead = input.itemLeads?.[`maintenance:${m._id}`] ?? prefs.defaultLead;
      if (lead === "off") continue;
      const until = dayDiff(today, m.nextDueDate);
      const due = parseYmd(m.nextDueDate);
      if (until < 0) {
        out.push(base({
          id: `maintenance_overdue:${m._id}:${m.nextDueDate}`,
          kind: "maintenance_overdue",
          group: "needs",
          subject: m.title,
          text: `{subject} is ${plural(-until, "day")} late`,
          meta: `Maintenance · was due ${shortDate(due)}`,
          target: { type: "maintenance", id: m._id },
          createdAt: due.toISOString(),
          tone: "schedule",
        }));
      } else if (until <= REMINDER_LEAD_DAYS[lead]) {
        out.push(base({
          id: `maintenance_upcoming:${m._id}:${m.nextDueDate}`,
          kind: "maintenance_upcoming",
          group: "needs",
          subject: m.title,
          text: until === 0 ? "{subject} is due today" : until === 1 ? "{subject} is due tomorrow" : `{subject} is due in ${until} days`,
          meta: `Maintenance · ${shortDate(due)}`,
          target: { type: "maintenance", id: m._id },
          // Appears on the morning the heads-up starts.
          createdAt: new Date(due.getTime() - REMINDER_LEAD_DAYS[lead] * DAY).toISOString(),
          tone: "schedule",
        }));
      }
    }
  }

  // --- Missed routines ----------------------------------------------------
  if (prefs.events.missed_routines.inApp) {
    for (const r of input.missedRoutines) {
      if (r.missed.length === 0) continue;
      const latest = [...r.missed].sort().at(-1)!;
      const ago = dayDiff(latest, today);
      out.push(base({
        id: `routine_missed:${r._id}:${latest}`,
        kind: "routine_missed",
        group: "fyi",
        subject: r.title,
        text: r.missed.length === 1 ? "You missed {subject}" : `You missed {subject} ${r.missed.length} times`,
        meta: `Routine · ${ago === 1 ? "yesterday" : `${ago} days ago`}`,
        target: { type: "routine", id: r._id },
        createdAt: new Date(parseYmd(latest).getTime() + DAY - 1).toISOString(),
        tone: "muted",
      }));
    }
  }

  // --- AI activity: one line per app per day, not one per task ----------
  if (prefs.events.ai_activity.inApp) {
    const byApp = new Map<string, { count: number; latest: number; quadrants: Set<string>; firstId: string }>();
    for (const t of input.tasks) {
      if (t.source?.kind !== "agent") continue;
      const at = new Date(t.createdAt).getTime();
      if (now.getTime() - at > DAY) continue;
      const app = friendlyAppName(t.source.title) ?? "An AI app";
      const e = byApp.get(app) ?? { count: 0, latest: 0, quadrants: new Set<string>(), firstId: t._id };
      e.count++;
      e.latest = Math.max(e.latest, at);
      e.quadrants.add(QUADRANT[t.quadrant].name);
      byApp.set(app, e);
    }
    for (const [app, e] of byApp) {
      const where = e.quadrants.size === 1 ? ` to ${[...e.quadrants][0]}` : "";
      out.push(base({
        id: `ai_activity:${app}:${today}:${e.count}`,
        kind: "ai_activity",
        group: "fyi",
        subject: app,
        text: `{subject} added ${e.count === 1 ? "a task" : `${e.count} tasks`}${where}`,
        meta: relativeTime(new Date(e.latest), now),
        target: e.count === 1 ? { type: "task", id: e.firstId } : { type: "none" },
        createdAt: new Date(e.latest).toISOString(),
        tone: "accent",
      }));
    }
  }

  return out;
}

export function relativeTime(d: Date, now: Date): string {
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** When a snooze option ends, in the person's local time. */
export function snoozeUntil(option: "later_today" | "tomorrow" | "next_week", now: Date): Date {
  const d = new Date(now);
  if (option === "later_today") {
    d.setHours(18, 0, 0, 0);
    // Already evening: give it three hours instead.
    if (d.getTime() <= now.getTime()) return new Date(now.getTime() + 3 * 3_600_000);
    return d;
  }
  d.setHours(9, 0, 0, 0);
  if (option === "tomorrow") {
    d.setDate(d.getDate() + 1);
    return d;
  }
  // Next Monday, 9 AM.
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d;
}

/** "Not now" on a needs item: hidden until tomorrow morning. */
export function notNowUntil(now: Date): Date {
  return snoozeUntil("tomorrow", now);
}
