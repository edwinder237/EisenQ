import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { TaskServiceError } from "~/server/task-service";
import {
  createGoalSchema,
  updateGoalSchema,
  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,
} from "~/server/goal-service";

// The rules live in ~/server/goal-service, shared with AI connectors. This
// route only authenticates, parses and maps errors.

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof TaskServiceError) {
    return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(await listGoals(userId));
  } catch {
    return NextResponse.json({ error: "Failed to fetch goals" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody: unknown = await request.json();
    const parseResult = createGoalSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    return NextResponse.json(await createGoal(userId, parseResult.data), { status: 201 });
  } catch (err) {
    return errorResponse(err, "Failed to create goal");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody: unknown = await request.json();
    const parseResult = updateGoalSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { _id, ...changes } = parseResult.data;
    return NextResponse.json(await updateGoal(userId, _id, changes));
  } catch (err) {
    return errorResponse(err, "Failed to update goal");
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
      return NextResponse.json({ error: "Goal ID is required" }, { status: 400 });
    }

    await deleteGoal(userId, id);
    return NextResponse.json({ message: "Goal deleted successfully" });
  } catch (err) {
    return errorResponse(err, "Failed to delete goal");
  }
}
