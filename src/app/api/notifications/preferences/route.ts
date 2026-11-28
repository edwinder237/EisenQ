import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { preferencesSchema } from "~/lib/notifications/schema";
import { badRequest } from "~/server/notifications-http";
import { NotificationError } from "~/server/notification-service";
import { readPreferences, writePreferences } from "~/server/notification-preferences";
import { socleClient } from "~/server/socle";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/notifications/preferences → NotificationPreferences
 *
 * EisenQ's own fields from UserSettings.notifications, gaps filled from
 * DEFAULT_NOTIFICATION_PREFERENCES, and the email and bell switches from
 * Socle, asked by this server with EisenQ's key (never by the browser).
 * digest.address is the verified Clerk primary email (read-only).
 *
 * ?cached=1: EisenQ's last copy of the switches, without asking Socle or
 * Clerk. For the bell's footer.
 */
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const cached = req.nextUrl.searchParams.get("cached") === "1";
    return NextResponse.json(await readPreferences(userId, socleClient(), { cached }), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Couldn't load notification settings" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PUT /api/notifications/preferences  NotificationPreferences → NotificationPreferences
 *
 * The email and bell switches the person changed go to Socle first. If Socle
 * can't take them: 503 { error }, and nothing is saved. digest.address is
 * ignored. The digest needs no rescheduling: the cron reads sendAt, in the
 * person's time zone, on every run.
 */
export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = preferencesSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  try {
    return NextResponse.json(await writePreferences(userId, parsed.data, socleClient()), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof NotificationError) return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    return NextResponse.json({ error: "Couldn't save notification settings" }, { status: 500, headers: NO_STORE });
  }
}
