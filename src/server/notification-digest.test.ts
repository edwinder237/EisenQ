import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "~/lib/notifications/types";
import type * as McpSettingsModule from "~/server/mcp-settings";
import {
  RUN_BUDGET_MS,
  RUN_DEADLINE_MS,
  runDigests,
  sendTestDigest,
} from "~/server/notification-digest";
import { createSocleClient } from "~/server/socle";
import {
  clearNotificationData,
  deleteNotificationsFor,
} from "~/server/notification-deletion";
import {
  applyAction,
  listNotifications,
  saveChannelsCopy,
} from "~/server/notification-service";
import {
  checklistItemsCollection,
  maintenanceItemsCollection,
  notificationDeletionsCollection,
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

  describe("an account Clerk says it doesn't have (404)", () => {
    const GONE = "user_2goneGoneGoneGone000005";
    const at = (minutes: number) => new Date(AT_SEVEN.getTime() + minutes * 60_000);
    const theirs = () => userSettingsCollection.findOne({ userId: GONE });

    beforeEach(async () => {
      // A settings row with no copy reads as "bell on".
      await seedSettings(GONE);
      await overdueTask(GONE);
      await notificationStatesCollection.insertOne({ userId: GONE, id: "task_overdue:x", readAt: AT_SEVEN, updatedAt: AT_SEVEN });
      vi.mocked(clerkClient).mockResolvedValue(fakeClerk({ gone: [GONE] }) as never);
    });

    it("is only marked at the first 404, deleted at a 404 an hour later in a run that finds someone else, and never sent to", async () => {
      // Someone Clerk does find, due at 08:00: in the hour-later run.
      const FOUND = "user_2foundFoundFound00007";
      await seedSettings(FOUND, { notifications: { digest: { sendAt: "08:00" } } });
      await overdueTask(FOUND);
      const gone = () =>
        socle.calls
          .filter((c) => c.body.recipientId === GONE || (c.body.recipient as { id?: string } | undefined)?.id === GONE)
          .map((c) => [c.path, GONE]);
      expect(await run(at(0))).toMatchObject({
        outcomes: { "missing-in-clerk": 1, empty: 1 },
        clerkMissing: { marked: 1, deleted: 0, misconfigured: false },
      });
      expect((await theirs())?.clerkMissingSince).toEqual(at(0));
      expect((await record(GONE))?.status).toBe("pending");
      expect(socle.calls).toEqual([]);

      // Half an hour on: still within the hour, still nothing done.
      expect(await run(at(30))).toMatchObject({
        outcomes: { "missing-in-clerk": 1 },
        clerkMissing: { marked: 0, deleted: 0 },
      });
      expect(socle.calls).toEqual([]);
      expect(await notificationStatesCollection.countDocuments({ userId: GONE })).toBe(1);

      // An hour after the first 404: deleted, here and in Socle, and nothing else reached Socle.
      expect(await run(at(60))).toMatchObject({
        outcomes: { sent: 1, "missing-in-clerk": 1 },
        clerkMissing: { marked: 0, deleted: 1 },
      });
      expect(gone()).toEqual([["/recipients/delete", GONE]]);
      expect(await notificationStatesCollection.countDocuments({ userId: GONE })).toBe(0);
      expect((await theirs())?.notificationChannels).toMatchObject({ email: false, bell: false });
      expect((await theirs())?.notificationDigest).toBeUndefined();

      // From then on, they aren't read at all.
      expect(await run(new Date("2026-11-28T12:05:00Z"))).toMatchObject({ scanned: 2 });
      expect(gone()).toHaveLength(1);
      expect(logs.join("\n")).toContain('"event":"digest_clerk_missing","marked":1,"deleted":0');
      expect(logs.join("\n")).not.toContain(GONE);
    });

    it("deletes nobody with a Clerk key for the wrong instance: every look-up 404, twice, over an hour apart", async () => {
      // Two accounts due, and Clerk (another instance) has neither.
      await overdueTask(OWNER);
      vi.mocked(clerkClient).mockResolvedValue(fakeClerk({ gone: [OWNER, GONE] }) as never);
      expect(await run(at(0))).toMatchObject({
        outcomes: { "missing-in-clerk": 2 },
        clerkMissing: { marked: 2, deleted: 0, misconfigured: false },
      });
      expect(await run(at(70))).toMatchObject({
        outcomes: { "missing-in-clerk": 2 },
        clerkMissing: { marked: 0, deleted: 0, misconfigured: false },
      });
      // Nobody deleted, nothing sent, and the marks are kept.
      expect(socle.calls).toEqual([]);
      for (const id of [OWNER, GONE]) {
        const doc = await userSettingsCollection.findOne({ userId: id });
        expect(doc?.notificationsDeletedAt).toBeUndefined();
        expect(doc?.clerkMissingSince).toEqual(at(0));
        expect(await notificationStatesCollection.countDocuments({ userId: id })).toBe(id === GONE ? 1 : 0);
      }
      const all = logs.join("\n");
      expect(all.match(/digest_clerk_deletions_held/g)).toHaveLength(1);
      expect(all).toContain('"event":"digest_clerk_deletions_held","count":2');
      for (const id of [OWNER, GONE]) expect(all).not.toContain(id);

      // The key is fixed: Clerk finds the owner, so the real deletion goes through.
      vi.mocked(clerkClient).mockResolvedValue(fakeClerk({ gone: [GONE] }) as never);
      expect(await run(at(80))).toMatchObject({
        outcomes: { sent: 1, "missing-in-clerk": 1 },
        clerkMissing: { marked: 0, deleted: 1 },
      });
      expect(socle.to("/recipients/delete").map((c) => c.body.recipientId)).toEqual([GONE]);
      expect((await userSettingsCollection.findOne({ userId: OWNER }))?.clerkMissingSince).toBeUndefined();
    });

    it("has its mark cleared when Clerk finds the account again", async () => {
      await run(at(0));
      expect((await theirs())?.clerkMissingSince).toEqual(at(0));
      vi.mocked(clerkClient).mockResolvedValue(fakeClerk() as never);
      expect(await run(at(70))).toMatchObject({ outcomes: { sent: 1 } });
      expect((await theirs())?.clerkMissingSince).toBeUndefined();
      expect(socle.to("/recipients/delete")).toEqual([]);
    });

    it("isn't acted on when more than 5 people get a 404 in one run: Clerk looks misconfigured", async () => {
      const ids = [1, 2, 3, 4, 5].map((n) => `user_2manyManyMany0000${n}`);
      for (const id of ids) {
        await seedSettings(id, { clerkMissingSince: at(-120) });
        await overdueTask(id);
      }
      vi.mocked(clerkClient).mockResolvedValue(fakeClerk({ gone: [GONE, ...ids] }) as never);
      expect(await run(at(0))).toMatchObject({
        outcomes: { "missing-in-clerk": 6 },
        clerkMissing: { marked: 0, deleted: 0, misconfigured: true },
      });
      // Nobody marked, nobody deleted, nothing sent.
      expect((await theirs())?.clerkMissingSince).toBeUndefined();
      expect(socle.calls).toEqual([]);
      for (const id of ids)
        expect((await userSettingsCollection.findOne({ userId: id }))?.notificationsDeletedAt).toBeUndefined();
      const all = logs.join("\n");
      expect(all.match(/digest_clerk_misconfigured/g)).toHaveLength(1);
      expect(all).toContain('"event":"digest_clerk_misconfigured","count":6');
      for (const id of [GONE, ...ids]) expect(all).not.toContain(id);
    });
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

    // Socle gates too: its 409 is recorded as opted out for the day, with
    // nothing sent.
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
  });

  it("doesn't take Socle's 409 for the person's choices: the copy stays what Socle's look-up said, and they're read again", async () => {
    await seedDay();
    socle.setChoices(OWNER, { email: true });
    socle.answerNext("/events", {
      status: 409,
      body: { type: "https://socle-services.app/problems/recipient-opted-out" },
    });
    expect(await run()).toMatchObject({ outcomes: { "opted-out": 1 } });
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationChannels,
    ).toMatchObject({ email: true, bell: true });
    // The next day they're still in the job, without opening Settings.
    expect(await run(new Date("2026-11-28T12:05:00Z"))).toMatchObject({
      scanned: 1,
      outcomes: { sent: 1 },
    });
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

  describe("a retry sends the day's first body again", () => {
    it("after Socle failed and a task changed, with the first counts, and Socle takes it as new", async () => {
      await seedDay();
      socle.setChoices(OWNER, { email: true });
      socle.answerNext("/events", { status: 503 }, { status: 503 });
      expect(await run()).toMatchObject({ outcomes: { unavailable: 1 } });
      // A task changes before the next run.
      await overdueTask(OWNER, "Something new");
      expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
        outcomes: { sent: 1 },
      });
      const events = socle.events();
      expect(events.map((e) => e.status)).toEqual([503, 503, 202]);
      expect(new Set(events.map((e) => e.key)).size).toBe(1);
      expect(new Set(events.map((e) => e.raw)).size).toBe(1);
      expect(events[2]!.data).toMatchObject({ dueCount: 2 });
      // Kept with the day's record: counts only.
      expect(await record(OWNER)).toMatchObject({
        status: "sent",
        counts: { dueCount: 2, comingUpCount: 1, missedRoutinesCount: 0 },
      });
    });

    it("after an answer that was lost on the way, and Socle replays it", async () => {
      await seedDay();
      const send = socle.socle.sendDigestEvent.bind(socle.socle);
      // Socle accepts each one, and EisenQ never hears back.
      const sendSpy = vi
        .spyOn(socle.socle, "sendDigestEvent")
        .mockImplementation(async (event, call) => {
          await send(event, call);
          return { kind: "unreachable", reason: "timeout" };
        });
      expect(await run()).toMatchObject({ outcomes: { unavailable: 1 } });
      sendSpy.mockRestore();
      await overdueTask(OWNER, "Something new");
      expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
        outcomes: { sent: 1 },
      });
      const events = socle.events();
      expect(events.map((e) => e.status)).toEqual([202, 202, 202]);
      expect(new Set(events.map((e) => e.raw)).size).toBe(1);
    });

    it("but a new key, after Socle asked for the address, goes with fresh counts", async () => {
      await seedDay();
      // Socle's look-up still says email off; by the send, it's on.
      socle.setChoices(OWNER, { email: true });
      const off = { enabled: false, changedAt: null, changedVia: null };
      const on = { enabled: true, changedAt: null, changedVia: null };
      socle.answerNext("/preferences/lookup", {
        status: 200,
        body: { channels: { email: off, in_app: on } },
      });
      expect(await run()).toMatchObject({ outcomes: { unavailable: 1 } });
      expect((await record(OWNER))?.counts).toBeUndefined();
      await overdueTask(OWNER, "Something new");
      expect(await run(new Date("2026-11-27T12:20:00Z"))).toMatchObject({
        outcomes: { sent: 1 },
      });
      const [first, second] = socle.events();
      expect(first!.status).toBe(422);
      expect(second!.key).not.toBe(first!.key);
      expect(second).toMatchObject({
        status: 202,
        recipient: { email: OWNER_EMAIL },
        data: { dueCount: 3 },
      });
    });
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

  it("an account deleted while the run is on it isn't written back, sent to, or read again", async () => {
    await seedSettings(OTHER);
    await overdueTask(OTHER);
    await overdueTask(OWNER);
    const lookup = socle.socle.lookupPreferences.bind(socle.socle);
    vi.spyOn(socle.socle, "lookupPreferences").mockImplementation(async (id) => {
      // Clerk's event arrives just as Socle is asked about them.
      if (id === OTHER) await clearNotificationData(OTHER, AT_SEVEN);
      return lookup(id);
    });
    expect(await run()).toMatchObject({
      outcomes: { sent: 1, "account-deleted": 1 },
    });
    expect(socle.events().map((e) => e.recipient.id)).toEqual([OWNER]);
    const theirs = await userSettingsCollection.findOne({ userId: OTHER });
    expect(theirs?.notificationChannels).toMatchObject({ email: false, bell: false });
    expect(theirs?.notificationsDeletedAt).toEqual(AT_SEVEN);
    // The copy can't be revived by anyone else either.
    expect(await saveChannelsCopy(OTHER, { email: false, bell: true })).toBe(false);
    expect(
      (await userSettingsCollection.findOne({ userId: OTHER }))?.notificationChannels,
    ).toMatchObject({ bell: false });
    expect(await run(new Date("2026-11-28T12:05:00Z"))).toMatchObject({ scanned: 1 });
  });

  it("counts, without naming them, those with something to report whom the cap leaves past their window", async () => {
    const ids = [1, 2].map((n) => `user_2lateLateLate0000${n}`);
    await overdueTask(OWNER);
    for (const id of ids) {
      await seedSettings(id);
      await overdueTask(id);
    }
    // And one with nothing to report: it misses nothing, so it isn't counted.
    await seedSettings("user_2idleIdleIdle00003");
    // 08:50 in Toronto: 07:00's window closes at 09:00, before the 09:05 run.
    const late = await run(new Date("2026-11-27T13:50:00Z"), { maxPeople: 1 });
    expect(late).toMatchObject({ outcomes: { sent: 1 }, capped: true, windowMissed: 2 });
    const all = logs.join("\n");
    expect(all).toContain('"event":"digest_window_missed","count":2,"complete":true');
    for (const id of ids) expect(all).not.toContain(id);

    // Earlier in the window the next run still reaches them: nothing counted.
    logs.length = 0;
    const early = await run(new Date("2026-11-28T12:05:00Z"), { maxPeople: 1 });
    expect(early).toMatchObject({ capped: true, windowMissed: 0 });
    expect(logs.join("\n")).not.toContain("digest_window_missed");
  });

  it("counts one whose retry is waiting with its counts, even with nothing left to report", async () => {
    const WAITING = "user_2waitWaitWait00004";
    await overdueTask(OWNER);
    await seedSettings(WAITING, {
      notificationDigest: {
        day: "2026-11-27",
        key: "00000000-0000-4000-8000-000000000000",
        status: "pending",
        counts: { dueCount: 1, comingUpCount: 0, missedRoutinesCount: 0 },
      },
    });
    const late = await run(new Date("2026-11-27T13:50:00Z"), { maxPeople: 1 });
    expect(late).toMatchObject({ outcomes: { sent: 1 }, capped: true, windowMissed: 1 });
  });

  it("an account deleted while its event is on the way gets Socle's delete again, after the event", async () => {
    await seedSettings(OTHER);
    await overdueTask(OTHER);
    const send = socle.socle.sendDigestEvent.bind(socle.socle);
    const sendSpy = vi.spyOn(socle.socle, "sendDigestEvent").mockImplementation(async (event, call) => {
      // Clerk's event lands, and Socle's delete runs, just before this send reaches Socle.
      if (event.recipient.id === OTHER) await deleteNotificationsFor(OTHER, socle.socle, AT_SEVEN);
      return send(event, call);
    });
    await run();
    expect(socle.calls.filter((c) => c.body.recipientId === OTHER || (c.body.recipient as { id?: string } | undefined)?.id === OTHER).map((c) => c.path)).toEqual([
      "/preferences/lookup",
      "/recipients/delete",
      "/events",
    ]);
    // Back on the deletions list, so the stray event's traces go too.
    expect(await notificationDeletionsCollection.findOne({ userId: OTHER })).toMatchObject({ userId: OTHER });
    expect(logs.join("\n")).toContain('"event":"digest_sent_after_deletion"');
    expect(logs.join("\n")).not.toContain(OTHER);

    sendSpy.mockRestore();
    expect((await run(new Date("2026-11-27T12:20:00Z"))).deletions).toEqual({ done: 1, pending: 0 });
    expect(socle.to("/recipients/delete").map((c) => c.body.recipientId)).toEqual([OTHER, OTHER]);
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
    const claimSpy = vi.spyOn(userSettingsCollection, "updateOne").mockImplementation(
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
    claimSpy.mockRestore();
    expect(await run(new Date("2026-11-27T12:35:00Z"))).toMatchObject({
      outcomes: { "already-sent": 2, sent: 1 },
    });
    expect(socle.events().map((e) => e.recipient.id).sort()).toEqual(
      [OWNER, BAD, OTHER].sort(),
    );
  });

  describe("one deadline for the whole run", () => {
    const clock = { t: 0 };
    const elapsed = () => clock.t;
    beforeEach(() => {
      clock.t = 0;
    });

    it("a Clerk call that hangs is cut off by the time left, and the day stays open", async () => {
      await seedDay();
      const started = performance.now();
      const result = await run(AT_SEVEN, {
        elapsed,
        addressFor: () => {
          clock.t = RUN_DEADLINE_MS - 300;
          return new Promise<never>(() => undefined);
        },
      });
      expect(performance.now() - started).toBeLessThan(3000);
      expect(result).toMatchObject({ status: "done", outcomes: { unavailable: 1 } });
      expect((await record(OWNER))?.status).toBe("pending");
      expect(socle.calls).toEqual([]);
    });

    it("a Socle call that hangs is aborted when the run's time is up", async () => {
      await seedDay();
      const stalled = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
          }),
      );
      const started = performance.now();
      const result = await runDigests({
        socle: createSocleClient({ apiUrl: "https://socle.test", apiKey: "k" }, stalled),
        now: AT_SEVEN,
        sleep: noWait,
        elapsed,
        addressFor: async () => {
          clock.t = RUN_DEADLINE_MS - 600;
          return { kind: "verified", email: OWNER_EMAIL };
        },
      });
      expect(performance.now() - started).toBeLessThan(3000);
      expect(stalled).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ outcomes: { unavailable: 1 } });
      expect((await record(OWNER))?.status).toBe("pending");
    });

    it("starts no call with under half a second left, and nobody new after the start budget", async () => {
      await seedDay();
      expect(
        await run(AT_SEVEN, {
          elapsed,
          addressFor: async () => {
            clock.t = RUN_DEADLINE_MS - 100;
            return { kind: "verified", email: OWNER_EMAIL };
          },
        }),
      ).toMatchObject({ outcomes: { unavailable: 1 } });
      expect(socle.calls).toEqual([]);
      expect(logs.join("\n")).toContain('"event":"digest_out_of_time"');

      clock.t = RUN_BUDGET_MS + 1;
      expect(await run(new Date("2026-11-27T12:20:00Z"), { elapsed })).toMatchObject({
        scanned: 0,
        capped: true,
      });
    });
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

  it("doesn't take Socle's 409 for the person's choices: the copy stays what Socle's look-up said", async () => {
    socle.setChoices(OWNER, { email: true });
    socle.answerNext("/events", {
      status: 409,
      body: { type: "https://socle-services.app/problems/recipient-opted-out" },
    });
    await expect(
      sendTestDigest(OWNER, { socle: socle.socle }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Your daily email is off, so nothing was sent.",
    });
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationChannels,
    ).toMatchObject({ email: true, bell: true });
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
