import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { resetFakeDb, userSettingsCollection } from "~/test/fake-db";
import { fakeSocle, type FakeSocle } from "~/test/fake-socle";
import { OTHER, OWNER, json, seedSettings } from "~/test/helpers";

// GET /api/notifications/bell-session: the signed-in person's own bell
// session from Socle, and nobody else's.

const testEnv = vi.hoisted(() => ({
  SOCLE_API_URL: "https://socle.test" as string | undefined,
  SOCLE_API_KEY: "k" as string | undefined,
}));

vi.mock("~/server/db", () => import("~/test/fake-db"));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(), clerkClient: vi.fn() }));
vi.mock("~/env", () => ({ env: testEnv }));

type Answer = { session: string | null; expiresAt?: string; error?: string };

async function get(signedIn: string | null) {
  vi.mocked(auth).mockResolvedValue({ userId: signedIn } as never);
  const { GET } = await import("~/app/api/notifications/bell-session/route");
  return GET();
}

/** Whose bell the fake Socle's opaque session opens. */
const whose = (session: string) =>
  (JSON.parse(Buffer.from(session.slice("sb1.".length), "base64url").toString()) as { s: string }).s;

let socle: FakeSocle;
let logs: string[];

beforeEach(async () => {
  resetFakeDb();
  Object.assign(testEnv, { SOCLE_API_URL: "https://socle.test", SOCLE_API_KEY: "k" });
  socle = fakeSocle();
  vi.stubGlobal("fetch", socle.fetchImpl);
  await seedSettings(OWNER);
  await seedSettings(OTHER);
  logs = [];
  for (const level of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/notifications/bell-session", () => {
  it("serves only the signed-in person: Socle is asked for their ID, from the sign-in", async () => {
    const mine = await get(OWNER);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const body = await json<Answer>(mine);
    expect(whose(body.session!)).toBe(`eisenq.${OWNER}`);
    expect(body.expiresAt).toBe("2026-11-28T00:05:00.000Z");

    const theirs = await json<Answer>(await get(OTHER));
    expect(whose(theirs.session!)).toBe(`eisenq.${OTHER}`);

    expect(socle.to("/bell-sessions").map((c) => c.body)).toEqual([
      { recipientId: OWNER },
      { recipientId: OTHER },
    ]);
    // With EisenQ's key, from EisenQ's server, the ID never in the address.
    for (const call of socle.to("/bell-sessions")) {
      expect(call.url).toBe("https://socle.test/v1/notifications/bell-sessions");
      expect(call.headers.get("authorization")).toBe("Bearer k");
    }
  });

  it("takes nothing from the request: it has no body or query to read", async () => {
    const { GET } = await import("~/app/api/notifications/bell-session/route");
    // GET takes no arguments: a recipientId in a link or a body can't reach it.
    expect(GET.length).toBe(0);
  });

  it("answers 401 without a sign-in, and asks Socle nothing", async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(socle.calls).toEqual([]);
  });

  it("answers no session, without calling Socle, when the person's bell is off", async () => {
    await userSettingsCollection.updateOne(
      { userId: OWNER },
      { $set: { notificationChannels: { email: false, bell: false, checkedAt: new Date() } } },
    );
    const res = await get(OWNER);
    expect(await json(res)).toEqual({ session: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(socle.calls).toEqual([]);
  });

  it("answers no session without Socle's variables (Preview and local builds)", async () => {
    Object.assign(testEnv, { SOCLE_API_URL: undefined, SOCLE_API_KEY: undefined });
    expect(await json(await get(OWNER))).toEqual({ session: null });
    expect(socle.calls).toEqual([]);
  });

  it("gives an account seen for the first time a settings record, so the daily job reaches it", async () => {
    const NEW = "user_2newNewNewNewNew000003";
    await get(NEW);
    expect(await userSettingsCollection.findOne({ userId: NEW })).toMatchObject({ userId: NEW });
  });

  it("answers 503 when Socle can't open it, and logs nothing about the person", async () => {
    socle.answerNext("/bell-sessions", { status: 503 });
    const res = await get(OWNER);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const all = logs.join("\n");
    expect(all).toContain('"status":503');
    expect(all).not.toContain(OWNER);
    expect(all).not.toContain("sb1.");
  });
});
