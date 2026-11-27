import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { logNotifications, parseAllowedUserIds } from "~/server/notifications";
import { createSocleClient, socleConfig } from "~/server/socle";
import { clerkRecipientFor, runStaleTaskJob } from "~/server/stale-tasks";

// GET /api/cron/stale-tasks — the daily waiting-task job (vercel.json:
// "0 13 * * *", 13:00 UTC, which is 8:00 or 9:00 in Toronto). Vercel calls it
// on Production with "Authorization: Bearer <CRON_SECRET>", for the schedule
// and for a run by hand from the dashboard (Settings → Cron Jobs → Run).
//
// Listed in isPublicRoute (middleware.ts) because Vercel's cron call carries
// no Clerk session: "public" there only means the middleware doesn't check
// Clerk. This handler checks the secret before it reads anything.
//
// ?dryRun=1 sends nothing and writes nothing, and lists the task IDs it would
// send. The answer is counts only: never a title, an email or a user ID.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Constant time whatever the lengths: both sides are hashed first.
function bearerMatches(header: string | null, secret: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), digest(secret));
}

export async function GET(request: Request) {
  const secret = env.CRON_SECRET?.trim();
  // No secret, no job: a Preview or local build answers as if the route weren't there.
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const config = socleConfig();
  try {
    const summary = await runStaleTaskJob({
      socle: config ? createSocleClient(config) : null,
      allowedUserIds: parseAllowedUserIds(env.NOTIFICATIONS_ALLOWED_USER_IDS),
      recipientFor: clerkRecipientFor,
      dryRun,
    });
    return NextResponse.json(summary, { headers: NO_STORE });
  } catch (err) {
    // The error's name only: a driver's message can quote a connection string.
    const errorName = err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name) ? err.name : "Error";
    logNotifications("error", "stale_tasks_run_failed", { errorName });
    return NextResponse.json({ status: "error" }, { status: 500, headers: NO_STORE });
  }
}
