// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// When a snooze ends, in the browser's own time, for the menu's labels and the
// Undo toast only. The app's server decides the real time (EisenQ's
// snoozeUntil, in derive.ts, which this follows).

import type { SnoozeOption } from "./types";

export function snoozeUntil(option: SnoozeOption, now: Date): Date {
  const d = new Date(now);
  if (option === "later_today") {
    d.setHours(18, 0, 0, 0);
    // Already evening: three hours instead.
    if (d.getTime() <= now.getTime()) return new Date(now.getTime() + 3 * 3_600_000);
    return d;
  }
  d.setHours(9, 0, 0, 0);
  if (option === "tomorrow") {
    d.setDate(d.getDate() + 1);
    return d;
  }
  // Next Monday, 9 AM.
  const add = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d;
}

export function whenLabel(d: Date, now = new Date()): string {
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? t : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${t}`;
}
