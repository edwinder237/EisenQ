import "server-only";
import {
  notificationDeletionsCollection,
  notificationStatesCollection,
  userSettingsCollection,
} from "~/server/db";
import { logNotifications } from "~/server/notification-access";
import type { SocleClient } from "~/server/socle";

// A deleted EisenQ account (legal's deletion rule, edwinder237/socle,
// docs/privacy/eisenq-notifications-deletion.md, point 1). Clerk's
// "user.deleted" event (POST /api/webhooks/clerk) calls deleteNotificationsFor:
// - EisenQ deletes its own notification data for the person: the bell's
//   per-id state, the notification settings, the copy of Socle's switches,
//   the sent-today record and the test counter. Both switches are left off,
//   so nothing is ever sent for that ID again.
// - Then Socle deletes its stored choices and everything at delivery
//   (POST /v1/notifications/recipients/delete).
// - If Socle doesn't confirm, only the user ID waits in notificationDeletions,
//   and the daily job retries it each run until Socle answers 204.
// Nothing about the person is logged.

export const MAX_DELETIONS_PER_RUN = 20;

/** EisenQ's own notification data for the person, gone; both switches off for good. */
export async function clearNotificationData(userId: string, now: Date) {
  await notificationStatesCollection.deleteMany({ userId });
  await userSettingsCollection.updateOne(
    { userId },
    {
      $unset: {
        notifications: "",
        notificationDigest: "",
        notificationTests: "",
      },
      $set: {
        notificationChannels: { email: false, bell: false, checkedAt: now },
        updatedAt: now,
      },
    },
  );
}

async function keepPending(userId: string, now: Date) {
  await notificationDeletionsCollection.updateOne(
    { userId },
    {
      $setOnInsert: { userId, since: now },
      $set: { lastTriedAt: now },
      $inc: { attempts: 1 },
    },
    { upsert: true },
  );
}

/** "deleted" once Socle confirmed; "pending" while the daily job still has to retry Socle. */
export async function deleteNotificationsFor(
  userId: string,
  socle: SocleClient | null,
  now = new Date(),
): Promise<"deleted" | "pending"> {
  await clearNotificationData(userId, now);
  const result = socle ? await socle.deleteRecipient(userId) : null;
  if (result?.kind === "deleted") {
    await notificationDeletionsCollection.deleteMany({ userId });
    return "deleted";
  }
  if (result?.kind === "problem")
    logNotifications("warn", "notification_deletion_pending", {
      status: result.status,
    });
  else
    logNotifications("warn", "notification_deletion_pending", {
      unreachable: result?.reason ?? "not-configured",
    });
  await keepPending(userId, now);
  return "pending";
}

/**
 * The daily job's retries, oldest first. It stops at the first one Socle
 * doesn't confirm: Socle is likely down, and the run's time is the summaries'.
 * The rest wait for the next run.
 */
export async function retryPendingDeletions(
  socle: SocleClient,
  now = new Date(),
  max = MAX_DELETIONS_PER_RUN,
): Promise<{ done: number; pending: number }> {
  const waiting = await notificationDeletionsCollection
    .find({})
    .sort({ since: 1 })
    .limit(max)
    .toArray();
  let done = 0;
  for (const { userId } of waiting) {
    const result = await socle.deleteRecipient(userId);
    if (result.kind !== "deleted") {
      await keepPending(userId, now);
      break;
    }
    await notificationDeletionsCollection.deleteMany({ userId });
    done++;
  }
  const pending =
    waiting.length === 0
      ? 0
      : await notificationDeletionsCollection.countDocuments({});
  return { done, pending };
}
