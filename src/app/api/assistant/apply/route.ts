import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { QUADRANT_NAMES, SERVER_APPLIED_ACTIONS, TaskServiceError, applySuggestion } from "~/server/task-service";
import { logActivity } from "~/server/mcp-settings";
import { isValidTimeZone } from "~/server/timezone";

// Applies one in-app assistant suggestion through the shared task rules, and
// records it in the same activity log as AI connectors, so Settings → AI
// connectors shows changes from every AI in one place. move_to_top stays in
// the browser: it reorders against what the dashboard is showing.

const schema = z.object({
  taskId: z.string().min(1),
  action: z.enum(SERVER_APPLIED_ACTIONS),
  value: z.string().max(100),
  // The browser's zone, so "set due Friday" means 9:00 on the person's Friday.
  timeZone: z.string().max(64).refine(isValidTimeZone),
});

const DESCRIBE: Record<(typeof SERVER_APPLIED_ACTIONS)[number], (v: string) => string> = {
  move_quadrant: (v) => `moved to ${QUADRANT_NAMES[v as keyof typeof QUADRANT_NAMES] ?? v}`,
  set_priority: (v) => `${v} priority`,
  set_due_date: (v) => `due ${v}`,
  archive: () => "archived",
  link_goal: () => "linked to a goal",
};

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request data" }, { status: 400 });

  const { timeZone, ...suggestion } = parsed.data;
  try {
    const task = await applySuggestion(userId, suggestion, timeZone);
    await logActivity(userId, {
      clientId: "eisenq-assistant",
      clientName: "EisenQ assistant",
      tool: suggestion.action,
      summary: `“${task.title}”: ${DESCRIBE[suggestion.action](suggestion.value)}`,
      taskId: suggestion.taskId,
    }).catch(() => undefined); // the log never blocks the change itself
    return NextResponse.json(task, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof TaskServiceError) {
      return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
    }
    return NextResponse.json({ error: "Couldn't apply that suggestion" }, { status: 500 });
  }
}
