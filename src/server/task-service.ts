import { ObjectId } from "mongodb";
import { z } from "zod";
import { tasksCollection, goalsCollection } from "~/server/db";
import type { Task, TaskQuadrant, TaskPriority, TaskSource } from "~/server/db/schema";
import { requiredStepsLeft } from "~/lib/checklist-steps";
import { zonedWallTimeToUtc } from "~/server/timezone";
import { assertOwnRoutineItem, syncRoutineFromTask } from "~/server/routine-links";

// The rules every task write obeys, wherever it comes from: the dashboard
// (/api/tasks), the in-app assistant (/api/assistant/apply) and AI connectors
// (/api/mcp). Kept in one place so an agent can never skip a rule the
// dashboard enforces — the checklist gate, goal ownership, the subtask cascade.

export class TaskServiceError extends Error {
  constructor(
    message: string,
    public status = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const taskQuadrantSchema = z.enum(["urgent-important", "important-not-urgent", "urgent-not-important", "not-urgent-not-important"]);
export const taskPrioritySchema = z.enum(["high", "medium", "low"]);
export const taskStatusSchema = z.enum(["pending", "in-progress", "completed"]);

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(500, "Title too long"),
  description: z.string().max(5000, "Description too long").optional(),
  quadrant: taskQuadrantSchema,
  priority: taskPrioritySchema,
  status: taskStatusSchema.optional(),
  dueDate: z.string().datetime().optional(),
  duration: z.number().int().min(1).max(1440).optional(),
  parentTaskId: z.string().optional(),  // For subtask creation
  goalId: z.string().optional(),        // Optional link to a weekly/monthly goal
  // A routine item put on the schedule: completing either side completes both
  routineRef: z.object({
    kind: z.enum(["checklist", "maintenance"]),
    itemId: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
});

export const updateTaskSchema = z.object({
  _id: z.string().min(1, "Task ID is required"),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  quadrant: taskQuadrantSchema.optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  dueDate: z.string().datetime().nullable().optional(),
  duration: z.number().int().min(1).max(1440).nullable().optional(),
  goalId: z.string().nullable().optional(),
  linkedParentId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  // Sent by the client so the stamp reflects the user's own clock
  completedAt: z.string().datetime().nullable().optional(),
});

export type CreateTaskInput = Omit<z.infer<typeof createTaskSchema>, "priority"> & {
  priority?: TaskPriority;   // omitted: Do First → high, anything else → medium
  source?: TaskSource;
};
export type UpdateTaskInput = Omit<z.infer<typeof updateTaskSchema>, "_id">;

export const QUADRANT_NAMES: Record<TaskQuadrant, string> = {
  "urgent-important": "Do First",
  "important-not-urgent": "Schedule",
  "urgent-not-important": "Delegate",
  "not-urgent-not-important": "Eliminate",
};
export const QUADRANT_BY_NAME = Object.fromEntries(
  Object.entries(QUADRANT_NAMES).map(([k, v]) => [v, k as TaskQuadrant]),
) as Record<string, TaskQuadrant>;

// Escape special regex characters to prevent NoSQL injection
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function toObjectId(id: string, what: string): ObjectId {
  if (!ObjectId.isValid(id)) throw new TaskServiceError(`Invalid ${what} ID`);
  return new ObjectId(id);
}

async function assertOwnGoal(userId: string, goalId: string): Promise<ObjectId> {
  const oid = toObjectId(goalId, "goal");
  const goal = await goalsCollection.findOne({ _id: oid, userId });
  if (!goal) throw new TaskServiceError("Goal not found");
  return oid;
}

/** Same rule as the dashboard's task form: Do First is always high priority. */
export function defaultPriorityFor(quadrant: TaskQuadrant): TaskPriority {
  return quadrant === "urgent-important" ? "high" : "medium";
}

/** A due date given as a plain day means 9:00 that day in the person's zone. */
export function dayToDueDate(ymd: string, timeZone: string): Date {
  return zonedWallTimeToUtc(ymd, 9, 0, timeZone);
}

export async function createTask(userId: string, input: CreateTaskInput): Promise<Task> {
  let quadrant = input.quadrant;
  let parentTaskId: ObjectId | undefined;

  if (input.parentTaskId) {
    const pid = toObjectId(input.parentTaskId, "parent task");
    // Parent must exist, be the user's, and not itself be a subtask.
    // { field: null } matches null OR missing.
    const parentTask = await tasksCollection.findOne({
      _id: pid,
      userId,
      parentTaskId: null as unknown as undefined,
    });
    if (!parentTask) throw new TaskServiceError("Parent task not found or is already a subtask");
    quadrant = parentTask.quadrant; // inherit
    parentTaskId = pid;
  }

  const goalId = input.goalId ? await assertOwnGoal(userId, input.goalId) : undefined;

  let routineRef: Task["routineRef"];
  if (input.routineRef) {
    const itemId = toObjectId(input.routineRef.itemId, "routine item");
    if (!(await assertOwnRoutineItem(userId, input.routineRef.kind, itemId))) {
      throw new TaskServiceError("Routine item not found", 404);
    }
    routineRef = { kind: input.routineRef.kind, itemId, date: input.routineRef.date };
  }

  const now = new Date();
  const newTask: Task = {
    title: input.title,
    description: input.description,
    quadrant,
    priority: input.priority ?? defaultPriorityFor(quadrant),
    status: input.status ?? "pending",
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    duration: input.duration,
    parentTaskId,
    goalId,
    source: input.source,
    routineRef,
    createdAt: now,
    updatedAt: now,
    quadrantSince: now,
    userId,
  };

  const result = await tasksCollection.insertOne(newTask);
  const inserted = await tasksCollection.findOne({ _id: result.insertedId, userId });
  if (!inserted) throw new TaskServiceError("Failed to create task", 500);
  return inserted;
}

/**
 * Throws when an opted-in checklist still has required steps. Only completing
 * is gated: un-completing never is, or a gated task completed by some other
 * path would be stuck completed forever.
 */
async function assertChecklistGate(userId: string, taskId: ObjectId) {
  const existing = await tasksCollection.findOne({ _id: taskId, userId });
  let remaining = 0;
  let blockingName = "";
  for (const checklist of existing?.checklists ?? []) {
    if (!checklist.blockCompletion) continue;
    const left = requiredStepsLeft(checklist.steps);
    if (left > 0) {
      if (remaining === 0) blockingName = checklist.name;
      remaining += left;
    }
  }
  if (remaining > 0) {
    throw new TaskServiceError(
      `${remaining} required step${remaining === 1 ? "" : "s"} left on ${blockingName}`,
      400,
      { checklistBlocked: true, remaining, checklistName: blockingName },
    );
  }
}

export async function updateTask(userId: string, id: string, input: UpdateTaskInput): Promise<Task> {
  const oid = toObjectId(id, "task");
  const { dueDate, duration, goalId, linkedParentId, archived, completedAt, ...rest } = input;

  if (rest.status === "completed") await assertChecklistGate(userId, oid);
  // Read before writing so a routine link only syncs on a real status change.
  const before = rest.status ? await tasksCollection.findOne({ _id: oid, userId }) : null;

  // Drop keys passed as undefined: the driver would store them as null and
  // wipe the field. Absent means "leave it alone", whoever the caller is.
  const set: Record<string, unknown> = { ...definedOnly(rest), updatedAt: new Date() };
  const unset: Record<string, ""> = {};

  // Start the "how long has it sat here" clock only on a real move, so
  // re-saving a task with the same quadrant doesn't reset it.
  if (rest.quadrant) {
    const current = await tasksCollection.findOne({ _id: oid, userId }, { projection: { quadrant: 1 } });
    if (current && current.quadrant !== rest.quadrant) set.quadrantSince = new Date();
  }

  // Moving into Do First without saying a priority makes it high.
  if (rest.quadrant === "urgent-important" && rest.priority === undefined) set.priority = "high";

  if (dueDate === null) unset.dueDate = "";
  else if (dueDate) set.dueDate = new Date(dueDate);

  if (duration === null) unset.duration = "";
  else if (duration !== undefined) set.duration = duration;

  // Completion stamp. Cleared when a task is reopened.
  if (completedAt === null) unset.completedAt = "";
  else if (completedAt !== undefined) set.completedAt = new Date(completedAt);

  if (archived === true) set.archivedAt = new Date();
  else if (archived === false) unset.archivedAt = "";

  if (goalId === null) unset.goalId = "";
  else if (goalId !== undefined) set.goalId = await assertOwnGoal(userId, goalId);

  // Soft link to a parent task's subtask list; the task stays top-level.
  if (linkedParentId === null) {
    unset.linkedParentId = "";
  } else if (linkedParentId !== undefined) {
    if (!ObjectId.isValid(linkedParentId) || linkedParentId === id) {
      throw new TaskServiceError("Invalid parent task");
    }
    // Must be one of the user's own top-level tasks, and not already linked
    // under this one (prevents a 2-way loop).
    const parent = await tasksCollection.findOne({
      _id: new ObjectId(linkedParentId),
      userId,
      parentTaskId: null as unknown as undefined,
    });
    if (!parent) throw new TaskServiceError("Parent task not found or is a subtask");
    if (parent.linkedParentId?.equals(oid)) {
      throw new TaskServiceError("That task is already linked under this one");
    }
    set.linkedParentId = new ObjectId(linkedParentId);
  }

  const update: { $set: Record<string, unknown>; $unset?: Record<string, ""> } = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;

  const result = await tasksCollection.updateOne({ _id: oid, userId }, update);
  if (result.matchedCount === 0) throw new TaskServiceError("Task not found", 404);

  // A parent's quadrant cascades to its real subtasks.
  if (rest.quadrant) {
    await tasksCollection.updateMany(
      { parentTaskId: oid, userId },
      { $set: { quadrant: rest.quadrant, updatedAt: new Date() } },
    );
  }

  // A task scheduled from a routine item ticks (or unticks) that item too.
  if (before?.routineRef && rest.status && (before.status === "completed") !== (rest.status === "completed")) {
    await syncRoutineFromTask(userId, before.routineRef, rest.status === "completed");
  }

  const updated = await tasksCollection.findOne({ _id: oid, userId });
  if (!updated) throw new TaskServiceError("Task not found", 404);
  return updated;
}

/**
 * Completes a task through the same gate as the dashboard, and archives it
 * straight away when the person has "archive automatically" switched on —
 * which the dashboard otherwise only applies in the browser.
 */
export async function completeTask(userId: string, id: string, opts: { autoArchive: boolean }): Promise<Task> {
  return updateTask(userId, id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    ...(opts.autoArchive ? { archived: true } : {}),
  });
}

/** Hard delete: removes real subtasks, unlinks soft-linked tasks. */
export async function deleteTask(userId: string, id: string): Promise<void> {
  const oid = toObjectId(id, "task");
  await tasksCollection.deleteMany({ parentTaskId: oid, userId });
  // Soft-linked tasks are independent top-level tasks — unlink, don't delete.
  await tasksCollection.updateMany(
    { linkedParentId: oid, userId },
    { $unset: { linkedParentId: "" }, $set: { updatedAt: new Date() } },
  );
  const result = await tasksCollection.deleteOne({ _id: oid, userId });
  if (result.deletedCount === 0) throw new TaskServiceError("Task not found", 404);
}

export async function removeTask(userId: string, id: string, mode: "archive" | "delete"): Promise<void> {
  if (mode === "archive") await updateTask(userId, id, { archived: true });
  else await deleteTask(userId, id);
}

/** The matrix view: top-level, unarchived tasks with subtask counts, newest first. */
export async function listMatrixTasks(
  userId: string,
  filters: { search?: string; quadrant?: TaskQuadrant; priority?: TaskPriority; status?: Task["status"]; includeCompleted?: boolean } = {},
) {
  // { field: null } matches docs where the field is null OR doesn't exist
  const match: Record<string, unknown> = { userId, parentTaskId: null, archivedAt: null };
  if (filters.search) {
    const s = escapeRegex(filters.search);
    match.$or = [
      { title: { $regex: s, $options: "i" } },
      { description: { $regex: s, $options: "i" } },
    ];
  }
  if (filters.quadrant) match.quadrant = filters.quadrant;
  if (filters.priority) match.priority = filters.priority;
  if (filters.status) match.status = filters.status;
  else if (filters.includeCompleted === false) match.status = { $ne: "completed" };

  return tasksCollection.aggregate<Task & { subtaskCount: number; subtaskCompletedCount: number }>([
    { $match: match },
    {
      $lookup: {
        from: "tasks",
        let: { parentId: "$_id", parentUserId: "$userId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $or: [{ $eq: ["$parentTaskId", "$$parentId"] }, { $eq: ["$linkedParentId", "$$parentId"] }] },
                  { $eq: ["$userId", "$$parentUserId"] },
                ],
              },
            },
          },
          { $project: { status: 1 } },
        ],
        as: "subtasks",
      },
    },
    {
      $addFields: {
        subtaskCount: { $size: "$subtasks" },
        subtaskCompletedCount: {
          $size: { $filter: { input: "$subtasks", cond: { $eq: ["$$this.status", "completed"] } } },
        },
      },
    },
    { $project: { subtasks: 0 } },
    { $sort: { createdAt: -1 } },
  ]).toArray();
}

/**
 * The dashboard's display order within a quadrant (page.tsx
 * getOrderedQuadrantTasks): open before completed, dated before undated and
 * soonest first, then manual sortOrder, then oldest. The first open task is
 * the quadrant's "next action".
 */
export function compareMatrixOrder(a: Task, b: Task): number {
  const aDone = a.status === "completed";
  const bDone = b.status === "completed";
  if (aDone !== bDone) return aDone ? 1 : -1;
  if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
  if (a.dueDate && b.dueDate) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  const ao = a.sortOrder ?? Infinity;
  const bo = b.sortOrder ?? Infinity;
  if (ao !== bo) return ao - bo;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/** Open top-level tasks and active goals: the assistant's and get_overview's view. */
export async function loadOpenTasksAndGoals(userId: string) {
  return Promise.all([
    tasksCollection
      .find({
        userId,
        status: { $ne: "completed" },
        archivedAt: null as unknown as undefined,
        parentTaskId: null as unknown as undefined,
      })
      .sort({ quadrant: 1, sortOrder: 1 })
      .limit(300)
      .toArray(),
    goalsCollection.find({ userId, status: "active" }).toArray(),
  ]);
}

// ===== Assistant suggestions =====

/** Suggestions the server applies. move_to_top stays in the browser: it depends on the dashboard's own ordering. */
export const SERVER_APPLIED_ACTIONS = ["move_quadrant", "set_priority", "set_due_date", "archive", "link_goal"] as const;
export type ServerAppliedAction = (typeof SERVER_APPLIED_ACTIONS)[number];

export async function applySuggestion(
  userId: string,
  s: { taskId: string; action: ServerAppliedAction; value: string },
  timeZone: string,
): Promise<Task> {
  switch (s.action) {
    case "archive":
      return updateTask(userId, s.taskId, { archived: true });
    case "move_quadrant": {
      const quadrant = taskQuadrantSchema.safeParse(s.value);
      if (!quadrant.success) throw new TaskServiceError("Unknown quadrant");
      return updateTask(userId, s.taskId, { quadrant: quadrant.data });
    }
    case "set_priority": {
      const priority = taskPrioritySchema.safeParse(s.value);
      if (!priority.success) throw new TaskServiceError("Unknown priority");
      return updateTask(userId, s.taskId, { priority: priority.data });
    }
    case "set_due_date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.value)) throw new TaskServiceError("Due date must be YYYY-MM-DD");
      return updateTask(userId, s.taskId, { dueDate: dayToDueDate(s.value, timeZone).toISOString() });
    }
    case "link_goal":
      return updateTask(userId, s.taskId, { goalId: s.value });
  }
}
