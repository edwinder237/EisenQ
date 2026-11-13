import Anthropic from "@anthropic-ai/sdk";
import type { ObjectId } from "mongodb";
import { tasksCollection, goalsCollection, userSettingsCollection } from "~/server/db";
import type { TaskQuadrant, TaskPriority } from "~/server/db/schema";
import { decrypt } from "~/server/crypto";

// The AI prioritization assistant: reads the user's open tasks and goals, asks
// Claude for a reply plus a few atomic changes, and returns those changes as
// suggestions the client can apply through the normal task APIs. Nothing here
// writes to the database.

export type SuggestionAction =
  | "move_quadrant"
  | "set_priority"
  | "set_due_date"
  | "archive"
  | "link_goal"
  | "move_to_top";

export interface AssistantSuggestion {
  id: string;
  taskId: string;
  taskTitle: string;
  action: SuggestionAction;
  // Machine value the client applies: a TaskQuadrant, TaskPriority, "YYYY-MM-DD", goal id, or "".
  value: string;
  // Human summary of the change, e.g. "Schedule → Do First".
  label: string;
  reason: string;
}

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export class AssistantError extends Error {
  constructor(
    public code: "no_key" | "bad_key" | "rate_limited" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const QUADRANT_NAMES: Record<TaskQuadrant, string> = {
  "urgent-important": "Do First",
  "important-not-urgent": "Schedule",
  "urgent-not-important": "Delegate",
  "not-urgent-not-important": "Eliminate",
};
const QUADRANT_BY_NAME = Object.fromEntries(
  Object.entries(QUADRANT_NAMES).map(([k, v]) => [v, k as TaskQuadrant]),
) as Record<string, TaskQuadrant>;
const PRIORITIES: TaskPriority[] = ["high", "medium", "low"];

const MODEL = "claude-opus-5-5";

// Stable across requests so it can be cached.
const SYSTEM_PROMPT = `You are the prioritization assistant inside EisenQ, an Eisenhower-matrix task manager
(quadrants: Do First, Schedule, Delegate, Eliminate). You help one person decide what to focus on.

Each turn you get a fresh snapshot of their open tasks (refs T1, T2, ...) and active goals (G1, G2, ...),
then their message. Reply briefly and concretely in "reply" (2-4 sentences, plain text, no markdown),
and put any proposed changes in "suggestions".

Each suggestion is one atomic change the app can apply to a single task:
- move_quadrant: value is Do First, Schedule, Delegate or Eliminate
- set_priority: value is high, medium or low
- set_due_date: value is YYYY-MM-DD
- archive: value is an empty string
- link_goal: value is a goal ref such as G2
- move_to_top: value is an empty string (makes it the first task in its quadrant)

Guidelines:
- Suggest at most 7 changes, fewer when the matrix is in good shape. Only suggest what you would actually do.
- Prefer removing, deferring or archiving work over adding urgency.
- Never invent tasks or refs. Only use refs from the latest snapshot.
- Ground each reason in the data (due dates, age, notes, goals) in one short sentence.
- If the person only asks a question, answer it and return no suggestions unless they help.
- Respect what the person tells you about their week or constraints.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_ref: { type: "string" },
          action: {
            type: "string",
            enum: ["move_quadrant", "set_priority", "set_due_date", "archive", "link_goal", "move_to_top"],
          },
          value: { type: "string" },
          reason: { type: "string" },
        },
        required: ["task_ref", "action", "value", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "suggestions"],
  additionalProperties: false,
} as const;

interface RawSuggestion {
  task_ref: string;
  action: SuggestionAction;
  value: string;
  reason: string;
}

const day = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

export async function hasAssistantKey(userId: string): Promise<boolean> {
  const doc = await userSettingsCollection.findOne({ userId }, { projection: { anthropicApiKeyEnc: 1 } });
  return !!doc?.anthropicApiKeyEnc;
}

async function loadApiKey(userId: string): Promise<string> {
  const doc = await userSettingsCollection.findOne({ userId }, { projection: { anthropicApiKeyEnc: 1 } });
  if (!doc?.anthropicApiKeyEnc) throw new AssistantError("no_key", "Add your Claude API key in Settings → Greeting.");
  try {
    return decrypt(doc.anthropicApiKeyEnc);
  } catch {
    throw new AssistantError("no_key", "Your saved Claude API key couldn't be read. Save it again in Settings.");
  }
}

export async function runAssistant(
  userId: string,
  history: AssistantMessage[],
  today: Date = new Date(),
): Promise<{ reply: string; suggestions: AssistantSuggestion[] }> {
  const apiKey = await loadApiKey(userId);

  // Same filter as the matrix (GET /api/tasks): top-level, open, not archived.
  const [tasks, goals] = await Promise.all([
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

  const taskByRef = new Map(tasks.map((t, i) => [`T${i + 1}`, t]));
  const goalByRef = new Map(goals.map((g, i) => [`G${i + 1}`, g]));
  const goalRefById = new Map([...goalByRef].map(([ref, g]) => [String(g._id), ref]));

  const snapshot = {
    today: `${day(today)} (${today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })})`,
    goals: [...goalByRef].map(([ref, g]) => ({
      ref,
      title: g.title,
      period: g.periodType,
      period_key: g.periodKey,
      pinned: g.pinned ?? undefined,
    })),
    tasks: [...taskByRef].map(([ref, t]) => ({
      ref,
      title: t.title,
      notes: t.description ? t.description.slice(0, 300) : undefined,
      quadrant: QUADRANT_NAMES[t.quadrant],
      priority: t.priority,
      status: t.status,
      due: day(t.dueDate),
      duration_min: t.duration,
      age_days: Math.round((today.getTime() - new Date(t.createdAt).getTime()) / 86_400_000),
      goal: t.goalId ? goalRefById.get(String(t.goalId)) : undefined,
    })),
  };

  // The snapshot rides on the latest user turn, so refs always match the current
  // matrix even after earlier suggestions were applied.
  const messages: Anthropic.MessageParam[] = history.map((m, i) =>
    i === history.length - 1 && m.role === "user"
      ? {
          role: "user",
          content: `Current matrix snapshot:\n${JSON.stringify(snapshot)}\n\nMy message: ${m.content}`,
        }
      : { role: m.role, content: m.content },
  );

  const client = new Anthropic({ apiKey });
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages,
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      throw new AssistantError("bad_key", "Claude rejected the saved API key. Check it in Settings → Greeting.");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new AssistantError("rate_limited", "Claude is rate limiting this key. Try again in a minute.");
    }
    throw new AssistantError("failed", "The assistant couldn't reach Claude. Try again.");
  }

  if (response.stop_reason === "refusal") {
    return { reply: "I can't help with that request.", suggestions: [] };
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  let parsed: { reply: string; suggestions: RawSuggestion[] };
  try {
    parsed = JSON.parse(text ?? "") as typeof parsed;
  } catch {
    throw new AssistantError("failed", "The assistant returned an unreadable answer. Try again.");
  }

  // Keep only suggestions that point at a real task and carry a value the app can apply.
  const suggestions: AssistantSuggestion[] = [];
  parsed.suggestions.forEach((s, i) => {
    const task = taskByRef.get(s.task_ref);
    if (!task) return;
    const built = buildSuggestion(s, task, goalByRef, goalRefById);
    if (!built) return;
    suggestions.push({
      id: `${response.id}-${i}`,
      taskId: String(task._id),
      taskTitle: task.title,
      action: s.action,
      reason: s.reason,
      ...built,
    });
  });

  return { reply: parsed.reply, suggestions };
}

function buildSuggestion(
  s: RawSuggestion,
  task: { quadrant: TaskQuadrant; priority: TaskPriority; dueDate?: Date; goalId?: ObjectId },
  goalByRef: Map<string, { _id?: ObjectId; title: string; icon?: string }>,
  goalRefById: Map<string, string>,
): { value: string; label: string } | null {
  const value = s.value.trim();
  switch (s.action) {
    case "move_quadrant": {
      const q = QUADRANT_BY_NAME[value];
      if (!q || q === task.quadrant) return null;
      return { value: q, label: `${QUADRANT_NAMES[task.quadrant]} → ${value}` };
    }
    case "set_priority": {
      const p = value.toLowerCase() as TaskPriority;
      if (!PRIORITIES.includes(p) || p === task.priority) return null;
      return { value: p, label: `Priority ${task.priority} → ${p}` };
    }
    case "set_due_date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return null;
      return { value, label: `Due ${day(task.dueDate) ?? "none"} → ${value}` };
    }
    case "archive":
      return { value: "", label: "Archive" };
    case "move_to_top":
      return { value: "", label: `Move to top of ${QUADRANT_NAMES[task.quadrant]}` };
    case "link_goal": {
      const goal = goalByRef.get(value);
      if (!goal?._id) return null;
      if (task.goalId && goalRefById.get(String(task.goalId)) === value) return null;
      return { value: String(goal._id), label: `Link to ${goal.icon ? `${goal.icon} ` : ""}${goal.title}` };
    }
    default:
      return null;
  }
}
