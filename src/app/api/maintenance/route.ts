import { type NextRequest, NextResponse } from "next/server";
import { maintenanceItemsCollection } from "~/server/db";
import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { markMaintenanceDone } from "~/server/routine-links";

const createSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title too long"),
  description: z.string().max(2000, "Description too long").optional(),
  intervalDays: z.number().int().min(1).max(3650),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});

const updateSchema = z.object({
  _id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  intervalDays: z.number().int().min(1).max(3650).optional(),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const items = await maintenanceItemsCollection
      .find({ userId })
      .sort({ nextDueDate: 1 })
      .toArray();

    return NextResponse.json(items);
  } catch {
    return NextResponse.json({ error: "Failed to fetch maintenance items" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }

    const now = new Date();
    const result = await maintenanceItemsCollection.insertOne({
      ...parsed.data,
      userId,
      createdAt: now,
      updatedAt: now,
    });

    const newItem = await maintenanceItemsCollection.findOne({ _id: result.insertedId });
    return NextResponse.json(newItem, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create maintenance item" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }

    const { _id, description, ...updateData } = parsed.data;
    // An empty or null description clears it
    const clearDescription = description === null || (description !== undefined && !description.trim());
    const update: { $set: Record<string, unknown>; $unset?: Record<string, "" > } = {
      $set: { ...updateData, updatedAt: new Date() },
    };
    if (clearDescription) update.$unset = { description: "" };
    else if (description !== undefined) update.$set.description = description;

    const result = await maintenanceItemsCollection.findOneAndUpdate(
      { _id: new ObjectId(_id), userId },
      update,
      { returnDocument: "after" }
    );

    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Failed to update maintenance item" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

    await maintenanceItemsCollection.deleteOne({ _id: new ObjectId(id), userId });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete maintenance item" }, { status: 500 });
  }
}

// PATCH — mark as done (resets the timer)
export async function PATCH(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = z.object({ _id: z.string().min(1) }).safeParse(await request.json());
    if (!body.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

    if (!ObjectId.isValid(body.data._id)) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    // Also completes any task scheduled for this item.
    const result = await markMaintenanceDone(userId, new ObjectId(body.data._id));
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Failed to mark item as done" }, { status: 500 });
  }
}
