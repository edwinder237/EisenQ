// Throwaway experiment: would an AI triage of my matrix give suggestions I'd actually apply?
// Read-only — pulls open tasks + active goals from Mongo, asks Claude for suggestions, prints them.
// Nothing is written back to the database.
//
// Usage:
//   node --env-file=.env scripts/triage-test.mjs                      # general triage
//   node --env-file=.env scripts/triage-test.mjs "I'm out Thursday"   # with a question/context
//   USER_ID=user_xxx node --env-file=.env scripts/triage-test.mjs     # pick a user if the DB has several
//
// Uses the Claude API key saved in the app (Settings → Claude API key) for the chosen user.
// Needs DATABASE_URL and SETTINGS_ENCRYPTION_KEY in .env (both already there).

import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { MongoClient } from "mongodb";

// Same AES-256-GCM format as src/server/crypto.ts: `${iv}:${authTag}:${ciphertext}` in base64.
function decrypt(payload) {
  const [iv, tag, data] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY, "hex"),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

const QUADRANTS = {
  "urgent-important": "Do First",
  "important-not-urgent": "Schedule",
  "urgent-not-important": "Delegate",
  "not-urgent-not-important": "Eliminate",
};

const question = process.argv.slice(2).join(" ").trim();
const today = new Date();

const mongo = new MongoClient(process.env.DATABASE_URL);
await mongo.connect();
const db = mongo.db();

try {
  // Figure out whose matrix to triage.
  // Defaults to the user with the most open tasks; override with USER_ID.
  let userId = process.env.USER_ID;
  if (!userId) {
    const [top] = await db
      .collection("tasks")
      .aggregate([
        { $match: { userId: { $exists: true }, status: { $ne: "completed" }, archivedAt: { $exists: false } } },
        { $group: { _id: "$userId", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    userId = top?._id;
    console.log(`Using user ${userId} (most open tasks). Set USER_ID to pick another.`);
  }

  const settings = await db.collection("userSettings").findOne({ userId }, { projection: { anthropicApiKeyEnc: 1 } });
  if (!settings?.anthropicApiKeyEnc) {
    console.error("No Claude API key saved for this user. Add it in the app: Settings → Claude API key.");
    process.exit(1);
  }
  const apiKey = decrypt(settings.anthropicApiKeyEnc);

  const tasks = await db
    .collection("tasks")
    .find({
      userId,
      status: { $ne: "completed" },
      archivedAt: { $exists: false },
      parentTaskId: { $exists: false },
    })
    .sort({ quadrant: 1, sortOrder: 1 })
    .toArray();

  const goals = await db.collection("goals").find({ userId, status: "active" }).toArray();

  if (tasks.length === 0) {
    console.log("No open tasks found for this user.");
    process.exit(0);
  }

  // Short refs keep the prompt small and let us map suggestions back to tasks.
  const taskRef = new Map(tasks.map((t, i) => [`T${i + 1}`, t]));
  const goalRef = new Map(goals.map((g, i) => [`G${i + 1}`, g]));
  const goalIdToRef = new Map([...goalRef].map(([ref, g]) => [String(g._id), ref]));

  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);
  const ageDays = (d) => Math.round((today - new Date(d)) / 86_400_000);

  const taskLines = [...taskRef].map(([ref, t]) => ({
    ref,
    title: t.title,
    notes: t.description ? t.description.slice(0, 300) : undefined,
    quadrant: QUADRANTS[t.quadrant],
    priority: t.priority,
    status: t.status,
    due: day(t.dueDate),
    duration_min: t.duration,
    age_days: ageDays(t.createdAt),
    position_in_quadrant: t.sortOrder,
    goal: t.goalId ? goalIdToRef.get(String(t.goalId)) : undefined,
  }));

  const goalLines = [...goalRef].map(([ref, g]) => ({
    ref,
    title: g.title,
    period: g.periodType,
    period_key: g.periodKey,
    pinned: g.pinned || undefined,
  }));

  const system = `You help one person triage their Eisenhower matrix (Do First, Schedule, Delegate, Eliminate).
Suggest a small number of concrete changes (3 to 7) that would most improve focus this week.
Each suggestion must be one atomic change the app can apply: move a task to another quadrant, change its priority,
set or change its due date, archive it, link it to a goal, or move it to the top of its quadrant.
Prefer removing or deferring work over adding urgency. Never invent tasks. Only reference the refs given.
Ground each reason in the data (due dates, age, goals), and keep reasons to one sentence.
If the matrix already looks well prioritized, say so and return fewer suggestions.`;

  const user = `Today is ${day(today)} (${today.toLocaleDateString("en-US", { weekday: "long" })}).

Active goals:
${JSON.stringify(goalLines, null, 1)}

Open tasks:
${JSON.stringify(taskLines, null, 1)}
${question ? `\nMy request: ${question}` : ""}`;

  const schema = {
    type: "object",
    properties: {
      overview: { type: "string", description: "Two sentences on the state of the matrix." },
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
            value: {
              type: "string",
              description:
                "move_quadrant: Do First|Schedule|Delegate|Eliminate; set_priority: high|medium|low; set_due_date: YYYY-MM-DD; link_goal: goal ref; archive/move_to_top: empty string",
            },
            reason: { type: "string" },
          },
          required: ["task_ref", "action", "value", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["overview", "suggestions"],
    additionalProperties: false,
  };

  console.log(`Triaging ${tasks.length} open tasks and ${goals.length} active goals…\n`);

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    console.error("Claude declined:", response.stop_details);
    process.exit(1);
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  const result = JSON.parse(text);

  console.log(result.overview, "\n");
  result.suggestions.forEach((s, i) => {
    const t = taskRef.get(s.task_ref);
    if (!t) {
      console.log(`${i + 1}. [unknown task ${s.task_ref}] — model referenced a task that doesn't exist\n`);
      return;
    }
    const current = {
      move_quadrant: QUADRANTS[t.quadrant],
      set_priority: t.priority,
      set_due_date: day(t.dueDate) ?? "none",
      link_goal: t.goalId ? goalIdToRef.get(String(t.goalId)) ?? "?" : "none",
      archive: "open",
      move_to_top: `position ${t.sortOrder ?? "?"}`,
    }[s.action];
    const target =
      s.action === "link_goal" ? `${s.value} (${goalRef.get(s.value)?.title ?? "unknown goal"})` : s.value || "";
    console.log(`${i + 1}. ${t.title}`);
    console.log(`   ${s.action}: ${current} → ${target}`);
    console.log(`   why: ${s.reason}\n`);
  });

  const u = response.usage;
  console.log(`— tokens: ${u.input_tokens} in / ${u.output_tokens} out`);
} finally {
  await mongo.close();
}
