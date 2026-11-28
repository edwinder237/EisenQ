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

  it("leaves the address out for a bell-only event, and reads where it went", async () => {
    const fetchImpl = stub(202, { channels: ["in_app", "sms"] });
    const result = await createSocleClient(config, fetchImpl).sendDigestEvent({
      ...event,
      recipient: { id: event.recipient.id },
    });
    expect(result).toEqual({
      kind: "accepted",
      replayed: false,
      channels: ["in_app"],
    });
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string) as {
      recipient: Record<string, unknown>;
    };
    expect(sent.recipient).toEqual({ id: event.recipient.id });
  });

  it("keeps a 422's JSON Pointers, never its values", async () => {
    const result = await createSocleClient(
      config,
      stub(422, {
        type: "https://socle-services.app/problems/recipient-invalid",
        errors: [
          { in: "body", pointer: "/recipient/email", detail: "Required" },
          { pointer: "owner@example.com" },
        ],
      }),
    ).sendDigestEvent(event);
    expect(result).toEqual({
      kind: "problem",
      status: 422,
      type: "recipient-invalid",
      pointers: ["/recipient/email"],
    });
  });

  it("reads 409 recipient-opted-out", async () => {
    const result = await createSocleClient(
      config,
      stub(409, {
        type: "https://socle-services.app/problems/recipient-opted-out",
      }),
    ).sendDigestEvent(event);
    expect(result).toMatchObject({ status: 409, type: "recipient-opted-out" });
  });
});

describe("the person's calls: the ID in the body, never in the address", () => {
  const ID = "user_2ownerOwnerOwner00001";
  const choices = {
    channels: {
      email: {
        enabled: true,
        changedAt: "2026-11-27T12:00:00.000Z",
        changedVia: "app",
      },
      in_app: { enabled: true, changedAt: null, changedVia: null },
    },
  };

  function sentTo(fetchImpl: ReturnType<typeof stub>) {
    const [input, init] = fetchImpl.mock.calls[0]!;
    const url = input instanceof Request ? input.url : input.toString();
    expect(url).not.toContain(ID);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(init?.redirect).toBe("error");
    return {
      url,
      method: init?.method,
      body: JSON.parse(init?.body as string) as unknown,
    };
  }

  it("bellSession passes Socle's opaque session on, unread", async () => {
    const fetchImpl = stub(200, {
      session: "sb1.eyJ2IjoxfQ",
      expiresAt: "2026-11-28T03:00:00.000Z",
    });
    expect(
      await createSocleClient(config, fetchImpl).bellSession(ID),
    ).toEqual({
      kind: "ok",
      session: "sb1.eyJ2IjoxfQ",
      expiresAt: "2026-11-28T03:00:00.000Z",
    });
    expect(sentTo(fetchImpl)).toEqual({
      url: "https://socle.test/v1/notifications/bell-sessions",
      method: "POST",
      body: { recipientId: ID },
    });
    expect(
      await createSocleClient(config, stub(200, { session: 3 })).bellSession(
        ID,
      ),
    ).toMatchObject({ kind: "problem", type: "unexpected-answer" });
    expect(
      await createSocleClient(
        config,
        stub(403, {
          type: "https://socle-services.app/problems/insufficient_scope",
        }),
      ).bellSession(ID),
    ).toMatchObject({ kind: "problem", status: 403 });
  });

  it("lookupPreferences and setPreferences read Socle's switches", async () => {
    const lookup = stub(200, choices);
    expect(
      await createSocleClient(config, lookup).lookupPreferences(ID),
    ).toEqual({ kind: "ok", choices: choices.channels });
    expect(sentTo(lookup)).toEqual({
      url: "https://socle.test/v1/notifications/preferences/lookup",
      method: "POST",
      body: { recipientId: ID },
    });

    const set = stub(200, choices);
    await createSocleClient(config, set).setPreferences(ID, { email: true });
    expect(sentTo(set)).toEqual({
      url: "https://socle.test/v1/notifications/preferences",
      method: "PUT",
      body: { recipientId: ID, channels: { email: true } },
    });

    expect(
      await createSocleClient(
        config,
        stub(200, { channels: { email: {} } }),
      ).lookupPreferences(ID),
    ).toMatchObject({ kind: "problem", type: "unexpected-answer" });
  });

  it("deleteRecipient is done on 204, and anything else is a failure to retry", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    expect(
      await createSocleClient(config, fetchImpl).deleteRecipient(ID),
    ).toEqual({ kind: "deleted" });
    expect(sentTo(fetchImpl)).toEqual({
      url: "https://socle.test/v1/notifications/recipients/delete",
      method: "POST",
      body: { recipientId: ID },
    });
    expect(
      await createSocleClient(
        config,
        stub(
          503,
          { type: "https://socle-services.app/problems/delivery-unavailable" },
          { "retry-after": "5" },
        ),
      ).deleteRecipient(ID),
    ).toEqual({
      kind: "problem",
      status: 503,
      type: "delivery-unavailable",
      retryAfterSeconds: 5,
    });
  });
});
