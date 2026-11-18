import { ObjectId } from "mongodb";
import { tasksCollection, userSettingsCollection } from "~/server/db";
import type { AssistantRun, StepOwner, Task } from "~/server/db/schema";
import { decrypt, encrypt } from "~/server/crypto";
import { TaskServiceError } from "~/server/task-service";

// Hand a task to the Assistant: fire the person's Claude Code routine through
// its API trigger. The routine runs on their own Claude plan, reads the task
// through the EisenQ connector and reports back with report_assistant_result.
//
// The trigger is an experimental Anthropic endpoint:
//   POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire
// Its token is per-routine (sk-ant-oat01-...), can only start that routine,
// and is shown once in claude.ai/code/routines.

const FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9_-]+)\/fire$/;
const TRIGGER_ID = /^trig_[A-Za-z0-9_-]+$/;

/** Accepts the full trigger URL or just its trig_ id; returns the canonical URL, or null. */
export function normalizeRoutineUrl(input: string): string | null {
  const value = input.trim();
  if (TRIGGER_ID.test(value)) return `https://api.anthropic.com/v1/claude_code/routines/${value}/fire`;
  return FIRE_URL.test(value) ? value : null;
}

export async function saveRoutine(userId: string, url: string, token: string): Promise<void> {
  await userSettingsCollection.updateOne(
    { userId },
    {
      $set: { assistantRoutineUrlEnc: encrypt(url), assistantRoutineTokenEnc: encrypt(token), updatedAt: new Date() },
      $setOnInsert: { userId, createdAt: new Date() },
    },
    { upsert: true },
  );
}

export async function forgetRoutine(userId: string): Promise<void> {
  await userSettingsCollection.updateOne(
    { userId },
    { $unset: { assistantRoutineUrlEnc: "", assistantRoutineTokenEnc: "" }, $set: { updatedAt: new Date() } },
  );
}

async function loadRoutine(userId: string): Promise<{ url: string; token: string } | null> {
  const doc = await userSettingsCollection.findOne(
    { userId },
    { projection: { assistantRoutineUrlEnc: 1, assistantRoutineTokenEnc: 1 } },
  );
  if (!doc?.assistantRoutineUrlEnc || !doc.assistantRoutineTokenEnc) return null;
  try {
    return { url: decrypt(doc.assistantRoutineUrlEnc), token: decrypt(doc.assistantRoutineTokenEnc) };
  } catch {
    return null; // rotated encryption key: treat as not connected
  }
}

/** What the browser may know: whether a routine is set up, and which one. Never the token. */
export async function routineStatus(userId: string): Promise<{ connected: boolean; triggerId?: string }> {
  const routine = await loadRoutine(userId);
  if (!routine) return { connected: false };
  return { connected: true, triggerId: FIRE_URL.exec(routine.url)?.[1] };
}

const FIRE_ERRORS: Record<number, string> = {
  400: "Claude didn't accept the request. The routine may be paused: check it at claude.ai/code/routines.",
  401: "The routine's token doesn't match. Generate a new one in claude.ai/code/routines and reconnect.",
  403: "Your Claude account can't use routine triggers. It needs a paid plan with Claude Code on the web.",
  404: "That routine no longer exists. Reconnect it with a current trigger URL.",
  429: "The routine has hit its hourly limit. Try again a little later.",
};

/**
 * Fires the routine for one task and records the hand-off on it. The payload
 * carries only the task id and how to do it: the routine looks the task up
 * through the connector, so nothing in the trigger text has to be trusted.
 */
export async function handToAssistant(
  userId: string,
  taskId: string,
  input: { mode: AssistantRun["mode"]; stepOwners: Record<string, StepOwner> },
): Promise<Task> {
  if (!ObjectId.isValid(taskId)) throw new TaskServiceError("Invalid task ID", 400);
  const _id = new ObjectId(taskId);
  const task = await tasksCollection.findOne({ _id, userId });
  if (!task) throw new TaskServiceError("Task not found", 404);
  if (task.status === "completed") throw new TaskServiceError("This task is already done.", 400);
  if (task.assistantRun?.status === "working") {
    throw new TaskServiceError("The Assistant is already working on this task.", 409);
  }

  const routine = await loadRoutine(userId);
  if (!routine) throw new TaskServiceError("Connect your Claude routine first.", 412, { code: "no_routine" });

  const text = [
    `EisenQ task id: ${taskId}`,
    `How: ${input.mode === "steps" ? "follow the task's checklist" : "figure it out"}`,
  ].join("\n");

  let res: Response;
  try {
    res = await fetch(routine.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${routine.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TaskServiceError("Couldn't reach Claude. Try again in a moment.", 502);
  }

  if (!res.ok) {
    const message = FIRE_ERRORS[res.status] ?? "Claude couldn't start the routine just now. Try again in a moment.";
    throw new TaskServiceError(message, res.status === 401 || res.status === 404 ? 412 : 502, {
      code: res.status === 401 || res.status === 404 ? "no_routine" : "fire_failed",
    });
  }

  const fired = (await res.json().catch(() => ({}))) as { claude_code_session_url?: unknown };
  const sessionUrl =
    typeof fired.claude_code_session_url === "string" && fired.claude_code_session_url.startsWith("https://claude.ai/")
      ? fired.claude_code_session_url
      : undefined;

  const run: AssistantRun = {
    mode: input.mode,
    stepOwners: input.stepOwners,
    status: "working",
    requestedAt: new Date(),
    sessionUrl,
  };
  const updated = await tasksCollection.findOneAndUpdate(
    { _id, userId },
    { $set: { assistantRun: run, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) throw new TaskServiceError("Task not found", 404);
  return updated;
}

/** Takes a task back. A run already started keeps going on Claude's side, but its report is refused. */
export async function takeBackFromAssistant(userId: string, taskId: string): Promise<void> {
  if (!ObjectId.isValid(taskId)) throw new TaskServiceError("Invalid task ID", 400);
  await tasksCollection.updateOne(
    { _id: new ObjectId(taskId), userId },
    { $unset: { assistantRun: "" }, $set: { updatedAt: new Date() } },
  );
}

/** Steps the Assistant may tick: required or optional, not owned by someone else. */
export function assistantOwns(run: AssistantRun, stepId: string): boolean {
  return (run.stepOwners[stepId] ?? "assistant") === "assistant";
}

/**
 * The routine's report, from the connector. Ticks only the Assistant's own
 * steps, and only while the task is still handed to it.
 */
export async function recordAssistantResult(
  userId: string,
  taskId: string,
  input: { status: "done" | "blocked"; result: string; stepsDone: string[] },
): Promise<{ task: Task; ticked: number; skipped: string[] }> {
  if (!ObjectId.isValid(taskId)) throw new TaskServiceError("Not an EisenQ task id.", 400);
  const _id = new ObjectId(taskId);
  const task = await tasksCollection.findOne({ _id, userId });
  if (!task) throw new TaskServiceError("No task with that id.", 404);
  const run = task.assistantRun;
  if (!run) throw new TaskServiceError("This task isn't handed to the Assistant (it may have been taken back). Don't change it.", 409);
  if (run.status !== "working") throw new TaskServiceError("This hand-off already has a report. Don't send another.", 409);

  const wanted = new Set(input.stepsDone);
  const skipped: string[] = [];
  let ticked = 0;
  const now = new Date();
  const checklists = (task.checklists ?? []).map((c) => ({
    ...c,
    steps: c.steps.map((s) => {
      if (!wanted.has(s.id)) return s;
      wanted.delete(s.id);
      if (!assistantOwns(run, s.id)) { skipped.push(s.id); return s; }
      if (s.done) return s;
      ticked++;
      return { ...s, done: true, doneAt: now };
    }),
  }));
  skipped.push(...wanted); // ids that aren't on this task

  const updated = await tasksCollection.findOneAndUpdate(
    { _id, userId, "assistantRun.status": "working" },
    {
      $set: {
        checklists,
        "assistantRun.status": input.status,
        "assistantRun.result": input.result,
        "assistantRun.finishedAt": now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) throw new TaskServiceError("This hand-off changed while you were working. Don't change it.", 409);
  return { task: updated, ticked, skipped };
}
