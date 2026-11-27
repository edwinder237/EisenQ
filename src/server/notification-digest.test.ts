import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "~/lib/notifications/types";
import { resetOwnerCache } from "~/server/notification-access";
import {
  resetTestEmailLimit,
  runDigests,
  sendTestDigest,
} from "~/server/notification-digest";
import { applyAction, listNotifications } from "~/server/notification-service";
import { createSocleClient } from "~/server/socle";
import {
  checklistItemsCollection,
  maintenanceItemsCollection,
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
  seedSettings,
} from "~/test/helpers";

const testEnv = vi.hoisted(() => ({
  CRON_SECRET: undefined as string | undefined,
  SOCLE_API_URL: undefined as string | undefined,
  SOCLE_API_KEY: undefined as string | undefined,
}));

vi.mock("~/server/db", () => import("~/test/fake-db"));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));
vi.mock("~/env", () => ({ env: testEnv }));

// Friday 2026-11-27, 07:05 in Toronto: just after the default 07:00.
const AT_SEVEN = new Date("2026-11-27T12:05:00Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SAVED: NotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES;

/** Socle, stubbed at the HTTP level: the real client builds the request. */
function socleAnswering(...answers: { status: number; body?: unknown }[]) {
  const queue = [...answers];
  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => {
      const next = queue.shift() ?? { status: 202, body: {} };
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return {
    socle: createSocleClient(
      { apiUrl: "https://socle.test", apiKey: "k" },
      fetchImpl,
    ),
    fetchImpl,
  };
}
const sentBodies = (f: ReturnType<typeof socleAnswering>["fetchImpl"]) =>
  f.mock.calls.map(
    ([, init]) =>
      JSON.parse(init?.body as string) as { data: Record<string, unknown> },
  );
const sentKeys = (f: ReturnType<typeof socleAnswering>["fetchImpl"]) =>
  f.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("idempotency-key"),
  );

const owner = async () => OWNER;
const noWait = async () => undefined;

async function seedDay() {
  await tasksCollection.insertOne({
    title: "File taxes",
    quadrant: "urgent-important",
    priority: "high",
    status: "pending",
    userId: OWNER,
    dueDate: new Date("2026-11-25T14:00:00Z"),
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
  });
  await tasksCollection.insertOne({
    title: "Call the bank",
    quadrant: "important-not-urgent",
    priority: "medium",
    status: "pending",
    userId: OWNER,
    dueDate: new Date("2026-11-27T20:00:00Z"),
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
  });
  await maintenanceItemsCollection.insertOne({
    title: "Furnace filter",
    intervalDays: 90,
    nextDueDate: "2026-11-28",
    userId: OWNER,
    createdAt: AT_SEVEN,
    updatedAt: AT_SEVEN,
  });
  await checklistItemsCollection.insertOne({
    title: "Water plants",
    frequency: "weekly",
    daysOfWeek: [3],
    completedDates: [],
    sortOrder: 0,
    userId: OWNER,
    createdAt: new Date("2026-11-20T12:00:00Z"),
    updatedAt: new Date("2026-11-20T12:00:00Z"),
  });
}

let logs: string[];

beforeEach(async () => {
  resetFakeDb();
  resetOwnerCache();
  resetTestEmailLimit();
  Object.assign(testEnv, {
    CRON_SECRET: undefined,
    SOCLE_API_URL: undefined,
    SOCLE_API_KEY: undefined,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT_SEVEN);
  vi.mocked(clerkClient).mockResolvedValue(fakeClerk() as never);
  vi.mocked(auth).mockResolvedValue({ userId: OWNER } as never);
  await seedSettings(OWNER, { notifications: SAVED });
  logs = [];
  for (const level of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    );
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the daily digest", () => {
  it("sends counts only, once sendAt has come, to the owner's primary email", async () => {
    await seedDay();
    const { socle, fetchImpl } = socleAnswering({
      status: 202,
      body: { eventId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" },
    });
    expect(await runDigests({ socle, now: AT_SEVEN, ownerId: owner })).toEqual({
      status: "done",
      outcome: "sent",
    });

    const [body] = sentBodies(fetchImpl);
    expect(body).toEqual({
      eventType: "eisenq.digest.ready",
      recipient: { id: OWNER, email: OWNER_EMAIL, locale: "fr" },
      // Missed routines' email switch is off by default.
      data: {
        dueCount: 2,
        comingUpCount: 1,
        missedRoutinesCount: 0,
        isTest: false,
      },
    });
    const raw = fetchImpl.mock.calls[0]![1]?.body as string;
    for (const leak of [
      "File taxes",
      "Call the bank",
      "Furnace",
      "Toronto",
      "07:00",
      "2026-11",
    ])
      expect(raw).not.toContain(leak);

    // The key is the random UUID kept with today's sent-today record.
    const record = (await userSettingsCollection.findOne({ userId: OWNER }))
      ?.notificationDigest;
    expect(record).toMatchObject({ day: "2026-11-27", status: "sent" });
    expect(record?.key).toMatch(UUID);
    expect(sentKeys(fetchImpl)).toEqual([record?.key]);
  });

  it("follows the email switches, not the in-app ones, and leaves hidden items out", async () => {
    await seedDay();
    const prefs: NotificationPreferences = {
      ...SAVED,
      events: {
        ...SAVED.events,
        upcoming: { inApp: true, email: false },
        missed_routines: { inApp: false, email: true },
      },
    };
    await userSettingsCollection.updateOne(
      { userId: OWNER },
      { $set: { notifications: prefs } },
    );
    const overdue = (await listNotifications(OWNER, AT_SEVEN)).items.find(
      (n) => n.kind === "task_overdue",
    )!;
    await applyAction(OWNER, overdue.id, { action: "dismiss" }, AT_SEVEN);

    const { socle, fetchImpl } = socleAnswering({ status: 202 });
    await runDigests({ socle, now: AT_SEVEN, ownerId: owner });
    expect(sentBodies(fetchImpl)[0]!.data).toEqual({
      dueCount: 1,
      comingUpCount: 0,
      missedRoutinesCount: 1,
      isTest: false,
    });
    // The bell still follows its in-app switches: maintenance yes, missed routines no.
    const kinds = (await listNotifications(OWNER, AT_SEVEN)).items.map(
      (n) => n.kind,
    );
    expect(kinds).toContain("maintenance_upcoming");
    expect(kinds).not.toContain("routine_missed");
  });

  it("sends nothing on an empty day", async () => {
    const { socle, fetchImpl } = socleAnswering();
    expect(await runDigests({ socle, now: AT_SEVEN, ownerId: owner })).toEqual({
      status: "done",
      outcome: "empty",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationDigest?.status,
    ).toBe("empty");
  });

  it("sends nothing on a second run the same day, and again the next morning with a new key", async () => {
    await seedDay();
    const { socle, fetchImpl } = socleAnswering();
    await runDigests({ socle, now: AT_SEVEN, ownerId: owner });
    const second = await runDigests({
      socle,
      now: new Date("2026-11-27T12:20:00Z"),
      ownerId: owner,
    });
    expect(second).toEqual({ status: "done", outcome: "already-sent" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await runDigests({
      socle,
      now: new Date("2026-11-28T12:05:00Z"),
      ownerId: owner,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [first, next] = sentKeys(fetchImpl);
    expect(next).not.toBe(first);
  });

  it("waits for sendAt, in the person's zone, and catches up for two hours", async () => {
    await seedDay();
    const { socle, fetchImpl } = socleAnswering();
    // 06:50 in Toronto is already 11:50 in UTC.
    expect(
      await runDigests({
        socle,
        now: new Date("2026-11-27T11:50:00Z"),
        ownerId: owner,
      }),
    ).toEqual({ status: "done", outcome: "not-due" });
    expect(
      await runDigests({
        socle,
        now: new Date("2026-11-27T14:10:00Z"),
        ownerId: owner,
      }),
    ).toEqual({ status: "done", outcome: "not-due" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await runDigests({
        socle,
        now: new Date("2026-11-27T13:40:00Z"),
        ownerId: owner,
      }),
    ).toEqual({ status: "done", outcome: "sent" });
  });

  it("retries with the same key after Socle was unavailable", async () => {
    await seedDay();
    const { socle, fetchImpl } = socleAnswering(
      { status: 503 },
      { status: 503 },
      { status: 202 },
    );
    expect(
      await runDigests({ socle, now: AT_SEVEN, ownerId: owner, sleep: noWait }),
    ).toEqual({ status: "done", outcome: "unavailable" });
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationDigest?.status,
    ).toBe("pending");
    expect(
      await runDigests({
        socle,
        now: new Date("2026-11-27T12:20:00Z"),
        ownerId: owner,
        sleep: noWait,
      }),
    ).toEqual({ status: "done", outcome: "sent" });
    const keys = sentKeys(fetchImpl);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("handles event-type-unknown while Socle doesn't have the event yet: refused, not retried today", async () => {
    await seedDay();
    const { socle, fetchImpl } = socleAnswering({
      status: 422,
      body: { type: "https://socle-services.app/problems/event-type-unknown" },
    });
    expect(await runDigests({ socle, now: AT_SEVEN, ownerId: owner })).toEqual({
      status: "done",
      outcome: "refused",
    });
    await runDigests({
      socle,
      now: new Date("2026-11-27T12:20:00Z"),
      ownerId: owner,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is opt-in, and only for the owner account", async () => {
    await seedDay();
    const { socle, fetchImpl } = socleAnswering();
    // Never saved: the defaults say "on", but nothing is emailed until the person saves.
    await userSettingsCollection.updateOne(
      { userId: OWNER },
      { $unset: { notifications: "" } },
    );
    expect(await runDigests({ socle, now: AT_SEVEN, ownerId: owner })).toEqual({
      status: "done",
      outcome: "digest-off",
    });
    // Clerk names no owner: nobody.
    expect(
      await runDigests({ socle, now: AT_SEVEN, ownerId: async () => null }),
    ).toEqual({ status: "off", reason: "no-owner-account" });
    // Someone else opted in, but they aren't the owner: never read, never sent.
    await seedSettings(OTHER, { notifications: SAVED });
    await runDigests({ socle, now: AT_SEVEN, ownerId: owner });
    expect(fetchImpl).not.toHaveBeenCalled();
    // And without Socle's address and key, nothing runs.
    expect(
      await runDigests({ socle: null, now: AT_SEVEN, ownerId: owner }),
    ).toEqual({ status: "off", reason: "socle-not-configured" });
  });

  it("logs statuses and counts only", async () => {
    await seedDay();
    const { socle } = socleAnswering({
      status: 422,
      body: {
        type: "https://socle-services.app/problems/data-invalid",
        detail: "x",
      },
    });
    await runDigests({ socle, now: AT_SEVEN, ownerId: owner });
    const all = logs.join("\n");
    expect(all).toContain('"status":422');
    for (const leak of [
      OWNER,
      OWNER_EMAIL,
      "File taxes",
      "data-invalid",
      "Toronto",
    ])
      expect(all).not.toContain(leak);
  });
});

describe("Send a test", () => {
  it("always sends, even on an empty day, marked as a test, to the account's own email", async () => {
    const { socle, fetchImpl } = socleAnswering(
      { status: 202 },
      { status: 202 },
    );
    expect(await sendTestDigest(OWNER, { socle, ownerId: owner })).toEqual({
      sentTo: OWNER_EMAIL,
    });
    const [body] = sentBodies(fetchImpl);
    expect(body).toMatchObject({
      recipient: { id: OWNER, email: OWNER_EMAIL },
      data: {
        dueCount: 0,
        comingUpCount: 0,
        missedRoutinesCount: 0,
        isTest: true,
      },
    });
    // Its own random key each time, never the day's record.
    await sendTestDigest(OWNER, { socle, ownerId: owner });
    const [a, b] = sentKeys(fetchImpl);
    expect(a).toMatch(UUID);
    expect(b).not.toBe(a);
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationDigest,
    ).toBeUndefined();
  });

  it("allows three an hour", async () => {
    const { socle } = socleAnswering();
    for (let i = 0; i < 3; i++)
      await sendTestDigest(OWNER, { socle, ownerId: owner });
    await expect(
      sendTestDigest(OWNER, { socle, ownerId: owner }),
    ).rejects.toMatchObject({ status: 429 });
    vi.setSystemTime(new Date(AT_SEVEN.getTime() + 61 * 60_000));
    await expect(
      sendTestDigest(OWNER, { socle, ownerId: owner, now: new Date() }),
    ).resolves.toEqual({ sentTo: OWNER_EMAIL });
  });

  it("is refused for anyone but the owner, without calling Socle", async () => {
    const { socle, fetchImpl } = socleAnswering();
    await expect(
      sendTestDigest(OTHER, { socle, ownerId: owner }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains event-type-unknown", async () => {
    const { socle } = socleAnswering({
      status: 422,
      body: { type: "https://socle-services.app/problems/event-type-unknown" },
    });
    await expect(
      sendTestDigest(OWNER, { socle, ownerId: owner }),
    ).rejects.toMatchObject({
      status: 503,
      message:
        "Socle doesn't know EisenQ's daily email yet, so nothing was sent.",
    });
  });

  it("through the route, without Socle's variables, answers { error } and calls nobody", async () => {
    const { POST } = await import("~/app/api/notifications/test-email/route");
    const res = await POST();
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({
      error: "Email isn't set up for EisenQ yet.",
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/notifications-digest", () => {
  const call = async (authorization?: string) => {
    const { GET } = await import("~/app/api/cron/notifications-digest/route");
    return GET(
      new Request("https://www.eisenq.app/api/cron/notifications-digest", {
        headers: authorization ? { authorization } : {},
      }),
    );
  };

  it("is not there without CRON_SECRET, and refuses a wrong secret", async () => {
    expect((await call("Bearer anything")).status).toBe(404);
    testEnv.CRON_SECRET = "a".repeat(48);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${"b".repeat(48)}`)).status).toBe(401);
  });

  it("with the secret but without Socle's variables, switches itself off and sends nothing", async () => {
    testEnv.CRON_SECRET = "a".repeat(48);
    const res = await call(`Bearer ${"a".repeat(48)}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      status: "off",
      reason: "socle-not-configured",
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("with everything set, sends the owner's digest through Socle", async () => {
    await seedDay();
    Object.assign(testEnv, {
      CRON_SECRET: "a".repeat(48),
      SOCLE_API_URL: "https://socle.test",
      SOCLE_API_KEY: "k",
    });
    vi.mocked(fetch).mockImplementation(
      async () => new Response("{}", { status: 202 }),
    );
    const res = await call(`Bearer ${"a".repeat(48)}`);
    expect(await json(res)).toEqual({ status: "done", outcome: "sent" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://socle.test/v1/notifications/events");
  });
});
