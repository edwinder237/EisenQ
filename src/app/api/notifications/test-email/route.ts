import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { NotificationError } from "~/server/notification-service";
import { sendTestDigest } from "~/server/notification-digest";
import { socleClient } from "~/server/socle";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/test-email → { sentTo: string }
 *
 * Sends today's summary now through Socle, marked as a test, even when it
 * would be skipped for being empty. Any account, to its own verified primary
 * email, only while its email is on in Socle, and 3 a day.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await sendTestDigest(userId, { socle: socleClient() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof NotificationError) return NextResponse.json({ error: err.message }, { status: err.status, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ error: "Couldn't send the test email" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
