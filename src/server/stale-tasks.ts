import "server-only";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { clerkClient } from "@clerk/nextjs/server";
import { staleTaskRemindersCollection, tasksCollection, userSettingsCollection } from "~/server/db";
import type { StaleTaskReminder, Task } from "~/server/db/schema";
import { normalizeReminderSettings, type ReminderSettings } from "~/lib/reminders";
import { logNotifications } from "~/server/notifications";
import { STALE_TASK_EVENT_TYPE, type SendResult, type SocleClient, type StaleTaskRecipient } from "~/server/socle";
import { ymdInZone } from "~/server/timezone";

// The daily waiting-task job (GET /api/cron/stale-tasks, docs/integrations/socle.md).
//
// Once a day it reads every saved task, whatever created it (the dashboard,
// the capture extension, AI connectors over MCP, the assistant, routines), and
// for each Do First task that has waited the person's threshold it asks Socle
// to send one reminder, again every day while the task waits. EisenQ never
// writes to a task here: what it sent goes in staleTaskReminders.

export const REMINDER_TIME_ZONE = "America/Toronto";
export const MAX_EVENTS_PER_RUN = 10;      // finance's cap, for the whole run
const MAX_RETRY_WAIT_MS = 5_000;          // one retry after a 503, waiting at most this
const RUN_BUDGET_MS = 45_000;             // stop starting new sends after this (maxDuration is 60 s)

/** The date in Toronto, "YYYY-MM-DD". */
export function torontoDay(date: Date): string {
  return ymdInZone(date, REMINDER_TIME_ZONE);
}

/** Whole calendar days from one "YYYY-MM-DD" to another. DST can't shift it. */
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const utc = (ymd: string) => {
    const [y = 1970, m = 1, d = 1] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toYmd) - utc(fromYmd)) / 86_400_000);
}

/**
 * The Idempotency-Key for one task on one Toronto day: the SHA-256 of
 * "eisenq.task.stale|<taskId>|<date>", shaped as a UUID (version 8, RFC 9562).
 * The same task on the same day always gets the same key, so Socle refuses a
 * repeat; the next day gets a new one. Built from no personal detail.
 */
export function staleTaskKey(taskId: string, day: string): string {
  const h = createHash("sha256").update(`${STALE_TASK_EVENT_TYPE}|${taskId}|${day}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type CandidateTask = Pick<
  Task,
  "_id" | "quadrant" | "status" | "archivedAt" | "parentTaskId" | "quadrantSince" | "createdAt"
>;

/** Open, not archived, top-level and in Do First. */
export function isDoFirstAndOpen(t: CandidateTask): boolean {
  return t.quadrant === "urgent-important" && t.status !== "completed" && !t.archivedAt && !t.parentTaskId;
}

/** When the task entered Do First. Older tasks have no quadrantSince and fall back to createdAt. */
export function waitingSince(t: CandidateTask): Date | null {
  const since = new Date(t.quadrantSince ?? t.createdAt);
  return Number.isFinite(since.getTime()) ? since : null;
}

export interface WaitingTask {
  taskId: string;
  since: Date;
  daysWaiting: number;
  lastSentOn?: string; // the last Toronto day it was reminded, in this stint in Do First
  sentCount: number;
}

export interface ReminderPlan {
  waiting: WaitingTask[];  // waited at least the threshold
  due: WaitingTask[];      // of those, to remind today, in sending order
  sentToday: number;       // already reminded today: skipped without calling Socle
  remindedOnce: number;    // "remind again: never", and already reminded once
}

/**
 * Which of one person's tasks wait, and which to remind today. Pure, so every
 * rule is tested on its own: Do First only, open, not archived, no subtasks,
 * the threshold in Toronto calendar days, and the sent-today record.
 */
export function planReminders(input: {
  tasks: readonly CandidateTask[];
  reminders: readonly Pick<StaleTaskReminder, "taskId" | "since" | "lastSentOn" | "sentCount">[];
  settings: ReminderSettings;
  today: string;
}): ReminderPlan {
  const rows = new Map(input.reminders.map((r) => [String(r.taskId), r]));
  const waiting: WaitingTask[] = [];
  for (const t of input.tasks) {
    if (!t._id || !isDoFirstAndOpen(t)) continue;
    const since = waitingSince(t);
    if (!since) continue;
    const daysWaiting = calendarDaysBetween(torontoDay(since), input.today);
    if (daysWaiting < input.settings.thresholdDays) continue;
    const taskId = String(t._id);
    const row = rows.get(taskId);
    // A row from an earlier stint (the task left Do First and came back) doesn't count.
    const sameStint = row !== undefined && new Date(row.since).getTime() === since.getTime();
    waiting.push({
      taskId,
      since,
      daysWaiting,
      ...(sameStint ? { lastSentOn: row.lastSentOn } : {}),
      sentCount: sameStint ? row.sentCount : 0,
    });
  }

  let sentToday = 0;
  let remindedOnce = 0;
  const due = waiting
    .filter((w) => {
      if (w.lastSentOn !== undefined && w.lastSentOn >= input.today) {
        sentToday++;
        return false;
      }
      if (input.settings.repeat === "never" && w.sentCount > 0) {
        remindedOnce++;
        return false;
      }
      return true;
    })
    // Never reminded first, then the one reminded longest ago, then the oldest,
    // so that with more than 10 waiting every task still gets its turn.
    .sort(
      (a, b) =>
        (a.lastSentOn ?? "").localeCompare(b.lastSentOn ?? "") ||
        a.since.getTime() - b.since.getTime() ||
        a.taskId.localeCompare(b.taskId),
    );
  return { waiting, due, sentToday, remindedOnce };
}

export interface StaleTaskRunSummary {
  status: "done" | "off" | "stopped";
  reason?: string;        // why it's off, or why it stopped early
  dryRun?: true;
  people: number;         // allowlisted people with reminders on
  waiting: number;        // tasks that waited at least the threshold
  due: number;            // of those, not yet reminded today
  sent: number;           // accepted by Socle, replays included
  replayed: number;       // of sent: Socle had already accepted it
  skippedToday: number;   // already reminded today, Socle not called
  remindedOnce: number;   // "remind again: never", already reminded
  failed: number;         // refused, or no email address to send to
  left: number;           // due but not sent this run: over the cap, or the run stopped
  cleared: number;        // reminder rows deleted for tasks that stopped waiting
  taskIds?: string[];     // dry run only: what would be sent
}

export interface StaleTaskJobOptions {
  socle: SocleClient | null;
  allowedUserIds: readonly string[];
  // The person's email (and language, when known), read from EisenQ's Clerk
  // when sending. Never stored.
  recipientFor: (userId: string) => Promise<Omit<StaleTaskRecipient, "id"> | null>;
  now?: Date;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  elapsedMs?: () => number;
}

type Outcome =
  | { kind: "sent"; replayed: boolean }
  | { kind: "skip" }
  | { kind: "stop"; reason: "event-type-off" | "socle-unavailable" | "socle-refused" };

function retryable(r: SendResult): boolean {
  return (
    r.kind === "unreachable" ||
    (r.kind === "problem" && (r.status === 503 || (r.status === 409 && r.type === "idempotency-key-in-use")))
  );
}

function outcomeOf(r: SendResult): Outcome {
  if (r.kind === "accepted") return { kind: "sent", replayed: r.replayed };
  if (r.kind === "problem") {
    // The key was already used today with another body (say, a new email):
    // it was sent, so it counts as sent.
    if (r.status === 422 && r.type === "idempotency-key-reused") return { kind: "sent", replayed: true };
    // Socle's leak check refused this one task's ID. The others can still go.
    if (r.status === 422 && r.type === "data-refused") return { kind: "skip" };
    // Marc switched the event type off in Socle: nothing more today.
    if (r.status === 409 && r.type === "event-type-off") return { kind: "stop", reason: "event-type-off" };
  }
  if (retryable(r)) return { kind: "stop", reason: "socle-unavailable" };
  return { kind: "stop", reason: "socle-refused" };
}

let indexRequested: Promise<unknown> | null = null;

// One row per task. createIndex is a no-op once the index exists; a failure
// never holds up the run, it is simply tried again next time.
function ensureReminderIndex() {
  indexRequested ??= staleTaskRemindersCollection
    .createIndex({ userId: 1, taskId: 1 }, { unique: true, name: "userId_taskId" })
    .catch(() => {
      indexRequested = null;
    });
  return indexRequested;
}

export async function runStaleTaskJob(opts: StaleTaskJobOptions): Promise<StaleTaskRunSummary> {
  const now = opts.now ?? new Date();
  const today = torontoDay(now);
  const dryRun = opts.dryRun === true;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();
  const elapsedMs = opts.elapsedMs ?? (() => Date.now() - startedAt);

  const summary: StaleTaskRunSummary = {
    status: "done",
    ...(dryRun ? { dryRun: true as const } : {}),
    people: 0,
    waiting: 0,
    due: 0,
    sent: 0,
    replayed: 0,
    skippedToday: 0,
    remindedOnce: 0,
    failed: 0,
    left: 0,
    cleared: 0,
    ...(dryRun ? { taskIds: [] } : {}),
  };
  const finish = (patch: Partial<StaleTaskRunSummary> = {}) => {
    Object.assign(summary, patch);
    const { taskIds, ...counts } = summary;
    logNotifications("info", "stale_tasks_run", { ...counts, ...(taskIds ? { wouldSend: taskIds.length } : {}) });
    return summary;
  };

  // Off, quietly, until Production has Socle's address and key and an allowlist.
  if (!opts.socle) return finish({ status: "off", reason: "socle-not-configured" });
  if (opts.allowedUserIds.length === 0) return finish({ status: "off", reason: "no-allowed-users" });
  const socle = opts.socle;

  const settingsDocs = await userSettingsCollection
    .find({ userId: { $in: [...opts.allowedUserIds] } }, { projection: { userId: 1, notifications: 1 } })
    .toArray();
  const settingsByUser = new Map(settingsDocs.map((d) => [d.userId, normalizeReminderSettings(d.notifications?.staleTasks)]));
  const people = opts.allowedUserIds.filter((id) => settingsByUser.get(id)?.enabled === true);
  summary.people = people.length;

  if (!dryRun) {
    await ensureReminderIndex();
    // Reminders turned off, or no longer on the allowlist: nothing of theirs is kept.
    summary.cleared += (await staleTaskRemindersCollection.deleteMany({ userId: { $nin: people } })).deletedCount;
  }

  let budget = MAX_EVENTS_PER_RUN;
  let stopped: string | undefined;

  for (const userId of people) {
    if (stopped) break;
    const settings = settingsByUser.get(userId)!;
    const tasks = await tasksCollection
      .find(
        {
          userId,
          quadrant: "urgent-important",
          status: { $ne: "completed" },
          // { field: null } matches null OR missing
          archivedAt: null as unknown as undefined,
          parentTaskId: null as unknown as undefined,
        },
        { projection: { _id: 1, quadrant: 1, status: 1, archivedAt: 1, parentTaskId: 1, quadrantSince: 1, createdAt: 1 } },
      )
      .limit(1000)
      .toArray();
    const rows = await staleTaskRemindersCollection.find({ userId }).toArray();
    const plan = planReminders({ tasks, reminders: rows, settings, today });
    summary.waiting += plan.waiting.length;
    summary.due += plan.due.length;
    summary.skippedToday += plan.sentToday;
    summary.remindedOnce += plan.remindedOnce;

    if (!dryRun) {
      // Rows for tasks that stopped waiting (done, archived, moved, deleted) go.
      const keep = plan.waiting.map((w) => new ObjectId(w.taskId));
      summary.cleared += (await staleTaskRemindersCollection.deleteMany({ userId, taskId: { $nin: keep } })).deletedCount;
    }

    const batch = plan.due.slice(0, budget);
    budget -= batch.length;
    if (batch.length === 0) continue;
    if (dryRun) {
      summary.taskIds?.push(...batch.map((w) => w.taskId));
      continue;
    }

    const recipient = await opts.recipientFor(userId).catch(() => null);
    if (!recipient) {
      summary.failed += batch.length;
      logNotifications("warn", "stale_tasks_no_recipient");
      continue;
    }

    for (const w of batch) {
      if (elapsedMs() > RUN_BUDGET_MS) {
        stopped = "time-budget";
        break;
      }
      const event = {
        idempotencyKey: staleTaskKey(w.taskId, today),
        recipient: { id: userId, ...recipient },
        taskId: w.taskId,
        daysWaiting: w.daysWaiting,
      };
      let result = await socle.sendStaleTaskEvent(event);
      if (retryable(result)) {
        // One retry, with the same key and body, then it waits for the next run.
        const waitS = result.kind === "problem" ? (result.retryAfterSeconds ?? 1) : 1;
        await sleep(Math.min(waitS * 1000, MAX_RETRY_WAIT_MS));
        result = await socle.sendStaleTaskEvent(event);
      }
      const outcome = outcomeOf(result);

      if (outcome.kind === "sent") {
        summary.sent++;
        if (outcome.replayed) summary.replayed++;
        try {
          await staleTaskRemindersCollection.updateOne(
            { userId, taskId: new ObjectId(w.taskId) },
            {
              $set: { since: w.since, lastSentOn: today, sentCount: w.sentCount + 1, updatedAt: now },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true },
          );
        } catch {
          // Socle holds the key for 24 hours, so a second run today still won't send twice.
          logNotifications("error", "stale_tasks_record_failed");
        }
        continue;
      }

      summary.failed++;
      logNotifications(
        "warn",
        "stale_task_refused",
        result.kind === "problem"
          ? { status: result.status, type: result.type, requestId: result.requestId }
          : { unreachable: result.kind === "unreachable" ? result.reason : undefined },
      );
      if (outcome.kind === "stop") {
        stopped = outcome.reason;
        break;
      }
    }
  }

  const handled = dryRun ? (summary.taskIds?.length ?? 0) : summary.sent + summary.failed;
  summary.left = Math.max(0, summary.due - handled);
  return finish(stopped ? { status: "stopped", reason: stopped } : {});
}

/** "fr-CA" → "fr", "en-US" → "en", anything else → nothing. */
export function localeFrom(raw: string | null | undefined): "fr" | "en" | undefined {
  const lang = raw?.toLowerCase().split(/[-_]/)[0];
  return lang === "fr" || lang === "en" ? lang : undefined;
}

/** The person's primary email from EisenQ's own Clerk application, at send time. */
export async function clerkRecipientFor(userId: string): Promise<Omit<StaleTaskRecipient, "id"> | null> {
  const user = await (await clerkClient()).users.getUser(userId);
  const email = user.primaryEmailAddress?.emailAddress;
  if (!email) return null;
  const locale = localeFrom(user.locale);
  return { email, ...(locale ? { locale } : {}) };
}
