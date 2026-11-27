import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { itemReminderSchema } from "~/lib/notifications/schema";
import { badRequest, notImplemented } from "~/server/notifications-stub";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/reminders?kind=maintenance&itemId=… → ItemReminder
 *
 * TODO(backend): suggested storage is a `reminderLead` field on the
 * MaintenanceItem (and later routine) document; null = use the default lead.
 * Check the item belongs to userId.
 */
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = req.nextUrl.searchParams.get("kind");
  const itemId = req.nextUrl.searchParams.get("itemId");
  if ((kind !== "maintenance" && kind !== "routine") || !itemId) return badRequest("kind and itemId are required");
  return notImplemented(`Read the reminder for ${kind} ${itemId}.`);
}

/** PUT /api/notifications/reminders  ItemReminder → ItemReminder */
export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = itemReminderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues);
  return notImplemented(`Save the reminder for ${parsed.data.kind} ${parsed.data.itemId}.`);
}
