import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { env } from "~/env";
import { RECIPIENT_ID, errorNameOf, logNotifications } from "~/server/notification-access";
import { deleteNotificationsFor } from "~/server/notification-deletion";
import { socleClient } from "~/server/socle";

// POST /api/webhooks/clerk: EisenQ's Clerk tells EisenQ an account was
// deleted ("user.deleted"), and EisenQ deletes that person's notifications,
// its own and Socle's (legal's deletion rule; ~/server/notification-deletion.ts).
//
// Listed in isPublicRoute (middleware.ts) because Clerk's call carries no
// Clerk session: "public" there only means the middleware doesn't check
// Clerk. This handler checks Clerk's signature with CLERK_WEBHOOK_SIGNING_SECRET
// before it reads anything. Without the secret the route answers 404.
// Nothing about the person is logged or answered.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  const signingSecret = env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
  if (!signingSecret) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(req, { signingSecret });
  } catch {
    logNotifications("warn", "clerk_webhook_refused");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400, headers: NO_STORE });
  }

  if (event.type !== "user.deleted") {
    // Only user.deleted is subscribed; anything else is acknowledged and left alone.
    logNotifications("info", "clerk_webhook_ignored", { type: /^[a-zA-Z.]{1,64}$/.test(event.type) ? event.type : "other" });
    return NextResponse.json({ received: true }, { headers: NO_STORE });
  }
  const userId = event.data.id;
  if (!userId || !RECIPIENT_ID.test(userId)) {
    logNotifications("warn", "clerk_webhook_ignored", { type: "user.deleted", reason: "no-id" });
    return NextResponse.json({ received: true }, { headers: NO_STORE });
  }

  try {
    const outcome = await deleteNotificationsFor(userId, socleClient());
    logNotifications("info", "account_notifications_deleted", { outcome });
    // "pending": EisenQ's rows are gone and the daily job retries Socle, so
    // Clerk needn't send it again.
    return NextResponse.json({ received: true }, { headers: NO_STORE });
  } catch (err) {
    // EisenQ's own database failed: a 500 makes Clerk send the event again.
    logNotifications("error", "account_notifications_delete_failed", { errorName: errorNameOf(err) });
    return NextResponse.json({ error: "Couldn't delete the account's notifications" }, { status: 500, headers: NO_STORE });
  }
}
