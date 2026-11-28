// Notifications: the contract between the front end and the backend.
//
// The front end only ever talks to `NotificationsApi` (./client.ts), live by
// default, on the HTTP routes under /api/notifications/* with exactly these
// shapes. See docs/notifications/README.md.

/** Which part of the bell panel an item sits in. */
export type NotificationGroup =
  /** Something to act on: overdue, due today, coming up. Comes back until handled. */
  | "needs"
  /** For your information: AI activity, missed routines. Gone once dismissed. */
  | "fyi";

export type NotificationKind =
  | "task_overdue"
  | "task_due_today"
  | "maintenance_upcoming"
  | "maintenance_overdue"
  | "routine_missed"
  | "ai_activity";

/** What tapping the notification opens. */
export type NotificationTarget =
  | { type: "task"; id: string }
  | { type: "maintenance"; id: string }
  | { type: "routine"; id: string }
  | { type: "none" };

export interface AppNotification {
  /**
   * Stable for the same underlying fact, so re-deriving never duplicates it,
   * e.g. "task_overdue:<taskId>" or "ai_activity:<clientId>:<YYYY-MM-DD>".
   */
  id: string;
  kind: NotificationKind;
  group: NotificationGroup;
  /** Plain text. The bold part is `subject`; `text` is the sentence around it. */
  subject: string;
  /** Sentence with "{subject}" where the subject goes: "{subject} is 2 days overdue". */
  text: string;
  /** Second line, e.g. "Do First · was due Mon". */
  meta: string;
  target: NotificationTarget;
  /** ISO timestamp the fact became true (sort key within a group, newest first). */
  createdAt: string;
  /** ISO timestamp, or null when unread. */
  readAt: string | null;
  /** Hidden until this ISO timestamp. Only "needs" items can be snoozed. */
  snoozedUntil: string | null;
  /** Quadrant colour hint for the icon: "do-first" | "schedule" | "delegate" | "eliminate". */
  tone?: "do-first" | "schedule" | "delegate" | "eliminate" | "accent" | "muted";
}

/** How far ahead to warn about routines and maintenance. */
export type ReminderLead = "off" | "same_day" | "1_day" | "2_days" | "1_week";

export const REMINDER_LEAD_DAYS: Record<Exclude<ReminderLead, "off">, number> = {
  same_day: 0,
  "1_day": 1,
  "2_days": 2,
  "1_week": 7,
};

export const REMINDER_LEAD_LABELS: Record<ReminderLead, string> = {
  off: "Off",
  same_day: "On the day",
  "1_day": "1 day before",
  "2_days": "2 days before",
  "1_week": "1 week before",
};

/** The events a person can switch on or off, per channel. */
export type NotificationEvent = "due" | "upcoming" | "missed_routines" | "ai_activity";

export interface ChannelToggle {
  inApp: boolean;
  /** null: this event is never emailed (AI activity). */
  email: boolean | null;
}

export interface NotificationPreferences {
  events: Record<NotificationEvent, ChannelToggle>;
  /** Default heads-up for routines and maintenance; items may override it. */
  defaultLead: Exclude<ReminderLead, "off">;
  digest: {
    /**
     * The daily email. Held by Socle, not EisenQ: off until the person turns
     * it on and saves, and turned off by the link in any summary email.
     */
    enabled: boolean;
    /** Local time "HH:mm" in the person's time zone. */
    sendAt: string;
    /** Read-only for the client: the verified account email the digest goes to. */
    address?: string;
    /** Read-only: the account's primary email isn't verified, so no email can go. */
    addressUnverified?: boolean;
  };
  /**
   * Notices in the bell, such as the daily summary's copy. Held by Socle: on
   * until the person turns it off. EisenQ's own reminders follow the in-app
   * switches above, whatever this says.
   */
  bell: { enabled: boolean };
  /** Read-only: Socle couldn't be reached, so the email and bell switches show EisenQ's last copy. */
  channelsUnavailable?: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  events: {
    due: { inApp: true, email: true },
    upcoming: { inApp: true, email: true },
    missed_routines: { inApp: true, email: false },
    ai_activity: { inApp: true, email: null },
  },
  defaultLead: "2_days",
  // Socle's defaults: email off, the bell on (amended design record, point 6).
  digest: { enabled: false, sendAt: "07:00" },
  bell: { enabled: true },
};

/** Per-item override of the heads-up, e.g. a week ahead for the annual doctor visit. */
export interface ItemReminder {
  kind: "maintenance" | "routine";
  itemId: string;
  /** null: use the default from preferences. */
  lead: ReminderLead | null;
}

export type SnoozeOption = "later_today" | "tomorrow" | "next_week";

/** Response of GET /api/notifications. */
export interface NotificationList {
  items: AppNotification[];
  /** Unread and not snoozed, across both groups: the number on the bell. */
  unreadCount: number;
}
