import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { runDigests } from "~/server/notification-digest";
import {
  notificationDeletionsCollection,
  notificationStatesCollection,
  resetFakeDb,
  tasksCollection,
  userSettingsCollection,
} from "~/test/fake-db";
import { fakeSocle, type FakeSocle } from "~/test/fake-socle";
import { OTHER, OWNER, fakeClerk, json, seedSettings } from "~/test/helpers";

// A deleted account (legal's deletion rule): Clerk's signed "user.deleted"
// event clears EisenQ's own notification rows and calls Socle's
// recipients/delete; until Socle confirms, the daily job retries it.

const SECRET = `whsec_${randomBytes(32).toString("base64")}`;
const testEnv = vi.hoisted(() => ({
  SOCLE_API_URL: "https://socle.test" as string | undefined,
  SOCLE_API_KEY: "k" as string | undefined,
  CLERK_WEBHOOK_SIGNING_SECRET: undefined as string | undefined,
}));

vi.mock("~/server/db", () => import("~/test/fake-db"));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn() }));
vi.mock("~/env", () => ({ env: testEnv }));

const NOW = new Date("2026-11-27T12:05:00Z");

/** A request signed as Clerk's webhooks are (Standard Webhooks, via Svix). */
function signed(payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new NextRequest("https://www.eisenq.app/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

const deleted = (id: string) => ({
  type: "user.deleted",
  object: "event",
  data: { id, object: "user", deleted: true },
});

async function post(req: NextRequest) {
  const { POST } = await import("~/app/api/webhooks/clerk/route");
  return POST(req);
}

let socle: FakeSocle;
let logs: string[];

async function seedPerson(userId: string) {
  await seedSettings(userId, {
    notifications: { digest: { sendAt: "07:00" } },
    notificationChannels: { email: true, bell: true, checkedAt: NOW },
    notificationDigest: { day: "2026-11-26", key: "k", status: "sent" },
    notificationTests: { day: "2026-11-27", count: 1 },
    geminiApiKeyEnc: "kept",
  });
  await notificationStatesCollection.insertOne({
    userId,
    id: "task_overdue:abc",
    readAt: NOW,
    updatedAt: NOW,
  });
  await tasksCollection.insertOne({
    title: "Overdue thing",
    quadrant: "urgent-important",
    priority: "high",
    status: "pending",
    userId,
    dueDate: new Date("2026-11-25T14:00:00Z"),
    createdAt: new Date("2026-11-01T12:00:00Z"),
    updatedAt: new Date("2026-11-01T12:00:00Z"),
  });
}

beforeEach(async () => {
  resetFakeDb();
  testEnv.CLERK_WEBHOOK_SIGNING_SECRET = SECRET;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(clerkClient).mockResolvedValue(fakeClerk() as never);
  socle = fakeSocle();
  vi.stubGlobal("fetch", socle.fetchImpl);
  await seedPerson(OWNER);
  await seedPerson(OTHER);
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

describe("POST /api/webhooks/clerk, user.deleted", () => {
  it("calls Socle's delete for that account and clears EisenQ's own notification rows", async () => {
    socle.setChoices(OTHER, { email: true });
    const res = await post(signed(deleted(OTHER)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(socle.to("/recipients/delete")).toHaveLength(1);
    expect(socle.to("/recipients/delete")[0]).toMatchObject({
      url: "https://socle.test/v1/notifications/recipients/delete",
      method: "POST",
      body: { recipientId: OTHER },
    });
    expect(socle.calls).toHaveLength(1);

    // Its rows are gone, with both switches off so nothing is ever sent again.
    expect(
      await notificationStatesCollection.countDocuments({ userId: OTHER }),
    ).toBe(0);
    const theirs = await userSettingsCollection.findOne({ userId: OTHER });
    expect(theirs?.notifications).toBeUndefined();
    expect(theirs?.notificationDigest).toBeUndefined();
    expect(theirs?.notificationTests).toBeUndefined();
    expect(theirs?.notificationChannels).toMatchObject({
      email: false,
      bell: false,
    });
    // Settings that aren't notifications' are left as they are.
    expect(theirs?.geminiApiKeyEnc).toBe("kept");
    expect(await notificationDeletionsCollection.countDocuments({})).toBe(0);

    // Nobody else's.
    expect(
      await notificationStatesCollection.countDocuments({ userId: OWNER }),
    ).toBe(1);
    expect(
      (await userSettingsCollection.findOne({ userId: OWNER }))
        ?.notificationChannels,
    ).toMatchObject({ email: true, bell: true });

    // The daily job then never sends for that ID.
    await runDigests({ socle: socle.socle, now: NOW, sleep: async () => undefined });
    expect(socle.events().map((e) => e.recipient.id)).toEqual([OWNER]);

    for (const leak of [OTHER, "other@example.com"])
      expect(logs.join("\n")).not.toContain(leak);
  });

  it("refuses an event without Clerk's signature, and touches nothing", async () => {
    const forged = signed(deleted(OTHER), `whsec_${randomBytes(32).toString("base64")}`);
    const res = await post(forged);
    expect(res.status).toBe(400);
    expect(socle.calls).toEqual([]);
    expect(
      await notificationStatesCollection.countDocuments({ userId: OTHER }),
    ).toBe(1);

    const unsigned = new NextRequest("https://www.eisenq.app/api/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deleted(OTHER)),
    });
    expect((await post(unsigned)).status).toBe(400);
    expect(socle.calls).toEqual([]);
  });

  it("isn't there without CLERK_WEBHOOK_SIGNING_SECRET", async () => {
    testEnv.CLERK_WEBHOOK_SIGNING_SECRET = undefined;
    expect((await post(signed(deleted(OTHER)))).status).toBe(404);
    expect(socle.calls).toEqual([]);
  });

  it("acknowledges other events and leaves everything alone", async () => {
    const res = await post(
      signed({ type: "user.updated", object: "event", data: { id: OTHER } }),
    );
    expect(res.status).toBe(200);
    expect(socle.calls).toEqual([]);
    expect(
      await notificationStatesCollection.countDocuments({ userId: OTHER }),
    ).toBe(1);
  });

  it("keeps only the ID when Socle can't confirm, and the daily job retries until it does", async () => {
    socle.answerNext("/recipients/delete", { status: 503 });
    expect((await post(signed(deleted(OTHER)))).status).toBe(200);
    // EisenQ's own rows are already gone.
    expect(
      await notificationStatesCollection.countDocuments({ userId: OTHER }),
    ).toBe(0);
    const waiting = await notificationDeletionsCollection.find({}).toArray();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ userId: OTHER, attempts: 1 });
    expect(Object.keys(waiting[0]!).sort()).toEqual(
      ["_id", "attempts", "lastTriedAt", "since", "userId"].sort(),
    );

    // Still down at the next run: kept, one more attempt.
    socle.answerNext("/recipients/delete", { status: 503 });
    const first = await runDigests({ socle: socle.socle, now: NOW, sleep: async () => undefined });
    expect(first.deletions).toEqual({ done: 0, pending: 1 });
    expect((await notificationDeletionsCollection.findOne({ userId: OTHER }))?.attempts).toBe(2);

    // Then Socle answers 204: done, and the ID goes.
    const second = await runDigests({
      socle: socle.socle,
      now: new Date("2026-11-27T12:20:00Z"),
      sleep: async () => undefined,
    });
    expect(second.deletions).toEqual({ done: 1, pending: 0 });
    expect(await notificationDeletionsCollection.countDocuments({})).toBe(0);
    expect(
      socle.to("/recipients/delete").map((c) => c.body.recipientId),
    ).toEqual([OTHER, OTHER, OTHER]);
    expect(logs.join("\n")).not.toContain(OTHER);
  });

  it("answers the result as JSON with nothing about the person", async () => {
    const res = await post(signed(deleted(OTHER)));
    expect(await json(res)).toEqual({ received: true });
  });
});
