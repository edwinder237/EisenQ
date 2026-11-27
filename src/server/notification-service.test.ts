import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  GET as listRoute,
  POST as bulkRoute,
} from "~/app/api/notifications/route";
import { PATCH as actRoute } from "~/app/api/notifications/[id]/route";
import {
  GET as getPrefsRoute,
  PUT as putPrefsRoute,
} from "~/app/api/notifications/preferences/route";
import {
  GET as getReminderRoute,
  PUT as putReminderRoute,
} from "~/app/api/notifications/reminders/route";
import type {
  NotificationList,
  NotificationPreferences,
} from "~/lib/notifications/types";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "~/lib/notifications/types";
import { completeTask } from "~/server/task-service";
import type * as McpSettingsModule from "~/server/mcp-settings";
import { resetOwnerCache } from "~/server/notification-access";
import {
  checklistItemsCollection,
  maintenanceItemsCollection,
  notificationStatesCollection,
  resetFakeDb,
  tasksCollection,
  userSettingsCollection,
} from "~/test/fake-db";
import {
  OTHER,
  OWNER,
  OWNER_EMAIL,
  fakeClerk,
  json,
  jsonRequest,
  params,
  seedSettings,
} from "~/test/helpers";

vi.mock("~/server/db", () => import("~/test/fake-db"));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));
// The AI connector's bookkeeping (switch, known apps, daily limit, activity
// log) is stubbed; the MCP handler, the add_task tool and createTask are real.
vi.mock("~/server/mcp-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof McpSettingsModule>();
  return {
    ...actual,
    loadMcpSettings: vi.fn(async () => ({
      mcp: actual.normalizeMcpSettings({
        enabled: true,
        preferences: {
          ...actual.DEFAULT_MCP_PREFERENCES,
          timeZone: "America/Toronto",
        },
      }),
      autoArchiveCompleted: false,
    })),
    touchClient: vi.fn(
      async (_u: string, _m: unknown, clientId: string, name?: string) => ({
        clientId,
        name: name ?? clientId,
        firstSeenAt: new Date(),
        lastUsedAt: new Date(),
        blocked: false,
      }),
    ),
    takeWriteSlot: vi.fn(async () => true),
    logActivity: vi.fn(async () => undefined),
  };
});

// Friday 2026-11-27, 10:00 in Toronto.
const NOW = new Date("2026-11-27T15:00:00Z");

async function addTask(patch: Record<string, unknown>) {
  const { insertedId } = await tasksCollection.insertOne({
    title: "A task",
    quadrant: "urgent-important",
    priority: "high",
    status: "pending",
    userId: OWNER,
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
    ...patch,
  });
  return String(insertedId);
}

async function list(): Promise<NotificationList> {
  const res = await listRoute();
  expect(res.status).toBe(200);
  return json<NotificationList>(res);
}
const ids = async () => (await list()).items.map((n) => n.id);

async function act(id: string, body: unknown) {
  return actRoute(
    jsonRequest(`/api/notifications/${encodeURIComponent(id)}`, "PATCH", body),
    params(id),
  );
}

beforeEach(async () => {
  resetFakeDb();
  resetOwnerCache();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(auth).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(clerkClient).mockResolvedValue(fakeClerk() as never);
  await seedSettings(OWNER);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/notifications", () => {
  it("derives from the database, needs first, newest first, with the unread count", async () => {
    const overdue = await addTask({
      title: "File taxes",
      dueDate: new Date("2026-11-25T14:00:00Z"),
    });
    const today = await addTask({
      title: "Call the bank",
      dueDate: new Date("2026-11-27T20:00:00Z"),
    });
    const routine = await checklistItemsCollection.insertOne({
      title: "Water plants",
      frequency: "weekly",
      daysOfWeek: [3], // Wednesdays
      completedDates: [],
      sortOrder: 0,
      userId: OWNER,
      createdAt: new Date("2026-11-20T12:00:00Z"),
      updatedAt: new Date("2026-11-20T12:00:00Z"),
    });

    const result = await list();
    expect(result.items.map((n) => n.id)).toEqual([
      `task_due_today:${today}:2026-11-27`,
      `task_overdue:${overdue}`,
      `routine_missed:${String(routine.insertedId)}:2026-11-25`,
    ]);
    expect(result.unreadCount).toBe(3);
    expect(
      result.items.every((n) => n.readAt === null && n.snoozedUntil === null),
    ).toBe(true);
  });

  it("is scoped to the signed-in person", async () => {
    await addTask({ userId: OTHER, dueDate: new Date("2026-11-25T14:00:00Z") });
    expect(await ids()).toEqual([]);
  });

  it("drops a task's notification by itself once the task is done", async () => {
    const id = await addTask({ dueDate: new Date("2026-11-25T14:00:00Z") });
    expect(await ids()).toEqual([`task_overdue:${id}`]);
    await completeTask(OWNER, id, { autoArchive: false });
    expect(await ids()).toEqual([]);
  });

  it("follows the in-app switches", async () => {
    await addTask({ dueDate: new Date("2026-11-25T14:00:00Z") });
    await userSettingsCollection.updateOne(
      { userId: OWNER },
      {
        $set: {
          notifications: {
            ...DEFAULT_NOTIFICATION_PREFERENCES,
            events: {
              ...DEFAULT_NOTIFICATION_PREFERENCES.events,
              due: { inApp: false, email: true },
            },
          },
        },
      },
    );
    expect(await ids()).toEqual([]);
  });

  it("shows a task added the way the MCP tools add it", async () => {
    const { handleVerifiedMcpRequest } = await import("~/server/mcp-handler");
    const res = await handleVerifiedMcpRequest(
      new Request("https://www.eisenq.app/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_task",
            arguments: {
              title: "Renew passport",
              quadrant: "Do First",
              due: "2026-11-27T16:00",
            },
          },
        }),
      }),
      {
        token: "test",
        clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        scopes: [],
        extra: {},
      },
      OWNER,
    );
    expect(res.status).toBe(200);
    const created = await tasksCollection.findOne({
      userId: OWNER,
      title: "Renew passport",
    });
    expect(created?.source).toMatchObject({ kind: "agent" });

    const items = (await list()).items;
    const id = String(created!._id);
    expect(items.map((n) => n.id)).toContain(`task_due_today:${id}:2026-11-27`);
    // 16:00 in the person's zone, as the AI asked.
    expect(items.find((n) => n.id.startsWith("task_due_today"))?.meta).toBe(
      "Do First · 4:00 PM",
    );
    // And the AI app's own line, in FYI.
    expect(items.some((n) => n.kind === "ai_activity")).toBe(true);
  });
});

describe("PATCH /api/notifications/:id", () => {
  it("Not now hides a Needs you item until 09:00 tomorrow, then it's back while still true", async () => {
    const id = `task_overdue:${await addTask({ dueDate: new Date("2026-11-25T14:00:00Z") })}`;
    expect((await act(id, { action: "dismiss" })).status).toBe(204);
    expect(await ids()).toEqual([]);

    vi.setSystemTime(new Date("2026-11-28T13:59:00Z")); // 08:59 Saturday in Toronto
    expect(await ids()).toEqual([]);
    vi.setSystemTime(new Date("2026-11-28T14:00:00Z")); // 09:00
    expect(await ids()).toEqual([id]);
  });

  it("Dismiss on FYI is for good", async () => {
    await addTask({
      title: "From Claude",
      source: { kind: "agent", title: "Claude", capturedAt: NOW },
      createdAt: new Date("2026-11-27T14:00:00Z"),
    });
    const [fyi] = (await list()).items.filter((n) => n.group === "fyi");
    expect((await act(fyi!.id, { action: "dismiss" })).status).toBe(204);
    vi.setSystemTime(new Date("2026-11-27T22:00:00Z"));
    expect(await ids()).not.toContain(fyi!.id);
    expect(
      (
        await notificationStatesCollection.findOne({
          userId: OWNER,
          id: fyi!.id,
        })
      )?.hiddenUntil,
    ).toBe("forever");
  });

  it("snoozes to 18:00 today, 09:00 tomorrow or Monday 09:00, local", async () => {
    const id = `task_overdue:${await addTask({ dueDate: new Date("2026-11-25T14:00:00Z") })}`;
    const until = async (option: string) => {
      expect((await act(id, { action: "snooze", option })).status).toBe(204);
      return (
        (await notificationStatesCollection.findOne({ userId: OWNER, id }))
          ?.hiddenUntil as Date
      ).toISOString();
    };
    expect(await until("later_today")).toBe("2026-11-27T23:00:00.000Z");
    expect(await until("tomorrow")).toBe("2026-11-28T14:00:00.000Z");
    expect(await until("next_week")).toBe("2026-11-30T14:00:00.000Z");
    vi.setSystemTime(new Date("2026-11-28T00:30:00Z")); // 19:30: past 18:00
    expect(await until("later_today")).toBe("2026-11-28T03:30:00.000Z");
  });

  it("restore puts back what was there before the last change", async () => {
    const id = `task_overdue:${await addTask({ dueDate: new Date("2026-11-25T14:00:00Z") })}`;
    await act(id, { action: "dismiss" });
    expect(await ids()).toEqual([]);
    expect((await act(id, { action: "restore" })).status).toBe(204);
    expect(await ids()).toEqual([id]);

    // Snoozed, then muted by mistake: Undo goes back to the snooze, not to shown.
    await act(id, { action: "snooze", option: "tomorrow" });
    await act(id, { action: "mute" });
    await act(id, { action: "restore" });
    const state = await notificationStatesCollection.findOne({
      userId: OWNER,
      id,
    });
    expect((state?.hiddenUntil as Date).toISOString()).toBe(
      "2026-11-28T14:00:00.000Z",
    );
  });

  it("mute is for this occurrence: the next maintenance cycle notifies again", async () => {
    const { insertedId } = await maintenanceItemsCollection.insertOne({
      title: "Furnace filter",
      intervalDays: 90,
      nextDueDate: "2026-11-28",
      userId: OWNER,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const first = `maintenance_upcoming:${String(insertedId)}:2026-11-28`;
    expect(await ids()).toEqual([first]);
    await act(first, { action: "mute" });
    expect(await ids()).toEqual([]);
    await maintenanceItemsCollection.updateOne(
      { _id: insertedId },
      { $set: { nextDueDate: "2026-11-29" } },
    );
    expect(await ids()).toEqual([
      `maintenance_upcoming:${String(insertedId)}:2026-11-29`,
    ]);
  });

  it("refuses to snooze FYI, and unknown ids, with { error }", async () => {
    const snoozeFyi = await act("ai_activity:Claude:2026-11-27:1", {
      action: "snooze",
      option: "tomorrow",
    });
    expect(snoozeFyi.status).toBe(400);
    expect(await json(snoozeFyi)).toEqual({
      error: "Only Needs you items can be snoozed",
    });
    const unknown = await act("something:else", { action: "read" });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ error: "Unknown notification" });
  });
});

describe("POST /api/notifications", () => {
  it("read_all reads everything listed; clear_fyi never touches Needs you", async () => {
    const needs = `task_overdue:${await addTask({ dueDate: new Date("2026-11-25T14:00:00Z") })}`;
    await addTask({
      title: "From Claude",
      source: { kind: "agent", title: "Claude", capturedAt: NOW },
      createdAt: new Date("2026-11-27T14:00:00Z"),
    });

    expect(
      (
        await bulkRoute(
          jsonRequest("/api/notifications", "POST", { action: "read_all" }),
        )
      ).status,
    ).toBe(204);
    const read = await list();
    expect(read.unreadCount).toBe(0);
    expect(read.items.every((n) => n.readAt === NOW.toISOString())).toBe(true);

    expect(
      (
        await bulkRoute(
          jsonRequest("/api/notifications", "POST", { action: "clear_fyi" }),
        )
      ).status,
    ).toBe(204);
    expect(await ids()).toEqual([needs]);
  });
});

describe("preferences", () => {
  it("fills gaps from the defaults and shows the Clerk email as the address", async () => {
    const prefs = await json<NotificationPreferences>(await getPrefsRoute());
    expect(prefs).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      digest: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.digest,
        address: OWNER_EMAIL,
      },
    });
  });

  it("saves what was sent, except the address", async () => {
    const next: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      defaultLead: "1_week",
      digest: {
        enabled: true,
        sendAt: "06:30",
        address: "someone-else@example.com",
      },
    };
    const res = await putPrefsRoute(
      jsonRequest("/api/notifications/preferences", "PUT", next),
    );
    expect(await json(res)).toEqual({
      ...next,
      digest: { enabled: true, sendAt: "06:30", address: OWNER_EMAIL },
    });
    const stored = await userSettingsCollection.findOne({ userId: OWNER });
    expect(stored?.notifications).toEqual({
      events: DEFAULT_NOTIFICATION_PREFERENCES.events,
      defaultLead: "1_week",
      digest: { enabled: true, sendAt: "06:30" },
    });
  });

  it("rejects a malformed body with { error }", async () => {
    const res = await putPrefsRoute(
      jsonRequest("/api/notifications/preferences", "PUT", {
        digest: { sendAt: "7am" },
      }),
    );
    expect(res.status).toBe(400);
    expect(typeof (await json<{ error: unknown }>(res)).error).toBe("string");
  });
});

describe("per-item heads-up (Remind me)", () => {
  async function addItem(userId = OWNER) {
    const { insertedId } = await maintenanceItemsCollection.insertOne({
      title: "Annual checkup",
      intervalDays: 365,
      nextDueDate: "2026-12-04",
      userId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return String(insertedId);
  }
  const put = (body: unknown) =>
    putReminderRoute(jsonRequest("/api/notifications/reminders", "PUT", body));
  const get = (itemId: string) =>
    getReminderRoute(
      jsonRequest(
        `/api/notifications/reminders?kind=maintenance&itemId=${itemId}`,
        "GET",
      ),
    );

  it("1 week ahead surfaces it 7 days early; Off never does; null goes back to the default", async () => {
    const itemId = await addItem();
    expect(await json(await get(itemId))).toEqual({
      kind: "maintenance",
      itemId,
      lead: null,
    });
    expect(await ids()).toEqual([]); // default 2 days, and it's 7 days away

    expect(
      await json(await put({ kind: "maintenance", itemId, lead: "1_week" })),
    ).toEqual({ kind: "maintenance", itemId, lead: "1_week" });
    expect(await json(await get(itemId))).toEqual({
      kind: "maintenance",
      itemId,
      lead: "1_week",
    });
    expect(await ids()).toEqual([`maintenance_upcoming:${itemId}:2026-12-04`]);

    await put({ kind: "maintenance", itemId, lead: "off" });
    expect(await ids()).toEqual([]);
    vi.setSystemTime(new Date("2026-12-04T15:00:00Z")); // the day itself
    expect(await ids()).toEqual([]);

    await put({ kind: "maintenance", itemId, lead: null });
    expect(
      (await maintenanceItemsCollection.findOne({ _id: new ObjectId(itemId) }))
        ?.reminderLead,
    ).toBeUndefined();
  });

  it("only for the person's own items", async () => {
    const theirs = await addItem(OTHER);
    expect((await get(theirs)).status).toBe(404);
    const res = await put({
      kind: "maintenance",
      itemId: theirs,
      lead: "1_week",
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "Item not found" });
  });
});
