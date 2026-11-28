// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// The one file that knows the notices' provider: Novu, through its headless
// browser library @novu/js 3.21.0 (pinned exactly), with none of Novu's
// screens (amended design record, point 1). The bell loads this file with a
// dynamic import only once a session arrives, so with the bell off nothing
// reaches Novu (legal's A8). A provider swap replaces this file only.
//
// Read in @novu/js 3.21.0's bundle (dist/esm, 2026-11-28):
// - new Novu(…) opens the Inbox session at once (POST /v1/inbox/session).
// - The socket connects only when code subscribes to a socket event with
//   novu.on(…). This file never calls on(), so no WebSocket is ever opened:
//   the bell fetches on load, when its panel opens and every 5 minutes.
// - The session sends the subscriber's time zone, the browser's own unless
//   one is given, and Novu saves it on the person's profile (Novu's
//   session.usecase.ts). Socle never gives Novu a time zone (legal, #52), so
//   this file sends a fixed "UTC".
// - Nothing about the person but the subscriber ID goes in: no email, no name.

import { Novu } from "@novu/js";
import type { Notification } from "@novu/js";
import type { Notice, NoticeFeed } from "./notices";
import type { BellSession } from "./session";

export const NOTICE_PAGE = 50;

// The parts of Novu's client this file uses, so the tests can stand in a fake.
export type NovuClient = {
  notifications: {
    list(args: { archived: boolean; limit: number; useCache?: boolean }): Promise<{ data?: { notifications: NovuNotification[] }; error?: unknown }>;
    readAll(): Promise<{ error?: unknown }>;
    archiveAll(): Promise<{ error?: unknown }>;
  };
};

export type NovuNotification = Pick<Notification, "id" | "subject" | "body" | "createdAt" | "readAt" | "isRead" | "read" | "archive" | "unarchive">;

export type NovuOptionsUsed = {
  applicationIdentifier: string;
  subscriber: { subscriberId: string; timezone: string };
  subscriberHash: string;
  apiUrl?: string;
  useCache: false;
};

export type MakeClient = (options: NovuOptionsUsed) => NovuClient;

const makeNovu: MakeClient = (options) => new Novu(options) as unknown as NovuClient;

// A failure, with no text of Novu's: it can echo the person's profile.
export class NoticeError extends Error {
  constructor() {
    super("Notices couldn't be reached");
    this.name = "NoticeError";
  }
}

export function novuOptions(session: BellSession): NovuOptionsUsed {
  return {
    applicationIdentifier: session.applicationIdentifier,
    subscriber: { subscriberId: session.subscriberId, timezone: "UTC" },
    subscriberHash: session.subscriberHash,
    ...(session.apiUrl ? { apiUrl: session.apiUrl.replace(/\/+$/, "") } : {}),
    useCache: false,
  };
}

export function createNoticeFeed(session: BellSession, make: MakeClient = makeNovu): NoticeFeed {
  const novu = make(novuOptions(session));
  // The last list's notifications, by ID, for their own read/archive calls.
  const known = new Map<string, NovuNotification>();

  const check = async (call: Promise<{ error?: unknown; data?: unknown }>): Promise<void> => {
    let result: { error?: unknown };
    try {
      result = await call;
    } catch {
      throw new NoticeError();
    }
    if (result.error) throw new NoticeError();
  };
  const one = (id: string): NovuNotification => {
    const notification = known.get(id);
    if (!notification) throw new NoticeError();
    return notification;
  };

  return {
    async list(): Promise<Notice[]> {
      let result: Awaited<ReturnType<NovuClient["notifications"]["list"]>>;
      try {
        result = await novu.notifications.list({ archived: false, limit: NOTICE_PAGE, useCache: false });
      } catch {
        throw new NoticeError();
      }
      if (result.error || !result.data) throw new NoticeError();
      known.clear();
      return result.data.notifications.map((notification) => {
        known.set(notification.id, notification);
        return {
          id: notification.id,
          subject: notification.subject ?? "",
          body: notification.body ?? "",
          createdAt: notification.createdAt,
          readAt: notification.isRead ? (notification.readAt ?? notification.createdAt) : null,
        };
      });
    },
    read: async (id) => check(one(id).read()),
    dismiss: async (id) => check(one(id).archive()),
    restore: async (id) => check(one(id).unarchive()),
    readAll: async () => check(novu.notifications.readAll()),
    dismissAll: async () => check(novu.notifications.archiveAll()),
  };
}
