import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { itemReminderSchema } from "~/lib/notifications/schema";
import { badRequest } from "~/server/notifications-http";
import { NotificationError, getItemReminder, setItemReminder } from "~/server/notification-service";

export const dynamic = "force-dynamic";

function errorResponse(err: unknown) {
  if (err instanceof NotificationError) return NextResponse.json({ error: err.message }, { status: err.status });
  return NextResponse.json({ error: "Couldn't load the reminder" }, { status: 500 });
}

/**
 * GET /api/notifications/reminders?kind=maintenance&itemId=… → ItemReminder
 *
 * Stored as `reminderLead` on the MaintenanceItem; unset (null here) means the
 * default lead from preferences. The item must be the person's own. Routines
 * have no override yet, so they always answer null.
 */
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = req.nextUrl.searchParams.get("kind");
  const itemId = req.nextUrl.searchParams.get("itemId");
  if ((kind !== "maintenance" && kind !== "routine") || !itemId) return badRequest("kind and itemId are required");
  try {
    return NextResponse.json(await getItemReminder(userId, kind, itemId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/notifications/reminders  ItemReminder → ItemReminder */
export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = itemReminderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  try {
    return NextResponse.json(await setItemReminder(userId, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}
