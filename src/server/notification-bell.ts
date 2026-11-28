import "server-only";
import { userSettingsCollection } from "~/server/db";
import { logNotifications } from "~/server/notification-access";
import type { SocleClient } from "~/server/socle";

// The bell's notices (amended design record, points 1 and 2). Socle's bell
// component, copied into src/vendor/socle-bell/, shows EisenQ's own reminders
// and the notices sent through Socle, such as the daily summary's copy. For
// the notices it needs a session, which EisenQ's own signed-in route
// (GET /api/notifications/bell-session) asks Socle for, once per dashboard
// load, for the signed-in person only.
//
// - The person's ID comes from their Clerk session, never from the request.
// - With their bell off (EisenQ's copy of Socle's switch), no session and no
//   call to Socle, so the browser never reaches the bell's provider.
// - The session is opaque: passed on as Socle gave it, never read, stored,
//   cached or logged.

export type BellSessionAnswer =
  | { session: string; expiresAt: string }
  | { session: null };

export class BellUnavailable extends Error {}

export async function bellSessionFor(
  userId: string,
  socle: SocleClient | null,
  now = new Date(),
): Promise<BellSessionAnswer> {
  const doc = await userSettingsCollection.findOne(
    { userId },
    { projection: { notificationChannels: 1 } },
  );
  // Every account that opens the dashboard has a settings record, so the
  // daily job reaches it too (its summary's copy in the bell).
  if (!doc)
    await userSettingsCollection.updateOne(
      { userId },
      { $setOnInsert: { userId, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
  if (doc?.notificationChannels?.bell === false) return { session: null };
  // Preview and local builds: reminders only.
  if (!socle) return { session: null };

  const answer = await socle.bellSession(userId);
  if (answer.kind === "ok")
    return { session: answer.session, expiresAt: answer.expiresAt };
  if (answer.kind === "problem")
    logNotifications("warn", "bell_session_unavailable", {
      status: answer.status,
    });
  else
    logNotifications("warn", "bell_session_unavailable", {
      unreachable: answer.reason,
    });
  throw new BellUnavailable();
}
