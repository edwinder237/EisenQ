// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// The bell session Socle's route answers (apps/backend/src/modules/notifications/bell.ts):
// an opaque string the app's server passes through. Only this file and the
// adapter read what's inside. Format "sb1": "sb1." + base64url(JSON) with the
// provider's application identifier (a), the person's subscriber ID (s), its
// HMAC (h), when to fetch a new one (e) and, outside the provider's US
// region, its API address (u). An older copy of the bell that gets a newer
// format shows reminders only.

export const SESSION_FORMAT = "sb1";

export type BellSession = {
  readonly applicationIdentifier: string;
  readonly subscriberId: string;
  readonly subscriberHash: string;
  readonly expiresAt: string;
  readonly apiUrl?: string;
};

export type SessionParse = { readonly ok: true; readonly session: BellSession } | { readonly ok: false; readonly reason: "format" | "invalid" };

function fromBase64Url(text: string): string {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function parseSession(value: unknown): SessionParse {
  if (typeof value !== "string") return { ok: false, reason: "invalid" };
  const dot = value.indexOf(".");
  if (dot < 1) return { ok: false, reason: "invalid" };
  if (value.slice(0, dot) !== SESSION_FORMAT) return { ok: false, reason: "format" };
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(fromBase64Url(value.slice(dot + 1))) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const { v, a, s, h, e, u } = fields;
  if (v !== 1 || typeof a !== "string" || typeof s !== "string" || typeof h !== "string" || typeof e !== "string") {
    return { ok: false, reason: "invalid" };
  }
  if (!/^[0-9a-f]{64}$/.test(h) || a === "" || s === "" || Number.isNaN(Date.parse(e))) return { ok: false, reason: "invalid" };
  if (u !== undefined && (typeof u !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/?$/.test(u))) return { ok: false, reason: "invalid" };
  return { ok: true, session: { applicationIdentifier: a, subscriberId: s, subscriberHash: h, expiresAt: e, ...(u ? { apiUrl: u } : {}) } };
}

export function sessionExpired(session: BellSession, now: Date): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}
