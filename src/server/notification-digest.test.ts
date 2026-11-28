import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "~/lib/notifications/types";
import type * as McpSettingsModule from "~/server/mcp-settings";
import {
  runDigests,
  sendTestDigest,
} from "~/server/notification-digest";
import { applyAction, listNotifications } from "~/server/notification-service";
import {
  checklistItemsCollection,
  maintenanceItemsCollection,
  notificationStatesCollection,
  resetFakeDb,
  tasksCollection,
  userSettingsCollection,
} from "~/test/fake-db";
import { fakeSocle, type FakeSocle } from "~/test/fake-socle";
import {
  OTHER,
  OTHER_EMAIL,
  OWNER,
  OWNER_EMAIL,
  emailOf,
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
// The AI connector's bookkeeping is stubbed; the MCP handler, the add_task
// tool and createTask are real.
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

// Friday 2026-11-27, 07:05 in Toronto: just after the default 07:00.
const AT_SEVEN = new Date("2026-11-27T12:05:00Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SAVED: NotificationPreferences = DEFAULT_NOTIFICATION_PREFERENCES;
const noWait = async () => undefined;

/** One overdue task, one due today, maintenance coming up, a missed routine. */
async function seedDay(userId = OWNER) {
  await tasksCollection.insertOne({
    title: "File taxes",
    quadrant: "urgent-important",
    priority: "high",
    status: "pending",
    userId,
    dueDate: new Date("2026-11-25T14:00:00Z"),
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
  });
  await tasksCollection.insertOne({
    title: "Call the bank",
    quadrant: "important-not-urgent",
    priority: "medium",
    status: "pending",
    userId,
    dueDate: new Date("2026-11-27T20:00:00Z"),
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
  });
  await maintenanceItemsCollection.insertOne({
    title: "Furnace filter",
    intervalDays: 90,
    nextDueDate: "2026-11-28",
    userId,
    createdAt: AT_SEVEN,
    updatedAt: AT_SEVEN,
  });
  await checklistItemsCollection.insertOne({
    title: "Water plants",
    frequency: "weekly",
    daysOfWeek: [3],
    completedDates: [],
    sortOrder: 0,
    userId,
    createdAt: new Date("2026-11-20T12:00:00Z"),
    updatedAt: new Date("2026-11-20T12:00:00Z"),
  });
}

async function overdueTask(userId: string, title = "Overdue thing") {
  await tasksCollection.insertOne({
    title,
    quadrant: "urgent-important",
    priority: "high",
    status: "pending",
    userId,
    dueDate: new Date("2026-11-25T14:00:00Z"),
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
  });
}

const record = async (userId: string) =>
  (await userSettingsCollection.findOne({ userId }))?.notificationDigest;

let socle: FakeSocle;
let logs: string[];

beforeEach(async () => {
  resetFakeDb();
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
  socle = fakeSocle();
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

const run = (now = AT_SEVEN, extra: Partial<Parameters<typeof runDigests>[0]> = {}) =>
  runDigests({ socle: socle.socle, now, sleep: noWait, ...extra });

describe("the daily summary, for every account", () => {
  it("sends counts only, once sendAt has come, to the account's own verified email", async () => {
    await seedDay();
    socle.setChoices(OWNER, { email: true });
    expect(await run()).toMatchObject({
      status: "done",
      scanned: 1,
      outcomes: { sent: 1 },
      capped: false,
    });

    const [event] = socle.events();
    expect(event).toMatchObject({
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
    for (const leak of [
      "File taxes",
      "Call the bank",
      "Furnace",
      "Toronto",
      "07:00",
      "2026-11",
    ])
      expect(event!.raw).not.toContain(leak);

    // Socle was asked first, server to server, with the ID in the body.
    expect(socle.calls.map((c) => c.path)).toEqual([
      "/preferences/lookup",
      "/events",
    ]);
    expect(socle.calls[0]!.body).toEqual({ recipientId: OWNER });
    // The key is the random UUID kept with today's sent-today record.
    const today = await record(OWNER);
    expect(today).toMatchObject({ day: "2026-11-27", status: "sent" });
    expect(today?.key).toMatch(UUID);
    expect(event!.key).toBe(today?.key);
  });

  it("a second account gets its own summary at its own email, with its own counts and key", async () => {
    await seedDay(OWNER);
    await seedSettings(OTHER);
    await overdueTask(OTHER, "Their thing");
    socle.setChoices(OWNER, { email: true });
    socle.setChoices(OTHER, { email: true });

    expect(await run()).toMatchObject({ scanned: 2, outcomes: { sent: 2 } });
    const events = socle.events();
    expect(events.map((e) => e.recipient)).toEqual([
      { id: OWNER, email: OWNER_EMAIL, locale: "fr" },
      { id: OTHER, email: OTHER_EMAIL, locale: "fr" },
    ]);
    expect(events.map((e) => e.data.dueCount)).toEqual([2, 1]);
    expect(events[0]!.key).not.toBe(events[1]!.key);
    expect(events[1]!.key).toBe((await record(OTHER))?.key);
    // Each was asked about with its own ID only.
    expect(socle.to("/preferences/lookup").map((c) => c.body)).toEqual([
      { recipientId: OWNER },
      { recipientId: OTHER },
    ]);
  });

  it("an account with email off gets no email: its summary goes to the bell only, with no address", async () => {
    await seedDay();
    const clerk = fakeClerk();
    vi.mocked(clerkClient).mockResolvedValue(clerk as never);
    // Socle's default: email off, the bell on.
    expect(await run()).toMatchObject({ outcomes: { sent: 1 } });
    const [event] = socle.events();
    expect(event!.recipient).toEqual({ id: OWNER });
    expect(event!.raw).not.toContain(OWNER_EMAIL);
    // Clerk is asked once, that the account still exists; its address stays out.
    expect(clerk.users.getUser).toHaveBeenCalledTimes(1);
  });

  it("an account deleted in Clerk without EisenQ hearing of it is deleted, not sent to", async () => {
    // A settings row with no copy reads as "bell on".
    const GONE = "user_2goneGoneGoneGone000005";
    await seedSettings(GONE);
    await overdueTask(GONE);
    await notificationStatesCollection.insertOne({ userId: GONE, id: "task_overdue:x", readAt: AT_SEVEN, updatedAt: AT_SEVEN });
    vi.mocked(clerkClient).mockResolvedValue(fakeClerk({ gone: [GONE] }) as never);

    expect(await run()).toMatchObject({ outcomes: { "account-deleted": 1, empty: 1 } });
    // Nothing reached Socle for them but the deletion.
    expect(socle.calls.map((c) => [c.path, c.body.recipientId])).toEqual([
      ["/recipients/delete", GONE],
    ]);
    expect(await notificationStatesCollection.countDocuments({ userId: GONE })).toBe(0);
    const theirs = await userSettingsCollection.findOne({ userId: GONE });
    expect(theirs?.notificationChannels).toMatchObject({ email: false, bell: false });
    expect(theirs?.notificationDigest).toBeUndefined();

    // From then on, they aren't read at all.
    expect(await run(new Date("2026-11-28T12:05:00Z"))).toMatchObject({ scanned: 1 });
    expect(socle.calls).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(GONE);
  });

  it("one that turned email off from an email's link gets no email the next day", async () => {
    await seedDay();
    socle.setChoices(OWNER, { email: true });
    await run();
    expect(socle.events()[0]!.recipient.email).toBe(OWNER_EMAIL);

    // The footer link, in Socle: EisenQ's copy still says on.
    socle.setChoices(OWNER, { email: false }, "unsubscribe_link");
    await run(new Date("2026-11-28T12:05:00Z"));
    expect(socle.events()[1]!.recipient).toEqual({ id: OWNER });
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationChannels,
    ).toMatchObject({ email: false, bell: true });
  });

  it("with email and the bell both off, sends nothing, and records Socle's own 409 the same way", async () => {
    await seedDay();
    socle.setChoices(OWNER, { email: false, bell: false });
    expect(await run()).toMatchObject({ outcomes: { "opted-out": 1 } });
    expect(socle.events()).toEqual([]);
    expect((await record(OWNER))?.status).toBe("opted-out");

    // The next day the copy says both off: the account isn't even read.
    expect(await run(new Date("2026-11-28T12:05:00Z"))).toMatchObject({
      scanned: 0,
    });

    // Socle gates too: its 409 is recorded as opted out, with nothing sent.
    await seedSettings(OTHER);
    await overdueTask(OTHER);
    socle.answerNext("/events", {
      status: 409,
      body: { type: "https://socle-services.app/problems/recipient-opted-out" },
    });
    expect(await run(new Date("2026-11-28T12:05:00Z"))).toMatchObject({
      outcomes: { "opted-out": 1 },
    });
    expect((await record(OTHER))?.status).toBe("opted-out");
    expect(
      (await userSettingsCollection.findOne({ userId: OTHER }))
        ?.notificationChannels,
    ).toMatchObject({ email: false, bell: false });
  });

  it("an unverified email gets nothing, and the skip is logged with no address", async () => {
    await seedDay();
    socle.setChoices(OWNER, { email: true });
    vi.mocked(clerkClient).mockResolvedValue(
      fakeClerk({ unverified: [OWNER] }) as never,
    );
    expect(await run()).toMatchObject({ outcomes: { "no-email": 1 } });
    expect(socle.events()).toEqual([]);
    expect((await record(OWNER))?.status).toBe("no-email");
    const all = logs.join("\n");
    expect(all).toContain('"event":"digest_skipped"');
    expect(all).toContain('"reason":"email-unverified"');
    for (const leak of [OWNER, OWNER_EMAIL]) expect(all).not.toContain(leak);
  });

  it("follows the email switches, not the in-app ones, and leaves hidden items out", async () => {
    await seedDay();
    socle.setChoices(OWNER, { email: true });
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

    await run();
    expect(socle.events()[0]!.data).toEqual({
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

  it("sends nothing on an empty day, and doesn't ask Socle", async () => {
    expect(await run()).toMatchObject({ outcomes: { empty: 1 } });
    expect(socle.calls).toEqual([]);
    expect((await record(OWNER))?.status).toBe("empty");
  });

  it("sends nothing on a second run the same day, and again the next morning with a new key", async () => {
    await seedDay();
    await run();
    expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
      outcomes: { "already-sent": 1 },
    });
    expect(socle.events()).toHaveLength(1);

    await run(new Date("2026-11-28T12:05:00Z"));
    const [first, next] = socle.events();
    expect(next!.key).not.toBe(first!.key);
  });

  it("waits for sendAt, in the person's zone, and catches up for two hours", async () => {
    await seedDay();
    // 06:50 in Toronto is already 11:50 in UTC.
    expect(await run(new Date("2026-11-27T11:50:00Z"))).toMatchObject({
      outcomes: { "not-due": 1 },
    });
    expect(await run(new Date("2026-11-27T14:10:00Z"))).toMatchObject({
      outcomes: { "not-due": 1 },
    });
    expect(socle.calls).toEqual([]);
    expect(await run(new Date("2026-11-27T13:40:00Z"))).toMatchObject({
      outcomes: { sent: 1 },
    });
  });

  it("retries with the same key after Socle was unavailable", async () => {
    await seedDay();
    socle.answerNext("/events", { status: 503 }, { status: 503 });
    expect(await run()).toMatchObject({ outcomes: { unavailable: 1 } });
    expect((await record(OWNER))?.status).toBe("pending");
    expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
      outcomes: { sent: 1 },
    });
    const keys = socle.events().map((e) => e.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("treats every 5xx and a 429 from Socle as worth a retry with the same key, never as a refusal", async () => {
    for (const [i, status] of [500, 502, 504, 429].entries()) {
      resetFakeDb();
      await seedSettings(OWNER, { notifications: SAVED });
      await seedDay();
      socle.answerNext("/events", { status }, { status });
      const day = new Date(AT_SEVEN.getTime() + i * 86_400_000);
      expect(await run(day)).toMatchObject({ outcomes: { unavailable: 1 } });
      expect((await record(OWNER))?.status).toBe("pending");
      // The next run, same window: sent, under the same key.
      expect(await run(new Date(day.getTime() + 15 * 60_000))).toMatchObject({
        outcomes: { sent: 1 },
      });
      const keys = socle.events().slice(-3).map((e) => e.key);
      expect(new Set(keys).size).toBe(1);
    }
    // A 4xx refusal is still final for the day.
    resetFakeDb();
    await seedSettings(OWNER, { notifications: SAVED });
    await seedDay();
    socle.answerNext("/events", { status: 422, body: { type: "https://socle-services.app/problems/data-invalid" } });
    expect(await run(new Date("2026-12-05T12:05:00Z"))).toMatchObject({ outcomes: { refused: 1 } });
  });

  it("retries the next run when Socle can't say what the person has on", async () => {
    await seedDay();
    socle.answerNext("/preferences/lookup", { status: 503 });
    expect(await run()).toMatchObject({ outcomes: { unavailable: 1 } });
    expect(socle.events()).toEqual([]);
    expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
      outcomes: { sent: 1 },
    });
  });

  it("handles event-type-unknown while Socle doesn't have the event yet: refused, not retried today", async () => {
    await seedDay();
    socle.answerNext("/events", {
      status: 422,
      body: { type: "https://socle-services.app/problems/event-type-unknown" },
    });
    expect(await run()).toMatchObject({ outcomes: { refused: 1 } });
    await run(new Date("2026-11-27T12:20:00Z"));
    expect(socle.events()).toHaveLength(1);
  });

  it("pages through every account, stops at its cap, and the next run carries on", async () => {
    const ids = [1, 2, 3, 4].map((n) => `user_2pagePagePage0000${n}`);
    for (const id of [OWNER, ...ids]) {
      if (id !== OWNER) await seedSettings(id);
      await overdueTask(id);
    }
    const first = await run(AT_SEVEN, { pageSize: 2, maxPeople: 3 });
    expect(first).toMatchObject({ scanned: 3, outcomes: { sent: 3 }, capped: true });
    const second = await run(new Date("2026-11-27T12:20:00Z"), {
      pageSize: 2,
      maxPeople: 3,
    });
    expect(second).toMatchObject({
      scanned: 5,
      outcomes: { "already-sent": 3, sent: 2 },
      capped: false,
    });
    expect(socle.events().map((e) => e.recipient.id).sort()).toEqual(
      [OWNER, ...ids].sort(),
    );
    // And a run out of time starts nobody new.
    expect(
      await run(new Date("2026-11-28T12:05:00Z"), { elapsed: () => 60_000 }),
    ).toMatchObject({ scanned: 0, capped: true });
  });

  it("carries on past one person's error: their day stays open for the next run, the others are sent", async () => {
    const BAD = "user_2badBadBadBadBad0000004";
    await overdueTask(OWNER);
    for (const id of [BAD, OTHER]) {
      await seedSettings(id);
      await overdueTask(id);
    }
    const find = tasksCollection.find.bind(tasksCollection);
    const spy = vi
      .spyOn(tasksCollection, "find")
      .mockImplementation((filter = {}, options) => {
        if (filter.userId === BAD) throw new Error("boom");
        return find(filter, options);
      });
    expect(await run()).toMatchObject({
      status: "done",
      scanned: 3,
      outcomes: { sent: 2, unavailable: 1 },
    });
    expect((await record(BAD))?.status).toBe("pending");
    expect(logs.join("\n")).toContain('"event":"digest_person_failed"');
    expect(logs.join("\n")).not.toContain(BAD);

    // And an error before their day is claimed: counted, and the run goes on.
    spy.mockRestore();
    const updateOne = userSettingsCollection.updateOne.bind(userSettingsCollection);
    vi.spyOn(userSettingsCollection, "updateOne").mockImplementation(
      (filter, update, options) => {
        if (filter.userId === BAD && "notificationDigest.day" in filter)
          throw new Error("boom");
        return updateOne(filter, update, options);
      },
    );
    expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
      status: "done",
      outcomes: { "already-sent": 2, unavailable: 1 },
    });
    vi.mocked(userSettingsCollection.updateOne).mockRestore();
    expect(await run(new Date("2026-11-27T12:35:00Z"))).toMatchObject({
      outcomes: { "already-sent": 2, sent: 1 },
    });
    expect(socle.events().map((e) => e.recipient.id).sort()).toEqual(
      [OWNER, BAD, OTHER].sort(),
    );
  });

  it("still counts a task created over MCP, for the account that created it", async () => {
    await seedSettings(OTHER);
    socle.setChoices(OTHER, { email: true });
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
      OTHER,
    );
    expect(res.status).toBe(200);
    expect(
      (await tasksCollection.findOne({ userId: OTHER, title: "Renew passport" }))
        ?.source,
    ).toMatchObject({ kind: "agent" });

    await run();
    const theirs = socle.events().find((e) => e.recipient.id === OTHER);
    expect(theirs).toMatchObject({
      recipient: { id: OTHER, email: OTHER_EMAIL },
      data: { dueCount: 1, comingUpCount: 0, missedRoutinesCount: 0 },
    });
    expect(theirs!.raw).not.toContain("Renew passport");
    // The owner has nothing due: no summary for them.
    expect(socle.events().some((e) => e.recipient.id === OWNER)).toBe(false);
  });

  it("is off without Socle's address and key", async () => {
    await seedDay();
    expect(await runDigests({ socle: null, now: AT_SEVEN })).toEqual({
      status: "off",
      reason: "socle-not-configured",
    });
  });

  it("logs statuses and counts only", async () => {
    await seedDay();
    await seedSettings(OTHER);
    await overdueTask(OTHER);
    socle.setChoices(OWNER, { email: true });
    socle.answerNext("/events", {
      status: 422,
      body: {
        type: "https://socle-services.app/problems/data-invalid",
        detail: "x",
      },
    });
    await run();
    const all = logs.join("\n");
    expect(all).toContain('"status":422');
    expect(all).toContain('"event":"digest_run"');
    for (const leak of [
      OWNER,
      OTHER,
      OWNER_EMAIL,
      OTHER_EMAIL,
      "File taxes",
      "data-invalid",
      "Toronto",
    ])
      expect(all).not.toContain(leak);
  });
});

describe("Send a test", () => {
  it("any account with email on, to its own verified email, even on an empty day, marked as a test", async () => {
    await seedSettings(OTHER);
    socle.setChoices(OTHER, { email: true });
    expect(await sendTestDigest(OTHER, { socle: socle.socle })).toEqual({
      sentTo: OTHER_EMAIL,
    });
    const [event] = socle.events();
    expect(event).toMatchObject({
      recipient: { id: OTHER, email: OTHER_EMAIL },
      data: {
        dueCount: 0,
        comingUpCount: 0,
        missedRoutinesCount: 0,
        isTest: true,
      },
    });
    // Its own random key each time, never the day's record.
    await sendTestDigest(OTHER, { socle: socle.socle });
    const [a, b] = socle.events().map((e) => e.key);
    expect(a).toMatch(UUID);
    expect(b).not.toBe(a);
    expect(await record(OTHER)).toBeUndefined();
  });

  it("works only while email is on in Socle", async () => {
    await expect(
      sendTestDigest(OWNER, { socle: socle.socle }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Turn the daily email on and save first.",
    });
    expect(socle.events()).toEqual([]);
  });

  it("never goes to an unverified address", async () => {
    socle.setChoices(OWNER, { email: true });
    vi.mocked(clerkClient).mockResolvedValue(
      fakeClerk({ unverified: [OWNER] }) as never,
    );
    await expect(
      sendTestDigest(OWNER, { socle: socle.socle }),
    ).rejects.toMatchObject({ status: 400 });
    expect(socle.events()).toEqual([]);
  });

  it("allows three a day per person, counted in EisenQ's database", async () => {
    await seedSettings(OTHER);
    socle.setChoices(OWNER, { email: true });
    socle.setChoices(OTHER, { email: true });
    for (let i = 0; i < 3; i++)
      await sendTestDigest(OWNER, { socle: socle.socle });
    await expect(
      sendTestDigest(OWNER, { socle: socle.socle }),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationTests,
    ).toEqual({ day: "2026-11-27", count: 3 });
    // Someone else's count is their own.
    await expect(
      sendTestDigest(OTHER, { socle: socle.socle }),
    ).resolves.toEqual({ sentTo: emailOf(OTHER) });
    // Late on the same local day, still three; after midnight in Toronto, again.
    await expect(
      sendTestDigest(OWNER, {
        socle: socle.socle,
        now: new Date("2026-11-28T04:30:00Z"),
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      sendTestDigest(OWNER, {
        socle: socle.socle,
        now: new Date("2026-11-28T05:30:00Z"),
      }),
    ).resolves.toEqual({ sentTo: OWNER_EMAIL });
    expect(socle.events()).toHaveLength(5);
  });

  it("explains event-type-unknown", async () => {
    socle.setChoices(OWNER, { email: true });
    socle.answerNext("/events", {
      status: 422,
      body: { type: "https://socle-services.app/problems/event-type-unknown" },
    });
    await expect(
      sendTestDigest(OWNER, { socle: socle.socle }),
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

  it("with everything set, sends each account's summary through Socle", async () => {
    await seedDay();
    Object.assign(testEnv, {
      CRON_SECRET: "a".repeat(48),
      SOCLE_API_URL: "https://socle.test",
      SOCLE_API_KEY: "k",
    });
    socle.setChoices(OWNER, { email: true });
    vi.stubGlobal("fetch", socle.fetchImpl);
    const res = await call(`Bearer ${"a".repeat(48)}`);
    expect(await json(res)).toMatchObject({
      status: "done",
      scanned: 1,
      outcomes: { sent: 1 },
    });
    expect(socle.calls.map((c) => c.url)).toEqual([
      "https://socle.test/v1/notifications/preferences/lookup",
      "https://socle.test/v1/notifications/events",
    ]);
  });
});
