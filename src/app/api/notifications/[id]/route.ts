import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { notificationActionSchema } from "~/lib/notifications/schema";
import { badRequest, notImplemented } from "~/server/notifications-stub";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/notifications/:id  NotificationAction → 204
 *
 * :id is the stable id from deriveNotifications(), e.g. "task_overdue:<taskId>".
 * Store state per (userId, id); the item itself is re-derived, never stored.
 *
 * TODO(backend):
 *  - read:    readAt = now.
 *  - dismiss: group "fyi" → hidden forever.
 *             group "needs" → hidden until tomorrow 09:00 local ("Not now").
 *             It comes back then if still true (task still overdue, etc.).
 *  - snooze:  hidden until later_today 18:00 (or now+3h if past) / tomorrow
 *             09:00 / next Monday 09:00, local. Use snoozeUntil() in derive.ts.
 *  - mute:    "Stop reminding me" → hidden forever for this id. Ids embed the
 *             occurrence (e.g. the maintenance due date), so the next cycle
 *             still notifies.
 *  - restore: Undo. Put back the hidden-until value from before the last
 *             change to this id (keep one previous value per id).
 *  - Anything hidden must also be left out of the next daily digest email.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = notificationActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  return notImplemented(`"${parsed.data.action}" on ${id}. See the comment on PATCH in this file.`);
}
