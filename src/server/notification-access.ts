import "server-only";
import { clerkClient } from "@clerk/nextjs/server";

// Where a person's notification email may go, and the notifications log.
//
// Every EisenQ account has its own bell, reminders, settings and daily email
// (amended design record, edwinder237/socle,
// docs/decisions/2026-11-27-eisenq-notifications-amended-design.md). Whether
// email is on is Socle's to say. Where it goes is the account's own Clerk
// primary email, and only once Clerk marks it verified (legal's A1): never an
// address someone types in.

// The same rule as Socle's recipient.id: 1 to 64 of A-Z, a-z, 0-9, _ and -.
export const RECIPIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function errorNameOf(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name)
    ? err.name
    : "Error";
}

/** "fr-CA" → "fr", "en-US" → "en", anything else → nothing. */
export function localeFrom(
  raw: string | null | undefined,
): "fr" | "en" | undefined {
  const lang = raw?.toLowerCase().split(/[-_]/)[0];
  return lang === "fr" || lang === "en" ? lang : undefined;
}

/**
 * The account's address, at send time, from EisenQ's Clerk:
 * - verified: its primary email, which Clerk has verified, and its language;
 * - unverified: it has a primary email, not verified, so nothing is sent;
 * - none: no primary email;
 * - gone: Clerk has no such account any more (deleted, and EisenQ missed
 *   the event), so its notifications are deleted.
 * Never stored, and never logged.
 */
export type AccountAddress =
  | { kind: "verified"; email: string; locale?: "fr" | "en" }
  | { kind: "unverified" }
  | { kind: "none" }
  | { kind: "gone" };

/** Clerk's answer for an account it doesn't have: a ClerkAPIResponseError with status 404. */
export function isClerkNotFound(err: unknown): boolean {
  const e = err as { clerkError?: unknown; status?: unknown } | null;
  return typeof e === "object" && e !== null && e.clerkError === true && e.status === 404;
}

export async function accountAddressFor(
  userId: string,
): Promise<AccountAddress> {
  let user: Awaited<ReturnType<Awaited<ReturnType<typeof clerkClient>>["users"]["getUser"]>>;
  try {
    user = await (await clerkClient()).users.getUser(userId);
  } catch (err) {
    if (isClerkNotFound(err)) return { kind: "gone" };
    throw err;
  }
  const primary = user.primaryEmailAddress;
  if (!primary?.emailAddress) return { kind: "none" };
  if (primary.verification?.status !== "verified")
    return { kind: "unverified" };
  const locale = localeFrom(user.locale);
  return {
    kind: "verified",
    email: primary.emailAddress,
    ...(locale ? { locale } : {}),
  };
}

/** For Settings → Notifications: the address, or why there is none. Undefined if Clerk can't say. */
export async function settingsAddressFor(
  userId: string,
): Promise<AccountAddress | undefined> {
  try {
    return await accountAddressFor(userId);
  } catch {
    return undefined;
  }
}

// One JSON line per event, for Vercel's logs. Counts and statuses only, plus
// Socle's eventId (legal, Socle's #50 and #52): never an email, a task title,
// a user ID, a key, a bell session, or anything else from Socle's answer.
export type LogField = string | number | boolean | undefined;

export function logNotifications(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, LogField> = {},
) {
  const line = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
