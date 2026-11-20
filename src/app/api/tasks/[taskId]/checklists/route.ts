import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { tasksCollection } from "~/server/db";
import { loadMyndlistCredentials, copyChecklistFromMyndlist } from "~/server/myndlist";

// POST /api/tasks/[taskId]/checklists — attach a Myndlist checklist to a task.
//
// Attaching DEEP-COPIES the template's steps onto the task document. After that
// the two are independent: editing the template does not rewrite instances that
// already ran, and ticking an instance never touches the template.

const attachSchema = z.object({ sourceId: z.string().min(1).max(200) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { taskId } = await params;
    if (!ObjectId.isValid(taskId)) {
      return NextResponse.json({ error: "Invalid task ID" }, { status: 400 });
    }

    const rawBody: unknown = await request.json();
    const parsed = attachSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const task = await tasksCollection.findOne({ _id: new ObjectId(taskId), userId });
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const creds = await loadMyndlistCredentials(userId);
    if (!creds.apiUrl || !creds.apiKey) {
      return NextResponse.json({ error: "Connect Myndlist in Settings → Integrations first." }, { status: 400 });
    }

    const copied = await copyChecklistFromMyndlist(userId, creds, parsed.data.sourceId, (task.checklists ?? []).length);
    if ("error" in copied) return NextResponse.json({ error: copied.error }, { status: 502 });
    const { checklist } = copied;

    await tasksCollection.updateOne(
      { _id: new ObjectId(taskId), userId },
      { $push: { checklists: checklist }, $set: { updatedAt: new Date() } }
    );

    return NextResponse.json({ checklist }, { status: 201 });
  } catch (err) {
    console.error("Attach checklist: request failed", err);
    return NextResponse.json({ error: "Failed to attach checklist" }, { status: 500 });
  }
}
