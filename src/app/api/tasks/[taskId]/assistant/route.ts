import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { tasksCollection } from "~/server/db";
import { TaskServiceError } from "~/server/task-service";
import { handToAssistant, takeBackFromAssistant } from "~/server/assistant-routine";

// GET    — the task's hand-off and checklists, for polling while the Assistant works
// POST   — hand the task to the Assistant (fires the person's Claude routine)
// PATCH  — change step owners while it's with the Assistant
// DELETE — take it back

const owner = z.enum(["you", "assistant", "sam", "noor"]);
const postSchema = z.object({
  mode: z.enum(["steps", "outcome"]),
  stepOwners: z.record(z.string().max(100), owner).default({}),
});

type Params = { params: Promise<{ taskId: string }> };

function errorResponse(err: unknown) {
  if (err instanceof TaskServiceError) {
    return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
  }
  console.error("Assistant hand-off failed", err);
  return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!ObjectId.isValid(taskId)) return NextResponse.json({ error: "Invalid task ID" }, { status: 400 });
  const task = await tasksCollection.findOne(
    { _id: new ObjectId(taskId), userId },
    { projection: { assistantRun: 1, checklists: 1, status: 1 } },
  );
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json(
    { assistantRun: task.assistantRun ?? null, checklists: task.checklists ?? [], status: task.status },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { taskId } = await params;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
    const task = await handToAssistant(userId, taskId, parsed.data);
    return NextResponse.json({ assistantRun: task.assistantRun });
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z.object({ stepOwners: z.record(z.string().max(100), owner) });

/** Change who does which step while the task is with the Assistant. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!ObjectId.isValid(taskId)) return NextResponse.json({ error: "Invalid task ID" }, { status: 400 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
  const res = await tasksCollection.updateOne(
    { _id: new ObjectId(taskId), userId, assistantRun: { $exists: true } },
    { $set: { "assistantRun.stepOwners": parsed.data.stepOwners, updatedAt: new Date() } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "This task isn't with the Assistant." }, { status: 404 });
  return NextResponse.json({ success: true });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { taskId } = await params;
    await takeBackFromAssistant(userId, taskId);
    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}
