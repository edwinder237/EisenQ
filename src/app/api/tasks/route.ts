import { type NextRequest, NextResponse } from "next/server";
import { tasksCollection } from "~/server/db";
import { auth } from "@clerk/nextjs/server";
import {
  TaskServiceError,
  createTaskSchema,
  updateTaskSchema,
  taskQuadrantSchema,
  taskPrioritySchema,
  taskStatusSchema,
  createTask,
  updateTask,
  deleteTask,
  listMatrixTasks,
} from "~/server/task-service";

// The rules live in ~/server/task-service, shared with the assistant and AI
// connectors. This route only authenticates, parses and maps errors.

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof TaskServiceError) {
    return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;

    // One-time backfill: tasks completed before completion stamping existed have
    // no completedAt, so they would render without a date forever. Stamp them
    // once with the current time. Self-limiting — after the first pass nothing
    // matches, so this costs an indexed no-op query per load.
    await tasksCollection.updateMany(
      { userId, status: "completed", completedAt: { $exists: false } },
      { $set: { completedAt: new Date() } }
    );

    // Invalid enum values are ignored rather than rejected, as before.
    const tasks = await listMatrixTasks(userId, {
      search: searchParams.get("search") ?? undefined,
      quadrant: taskQuadrantSchema.safeParse(searchParams.get("quadrant")).data,
      priority: taskPrioritySchema.safeParse(searchParams.get("priority")).data,
      status: taskStatusSchema.safeParse(searchParams.get("status")).data,
    });

    return NextResponse.json(tasks);
  } catch {
    return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody: unknown = await request.json();
    const parseResult = createTaskSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const task = await createTask(userId, parseResult.data);
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create task");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody: unknown = await request.json();
    const parseResult = updateTaskSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { _id, ...changes } = parseResult.data;
    const task = await updateTask(userId, _id, changes);
    return NextResponse.json(task);
  } catch (err) {
    return errorResponse(err, "Failed to update task");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Task ID is required" }, { status: 400 });
    }

    await deleteTask(userId, id);
    return NextResponse.json({ message: "Task deleted successfully" });
  } catch (err) {
    return errorResponse(err, "Failed to delete task");
  }
}
