import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import type { SocleRecipient } from "~/server/socle";

// Who may get notification emails through Socle, and where they go.
//
// The bell is EisenQ's own and works for everyone. The daily email goes
// through Socle, and legal's condition there is "Marc only" for now (Socle's
// #50). EisenQ has no admin role or owner flag, and no environment variable
// holds anyone's ID, so the owner is the first account created in EisenQ's own
// Clerk application: the one that built the app. Only that account is emailed.

// The same rule as Socle's recipient.id: 1 to 64 of A-Z, a-z, 0-9, _ and -.
export const RECIPIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const OWNER_TTL_MS = 10 * 60_000;
let ownerCache: { at: number; id: Promise<string | null> } | null = null;

function errorNameOf(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name)
    ? err.name
    : "Error";
}

async function lookUpOwner(): Promise<string | null> {
  try {
    const { data } = await (
      await clerkClient()
    ).users.getUserList({ orderBy: "+created_at", limit: 1 });
    const id = data[0]?.id;
    return id && RECIPIENT_ID.test(id) ? id : null;
  } catch (err) {
    // Fails closed: nobody is emailed until Clerk answers.
    logNotifications("warn", "notifications_owner_lookup_failed", {
      errorName: errorNameOf(err),
    });
    ownerCache = null;
    return null;
  }
}

/**
 * EisenQ's owner account: the oldest account in EisenQ's Clerk application.
 * Kept for 10 minutes in this server instance's memory only. Never stored or
 * logged.
 */
export function eisenqOwnerId(
  opts: { fresh?: boolean } = {},
): Promise<string | null> {
  const now = Date.now();
  if (opts.fresh || !ownerCache || now - ownerCache.at > OWNER_TTL_MS) {
    ownerCache = { at: now, id: lookUpOwner() };
  }
  return ownerCache.id;
}

/** For tests: forget the cached owner. */
export function resetOwnerCache() {
  ownerCache = null;
}

/** "fr-CA" → "fr", "en-US" → "en", anything else → nothing. */
export function localeFrom(
  raw: string | null | undefined,
): "fr" | "en" | undefined {
  const lang = raw?.toLowerCase().split(/[-_]/)[0];
  return lang === "fr" || lang === "en" ? lang : undefined;
}

/** The person's primary email (and language, when known) from EisenQ's Clerk, at send time. */
export async function clerkRecipientFor(
  userId: string,
): Promise<SocleRecipient | null> {
  const user = await (await clerkClient()).users.getUser(userId);
  const email = user.primaryEmailAddress?.emailAddress;
  if (!email) return null;
  const locale = localeFrom(user.locale);
  return { id: userId, email, ...(locale ? { locale } : {}) };
}

/** The address shown in Settings → Notifications, or undefined if Clerk can't say. */
export async function clerkPrimaryEmail(
  userId: string,
): Promise<string | undefined> {
  try {
    return (await clerkRecipientFor(userId))?.email;
  } catch {
    return undefined;
  }
}

// One JSON line per event, for Vercel's logs. Counts and statuses only, plus
// Socle's eventId (legal, Socle's #50 and #52): never an email, a task title,
// a user ID, a key, or anything else from Socle's answer.
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
