import "server-only";
import { env } from "~/env";

// The only module that talks to Socle (docs/integrations/socle.md). Socle
// delivers EisenQ's waiting-task reminders through Novu: by email, and in the
// bell in the dashboard's header. EisenQ decides when; Socle only delivers.
//
// Two calls, both from EisenQ's server with EisenQ's key, never from a browser:
// - POST /v1/notifications/events: one waiting-task reminder for one person.
// - POST /v1/notifications/inbox-session: what Novu's Inbox (the bell) needs
//   for the signed-in person.
//
// The address and the key come from SOCLE_API_URL and SOCLE_API_KEY. Without
// either, socleConfig() is null and every caller switches its feature off.

export const STALE_TASK_EVENT_TYPE = "eisenq.task.stale";
const TIMEOUT_MS = 10_000;

export interface SocleConfig {
  apiUrl: string; // no trailing slash
  apiKey: string;
}

export function socleConfigFrom(source: { SOCLE_API_URL?: string; SOCLE_API_KEY?: string }): SocleConfig | null {
  const rawUrl = source.SOCLE_API_URL?.trim();
  const apiKey = source.SOCLE_API_KEY?.trim();
  if (!rawUrl || !apiKey) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return { apiUrl: rawUrl.replace(/\/+$/, ""), apiKey };
  } catch {
    return null;
  }
}

export function socleConfig(): SocleConfig | null {
  return socleConfigFrom(env);
}

export interface StaleTaskRecipient {
  id: string;           // EisenQ's Clerk user ID. Socle names the Novu subscriber "eisenq.<id>"
  email: string;        // read from EisenQ's Clerk at send time, never stored
  locale?: "fr" | "en"; // only when Clerk knows it; the messages are bilingual anyway
}

export interface StaleTaskEvent {
  idempotencyKey: string;
  recipient: StaleTaskRecipient;
  taskId: string;
  daysWaiting: number;
}

// What Socle answered, without its body: the job and the logs need only the
// status, the problem's type (its last path segment, such as "event-type-off")
// and Socle's request ID.
export type SocleProblem = {
  kind: "problem";
  status: number;
  type: string;
  retryAfterSeconds?: number;
  requestId?: string;
};
export type SocleUnreachable = { kind: "unreachable"; reason: "timeout" | "network" };
export type SendResult = { kind: "accepted"; replayed: boolean } | SocleProblem | SocleUnreachable;

export interface InboxSession {
  applicationIdentifier: string;
  subscriberId: string;
  subscriberHash: string;
}
export type InboxSessionResult = { kind: "session"; session: InboxSession } | SocleProblem | SocleUnreachable;

const PROBLEM_SLUG = /^[a-z0-9_-]{1,64}$/;

async function problemFrom(res: Response): Promise<SocleProblem> {
  let type = "unknown";
  try {
    const body = (await res.json()) as { type?: unknown };
    if (typeof body.type === "string") {
      const slug = body.type.split(/[/#]/).filter(Boolean).pop() ?? "";
      if (PROBLEM_SLUG.test(slug)) type = slug;
    }
  } catch {
    /* not JSON: the type stays unknown */
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  const requestId = res.headers.get("x-request-id");
  return {
    kind: "problem",
    status: res.status,
    type,
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
    ...(requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? { requestId } : {}),
  };
}

function unreachable(err: unknown): SocleUnreachable {
  const name = err instanceof Error ? err.name : "";
  return { kind: "unreachable", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
}

function isInboxSession(value: unknown): value is InboxSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.applicationIdentifier === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(v.applicationIdentifier) &&
    typeof v.subscriberId === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(v.subscriberId) &&
    typeof v.subscriberHash === "string" &&
    /^[0-9a-f]{64}$/.test(v.subscriberHash)
  );
}

export function createSocleClient(config: SocleConfig, fetchImpl: typeof fetch = fetch) {
  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetchImpl(`${config.apiUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      // Never follow a redirect with the key.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  return {
    /**
     * One reminder for one waiting task. The data is exactly `taskId` and
     * `daysWaiting`, the two fields legal approved: never a title, a
     * quadrant or a date.
     */
    async sendStaleTaskEvent(event: StaleTaskEvent): Promise<SendResult> {
      const { id, email, locale } = event.recipient;
      const body = {
        eventType: STALE_TASK_EVENT_TYPE,
        recipient: { id, email, ...(locale ? { locale } : {}) },
        data: { taskId: event.taskId, daysWaiting: event.daysWaiting },
      };
      try {
        const res = await post("/v1/notifications/events", body, { "Idempotency-Key": event.idempotencyKey });
        if (res.status === 202) {
          await res.body?.cancel();
          return { kind: "accepted", replayed: res.headers.get("idempotency-replayed") === "true" };
        }
        return await problemFrom(res);
      } catch (err) {
        return unreachable(err);
      }
    },

    /**
     * The bell's signed pass for one of EisenQ's people. The answer opens that
     * person's bell and never expires: callers hand it to the browser and
     * never store, cache or log it.
     */
    async openInboxSession(recipientId: string): Promise<InboxSessionResult> {
      try {
        const res = await post("/v1/notifications/inbox-session", { recipientId });
        if (res.status !== 200) return await problemFrom(res);
        const session: unknown = await res.json().catch(() => null);
        if (!isInboxSession(session)) return { kind: "problem", status: 502, type: "invalid-session" };
        const { applicationIdentifier, subscriberId, subscriberHash } = session;
        return { kind: "session", session: { applicationIdentifier, subscriberId, subscriberHash } };
      } catch (err) {
        return unreachable(err);
      }
    },
  };
}

export type SocleClient = ReturnType<typeof createSocleClient>;
