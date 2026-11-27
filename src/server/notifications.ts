import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { REMINDER_THRESHOLD_MAX, REMINDER_THRESHOLD_MIN } from "~/lib/reminders";
import { socleConfig, type SocleConfig } from "~/server/socle";

// Who gets waiting-task reminders and the bell (docs/integrations/socle.md).
//
// For now, only EisenQ's owner: legal's condition is "Marc only" (Socle's #50).
// EisenQ has no admin role or flag, so the owner is the first account created
// in EisenQ's own Clerk application, the one that built the app. Only that
// account sees the Reminders setting or the bell, and the job never sends
// Socle an event for anyone else. Reminders also stay opt-in for the owner.
// No environment variable holds anyone's ID.

// The same rule as Socle's recipient.id: 1 to 64 of A-Z, a-z, 0-9, _ and -.
// Clerk's user IDs ("user_…") fit it.
export const RECIPIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const OWNER_TTL_MS = 10 * 60_000;
let ownerCache: { at: number; id: Promise<string | null> } | null = null;

async function lookUpOwner(): Promise<string | null> {
  try {
    const { data } = await (await clerkClient()).users.getUserList({ orderBy: "+created_at", limit: 1 });
    const id = data[0]?.id;
    return id && RECIPIENT_ID.test(id) ? id : null;
  } catch (err) {
    // Fails closed: nobody gets reminders or the bell until Clerk answers.
    const errorName = err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name) ? err.name : "Error";
    logNotifications("warn", "notifications_owner_lookup_failed", { errorName });
    ownerCache = null;
    return null;
  }
}

/**
 * EisenQ's owner account: the oldest account in EisenQ's Clerk application.
 * Kept for 10 minutes in this server instance's memory only, so a dashboard
 * load doesn't always cost a Clerk call. Never stored or logged.
 */
export function eisenqOwnerId(opts: { fresh?: boolean } = {}): Promise<string | null> {
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

export interface NotificationsAccess {
  reminders: boolean; // may see and save the Reminders setting
  bell: boolean;      // gets the bell: also needs Socle's address and key
}

/** Pure: what one signed-in person gets, given the owner's ID and Socle's settings. */
export function accessFrom(userId: string, ownerId: string | null, socle: SocleConfig | null): NotificationsAccess {
  const owner = ownerId !== null && userId === ownerId;
  return { reminders: owner, bell: owner && socle !== null };
}

/** What one signed-in person gets. Everything is off unless they are the owner. */
export async function notificationsAccess(userId: string): Promise<NotificationsAccess> {
  return accessFrom(userId, await eisenqOwnerId(), socleConfig());
}

// What PUT /api/settings may change. Each field is optional: absent means
// unchanged, like the rest of Settings.
export const reminderSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    thresholdDays: z.number().int().min(REMINDER_THRESHOLD_MIN).max(REMINDER_THRESHOLD_MAX),
    repeat: z.enum(["daily", "never"]),
  })
  .partial();
export type ReminderSettingsUpdate = z.infer<typeof reminderSettingsUpdateSchema>;

/** Dot-path $set entries, so saving the setting never touches the rest of the document. */
export function reminderUpdateToSet(update: ReminderSettingsUpdate): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(update)) {
    if (v !== undefined) set[`notifications.staleTasks.${k}`] = v;
  }
  return set;
}

// One JSON line per event, for Vercel's logs. Counts, statuses and problem
// types only (legal's condition 5 on Socle's #50): never an email, a task
// title, a user ID, a key, a hash or a response body.
export type LogField = string | number | boolean | undefined;

export function logNotifications(level: "info" | "warn" | "error", event: string, fields: Record<string, LogField> = {}) {
  const line = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
