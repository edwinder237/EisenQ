import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { logNotifications, notificationsAccess } from "~/server/notifications";
import { createSocleClient, socleConfig } from "~/server/socle";

// POST /api/notifications/inbox-session — what the bell (Novu's Inbox) needs
// for the signed-in person: Novu's public application identifier, their
// subscriber ID and its HMAC hash. Clerk-protected (deny-by-default
// middleware). The dashboard calls it once per page load, and only when
// GET /api/settings said the bell is on for this person.
//
// The hash never expires and opens the person's bell, so it is fetched from
// Socle on each call, passed straight through, and never stored, cached or
// logged here; nor is the subscriber ID (legal's condition 5 on Socle's #50).

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  // The allowlist is checked before Socle is called, so nobody else costs a
  // call (finance's condition 8). Without Socle's address and key: no bell.
  const config = socleConfig();
  if (!config || !notificationsAccess(userId).bell) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  }

  const result = await createSocleClient(config).openInboxSession(userId);
  if (result.kind !== "session") {
    logNotifications(
      "warn",
      "inbox_session_refused",
      result.kind === "problem"
        ? { status: result.status, type: result.type, requestId: result.requestId }
        : { unreachable: result.reason },
    );
    return NextResponse.json({ error: "The bell is unavailable right now." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json(result.session, { headers: NO_STORE });
}
