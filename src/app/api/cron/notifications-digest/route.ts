import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { logNotifications } from "~/server/notification-access";
import { runDigests } from "~/server/notification-digest";
import { createSocleClient, socleConfig } from "~/server/socle";

// GET /api/cron/notifications-digest — the daily notifications email
// (vercel.json: every 15 minutes). Each run sends the digest to whoever's
// digest.sendAt has come in their own time zone, once per local day. Vercel
// calls it on Production with "Authorization: Bearer <CRON_SECRET>", for the
// schedule and for a run by hand from the dashboard (Settings → Cron Jobs).
//
// Listed in isPublicRoute (middleware.ts) because Vercel's cron call carries
// no Clerk session: "public" there only means the middleware doesn't check
// Clerk. This handler checks the secret before it reads anything. The answer
// says what happened, never who or what.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Constant time whatever the lengths: both sides are hashed first.
function bearerMatches(header: string | null, secret: string): boolean {
  const presented = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  return timingSafeEqual(digest(presented), digest(secret));
}

export async function GET(request: Request) {
  const secret = env.CRON_SECRET?.trim();
  // No secret, no job: a Preview or local build answers as if the route weren't there.
  if (!secret)
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }
  try {
    const config = socleConfig();
    const summary = await runDigests({
      socle: config ? createSocleClient(config) : null,
    });
    return NextResponse.json(summary, { headers: NO_STORE });
  } catch (err) {
    // The error's name only: a driver's message can quote a connection string.
    const errorName =
      err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name)
        ? err.name
        : "Error";
    logNotifications("error", "digest_run_failed", { errorName });
    return NextResponse.json(
      { error: "The digest run failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
