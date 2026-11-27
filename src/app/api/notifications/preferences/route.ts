import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { preferencesSchema } from "~/lib/notifications/schema";
import { badRequest, notImplemented } from "~/server/notifications-stub";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/preferences → NotificationPreferences
 *
 * TODO(backend): read from user settings (suggested: UserSettings.notifications),
 * fill gaps from DEFAULT_NOTIFICATION_PREFERENCES, and set digest.address to
 * the Clerk primary email (read-only for the client).
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return notImplemented("Return saved preferences with defaults filled in.");
}

/**
 * PUT /api/notifications/preferences  NotificationPreferences → NotificationPreferences
 *
 * TODO(backend): save (ignore digest.address), reschedule the digest for the
 * new sendAt in the person's time zone, and return what was stored.
 */
export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = preferencesSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  return notImplemented("Save preferences and return them.");
}
