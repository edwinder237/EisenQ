import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { preferencesSchema } from "~/lib/notifications/schema";
import type { NotificationPreferences } from "~/lib/notifications/types";
import { badRequest } from "~/server/notifications-http";
import { clerkPrimaryEmail } from "~/server/notification-access";
import { loadContext, savePreferences } from "~/server/notification-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function preferencesFor(userId: string): Promise<NotificationPreferences> {
  const [{ prefs }, address] = await Promise.all([loadContext(userId), clerkPrimaryEmail(userId)]);
  return { ...prefs, digest: { ...prefs.digest, ...(address ? { address } : {}) } };
}

/**
 * GET /api/notifications/preferences → NotificationPreferences
 *
 * Saved in UserSettings.notifications, gaps filled from
 * DEFAULT_NOTIFICATION_PREFERENCES. digest.address is the Clerk primary email
 * (read-only for the client).
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await preferencesFor(userId), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Couldn't load notification settings" }, { status: 500 });
  }
}

/**
 * PUT /api/notifications/preferences  NotificationPreferences → NotificationPreferences
 *
 * digest.address is ignored. The digest needs no rescheduling: the cron reads
 * sendAt, in the person's time zone, on every run.
 */
export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = preferencesSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  try {
    await savePreferences(userId, parsed.data);
    return NextResponse.json(await preferencesFor(userId), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Couldn't save notification settings" }, { status: 500 });
  }
}
