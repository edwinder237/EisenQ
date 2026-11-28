// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// The bell's one list: the app's reminders and the notices together, one
// unread count. Pure functions, no React and no network.

import type { BellItem } from "./types";

const byNewest = (a: BellItem, b: BellItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

// The app's reminders keep the order the app gave them; notices go in FYI,
// newest first, after the app's own FYI items.
export function mergeFeeds(reminders: readonly BellItem[], notices: readonly BellItem[]): BellItem[] {
  return [...reminders, ...[...notices].sort(byNewest)];
}

export function unreadCount(items: readonly BellItem[]): number {
  return items.filter((item) => item.readAt === null).length;
}

export function groups(items: readonly BellItem[]): { needs: BellItem[]; fyi: BellItem[] } {
  return { needs: items.filter((item) => item.group === "needs"), fyi: items.filter((item) => item.group === "fyi") };
}

// The bell's badge: up to 9, then "9+".
export function badge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
