import { describe, expect, it, vi } from "vitest";
import {
  createSocleClient,
  socleConfigFrom,
  type DigestEvent,
} from "~/server/socle";

const config = { apiUrl: "https://socle.test", apiKey: "test-key" };
const event: DigestEvent = {
  idempotencyKey: "0b8f6d1e-3c2a-4e7b-9a51-6f0d2c9e7a44",
  recipient: {
    id: "user_2ownerOwnerOwner00001",
    email: "owner@example.com",
    locale: "fr",
  },
  counts: {
    dueCount: 2,
    comingUpCount: 1,
    missedRoutinesCount: 0,
    isTest: false,
  },
};

function stub(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

describe("socleConfigFrom", () => {
  it("is off without the address or the key", () => {
    expect(socleConfigFrom({})).toBeNull();
    expect(
      socleConfigFrom({ SOCLE_API_URL: "https://socle-services.app" }),
    ).toBeNull();
    expect(socleConfigFrom({ SOCLE_API_KEY: "k" })).toBeNull();
    expect(
      socleConfigFrom({ SOCLE_API_URL: "not a url", SOCLE_API_KEY: "k" }),
    ).toBeNull();
    expect(
      socleConfigFrom({
        SOCLE_API_URL: "https://socle-services.app/",
        SOCLE_API_KEY: "k",
      }),
    ).toEqual({
      apiUrl: "https://socle-services.app",
      apiKey: "k",
    });
  });
});

describe("sendDigestEvent", () => {
  it("sends exactly the four counts, with the key and the Idempotency-Key", async () => {
    const fetchImpl = stub(202, {
      eventId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    });
    const result = await createSocleClient(config, fetchImpl).sendDigestEvent(
      event,
    );
    expect(result).toEqual({
      kind: "accepted",
      replayed: false,
      eventId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://socle.test/v1/notifications/events");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("idempotency-key")).toBe(event.idempotencyKey);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(init?.body as string)).toEqual({
      eventType: "eisenq.digest.ready",
      recipient: {
        id: event.recipient.id,
        email: "owner@example.com",
        locale: "fr",
      },
      data: {
        dueCount: 2,
        comingUpCount: 1,
        missedRoutinesCount: 0,
        isTest: false,
      },
    });
  });

  it("caps each count at 999, Socle's limit", async () => {
    const fetchImpl = stub(202);
    await createSocleClient(config, fetchImpl).sendDigestEvent({
      ...event,
      counts: {
        dueCount: 1500,
        comingUpCount: 999,
        missedRoutinesCount: 3,
        isTest: true,
      },
    });
    expect(
      (
        JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string) as {
          data: unknown;
        }
      ).data,
    ).toEqual({
      dueCount: 999,
      comingUpCount: 999,
      missedRoutinesCount: 3,
      isTest: true,
    });
  });

  it("reads replays, problems and outages without keeping their bodies", async () => {
    const replay = await createSocleClient(
      config,
      stub(202, {}, { "idempotency-replayed": "true" }),
    ).sendDigestEvent(event);
    expect(replay).toEqual({ kind: "accepted", replayed: true });

    const unknown = await createSocleClient(
      config,
      stub(
        422,
        {
          type: "https://socle-services.app/problems/event-type-unknown",
          detail: "There is no event type with this name.",
        },
        { "x-request-id": "r1" },
      ),
    ).sendDigestEvent(event);
    expect(unknown).toEqual({
      kind: "problem",
      status: 422,
      type: "event-type-unknown",
    });

    const busy = await createSocleClient(
      config,
      stub(
        503,
        { type: "https://socle-services.app/problems/delivery-unavailable" },
        { "retry-after": "2" },
      ),
    ).sendDigestEvent(event);
    expect(busy).toEqual({
      kind: "problem",
      status: 503,
      type: "delivery-unavailable",
      retryAfterSeconds: 2,
    });

    const down = await createSocleClient(
      config,
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    ).sendDigestEvent(event);
    expect(down).toEqual({ kind: "unreachable", reason: "network" });
  });
});
