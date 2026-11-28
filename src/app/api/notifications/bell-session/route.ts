import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { BellUnavailable, bellSessionFor } from "~/server/notification-bell";
import { socleClient } from "~/server/socle";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/notifications/bell-session → { session: string, expiresAt } | { session: null }
 *
 * For Socle's bell component on the dashboard, once per page load. The
 * signed-in person's own bell session, from Socle (POST
 * /v1/notifications/bell-sessions, EisenQ's key, scope notifications:bell).
 * The ID comes from the Clerk session only: nothing in the request is read.
 * { session: null } without calling Socle when the person's bell is off.
 * Sent with no-store; nothing about the person is logged.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    return NextResponse.json(await bellSessionFor(userId, socleClient()), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BellUnavailable)
      return NextResponse.json({ error: "The bell's notices aren't available right now." }, { status: 503, headers: NO_STORE });
    return NextResponse.json({ error: "Couldn't open the bell" }, { status: 500, headers: NO_STORE });
  }
}
