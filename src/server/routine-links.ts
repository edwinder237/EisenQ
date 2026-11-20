import type { ObjectId } from "mongodb";
import { checklistItemsCollection, maintenanceItemsCollection, tasksCollection } from "~/server/db";
import type { MaintenanceItem, RoutineRef } from "~/server/db/schema";

// A routine item put on the schedule becomes a task carrying a routineRef.
// The two stay in step whichever side is ticked: completing the task marks the
// routine occurrence done, and ticking the routine completes the task. Writes
// here go straight to the collections (not through the task service) so the
// two directions can never call each other in a loop.

/** Resets a maintenance item's timer: done today, next due one interval out. */
export async function markMaintenanceDone(userId: string, itemId: ObjectId): Promise<MaintenanceItem | null> {
  const item = await maintenanceItemsCollection.findOne({ _id: itemId, userId });
  if (!item) return null;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const nextDue = new Date(today);
  nextDue.setDate(nextDue.getDate() + item.intervalDays);

  const updated = await maintenanceItemsCollection.findOneAndUpdate(
    { _id: itemId, userId },
    { $set: { lastCompletedDate: todayStr, nextDueDate: nextDue.toISOString().slice(0, 10), updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  await setLinkedTasksDone(userId, "maintenance", itemId, null, true);
  return updated;
}

/**
 * Marks a checklist occurrence done. A past occurrence (a carried-over miss)
 * also resolves every earlier miss, so the card stops nagging about it.
 */
export async function markChecklistOccurrence(
  userId: string,
  itemId: ObjectId,
  date: string,
  opts: { done: boolean; today: string },
) {
  if (opts.done) {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const item = await checklistItemsCollection.findOne({ _id: itemId, userId });
    if (!item) return;
    if (date < opts.today && (!item.caughtUpThrough || item.caughtUpThrough < date)) set.caughtUpThrough = date;
    await checklistItemsCollection.updateOne({ _id: itemId, userId }, { $addToSet: { completedDates: date }, $set: set });
  } else {
    await checklistItemsCollection.updateOne(
      { _id: itemId, userId },
      { $pull: { completedDates: date }, $set: { updatedAt: new Date() } },
    );
  }
}

/** Completes (or reopens) the tasks scheduled for a routine occurrence. */
export async function setLinkedTasksDone(
  userId: string,
  kind: RoutineRef["kind"],
  itemId: ObjectId,
  date: string | null, // null: any occurrence (maintenance has one open at a time)
  done: boolean,
) {
  const filter: Record<string, unknown> = { userId, "routineRef.kind": kind, "routineRef.itemId": itemId };
  if (date) filter["routineRef.date"] = date;
  if (done) {
    await tasksCollection.updateMany(
      { ...filter, status: { $ne: "completed" } },
      { $set: { status: "completed", completedAt: new Date(), updatedAt: new Date() } },
    );
  } else {
    await tasksCollection.updateMany(
      { ...filter, status: "completed" },
      { $set: { status: "pending", updatedAt: new Date() }, $unset: { completedAt: "" } },
    );
  }
}

/** Called by the task service when a linked task is completed or reopened. */
export async function syncRoutineFromTask(userId: string, ref: RoutineRef, done: boolean) {
  const today = new Date().toISOString().slice(0, 10);
  if (ref.kind === "checklist") {
    await markChecklistOccurrence(userId, ref.itemId, ref.date, { done, today });
    return;
  }
  // Maintenance: only advance the timer if this is still the occurrence the
  // task was scheduled for, so completing twice can't skip a cycle. Reopening
  // leaves the timer alone.
  if (!done) return;
  const item = await maintenanceItemsCollection.findOne({ _id: ref.itemId, userId });
  if (item && item.nextDueDate === ref.date) await markMaintenanceDone(userId, ref.itemId);
}

/** Checks a routineRef points at one of the user's own items. */
export async function assertOwnRoutineItem(userId: string, kind: RoutineRef["kind"], itemId: ObjectId) {
  const coll = kind === "checklist" ? checklistItemsCollection : maintenanceItemsCollection;
  const found = await (coll as typeof checklistItemsCollection).countDocuments({ _id: itemId, userId }, { limit: 1 });
  return found > 0;
}
