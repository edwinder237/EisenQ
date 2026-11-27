// Waiting-task reminders: the person's setting, shared by the Settings dialog
// (browser) and the daily job (server). No server imports, so the dashboard
// can use it. Stored in userSettings.notifications.staleTasks.
//
// A Do First task "waits" from the moment it entered Do First. Once it has
// waited the threshold, counted in calendar days in Toronto, EisenQ asks Socle
// to send one reminder a day: by email and in the bell. The reminder says only
// that a task has waited N days, never which one.

export type ReminderRepeat = "daily" | "never";

export interface ReminderSettings {
  enabled: boolean;        // off until the person turns it on (opt-in)
  thresholdDays: number;   // remind once a Do First task has waited this many days
  repeat: ReminderRepeat;  // "daily": again every day while it waits; "never": once
}

export const REMINDER_THRESHOLD_MIN = 2; // so "days" / "jours" is always right
export const REMINDER_THRESHOLD_MAX = 30;

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: false,
  thresholdDays: 5,
  repeat: "daily",
};

export function clampThreshold(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_REMINDER_SETTINGS.thresholdDays;
  return Math.min(REMINDER_THRESHOLD_MAX, Math.max(REMINDER_THRESHOLD_MIN, Math.round(days)));
}

/** Fills in defaults for anything never saved, and repairs anything out of range. */
export function normalizeReminderSettings(raw?: Partial<ReminderSettings> | null): ReminderSettings {
  return {
    enabled: raw?.enabled === true,
    thresholdDays: clampThreshold(raw?.thresholdDays ?? DEFAULT_REMINDER_SETTINGS.thresholdDays),
    repeat: raw?.repeat === "never" ? "never" : "daily",
  };
}

export function reminderSettingsEqual(a: ReminderSettings | null, b: ReminderSettings | null): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.thresholdDays === b.thresholdDays && a.repeat === b.repeat;
}
