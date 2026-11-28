// Socle, faked at the HTTP level for tests: the real client
// (~/server/socle.ts) builds every request, and this answers them the way
// Socle's A3 contract does (edwinder237/socle#83, the guide "Add notifications
// to your app"). No network.
//
// - Each person's email and bell, with Socle's defaults: email off, bell on.
// - POST /events is gated on them: both off is 409 recipient-opted-out; email
//   on without an address is 422 recipient-invalid at /recipient/email;
//   otherwise 202 with the channels it went out on.
// - answerNext() queues answers for a path, ahead of the behaviour above.

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

  const choicesOf = (id: string) =>
    people.get(id) ?? {
      email: { enabled: false, changedAt: null, changedVia: null },
      in_app: { enabled: true, changedAt: null, changedVia: null },
    };

  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname.replace(/^\/v1\/notifications/, "");
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<
        string,
        unknown
      >;
      calls.push({
        path,
        method: init?.method ?? "GET",
        body,
        headers: new Headers(init?.headers),
        url,
      });
      const next = queued.get(path)?.shift();
      if (next) return reply(next);

      if (path === "/preferences/lookup")
        return reply({ status: 200, body: { channels: choicesOf(String(body.recipientId)) } });
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
        return reply({ status: 200, body: { channels: choicesOf(id) } });
      }
      if (path === "/events") {
        const recipient = body.recipient as { id: string; email?: string };
        const c = choicesOf(recipient.id);
        if (!c.email.enabled && !c.in_app.enabled)
          return reply({ status: 409, body: { type: `${PROBLEMS}recipient-opted-out` } });
        if (c.email.enabled && !recipient.email)
          return reply({
            status: 422,
            body: {
              type: `${PROBLEMS}recipient-invalid`,
              errors: [{ in: "body", pointer: "/recipient/email", detail: "Required" }],
            },
          });
        return reply({
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
        });
      }
      if (path === "/bell-sessions") {
        // Opaque to EisenQ. Here it names whose it is, so tests can tell.
        const inside = Buffer.from(
          JSON.stringify({ v: 1, s: `eisenq.${String(body.recipientId)}` }),
        ).toString("base64url");
        return reply({
          status: 200,
          body: { session: `sb1.${inside}`, expiresAt: "2026-11-28T00:05:00.000Z" },
        });
      }
      if (path === "/recipients/delete") {
        people.delete(String(body.recipientId));
        return reply({ status: 204 });
      }
      return reply({ status: 404, body: { type: `${PROBLEMS}not-found` } });
    },
  );

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
        })),
  };
}

export type FakeSocle = ReturnType<typeof fakeSocle>;
