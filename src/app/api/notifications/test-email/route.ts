import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { NotificationError } from "~/server/notification-service";
import { sendTestDigest } from "~/server/notification-digest";
import { createSocleClient, socleConfig } from "~/server/socle";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/test-email → { sentTo: string }
 *
 * Sends today's digest now through Socle, marked as a test, even when it would
 * be skipped for being empty. Three per hour. For now only EisenQ's owner
 * account can be emailed (legal, Socle's #50); anyone else gets 403.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const config = socleConfig();
    const result = await sendTestDigest(userId, { socle: config ? createSocleClient(config) : null });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof NotificationError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Couldn't send the test email" }, { status: 500 });
  }
}
