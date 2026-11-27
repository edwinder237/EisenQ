import { type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { bulkActionSchema } from "~/lib/notifications/schema";
import { badRequest, notImplemented } from "~/server/notifications-stub";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications → NotificationList (~/lib/notifications/types.ts)
 *
 * TODO(backend):
 *  - Derive the current items with deriveNotifications() from
 *    ~/lib/notifications/derive.ts (tasks, maintenance, missed routines,
 *    preferences, per-item leads), so client and server share one rulebook.
 *  - Merge the stored per-item state by id: readAt, hidden-until.
 *  - Drop items hidden until a time still in the future, or hidden forever.
 *  - Sort: "needs" first, then "fyi"; newest first within each.
 *  - unreadCount = items with readAt null.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return notImplemented("List the current notifications. See the comment on GET in this file.");
}

/**
 * POST /api/notifications  { action: "read_all" | "clear_fyi" } → 204
 *
 * TODO(backend):
 *  - read_all: set readAt = now on every item currently listed.
 *  - clear_fyi: hide every listed "fyi" item forever. Never touches "needs".
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bulkActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  return notImplemented(`Bulk action "${parsed.data.action}". See the comment on POST in this file.`);
}
