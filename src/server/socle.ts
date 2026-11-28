import "server-only";
import { env } from "~/env";

// The only module that talks to Socle (edwinder237/socle, the guide "Add
// notifications to your app"). EisenQ decides when and what; Socle holds each
// person's email and bell switches, gates every send on them, and delivers.
// EisenQ never names Socle's delivery services, and never calls them.
//
// Five calls, all from EisenQ's server with its key, the person's ID always in
// the body, never in a link:
// - sendDigestEvent: the daily summary, counts only (scope notifications:send);
// - bellSession: the signed-in person's bell session (notifications:bell);
// - lookupPreferences / setPreferences: the email and bell switches
//   (notifications:send);
// - deleteRecipient: a deleted account (notifications:send).
//
// The address and the key come from SOCLE_API_URL and SOCLE_API_KEY. Without
// either, socleConfig() is null and nothing reaches Socle. Nothing from a body
// is ever logged: callers may log the status, the problem's type and Socle's
// eventId only.

export const DIGEST_EVENT_TYPE = "eisenq.digest.ready";
const TIMEOUT_MS = 10_000;

export interface SocleConfig {
  apiUrl: string; // no trailing slash
  apiKey: string;
}

export function socleConfigFrom(source: {
  SOCLE_API_URL?: string;
  SOCLE_API_KEY?: string;
}): SocleConfig | null {
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

export interface SocleRecipient {
  id: string; // EisenQ's Clerk user ID, the same in every call
  // The verified Clerk primary email, read at send time and never stored.
  // Only when the person has email on: a bell-only event carries none.
  email?: string;
  locale?: "fr" | "en"; // only when Clerk knows it
}

/** The digest's data: counts only. */
export interface DigestCounts {
  dueCount: number; // overdue plus due today
  comingUpCount: number; // maintenance within its heads-up
  missedRoutinesCount: number; // 0 when that email switch is off
  isTest: boolean; // "Send a test" from Settings
}

export interface DigestEvent {
  idempotencyKey: string;
  recipient: SocleRecipient;
  counts: DigestCounts;
}

export type SocleChannel = "email" | "in_app";

/** One switch as Socle holds it. changedAt and changedVia are null while it's the default. */
export interface ChannelState {
  enabled: boolean;
  changedAt: string | null;
  changedVia: "app" | "unsubscribe_link" | null;
}

/** A person's email and bell, as Socle answers them. No row in Socle: email off, the bell on. */
export interface SocleChoices {
  email: ChannelState;
  in_app: ChannelState;
}

// What Socle answered, without its body. Callers decide with the status and
// the problem's type (its last path segment, such as "event-type-unknown"),
// plus, on a 422, the JSON Pointers of the fields at fault, which never hold a
// value. Only the status and Socle's eventId may be logged (legal, Socle's #52).
export type SocleProblem = {
  kind: "problem";
  status: number;
  type: string;
  retryAfterSeconds?: number;
  pointers?: string[];
};
export type SocleUnreachable = {
  kind: "unreachable";
  reason: "timeout" | "network";
};
export type SocleFailure = SocleProblem | SocleUnreachable;

export type SendResult =
  | {
      kind: "accepted";
      replayed: boolean;
      eventId?: string;
      // Where it went: the channels switched on that the person has on.
      channels?: SocleChannel[];
    }
  | SocleFailure;
export type BellSessionResult =
  | { kind: "ok"; session: string; expiresAt: string }
  | SocleFailure;
export type ChoicesResult = { kind: "ok"; choices: SocleChoices } | SocleFailure;
export type DeleteResult = { kind: "deleted" } | SocleFailure;

// Socle checks each count is a whole number up to 999.
export const MAX_COUNT = 999;
const clamp = (n: number) => Math.min(MAX_COUNT, Math.max(0, Math.floor(n)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROBLEM_SLUG = /^[a-z0-9_-]{1,64}$/;
const POINTER = /^(\/[A-Za-z0-9_~-]{0,64}){1,8}$/;
const CHANNELS: readonly SocleChannel[] = ["email", "in_app"];
// The bell session is opaque and passed on as it is; this only bounds it.
const SESSION_MAX = 8192;

async function problemFrom(res: Response): Promise<SocleProblem> {
  let type = "unknown";
  let pointers: string[] = [];
  try {
    const body = (await res.json()) as { type?: unknown; errors?: unknown };
    if (typeof body.type === "string") {
      const slug = body.type.split(/[/#]/).filter(Boolean).pop() ?? "";
      if (PROBLEM_SLUG.test(slug)) type = slug;
    }
    if (Array.isArray(body.errors)) {
      pointers = body.errors
        .map((e) => (e as { pointer?: unknown } | null)?.pointer)
        .filter((p): p is string => typeof p === "string" && POINTER.test(p));
    }
  } catch {
    /* not JSON: the type stays unknown */
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  return {
    kind: "problem",
    status: res.status,
    type,
    ...(res.headers.has("retry-after") &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
      ? { retryAfterSeconds: retryAfter }
      : {}),
    ...(pointers.length > 0 ? { pointers } : {}),
  };
}

function unreachable(err: unknown): SocleUnreachable {
  const name = err instanceof Error ? err.name : "";
  return {
    kind: "unreachable",
    reason:
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
  };
}

function channelState(value: unknown): ChannelState | null {
  if (typeof value !== "object" || value === null) return null;
  const { enabled, changedAt, changedVia } = value as Record<string, unknown>;
  if (typeof enabled !== "boolean") return null;
  return {
    enabled,
    changedAt:
      typeof changedAt === "string" && !Number.isNaN(Date.parse(changedAt))
        ? changedAt
        : null,
    changedVia:
      changedVia === "app" || changedVia === "unsubscribe_link"
        ? changedVia
        : null,
  };
}

function choicesFrom(body: unknown): SocleChoices | null {
  const channels = (body as { channels?: Record<string, unknown> } | null)
    ?.channels;
  const email = channelState(channels?.email);
  const inApp = channelState(channels?.in_app);
  return email && inApp ? { email, in_app: inApp } : null;
}

const unexpected = (status: number): SocleProblem => ({
  kind: "problem",
  status,
  type: "unexpected-answer",
});

export function createSocleClient(
  config: SocleConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const call = (
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetchImpl(`${config.apiUrl}/v1/notifications${path}`, {
      method,
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

  const readChoices = async (res: Response): Promise<ChoicesResult> => {
    if (res.status !== 200) return problemFrom(res);
    const choices = choicesFrom(await res.json().catch(() => null));
    return choices ? { kind: "ok", choices } : unexpected(res.status);
  };

  return {
    /**
     * One daily summary for one person. The data is exactly the four counts,
     * each capped at 999: never a title, a date, a time zone or an ID. The
     * address goes only when the caller includes it (the person has email on).
     */
    async sendDigestEvent(event: DigestEvent): Promise<SendResult> {
      const { id, email, locale } = event.recipient;
      const { dueCount, comingUpCount, missedRoutinesCount, isTest } =
        event.counts;
      const body = {
        eventType: DIGEST_EVENT_TYPE,
        recipient: {
          id,
          ...(email ? { email } : {}),
          ...(locale ? { locale } : {}),
        },
        data: {
          dueCount: clamp(dueCount),
          comingUpCount: clamp(comingUpCount),
          missedRoutinesCount: clamp(missedRoutinesCount),
          isTest,
        },
      };
      try {
        const res = await call("POST", "/events", body, {
          "Idempotency-Key": event.idempotencyKey,
        });
        if (res.status === 202) {
          const accepted = (await res.json().catch(() => ({}))) as {
            eventId?: unknown;
            channels?: unknown;
          };
          const eventId =
            typeof accepted.eventId === "string" && UUID.test(accepted.eventId)
              ? accepted.eventId
              : undefined;
          const channels = Array.isArray(accepted.channels)
            ? CHANNELS.filter((c) => (accepted.channels as unknown[]).includes(c))
            : undefined;
          return {
            kind: "accepted",
            replayed: res.headers.get("idempotency-replayed") === "true",
            ...(eventId ? { eventId } : {}),
            ...(channels ? { channels } : {}),
          };
        }
        return await problemFrom(res);
      } catch (err) {
        return unreachable(err);
      }
    },

    /**
     * The signed-in person's bell session: an opaque string for Socle's bell
     * component, passed on unread. Never stored, cached or logged.
     */
    async bellSession(recipientId: string): Promise<BellSessionResult> {
      try {
        const res = await call("POST", "/bell-sessions", { recipientId });
        if (res.status !== 200) return await problemFrom(res);
        const body = (await res.json().catch(() => null)) as {
          session?: unknown;
          expiresAt?: unknown;
        } | null;
        const session = body?.session;
        const expiresAt = body?.expiresAt;
        if (
          typeof session !== "string" ||
          session === "" ||
          session.length > SESSION_MAX ||
          typeof expiresAt !== "string" ||
          Number.isNaN(Date.parse(expiresAt))
        )
          return unexpected(res.status);
        return { kind: "ok", session, expiresAt };
      } catch (err) {
        return unreachable(err);
      }
    },

    /** The person's email and bell, as Socle holds them. */
    async lookupPreferences(recipientId: string): Promise<ChoicesResult> {
      try {
        return await readChoices(
          await call("POST", "/preferences/lookup", { recipientId }),
        );
      } catch (err) {
        return unreachable(err);
      }
    },

    /**
     * Only the switches the person just changed. Socle records when email was
     * turned on, as their consent, and answers the switches after the change.
     */
    async setPreferences(
      recipientId: string,
      changes: { email?: boolean; in_app?: boolean },
    ): Promise<ChoicesResult> {
      try {
        return await readChoices(
          await call("PUT", "/preferences", { recipientId, channels: changes }),
        );
      } catch (err) {
        return unreachable(err);
      }
    },

    /** A deleted account: Socle deletes its stored choices and everything at delivery. 204 even when nothing was there. */
    async deleteRecipient(recipientId: string): Promise<DeleteResult> {
      try {
        const res = await call("POST", "/recipients/delete", { recipientId });
        if (res.status === 204) return { kind: "deleted" };
        return await problemFrom(res);
      } catch (err) {
        return unreachable(err);
      }
    },
  };
}

export type SocleClient = ReturnType<typeof createSocleClient>;

/** The client from EisenQ's variables, or null when Socle isn't set up (Preview, local). */
export function socleClient(): SocleClient | null {
  const config = socleConfig();
  return config ? createSocleClient(config) : null;
}
