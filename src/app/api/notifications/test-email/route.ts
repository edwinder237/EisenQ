import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { notImplemented } from "~/server/notifications-stub";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/test-email → { sentTo: string }
 *
 * TODO(backend): send today's digest now to the account email, even when it
 * would be skipped for having nothing in it (say so in the email). Rate-limit
 * to a few per hour.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return notImplemented("Send a test digest email.");
}
