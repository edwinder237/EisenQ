// Socle, faked at the HTTP level for tests: the real client
// (~/server/socle.ts) builds every request, and this answers them the way
// Socle's A3 contract does (edwinder237/socle#83, the guide "Add notifications
// to your app"). No network.
//
// - Each person's email and bell, with Socle's defaults: email off, bell on.
// - POST /events is gated on them: both off is 409 recipient-opted-out; email
//   on without an address is 422 recipient-invalid at /recipient/email;
//   otherwise 202 with the channels it went out on.
// - POST /events keeps each Idempotency-Key with the first body it came with.
//   The same body again is replayed (202, Idempotency-Replayed) once accepted,
//   or taken as new after a failure, when Socle releases the key. Any other
//   body is 422 idempotency-key-reused, whatever happened first.
// - answerNext() queues answers for a path, ahead of the behaviour above. A
//   queued answer to POST /events still marks its key the way Socle would.
// - Each call records the status it was answered with.

import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { createSocleClient } from "~/server/socle";

export type FakeChannel = {
  enabled: boolean;
  changedAt: string | null;
  changedVia: "app" | "unsubscribe_link" | null;
};
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
type Path =
  | "/events"
  | "/bell-sessions"
  | "/preferences/lookup"
  | "/preferences"
  | "/recipients/delete";

export type SocleCall = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  headers: Headers;
  url: string;
  /** What the fake answered. */
  status?: number;
};

const PROBLEMS = "https://socle-services.app/problems/";

function reply({ status, body, headers }: Answer): Response {
  return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function fakeSocle() {
  const people = new Map<string, { email: FakeChannel; in_app: FakeChannel }>();
  const queued = new Map<string, Answer[]>();
  const calls: SocleCall[] = [];
  // Idempotency-Key → the first body it came with, and Socle's 202 if it was accepted.
  const keys = new Map<string, { body: string; accepted?: Answer }>();

  const choicesOf = (id: string) =>
    people.get(id) ?? {
      email: { enabled: false, changedAt: null, changedVia: null },
      in_app: { enabled: true, changedAt: null, changedVia: null },
    };

  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const path = new URL(url).pathname.replace(/^\/v1\/notifications/, "");
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<
        string,
        unknown
      >;
      const call: SocleCall = {
        path,
        method: init?.method ?? "GET",
        body,
        headers: new Headers(init?.headers),
        url,
      };
      calls.push(call);
      const answer = answerFor(path, body, call.headers);
      call.status = answer.status;
      return reply(answer);
    },
  );

  function answerFor(
    path: string,
    body: Record<string, unknown>,
    headers: Headers,
  ): Answer {
    const next = queued.get(path)?.shift();
    if (path === "/events") {
      const key = headers.get("idempotency-key") ?? "";
      const raw = JSON.stringify(body);
      const seen = keys.get(key);
      const answer: Answer =
        next ??
        (seen && seen.body !== raw
          ? { status: 422, body: { type: `${PROBLEMS}idempotency-key-reused` } }
          : seen?.accepted
            ? {
                ...seen.accepted,
                headers: { ...seen.accepted.headers, "idempotency-replayed": "true" },
              }
            : deliver(body));
      if (!seen) keys.set(key, { body: raw });
      const kept = keys.get(key)!;
      if (answer.status === 202 && kept.body === raw) kept.accepted ??= answer;
      return answer;
    }
    if (next) return next;

    if (path === "/preferences/lookup")
      return { status: 200, body: { channels: choicesOf(String(body.recipientId)) } };
    if (path === "/preferences") {
      const id = String(body.recipientId);
      const channels = body.channels as { email?: boolean; in_app?: boolean };
      const current = choicesOf(id);
      const at = new Date().toISOString();
      const set = (c: FakeChannel, v: boolean | undefined): FakeChannel =>
        v === undefined || v === c.enabled
          ? c
          : { enabled: v, changedAt: at, changedVia: "app" };
      people.set(id, {
        email: set(current.email, channels.email),
        in_app: set(current.in_app, channels.in_app),
      });
      return { status: 200, body: { channels: choicesOf(id) } };
    }
    if (path === "/bell-sessions") {
      // Opaque to EisenQ. Here it names whose it is, so tests can tell.
      const inside = Buffer.from(
        JSON.stringify({ v: 1, s: `eisenq.${String(body.recipientId)}` }),
      ).toString("base64url");
      return {
        status: 200,
        body: { session: `sb1.${inside}`, expiresAt: "2026-11-28T00:05:00.000Z" },
      };
    }
    if (path === "/recipients/delete") {
      people.delete(String(body.recipientId));
      return { status: 204 };
    }
    return { status: 404, body: { type: `${PROBLEMS}not-found` } };
  }

  /** A new event, gated on the person's switches. */
  function deliver(body: Record<string, unknown>): Answer {
    const recipient = body.recipient as { id: string; email?: string };
    const c = choicesOf(recipient.id);
    if (!c.email.enabled && !c.in_app.enabled)
      return { status: 409, body: { type: `${PROBLEMS}recipient-opted-out` } };
    if (c.email.enabled && !recipient.email)
      return {
        status: 422,
        body: {
          type: `${PROBLEMS}recipient-invalid`,
          errors: [{ in: "body", pointer: "/recipient/email", detail: "Required" }],
        },
      };
    return {
      status: 202,
      body: {
        eventId: randomUUID(),
        eventType: body.eventType,
        status: "accepted",
        channels: [
          ...(c.email.enabled && recipient.email ? ["email"] : []),
          ...(c.in_app.enabled ? ["in_app"] : []),
        ],
        acceptedAt: new Date().toISOString(),
      },
    };
  }

  return {
    socle: createSocleClient({ apiUrl: "https://socle.test", apiKey: "k" }, fetchImpl),
    fetchImpl,
    calls,
    /** Socle's stored switches for one person; unset keeps the default. */
    setChoices(
      id: string,
      choices: { email?: boolean; bell?: boolean },
      via: FakeChannel["changedVia"] = "app",
    ) {
      const current = choicesOf(id);
      const at = "2026-11-20T12:00:00.000Z";
      people.set(id, {
        email:
          choices.email === undefined
            ? current.email
            : { enabled: choices.email, changedAt: at, changedVia: via },
        in_app:
          choices.bell === undefined
            ? current.in_app
            : { enabled: choices.bell, changedAt: at, changedVia: via },
      });
    },
    choicesOf,
    answerNext(path: Path, ...answers: Answer[]) {
      queued.set(path, [...(queued.get(path) ?? []), ...answers]);
    },
    to: (path: Path) => calls.filter((c) => c.path === path),
    events: () =>
      calls
        .filter((c) => c.path === "/events")
        .map((c) => ({
          ...(c.body as {
            eventType: string;
            recipient: { id: string; email?: string; locale?: string };
            data: Record<string, unknown>;
          }),
          key: c.headers.get("idempotency-key"),
          raw: JSON.stringify(c.body),
          status: c.status,
        })),
  };
}

export type FakeSocle = ReturnType<typeof fakeSocle>;
