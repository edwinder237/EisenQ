import "server-only";
import { env } from "~/env";

// The only module that talks to Socle. Socle delivers EisenQ's daily
// notifications email: EisenQ decides when and what, Socle checks it and hands
// it to Novu, which sends it through Resend. The email holds counts only,
// never a task's name (docs/notifications/README.md, "Daily email").
//
// The address and the key come from SOCLE_API_URL and SOCLE_API_KEY. Without
// either, socleConfig() is null and nothing is emailed.

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
  id: string; // EisenQ's Clerk user ID. Socle names the Novu subscriber "eisenq.<id>"
  email: string; // the Clerk primary email, read at send time, never stored
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

// What Socle answered, without its body. Callers decide with the status and
// the problem's type (its last path segment, such as "event-type-unknown"),
// but only the status and Socle's eventId may be logged (legal, Socle's #52).
export type SocleProblem = {
  kind: "problem";
  status: number;
  type: string;
  retryAfterSeconds?: number;
};
export type SocleUnreachable = {
  kind: "unreachable";
  reason: "timeout" | "network";
};
export type SendResult =
  | { kind: "accepted"; replayed: boolean; eventId?: string }
  | SocleProblem
  | SocleUnreachable;

// Socle checks each count is a whole number up to 999.
export const MAX_COUNT = 999;
const clamp = (n: number) => Math.min(MAX_COUNT, Math.max(0, Math.floor(n)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return {
    kind: "problem",
    status: res.status,
    type,
    ...(res.headers.has("retry-after") &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
      ? { retryAfterSeconds: retryAfter }
      : {}),
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

export function createSocleClient(
  config: SocleConfig,
  fetchImpl: typeof fetch = fetch,
) {
  return {
    /**
     * One daily email for one person. The data is exactly the four counts,
     * each capped at 999: never a title, a date, a time zone or an ID.
     */
    async sendDigestEvent(event: DigestEvent): Promise<SendResult> {
      const { id, email, locale } = event.recipient;
      const { dueCount, comingUpCount, missedRoutinesCount, isTest } =
        event.counts;
      const body = {
        eventType: DIGEST_EVENT_TYPE,
        recipient: { id, email, ...(locale ? { locale } : {}) },
        data: {
          dueCount: clamp(dueCount),
          comingUpCount: clamp(comingUpCount),
          missedRoutinesCount: clamp(missedRoutinesCount),
          isTest,
        },
      };
      try {
        const res = await fetchImpl(
          `${config.apiUrl}/v1/notifications/events`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              "Idempotency-Key": event.idempotencyKey,
            },
            body: JSON.stringify(body),
            cache: "no-store",
            // Never follow a redirect with the key.
            redirect: "error",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        if (res.status === 202) {
          const accepted = (await res.json().catch(() => ({}))) as {
            eventId?: unknown;
          };
          const eventId =
            typeof accepted.eventId === "string" && UUID.test(accepted.eventId)
              ? accepted.eventId
              : undefined;
          return {
            kind: "accepted",
            replayed: res.headers.get("idempotency-replayed") === "true",
            ...(eventId ? { eventId } : {}),
          };
        }
        return await problemFrom(res);
      } catch (err) {
        return unreachable(err);
      }
    },
  };
}

export type SocleClient = ReturnType<typeof createSocleClient>;
