import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { notificationActionSchema } from "~/lib/notifications/schema";
import { badRequest } from "~/server/notifications-http";
import { NotificationError, applyAction } from "~/server/notification-service";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/notifications/:id  NotificationAction → 204
 *
 * :id is the stable id from deriveNotifications(), e.g. "task_overdue:<taskId>".
 * State is stored per (userId, id); the item itself is re-derived, never stored.
 *
 *  - read:    readAt = now.
 *  - dismiss: "fyi" → hidden for good. "needs" → hidden until tomorrow 09:00
 *             local ("Not now"); back then if still true.
 *  - snooze:  later_today 18:00 (or now + 3 h if past) / tomorrow 09:00 /
 *             next Monday 09:00, local, with snoozeUntil(). "needs" only.
 *  - mute:    "Stop reminding me" → hidden for good for this id.
 *  - restore: Undo: the hidden-until from before the last change.
 *
 * Anything hidden is also left out of the next daily email.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = notificationActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  try {
    await applyAction(userId, id, parsed.data);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotificationError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Couldn't update that notification" }, { status: 500 });
  }
}
