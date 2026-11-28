// Socle bell. Source: edwinder237/socle, packages/bell. Apps copy it with its
// scripts/vendor.ts and never edit their copy: changes go through Socle.
//
// What an app sees of the bell (amended design record,
// docs/decisions/2026-11-27-eisenq-notifications-amended-design.md, point 1).
// No provider name appears here: the notices' provider sits behind one
// adapter file (novu-adapter.ts), loaded only when a session arrives.

import type { ReactNode } from "react";

// Which part of the panel an item sits in: "needs" comes back until handled,
// "fyi" is gone once dismissed.
export type BellGroup = "needs" | "fyi";

// What tapping an item opens.
export type BellTarget = { type: "task"; id: string } | { type: "maintenance"; id: string } | { type: "routine"; id: string } | { type: "none" };

export type SnoozeOption = "later_today" | "tomorrow" | "next_week";

// One row. The app's reminders come in this shape (EisenQ's AppNotification,
// unchanged); notices are turned into it.
export interface BellItem {
  // Stable for the same fact. Notices' IDs start with "notice:".
  id: string;
  // The app's own kinds, or "notice".
  kind: string;
  group: BellGroup;
  // Plain text. The bold part is `subject`; `text` is the sentence around it,
  // with "{subject}" where it goes.
  subject: string;
  text: string;
  // The second line.
  meta: string;
  target: BellTarget;
  // ISO timestamps.
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  tone?: "do-first" | "schedule" | "delegate" | "eliminate" | "accent" | "muted";
}

export type BellAction =
  | { action: "read" }
  // FYI: removed for good. Needs you: hidden until tomorrow 9 AM ("Not now").
  | { action: "dismiss" }
  | { action: "snooze"; option: SnoozeOption }
  // "Stop reminding me": hidden for good, for this occurrence.
  | { action: "mute" }
  // Undo of dismiss, snooze or mute.
  | { action: "restore" };

// The app's own live items (EisenQ's NotificationsApi already fits it).
// Optional: an app without reminders shows notices only.
export interface BellReminders {
  list(): Promise<{ items: BellItem[]; unreadCount: number }>;
  act(id: string, action: BellAction): Promise<void>;
  markAllRead(): Promise<void>;
  clearFyi(): Promise<void>;
}

// The words the bell shows, in English by default (Marc's).
export interface BellLabels {
  title: string;
  bellButton: string;
  bellButtonUnread: (count: number) => string;
  markAllRead: string;
  needsYou: (count: number) => string;
  fyi: string;
  clearAll: string;
  loading: string;
  unavailable: string;
  caughtUp: string;
  caughtUpHint: string;
  open: string;
  more: string;
  notNow: string;
  dismiss: string;
  snooze: string;
  snoozeOptions: Record<SnoozeOption, string>;
  markDone: string;
  stopReminding: string;
  settings: string;
  undo: string;
  dismissed: string;
  hiddenUntilTomorrow: string;
  snoozedUntil: (when: string) => string;
  wontRemind: string;
  updateFailed: string;
  undoFailed: string;
  markReadFailed: string;
  clearFailed: string;
}

// Colours, as CSS values. Each defaults to the CSS variable EisenQ already
// defines (var(--ink), var(--accent), var(--q-do-first), …), so EisenQ passes
// nothing.
export type BellColor =
  | "ink"
  | "ink2"
  | "ink3"
  | "muted"
  | "muted3"
  | "accent"
  | "accentText"
  | "background"
  | "drawer"
  | "drawerBorder"
  | "line"
  | "chip"
  | "hover"
  | "overlay"
  | "doFirst"
  | "schedule"
  | "delegate"
  | "eliminate";

export interface BellAppearance {
  colors?: Partial<Record<BellColor, string>>;
  // The panel's corner radius on a large screen, such as "16px".
  radius?: string;
  fontFamily?: string;
  // The panel's title font.
  titleFontFamily?: string;
}

export interface SocleBellProps {
  // The app's own signed-in route that returns Socle's bell session, as
  // { session: string | null }. Same origin: the browser never calls Socle.
  // Unset or null: no notices (the app's mock mode, or the bell is off).
  sessionUrl?: string | null;
  reminders?: BellReminders;
  // Anything that changes when the app's items change; refreshes the list.
  refreshKey?: unknown;
  onOpen(target: BellTarget): void;
  // "Mark task done", in a task reminder's menu.
  onMarkDone?(target: BellTarget): void;
  // "Settings ›", in the panel's footer.
  onOpenSettings?(): void;
  // The panel's footer text, such as "Daily email at 7:00".
  footer?: ReactNode;
  // Told when the panel opens or closes, so the app can refresh its footer.
  onOpenChange?(open: boolean): void;
  appearance?: BellAppearance;
  labels?: Partial<BellLabels>;
  // How often the reminders refresh, in ms. Default 60 000.
  pollMs?: number;
}
