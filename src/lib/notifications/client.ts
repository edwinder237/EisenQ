// The one door the UI uses for notifications. Two implementations:
//
//  - "live": calls /api/notifications/* (stubs today, see the route files).
//  - "mock": derives notifications in the browser from the tasks and
//            maintenance already loaded, and keeps read / snoozed / dismissed
//            state and preferences in localStorage. Good enough to use and
//            demo the whole UI before the backend exists.
//
// Mode: NEXT_PUBLIC_NOTIFICATIONS_MODE ("off" | "mock" | "live", default
// "off"). Overridable per browser with ?notifications=mock|live|off on any
// page, remembered in localStorage, so it can be tried in production without
// turning it on for anyone else.

import { deriveNotifications, notNowUntil, snoozeUntil, type DeriveInput } from "./derive";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type ItemReminder,
  type NotificationList,
  type NotificationPreferences,
  type ReminderLead,
  type SnoozeOption,
} from "./types";

export type NotificationsMode = "off" | "mock" | "live";

/** What the user does to one notification. */
export type NotificationAction =
  | { action: "read" }
  /** FYI: removed for good. Needs-you: hidden until tomorrow 9 AM ("Not now"). */
  | { action: "dismiss" }
  | { action: "snooze"; option: SnoozeOption }
  /** "Stop reminding me": hidden for good, for this occurrence. */
  | { action: "mute" }
  /** Undo of dismiss / snooze / mute. */
  | { action: "restore" };

export interface NotificationsApi {
  list(): Promise<NotificationList>;
  act(id: string, action: NotificationAction): Promise<void>;
  markAllRead(): Promise<void>;
  /** Dismiss every FYI item. Needs-you items are never bulk-cleared. */
  clearFyi(): Promise<void>;
  getPreferences(): Promise<NotificationPreferences>;
  savePreferences(prefs: NotificationPreferences): Promise<NotificationPreferences>;
  getItemReminder(kind: ItemReminder["kind"], itemId: string): Promise<ItemReminder>;
  setItemReminder(reminder: ItemReminder): Promise<ItemReminder>;
  sendTestEmail(): Promise<{ sentTo: string }>;
}

const MODE_KEY = "eisenq-notifications-mode";

export function getNotificationsMode(): NotificationsMode {
  const valid = (v: unknown): v is NotificationsMode => v === "off" || v === "mock" || v === "live";
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("notifications");
      if (valid(q)) {
        localStorage.setItem(MODE_KEY, q);
        return q;
      }
      const saved = localStorage.getItem(MODE_KEY);
      if (valid(saved)) return saved;
    } catch {
      /* storage blocked: fall through to the build default */
    }
  }
  const env = process.env.NEXT_PUBLIC_NOTIFICATIONS_MODE;
  return valid(env) ? env : "off";
}

// ---------------------------------------------------------------- live ----

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/notifications${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Notifications request failed (${res.status})`);
  }
  // The actions answer 204 No Content, which has no JSON to read.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const liveNotificationsApi: NotificationsApi = {
  list: () => call<NotificationList>(""),
  act: (id, action) => call<void>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(action) }),
  markAllRead: () => call<void>("", { method: "POST", body: JSON.stringify({ action: "read_all" }) }),
  clearFyi: () => call<void>("", { method: "POST", body: JSON.stringify({ action: "clear_fyi" }) }),
  getPreferences: () => call<NotificationPreferences>("/preferences"),
  savePreferences: (prefs) => call<NotificationPreferences>("/preferences", { method: "PUT", body: JSON.stringify(prefs) }),
  getItemReminder: (kind, itemId) =>
    call<ItemReminder>(`/reminders?kind=${kind}&itemId=${encodeURIComponent(itemId)}`),
  setItemReminder: (r) => call<ItemReminder>("/reminders", { method: "PUT", body: JSON.stringify(r) }),
  sendTestEmail: () => call<{ sentTo: string }>("/test-email", { method: "POST" }),
};

// ---------------------------------------------------------------- mock ----

const STATE_KEY = "eisenq-notifications-mock";

interface MockState {
  read: Record<string, string>;
  /** id → ISO "hidden until"; "forever" for dismissed FYI and muted items. */
  hidden: Record<string, string>;
  /** Kept for Undo: what `hidden` held before the last change to each id. */
  previous: Record<string, string | null>;
  prefs: NotificationPreferences;
  itemLeads: Record<string, ReminderLead | null>;
}

function loadState(): MockState {
  const empty: MockState = { read: {}, hidden: {}, previous: {}, prefs: DEFAULT_NOTIFICATION_PREFERENCES, itemLeads: {} };
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return empty;
    const s = JSON.parse(raw) as Partial<MockState>;
    return {
      ...empty,
      ...s,
      prefs: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...s.prefs,
        events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...s.prefs?.events },
        digest: { ...DEFAULT_NOTIFICATION_PREFERENCES.digest, ...s.prefs?.digest },
      },
    };
  } catch {
    return empty;
  }
}

function saveState(s: MockState) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: state lasts for this page only */
  }
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * @param source returns the data the dashboard already holds; called on every
 *               list() so notifications follow edits without a refetch.
 * @param email  shown as the digest address.
 */
export function createMockNotificationsApi(
  source: () => Omit<DeriveInput, "now" | "prefs" | "itemLeads">,
  email?: string,
): NotificationsApi {
  let state = loadState();
  const commit = (next: MockState) => {
    state = next;
    saveState(state);
  };
  const setHidden = (id: string, until: string | null) => {
    const hidden = { ...state.hidden };
    const previous = { ...state.previous, [id]: state.hidden[id] ?? null };
    if (until) hidden[id] = until;
    else delete hidden[id];
    commit({ ...state, hidden, previous });
  };

  return {
    async list() {
      const now = new Date();
      const derived = deriveNotifications({ ...source(), now, prefs: state.prefs, itemLeads: state.itemLeads });
      const items = derived
        .filter((n) => {
          const h = state.hidden[n.id];
          return !h || (h !== "forever" && new Date(h) <= now);
        })
        .map((n) => ({ ...n, readAt: state.read[n.id] ?? null }))
        .sort((a, b) => (a.group === b.group ? b.createdAt.localeCompare(a.createdAt) : a.group === "needs" ? -1 : 1));
      return { items, unreadCount: items.filter((n) => !n.readAt).length };
    },
    async act(id, a) {
      const now = new Date();
      if (a.action === "read") {
        commit({ ...state, read: { ...state.read, [id]: now.toISOString() } });
      } else if (a.action === "dismiss") {
        setHidden(id, id.startsWith("routine_missed") || id.startsWith("ai_activity") ? "forever" : notNowUntil(now).toISOString());
      } else if (a.action === "snooze") {
        setHidden(id, snoozeUntil(a.option, now).toISOString());
      } else if (a.action === "mute") {
        setHidden(id, "forever");
      } else {
        const prev = state.previous[id] ?? null;
        const hidden = { ...state.hidden };
        if (prev) hidden[id] = prev;
        else delete hidden[id];
        commit({ ...state, hidden });
      }
    },
    async markAllRead() {
      const { items } = await this.list();
      const at = new Date().toISOString();
      const read = { ...state.read };
      for (const n of items) read[n.id] ??= at;
      commit({ ...state, read });
    },
    async clearFyi() {
      const { items } = await this.list();
      const hidden = { ...state.hidden };
      for (const n of items) if (n.group === "fyi") hidden[n.id] = "forever";
      commit({ ...state, hidden });
    },
    async getPreferences() {
      return { ...state.prefs, digest: { ...state.prefs.digest, address: email } };
    },
    async savePreferences(prefs) {
      // The address is the account email, never stored from the client.
      commit({ ...state, prefs: { ...prefs, digest: { enabled: prefs.digest.enabled, sendAt: prefs.digest.sendAt } } });
      return this.getPreferences();
    },
    async getItemReminder(kind, itemId) {
      return { kind, itemId, lead: state.itemLeads[`${kind}:${itemId}`] ?? null };
    },
    async setItemReminder(r) {
      commit({ ...state, itemLeads: { ...state.itemLeads, [`${r.kind}:${r.itemId}`]: r.lead } });
      return r;
    },
    async sendTestEmail() {
      await later(500);
      return { sentTo: email ?? "your account email" };
    },
  };
}
