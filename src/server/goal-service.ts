import { ObjectId } from "mongodb";
import { z } from "zod";
import { goalsCollection, tasksCollection } from "~/server/db";
import type { Goal, GoalPeriodType } from "~/server/db/schema";
import { TaskServiceError, definedOnly } from "~/server/task-service";

// Goal rules shared by /api/goals and AI connectors (/api/mcp): period-key
// formats, Sunday-start weeks, the week → month → year parent chain, and the
// child detach that a period move requires.

const weekKeyRegex = /^\d{4}-\d{2}-\d{2}$/;
const monthKeyRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
const yearKeyRegex = /^\d{4}$/;
export const dateKeyRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Weeks start on Sunday (weekStartsOn: 0 everywhere in the app)
function isSundayKey(key: string): boolean {
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

// The period type a goal of `periodType` may link up to, or null if none.
export function expectedParentType(periodType: GoalPeriodType): GoalPeriodType | null {
  if (periodType === "week") return "month";
  if (periodType === "month") return "year";
  return null;
}

export function isValidKeyForType(periodType: GoalPeriodType, periodKey: string): boolean {
  if (periodType === "week") return weekKeyRegex.test(periodKey) && isSundayKey(periodKey);
  if (periodType === "month") return monthKeyRegex.test(periodKey);
  if (periodType === "year") return yearKeyRegex.test(periodKey);
  return dateKeyRegex.test(periodKey);
}

const PERIOD_KEY_HELP: Record<GoalPeriodType, string> = {
  week: "periodKey must be a Sunday date in YYYY-MM-DD format for weekly goals",
  month: "periodKey must be in YYYY-MM format for monthly goals",
  year: "periodKey must be in YYYY format for yearly goals",
  custom: "periodKey must be in YYYY-MM-DD format for custom goals",
};

/** The Sunday that starts the week containing `ymd`. */
export function weekKeyFor(ymd: string): string {
  const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

export const goalPeriodSchema = z.enum(["week", "month", "year", "custom"]);

export const createGoalSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(200, "Title too long"),
    icon: z.string().max(16, "Icon too long").optional(),
    note: z.string().max(1000, "Note too long").optional(),
    periodType: goalPeriodSchema,
    periodKey: z.string(),
    startDate: z.string().regex(dateKeyRegex).optional(),
    endDate: z.string().regex(dateKeyRegex).optional(),
    parentGoalId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!isValidKeyForType(data.periodType, data.periodKey)) {
      ctx.addIssue({ code: "custom", path: ["periodKey"], message: PERIOD_KEY_HELP[data.periodType] });
    }
    if (data.periodType === "custom") {
      if (!data.startDate || !data.endDate) {
        ctx.addIssue({ code: "custom", path: ["startDate"], message: "Custom goals require a start and end date" });
      } else if (data.endDate < data.startDate) {
        ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date" });
      }
    }
    if (data.parentGoalId !== undefined && expectedParentType(data.periodType) === null) {
      ctx.addIssue({
        code: "custom",
        path: ["parentGoalId"],
        message: "Only weekly and monthly goals can link to a parent goal",
      });
    }
  });

export const updateGoalSchema = z.object({
  _id: z.string().min(1, "Goal ID is required"),
  title: z.string().min(1).max(200).optional(),
  icon: z.string().max(16).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  status: z.enum(["active", "achieved", "dropped"]).optional(),
  pinned: z.boolean().optional(),
  periodType: goalPeriodSchema.optional(),
  periodKey: z.string().optional(),
  startDate: z.string().regex(dateKeyRegex).optional(),
  endDate: z.string().regex(dateKeyRegex).optional(),
  parentGoalId: z.string().nullable().optional(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = Omit<z.infer<typeof updateGoalSchema>, "_id">;

async function findParentGoal(parentGoalId: string, userId: string, periodType: GoalPeriodType) {
  if (!ObjectId.isValid(parentGoalId)) return null;
  return goalsCollection.findOne({ _id: new ObjectId(parentGoalId), userId, periodType });
}

export async function listGoals(userId: string, opts: { activeOnly?: boolean } = {}) {
  return goalsCollection
    .find(opts.activeOnly ? { userId, status: "active" } : { userId })
    .sort({ createdAt: 1 })
    .toArray();
}

/** Linked-task counts per goal: { total, completed }, top-level unarchived tasks only. */
export async function goalProgress(userId: string, goalIds: ObjectId[]) {
  const rows = await tasksCollection
    .aggregate<{ _id: ObjectId; total: number; completed: number }>([
      { $match: { userId, goalId: { $in: goalIds }, archivedAt: null } },
      {
        $group: {
          _id: "$goalId",
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id.toHexString(), { total: r.total, completed: r.completed }]));
}

export async function createGoal(userId: string, body: CreateGoalInput): Promise<Goal> {
  let parentGoalId: ObjectId | undefined;
  if (body.parentGoalId !== undefined) {
    const parentType = expectedParentType(body.periodType);
    const parent = parentType ? await findParentGoal(body.parentGoalId, userId, parentType) : null;
    if (!parent) throw new TaskServiceError(`Parent goal not found or is not a ${parentType ?? "valid"} goal`);
    parentGoalId = parent._id;
  }

  const now = new Date();
  const newGoal: Goal = {
    title: body.title,
    icon: body.icon?.trim() ? body.icon : undefined,
    note: body.note,
    periodType: body.periodType,
    periodKey: body.periodKey,
    startDate: body.periodType === "custom" ? body.startDate : undefined,
    endDate: body.periodType === "custom" ? body.endDate : undefined,
    status: "active",
    parentGoalId,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  const result = await goalsCollection.insertOne(newGoal);
  const inserted = await goalsCollection.findOne({ _id: result.insertedId, userId });
  if (!inserted) throw new TaskServiceError("Failed to create goal", 500);
  return inserted;
}

export async function updateGoal(userId: string, id: string, input: UpdateGoalInput): Promise<Goal> {
  if (!ObjectId.isValid(id)) throw new TaskServiceError("Invalid goal ID format");
  const oid = new ObjectId(id);
  const { note, icon, parentGoalId, periodType, periodKey, startDate, endDate, ...rest } = input;

  // Drop keys passed as undefined: the driver would store them as null and
  // wipe the field. Absent means "leave it alone", whoever the caller is.
  const set: Record<string, unknown> = { ...definedOnly(rest), updatedAt: new Date() };
  const unset: Record<string, ""> = {};

  if (note === null) unset.note = "";
  else if (note !== undefined) set.note = note;

  // An empty or null icon clears it
  if (icon === null || (icon !== undefined && !icon.trim())) unset.icon = "";
  else if (icon !== undefined) set.icon = icon;

  // Move a goal to a different period (Week/Month/Year/Custom). This resets
  // its parent link and unlinks any children, since the hierarchy may no
  // longer hold.
  const isMoving = periodType !== undefined;
  if (isMoving) {
    if (!periodKey || !isValidKeyForType(periodType, periodKey)) {
      throw new TaskServiceError(`Invalid periodKey for a ${periodType} goal`);
    }
    set.periodType = periodType;
    set.periodKey = periodKey;
    if (periodType === "custom") {
      if (!startDate || !endDate || endDate < startDate) {
        throw new TaskServiceError("Custom goals require an ordered start and end date");
      }
      set.startDate = startDate;
      set.endDate = endDate;
    } else {
      unset.startDate = "";
      unset.endDate = "";
    }
    unset.parentGoalId = "";
  }

  // Custom-goal date range edits (not a period move); keep periodKey pinned to the start date.
  if (!isMoving && (startDate !== undefined || endDate !== undefined)) {
    const goal = await goalsCollection.findOne({ _id: oid, userId });
    if (!goal) throw new TaskServiceError("Goal not found", 404);
    if (goal.periodType !== "custom") throw new TaskServiceError("Only custom goals have an editable date range");
    const nextStart = startDate ?? goal.startDate;
    const nextEnd = endDate ?? goal.endDate;
    if (!nextStart || !nextEnd || nextEnd < nextStart) {
      throw new TaskServiceError("End date must be on or after the start date");
    }
    set.startDate = nextStart;
    set.endDate = nextEnd;
    set.periodKey = nextStart;
  }

  if (!isMoving && parentGoalId === null) {
    unset.parentGoalId = "";
  } else if (!isMoving && parentGoalId != null) {
    const goal = await goalsCollection.findOne({ _id: oid, userId });
    if (!goal) throw new TaskServiceError("Goal not found", 404);
    const parentType = expectedParentType(goal.periodType);
    if (!parentType) throw new TaskServiceError("Only weekly and monthly goals can link to a parent goal");
    const parent = await findParentGoal(parentGoalId, userId, parentType);
    if (!parent) throw new TaskServiceError(`Parent goal not found or is not a ${parentType} goal`);
    set.parentGoalId = parent._id;
  }

  const update: { $set: Record<string, unknown>; $unset?: Record<string, ""> } = { $set: set };
  if (Object.keys(unset).length > 0) update.$unset = unset;

  const result = await goalsCollection.updateOne({ _id: oid, userId }, update);
  if (result.matchedCount === 0) throw new TaskServiceError("Goal not found", 404);

  // Detach children only once the move itself has gone through.
  if (isMoving) {
    await goalsCollection.updateMany(
      { parentGoalId: oid, userId },
      { $unset: { parentGoalId: "" }, $set: { updatedAt: new Date() } },
    );
  }

  const updated = await goalsCollection.findOne({ _id: oid, userId });
  if (!updated) throw new TaskServiceError("Goal not found", 404);
  return updated;
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  if (!ObjectId.isValid(id)) throw new TaskServiceError("Invalid goal ID format");
  const oid = new ObjectId(id);

  // Unlink tasks and child goals before deleting
  await tasksCollection.updateMany(
    { goalId: oid, userId },
    { $unset: { goalId: "" }, $set: { updatedAt: new Date() } },
  );
  await goalsCollection.updateMany(
    { parentGoalId: oid, userId },
    { $unset: { parentGoalId: "" }, $set: { updatedAt: new Date() } },
  );

  const result = await goalsCollection.deleteOne({ _id: oid, userId });
  if (result.deletedCount === 0) throw new TaskServiceError("Goal not found", 404);
}
