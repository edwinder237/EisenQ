import type { ObjectId } from "mongodb";
import { checklistItemsCollection, maintenanceItemsCollection, tasksCollection } from "~/server/db";
import type { RoutineChecklistRef, RoutineRef, Task, TaskChecklist } from "~/server/db/schema";
import { loadMyndlistCredentials, copyChecklistFromMyndlist } from "~/server/myndlist";
import { carriesOver, missedDates } from "~/lib/routine";

// A routine item with checklists attached gets a "run" each time it comes up:
// a task linked to that occurrence by routineRef, carrying fresh copies of the
// checklists. It has no due date, so it stays on the routine card and out of
// the matrix until the person schedules it. Ticking works through the same
// link as scheduling (see routine-links.ts).

interface Occurrence {
  ref: RoutineRef;
  title: string;
  checklists: RoutineChecklistRef[];
}

function isScheduledToday(frequency: "daily" | "weekly", daysOfWeek: number[] | undefined, today: string) {
  if (frequency === "daily") return true;
  const [y, m, d] = today.split("-").map(Number);
  return daysOfWeek?.includes(new Date(y!, m! - 1, d).getDay()) ?? false;
}

/** The occurrences on the routine card today that have checklists attached. */
async function dueOccurrences(userId: string, today: string): Promise<Occurrence[]> {
  const out: Occurrence[] = [];

  const items = await checklistItemsCollection.find({ userId, "checklists.0": { $exists: true } }).toArray();
  for (const item of items) {
    const dates: string[] = [];
    if (isScheduledToday(item.frequency, item.daysOfWeek, today)) dates.push(today);
    if (carriesOver(item)) {
      const missed = missedDates({ ...item, createdAt: item.createdAt.toISOString() }, today);
      if (missed[0]) dates.push(missed[0]); // the card shows one row per item: the latest miss
    }
    for (const date of dates) {
      out.push({ ref: { kind: "checklist", itemId: item._id, date }, title: item.title, checklists: item.checklists! });
    }
  }

  const maint = await maintenanceItemsCollection
    .find({ userId, "checklists.0": { $exists: true }, nextDueDate: { $lte: today } })
    .toArray();
  for (const m of maint) {
    out.push({ ref: { kind: "maintenance", itemId: m._id, date: m.nextDueDate }, title: m.title, checklists: m.checklists! });
  }
  return out;
}

function runFilter(userId: string, ref: RoutineRef) {
  return { userId, "routineRef.kind": ref.kind, "routineRef.itemId": ref.itemId, "routineRef.date": ref.date };
}

/**
 * Makes sure every due occurrence with checklists has its run. Idempotent: an
 * occurrence that already has a task (run, scheduled, done or archived) is left
 * alone, except that a still-open task with no checklists yet gets them added.
 * Myndlist being unreachable skips that occurrence; the next load retries.
 */
export async function ensureRoutineRuns(userId: string, today: string): Promise<{ created: number; updated: number }> {
  const occurrences = await dueOccurrences(userId, today);
  if (occurrences.length === 0) return { created: 0, updated: 0 };

  let created = 0;
  let updated = 0;
  let creds: Awaited<ReturnType<typeof loadMyndlistCredentials>> | null = null;

  for (const occ of occurrences) {
    const existing = await tasksCollection.findOne(runFilter(userId, occ.ref));
    if (existing && (existing.status === "completed" || existing.archivedAt || existing.checklists?.length)) continue;

    creds ??= await loadMyndlistCredentials(userId);
    if (!creds.apiUrl || !creds.apiKey) return { created, updated };

    const copies: TaskChecklist[] = [];
    for (const [i, c] of occ.checklists.entries()) {
      const copied = await copyChecklistFromMyndlist(userId, creds, c.sourceId, i);
      if ("checklist" in copied) copies.push(copied.checklist);
    }
    if (copies.length === 0) continue;

    if (existing) {
      await tasksCollection.updateOne(
        { _id: existing._id, userId, "checklists.0": { $exists: false } },
        { $set: { checklists: copies, updatedAt: new Date() } },
      );
      updated++;
      continue;
    }

    const now = new Date();
    // Upsert keyed on the occurrence, so two dashboards loading at once can't
    // both create a run. The filter's equality fields (userId, routineRef.*)
    // become the inserted document's, so they're not repeated in $setOnInsert.
    const insert: Omit<Task, "_id" | "userId" | "routineRef"> = {
      title: occ.title,
      quadrant: "important-not-urgent",
      priority: "medium",
      status: "pending",
      checklists: copies,
      createdAt: now,
      updatedAt: now,
    };
    const res = await tasksCollection.updateOne(
      runFilter(userId, occ.ref),
      { $setOnInsert: insert },
      { upsert: true },
    );
    if (res.upsertedCount) created++;
  }
  return { created, updated };
}

/** Lets go of open runs for a checklist item's misses up to `date` (dismissed). */
export async function archiveDismissedRuns(userId: string, itemId: ObjectId, date: string) {
  await tasksCollection.updateMany(
    {
      userId,
      "routineRef.kind": "checklist",
      "routineRef.itemId": itemId,
      "routineRef.date": { $lte: date },
      status: { $ne: "completed" },
      archivedAt: null as unknown as undefined,
    },
    { $set: { archivedAt: new Date(), updatedAt: new Date() } },
  );
}
