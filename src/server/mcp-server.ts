import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ObjectId } from "mongodb";
import type { Goal, McpSettings, Task, TaskQuadrant, TaskSource } from "~/server/db/schema";
import { goalsCollection, tasksCollection } from "~/server/db";
import {
  QUADRANT_NAMES,
  QUADRANT_BY_NAME,
  TaskServiceError,
  compareMatrixOrder,
  completeTask,
  createTask,
  listMatrixTasks,
  loadOpenTasksAndGoals,
  removeTask,
  taskPrioritySchema,
  updateTask,
  type UpdateTaskInput,
} from "~/server/task-service";
import {
  createGoal,
  createGoalSchema,
  dateKeyRegex,
  goalProgress,
  listGoals,
  updateGoal,
  weekKeyFor,
  type UpdateGoalInput,
} from "~/server/goal-service";
import { logActivity, takeWriteSlot } from "~/server/mcp-settings";
import { formatInZone, ymdInZone, zonedWallTimeToUtc } from "~/server/timezone";
import { PRIORITIZATION_GUIDELINES } from "~/server/assistant";

// The tools an AI app (Claude, ChatGPT, ...) sees when EisenQ is added as a
// connector. Built fresh for every request from that request's settings, so a
// switch flipped in Settings applies to the very next call. Every write goes
// through the same task and goal services as the dashboard.

export interface McpCallContext {
  userId: string;
  clientId: string;
  clientName: string;
  mcp: McpSettings;
  autoArchive: boolean;
}

// ===== Inputs =====

const quadrantName = z
  .enum(["Do First", "Schedule", "Delegate", "Eliminate"])
  .describe("Do First = urgent & important, Schedule = important not urgent, Delegate = urgent not important, Eliminate = neither");

const dueInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "Use YYYY-MM-DD or YYYY-MM-DDTHH:MM")
  .describe("Due date in the person's own time zone: YYYY-MM-DD (means 9:00 AM that day) or YYYY-MM-DDTHH:MM");

const idInput = z.string().regex(/^[0-9a-f]{24}$/i, "Not an EisenQ id");

function parseDue(value: string, tz: string): string {
  const [ymd = "", time] = value.split("T");
  const [h = 9, m = 0] = time ? time.split(":").map(Number) : [9, 0];
  return zonedWallTimeToUtc(ymd, h, m, tz).toISOString();
}

// ===== Outputs =====

function ok(text: string, data?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: data === undefined ? text : `${text}\n\n${JSON.stringify(data, null, 1)}` }],
  };
}

function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Runs a tool body, turning service errors into a message the AI can relay. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TaskServiceError) return fail(err.message);
    console.error("MCP tool failed", err);
    return fail("EisenQ couldn't complete that just now. Try again in a moment.");
  }
}

function taskView(t: Task, tz: string, goalTitles: Map<string, string>, now: Date, extra: Record<string, unknown> = {}) {
  const due = t.dueDate ? new Date(t.dueDate) : undefined;
  return {
    id: String(t._id),
    title: t.title,
    quadrant: QUADRANT_NAMES[t.quadrant],
    priority: t.priority,
    status: t.status,
    due: due ? formatInZone(due, tz) : undefined,
    overdue: due && t.status !== "completed" && due < now ? true : undefined,
    durationMin: t.duration,
    goal: t.goalId ? goalTitles.get(String(t.goalId)) ?? undefined : undefined,
    goalId: t.goalId ? String(t.goalId) : undefined,
    notes: t.description ? t.description.slice(0, 500) : undefined,
    addedBy: t.source?.kind === "agent" ? t.source.title : undefined,
    ...extra,
  };
}

function goalPeriodLabel(g: Goal): string {
  if (g.periodType === "week") return `week of ${g.periodKey}`;
  if (g.periodType === "month") return `month ${g.periodKey}`;
  if (g.periodType === "year") return `year ${g.periodKey}`;
  return `${g.startDate ?? g.periodKey} → ${g.endDate ?? "?"}`;
}

async function goalTitleMap(userId: string): Promise<Map<string, string>> {
  const goals = await goalsCollection.find({ userId }, { projection: { title: 1 } }).toArray();
  return new Map(goals.map((g) => [String(g._id), g.title]));
}

// ===== Server =====

export function buildMcpServer(c: McpCallContext): McpServer {
  const { permissions: p, preferences: prefs } = c.mcp;
  const tz = prefs.timeZone;
  const today = ymdInZone(new Date(), tz);

  const off = Object.entries({
    "reading tasks": p.readTasks,
    "adding tasks": p.createTasks,
    "editing tasks": p.editTasks,
    "completing tasks": p.completeTasks,
    "removing tasks": p.deleteTasks,
    "reading goals": p.readGoals,
    "creating and editing goals": p.editGoals,
  })
    .filter(([, allowed]) => !allowed)
    .map(([what]) => what);

  const server = new McpServer(
    { name: "eisenq", title: "EisenQ", version: "1.0.0" },
    {
      instructions: [
        "EisenQ is the person's Eisenhower-matrix to-do list. Every task sits in one quadrant:",
        "Do First (urgent & important), Schedule (important, not urgent), Delegate (urgent, not important), Eliminate (neither).",
        `Today is ${today} in the person's time zone (${tz}). Dates you send are read in that zone; a plain date means 9:00 AM.`,
        "Each quadrant's first open task is its 'next action'. Look a task up with list_tasks before changing it, and use its id.",
        off.length
          ? `The person has switched off: ${off.join(", ")}. If they ask for one of these, tell them to turn it on in EisenQ → Settings → AI connectors.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  );

  /** Wraps a write: daily limit first, activity line after. */
  async function write(tool: string, fn: () => Promise<{ result: CallToolResult; summary: string; taskId?: string }>) {
    return guard(async () => {
      if (!(await takeWriteSlot(c.userId, prefs))) {
        return fail(
          `EisenQ's daily limit of ${prefs.dailyWriteLimit} changes from AI apps is reached. It resets at midnight, or the person can raise it in Settings → AI connectors.`,
        );
      }
      const { result, summary, taskId } = await fn();
      await logActivity(c.userId, { clientId: c.clientId, clientName: c.clientName, tool, summary, taskId });
      return result;
    });
  }

  // ----- Reading -----

  if (p.readTasks) {
    server.registerTool(
      "list_tasks",
      {
        title: "List tasks",
        description:
          "List the person's tasks in the matrix, in the order the app shows them. Each quadrant's first open task is flagged nextAction. Archived tasks and subtasks are left out.",
        inputSchema: z.object({
          quadrant: quadrantName.optional(),
          search: z.string().max(100).optional().describe("Text to look for in titles and notes"),
          include_completed: z
            .boolean()
            .optional()
            .describe(prefs.shareCompleted ? "Also list completed tasks" : "Not available: the person keeps completed tasks private"),
          limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) =>
        guard(async () => {
          const now = new Date();
          const includeCompleted = prefs.shareCompleted && args.include_completed === true;
          const [tasks, goals] = await Promise.all([
            listMatrixTasks(c.userId, {
              search: args.search,
              quadrant: args.quadrant ? QUADRANT_BY_NAME[args.quadrant] : undefined,
              includeCompleted,
            }),
            goalTitleMap(c.userId),
          ]);
          const byQuadrant = new Map<TaskQuadrant, typeof tasks>();
          for (const t of tasks) byQuadrant.set(t.quadrant, [...(byQuadrant.get(t.quadrant) ?? []), t]);
          const rows: ReturnType<typeof taskView>[] = [];
          for (const [, list] of byQuadrant) {
            list.sort(compareMatrixOrder);
            list.forEach((t, i) =>
              rows.push(
                taskView(t, tz, goals, now, {
                  nextAction: i === 0 && t.status !== "completed" && !args.search ? true : undefined,
                  subtasks: t.subtaskCount ? `${t.subtaskCompletedCount}/${t.subtaskCount} done` : undefined,
                }),
              ),
            );
          }
          const limit = args.limit ?? 50;
          const shown = rows.slice(0, limit);
          return ok(
            `${rows.length} task${rows.length === 1 ? "" : "s"}${rows.length > limit ? `, showing ${limit}` : ""}.`,
            shown,
          );
        }),
    );

    server.registerTool(
      "get_overview",
      {
        title: "Overview of my matrix",
        description:
          "A snapshot of the whole matrix: open tasks per quadrant with each quadrant's next action, overdue tasks, and active goals with progress. Start here when asked what to focus on.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () =>
        guard(async () => {
          const now = new Date();
          const [tasks, goals] = await loadOpenTasksAndGoals(c.userId);
          const titles = new Map(goals.map((g) => [String(g._id), g.title]));
          const quadrants = (Object.keys(QUADRANT_NAMES) as TaskQuadrant[]).map((q) => {
            const list = tasks.filter((t) => t.quadrant === q).sort(compareMatrixOrder);
            return {
              quadrant: QUADRANT_NAMES[q],
              open: list.length,
              nextAction: list[0] ? taskView(list[0], tz, titles, now) : null,
              tasks: list.slice(0, 25).map((t) => taskView(t, tz, titles, now)),
            };
          });
          const overdue = tasks
            .filter((t) => t.dueDate && new Date(t.dueDate) < now)
            .map((t) => ({ id: String(t._id), title: t.title, due: formatInZone(new Date(t.dueDate!), tz) }));
          const progress = p.readGoals ? await goalProgress(c.userId, goals.map((g) => g._id)) : null;
          return ok(`Matrix as of ${formatInZone(now, tz)}.`, {
            today,
            quadrants,
            overdue,
            goals: p.readGoals
              ? goals.map((g) => ({
                  id: String(g._id),
                  title: g.title,
                  period: goalPeriodLabel(g),
                  progress: progress?.get(String(g._id)) ?? { total: 0, completed: 0 },
                }))
              : "hidden: reading goals is switched off",
          });
        }),
    );

    server.registerPrompt(
      "prioritize_my_matrix",
      {
        title: "Prioritize my matrix",
        description: "Review the EisenQ matrix and propose what to move, reschedule or drop.",
        argsSchema: z.object({
          context: z.string().max(1000).optional().describe("Anything about your week or constraints"),
        }),
      },
      ({ context }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Help me prioritize my EisenQ matrix. Call get_overview first.",
                "Then propose at most 7 concrete changes (move quadrant, change priority, set a due date, link a goal, or remove), fewer if the matrix is in good shape.",
                "List them for me first and apply only the ones I approve, using update_task" +
                  (p.deleteTasks ? " or delete_task." : "."),
                "Guidelines:",
                PRIORITIZATION_GUIDELINES,
                context ? `\nAbout my week: ${context}` : "",
              ].join("\n"),
            },
          },
        ],
      }),
    );
  }

  if (p.readGoals) {
    server.registerTool(
      "list_goals",
      {
        title: "List goals",
        description:
          "List the person's goals (weekly, monthly, yearly or custom range) with how many linked tasks are done. Use a goal's id to link a task to it.",
        inputSchema: z.object({
          include_inactive: z.boolean().optional().describe("Also list achieved and dropped goals"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) =>
        guard(async () => {
          const goals = await listGoals(c.userId, { activeOnly: !args.include_inactive });
          const progress = await goalProgress(c.userId, goals.map((g) => g._id));
          return ok(
            `${goals.length} goal${goals.length === 1 ? "" : "s"}.`,
            goals.map((g) => ({
              id: String(g._id),
              title: g.title,
              icon: g.icon,
              period: goalPeriodLabel(g),
              status: g.status,
              pinned: g.pinned ? true : undefined,
              parentGoalId: g.parentGoalId ? String(g.parentGoalId) : undefined,
              progress: progress.get(String(g._id)) ?? { total: 0, completed: 0 },
              note: g.note,
            })),
          );
        }),
    );
  }

  // ----- Writing tasks -----

  if (p.createTasks) {
    server.registerTool(
      "add_task",
      {
        title: "Add a task",
        description: `Add a task to the matrix. If no quadrant is given it goes to ${QUADRANT_NAMES[prefs.defaultQuadrant]}. Do First tasks are always high priority.`,
        inputSchema: z.object({
          title: z.string().min(1).max(500),
          quadrant: quadrantName.optional(),
          priority: taskPrioritySchema.optional().describe("Default: high in Do First, otherwise medium"),
          due: dueInput.optional(),
          duration_min: z.number().int().min(1).max(1440).optional().describe("Estimated minutes"),
          notes: z.string().max(5000).optional(),
          goal_id: idInput.optional().describe("Link to a goal from list_goals"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) =>
        write("add_task", async () => {
          const quadrant = args.quadrant ? QUADRANT_BY_NAME[args.quadrant]! : prefs.defaultQuadrant;
          const source: TaskSource | undefined = prefs.labelAiTasks
            ? { kind: "agent", title: c.clientName, capturedAt: new Date() }
            : undefined;
          const task = await createTask(c.userId, {
            title: args.title.trim(),
            quadrant,
            priority: quadrant === "urgent-important" ? "high" : args.priority,
            description: args.notes,
            dueDate: args.due ? parseDue(args.due, tz) : undefined,
            duration: args.duration_min,
            goalId: args.goal_id,
            source,
          });
          const where = QUADRANT_NAMES[task.quadrant];
          return {
            result: ok(`Added “${task.title}” to ${where}.`, taskView(task, tz, await goalTitleMap(c.userId), new Date())),
            summary: `Added “${task.title}” to ${where}`,
            taskId: String(task._id),
          };
        }),
    );
  }

  if (p.editTasks) {
    server.registerTool(
      "update_task",
      {
        title: "Edit a task",
        description:
          "Change a task: rename it, move it to another quadrant, change priority, set or clear the due date or duration, edit notes, link or unlink a goal, or reopen a completed task. Only the fields you send change.",
        inputSchema: z.object({
          id: idInput,
          title: z.string().min(1).max(500).optional(),
          quadrant: quadrantName.optional(),
          priority: taskPrioritySchema.optional(),
          due: dueInput.nullable().optional().describe("null clears the due date"),
          duration_min: z.number().int().min(1).max(1440).nullable().optional().describe("null clears it"),
          notes: z.string().max(5000).optional(),
          goal_id: idInput.nullable().optional().describe("null unlinks the goal"),
          status: z.enum(["pending", "in-progress"]).optional().describe("Use complete_task to complete; pending reopens a completed task"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        write("update_task", async () => {
          const changes: UpdateTaskInput = {};
          const said: string[] = [];
          if (args.title !== undefined) { changes.title = args.title.trim(); said.push("renamed"); }
          if (args.quadrant) { changes.quadrant = QUADRANT_BY_NAME[args.quadrant]; said.push(`moved to ${args.quadrant}`); }
          if (args.priority) { changes.priority = args.priority; said.push(`${args.priority} priority`); }
          if (args.due !== undefined) {
            changes.dueDate = args.due === null ? null : parseDue(args.due, tz);
            said.push(args.due === null ? "due date cleared" : `due ${formatInZone(new Date(changes.dueDate!), tz)}`);
          }
          if (args.duration_min !== undefined) { changes.duration = args.duration_min; said.push("duration"); }
          if (args.notes !== undefined) { changes.description = args.notes; said.push("notes"); }
          if (args.goal_id !== undefined) { changes.goalId = args.goal_id; said.push(args.goal_id ? "linked to a goal" : "goal unlinked"); }
          if (args.status) {
            changes.status = args.status;
            changes.completedAt = null; // reopening clears the completion stamp
            said.push(args.status === "pending" ? "reopened" : "in progress");
          }
          if (said.length === 0) throw new TaskServiceError("Nothing to change: send at least one field besides id.");
          const task = await updateTask(c.userId, args.id, changes);
          return {
            result: ok(`Updated “${task.title}”: ${said.join(", ")}.`, taskView(task, tz, await goalTitleMap(c.userId), new Date())),
            summary: `Edited “${task.title}”: ${said.join(", ")}`,
            taskId: String(task._id),
          };
        }),
    );
  }

  if (p.completeTasks) {
    server.registerTool(
      "complete_task",
      {
        title: "Complete a task",
        description:
          "Mark a task done. Refused while a checklist the person marked as required still has steps left; tell them which.",
        inputSchema: z.object({ id: idInput }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        write("complete_task", async () => {
          const task = await completeTask(c.userId, args.id, { autoArchive: c.autoArchive });
          return {
            result: ok(`Completed “${task.title}”${c.autoArchive ? " (and archived it, as the person's settings ask)" : ""}.`),
            summary: `Completed “${task.title}”`,
            taskId: String(task._id),
          };
        }),
    );
  }

  if (p.deleteTasks) {
    const archives = prefs.deleteMode === "archive";
    server.registerTool(
      "delete_task",
      {
        title: archives ? "Remove a task (archive)" : "Delete a task",
        description: archives
          ? "Remove a task from the matrix. It is archived, so the person can restore it from the archive."
          : "Permanently delete a task and its subtasks. This cannot be undone; confirm with the person first.",
        inputSchema: z.object({ id: idInput }),
        annotations: { readOnlyHint: false, destructiveHint: !archives, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        write("delete_task", async () => {
          const before = await listTitle(c.userId, args.id);
          await removeTask(c.userId, args.id, prefs.deleteMode);
          const verb = archives ? "Archived" : "Deleted";
          return { result: ok(`${verb} “${before}”.`), summary: `${verb} “${before}”`, taskId: args.id };
        }),
    );
  }

  // ----- Writing goals -----

  if (p.editGoals) {
    const period = z.enum(["week", "month", "year", "custom"]);
    server.registerTool(
      "create_goal",
      {
        title: "Create a goal",
        description:
          "Create a weekly, monthly, yearly or custom-range goal. For week/month/year, pass any date inside that period (default today). Custom goals need start and end dates.",
        inputSchema: z.object({
          title: z.string().min(1).max(200),
          period,
          date: z.string().regex(dateKeyRegex).optional().describe("Any YYYY-MM-DD inside the week, month or year"),
          start_date: z.string().regex(dateKeyRegex).optional().describe("Custom goals only"),
          end_date: z.string().regex(dateKeyRegex).optional().describe("Custom goals only"),
          icon: z.string().max(16).optional().describe("A single emoji"),
          note: z.string().max(1000).optional(),
          parent_goal_id: idInput.optional().describe("Weekly goals can sit under a monthly goal, monthly under a yearly one"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args) =>
        write("create_goal", async () => {
          const parsed = createGoalSchema.safeParse({
            title: args.title.trim(),
            periodType: args.period,
            periodKey: periodKeyFor(args.period, args.date ?? today, args.start_date),
            startDate: args.start_date,
            endDate: args.end_date,
            icon: args.icon,
            note: args.note,
            parentGoalId: args.parent_goal_id,
          });
          if (!parsed.success) throw new TaskServiceError(parsed.error.issues.map((i) => i.message).join("; "));
          const goal = await createGoal(c.userId, parsed.data);
          return {
            result: ok(`Created goal “${goal.title}” (${goalPeriodLabel(goal)}).`, { id: String(goal._id) }),
            summary: `Created goal “${goal.title}”`,
          };
        }),
    );

    server.registerTool(
      "update_goal",
      {
        title: "Edit a goal",
        description:
          "Rename a goal, edit its note or icon, mark it achieved or dropped, pin it, move it to another period, or change its parent. Only the fields you send change.",
        inputSchema: z.object({
          id: idInput,
          title: z.string().min(1).max(200).optional(),
          note: z.string().max(1000).nullable().optional(),
          icon: z.string().max(16).nullable().optional(),
          status: z.enum(["active", "achieved", "dropped"]).optional(),
          pinned: z.boolean().optional(),
          move_to_period: period.optional().describe("Move to another period; pass date (or start/end dates for custom)"),
          date: z.string().regex(dateKeyRegex).optional(),
          start_date: z.string().regex(dateKeyRegex).optional(),
          end_date: z.string().regex(dateKeyRegex).optional(),
          parent_goal_id: idInput.nullable().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) =>
        write("update_goal", async () => {
          const changes: UpdateGoalInput = {
            title: args.title?.trim(),
            note: args.note,
            icon: args.icon,
            status: args.status,
            pinned: args.pinned,
            startDate: args.start_date,
            endDate: args.end_date,
            parentGoalId: args.parent_goal_id,
          };
          if (args.move_to_period) {
            changes.periodType = args.move_to_period;
            changes.periodKey = periodKeyFor(args.move_to_period, args.date ?? today, args.start_date);
          }
          const goal = await updateGoal(c.userId, args.id, changes);
          return { result: ok(`Updated goal “${goal.title}”.`), summary: `Edited goal “${goal.title}”` };
        }),
    );
  }

  return server;
}

function periodKeyFor(period: "week" | "month" | "year" | "custom", date: string, startDate?: string): string {
  if (period === "week") return weekKeyFor(date);
  if (period === "month") return date.slice(0, 7);
  if (period === "year") return date.slice(0, 4);
  return startDate ?? date;
}

async function listTitle(userId: string, id: string): Promise<string> {
  const task = await tasksCollection.findOne({ _id: new ObjectId(id), userId }, { projection: { title: 1 } });
  if (!task) throw new TaskServiceError("Task not found", 404);
  return task.title;
}
