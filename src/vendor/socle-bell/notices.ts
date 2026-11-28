// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// Notices: one-off messages an app sends through Socle, such as the daily
// summary's copy (amended design record, point 1). They live with Socle's
// delivery provider. This interface names no provider: novu-adapter.ts is the
// only file that does, and a provider swap changes only that file.

import type { BellItem } from "./types";

// A notice as the adapter hands it over.
export type Notice = {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
  readonly readAt: string | null;
};

export interface NoticeFeed {
  // The notices not dismissed, newest first.
  list(): Promise<Notice[]>;
  read(id: string): Promise<void>;
  // Gone from the bell; restore() brings it back (Undo).
  dismiss(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  readAll(): Promise<void>;
  dismissAll(): Promise<void>;
}

export const NOTICE_PREFIX = "notice:";

export function isNoticeId(id: string): boolean {
  return id.startsWith(NOTICE_PREFIX);
}

export function noticeIdOf(itemId: string): string {
  return itemId.slice(NOTICE_PREFIX.length);
}

// A notice as a row: in FYI, with read, dismiss and Undo, and no snooze (only
// "Needs you" items snooze). The subject is the bold part; the body, one line
// per language, is the second line after the time it arrived.
export function noticeItem(notice: Notice, whenLabel: (date: Date) => string): BellItem {
  const lines = notice.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const subject = notice.subject.trim() || lines.shift() || "";
  const when = whenLabel(new Date(notice.createdAt));
  return {
    id: NOTICE_PREFIX + notice.id,
    kind: "notice",
    group: "fyi",
    subject,
    text: "{subject}",
    meta: [when, ...(lines.length > 0 ? [lines.join(" / ")] : [])].join(" · "),
    target: { type: "none" },
    createdAt: notice.createdAt,
    readAt: notice.readAt,
    snoozedUntil: null,
    tone: "accent",
  };
}
