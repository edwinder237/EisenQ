// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// The bell's logic without React: where notices come from, and which feed an
// action goes to. The component (SocleBell.tsx) holds the state and the timers.

import { isNoticeId, noticeIdOf } from "./notices";
import type { NoticeFeed } from "./notices";
import { parseSession, sessionExpired } from "./session";
import type { BellSession } from "./session";
import type { BellAction, BellItem, BellReminders } from "./types";

// How often notices refresh while the page is open. They also refresh when
// the panel opens. No live connection (amended design record, point 1).
export const NOTICE_POLL_MS = 5 * 60_000;
// The reminders' refresh, as in Marc's bell.
export const REMINDER_POLL_MS = 60_000;

export type LoadFeed = () => Promise<(session: BellSession) => NoticeFeed>;

// The adapter, loaded only when a session arrives: with the bell off, the
// provider's library is never even downloaded.
const loadNovu: LoadFeed = async () => (await import("./novu-adapter")).createNoticeFeed;

export type NoticeSourceOptions = {
  // The app's own signed-in route. Unset or null: no notices.
  readonly sessionUrl?: string | null;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly load?: LoadFeed;
  readonly now?: () => Date;
  // One line, with no personal data, when this copy can't read the session.
  readonly warn?: (message: string) => void;
};

export type NoticeSource = {
  // The feed, or null when there are no notices for this page load: no
  // session URL, the bell off (a null session), an unknown format or a failed
  // fetch. Fetches the session at most once per page load, and again only
  // once it has expired (12 hours).
  readonly feed: () => Promise<NoticeFeed | null>;
};

export function createNoticeSource(options: NoticeSourceOptions): NoticeSource {
  const fetcher = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const load = options.load ?? loadNovu;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let current: { session: BellSession; feed: NoticeFeed } | undefined;
  let off = false;
  let pending: Promise<NoticeFeed | null> | undefined;

  const open = async (): Promise<NoticeFeed | null> => {
    if (!options.sessionUrl) return null;
    let body: { session?: unknown };
    try {
      const res = await fetcher(options.sessionUrl, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (!res.ok) {
        off = true;
        return null;
      }
      body = (await res.json()) as { session?: unknown };
    } catch {
      off = true;
      return null;
    }
    if (body.session === null || body.session === undefined) {
      off = true;
      return null;
    }
    const parsed = parseSession(body.session);
    if (!parsed.ok) {
      off = true;
      if (parsed.reason === "format") warn("Socle bell: this copy doesn't know the bell session's format. Showing reminders only; update the copy.");
      return null;
    }
    const make = await load();
    current = { session: parsed.session, feed: make(parsed.session) };
    return current.feed;
  };

  return {
    feed() {
      if (current && !sessionExpired(current.session, now())) return Promise.resolve(current.feed);
      // Expired: fetched again once. If that fails, notices stop for the page.
      current = undefined;
      if (off) return Promise.resolve(null);
      pending ??= open().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

export type BellActions = {
  readonly act: (item: BellItem, action: BellAction) => Promise<void>;
  readonly markAllRead: () => Promise<void>;
  readonly clearFyi: () => Promise<void>;
};

// Each action goes to the feed its item came from. Notices are read,
// dismissed and restored; they're never snoozed or muted.
export function bellActions(reminders: BellReminders | undefined, notices: NoticeSource): BellActions {
  return {
    async act(item, action) {
      if (!isNoticeId(item.id)) {
        if (!reminders) throw new Error("No reminders for this item");
        return reminders.act(item.id, action);
      }
      const feed = await notices.feed();
      if (!feed) throw new Error("No notices right now");
      const id = noticeIdOf(item.id);
      if (action.action === "read") return feed.read(id);
      if (action.action === "dismiss") return feed.dismiss(id);
      if (action.action === "restore") return feed.restore(id);
      throw new Error("A notice can't be snoozed or muted");
    },
    async markAllRead() {
      const feed = await notices.feed();
      await Promise.all([reminders?.markAllRead(), feed?.readAll()]);
    },
    async clearFyi() {
      const feed = await notices.feed();
      await Promise.all([reminders?.clearFyi(), feed?.dismissAll()]);
    },
  };
}
