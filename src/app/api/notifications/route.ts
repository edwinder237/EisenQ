import { type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { bulkActionSchema } from "~/lib/notifications/schema";
import { badRequest } from "~/server/notifications-stub";
import { applyBulk, listNotifications } from "~/server/notification-service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/notifications → NotificationList (~/lib/notifications/types.ts)
 *
 * Derived with deriveNotifications() on the server, from the person's tasks,
 * maintenance and routines, in their time zone; stored per-id state merged on
 * top; hidden items left out; "needs" first, newest first. See
 * ~/server/notification-service.ts.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await listNotifications(userId), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Couldn't load notifications" }, { status: 500 });
  }
}

/**
 * POST /api/notifications  { action: "read_all" | "clear_fyi" } → 204
 *
 *  - read_all: readAt = now on every item currently listed.
 *  - clear_fyi: every listed "fyi" item hidden for good. Never touches "needs".
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bulkActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  try {
    await applyBulk(userId, parsed.data.action);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Couldn't update notifications" }, { status: 500 });
  }
}
