// Delegate quadrant relay logic.
//
// Hand-offs to the Assistant are real: they're saved on the task and fire the
// person's Claude routine (see delegationFromRun). Hand-offs to household
// members are still a prototype, kept in this browser's localStorage, because
// household accounts don't exist yet; Sam and Noor are placeholders. Ticking a
// step always goes through the normal checklist API.
//
// The relay is the task's checklist read in order: one chip per required step,
// owned by whoever the step was handed to. Optional steps stay out of it (they
// never hold anyone up), and only one step is current at a time.

import { format } from "date-fns";

export type HelperId = "assistant" | "sam" | "noor";
export type Who = "you" | HelperId;

export interface Helper {
  id: HelperId;
  name: string;
  kind: "ai" | "person";
  initial: string;
}

export const HELPERS: Helper[] = [
  { id: "assistant", name: "Assistant", kind: "ai", initial: "" },
  { id: "sam", name: "Sam", kind: "person", initial: "S" },
  { id: "noor", name: "Noor", kind: "person", initial: "N" },
];

export function helper(id: HelperId): Helper {
  return HELPERS.find((h) => h.id === id)!;
}

export function nameOf(who: Who): string {
  return who === "you" ? "You" : helper(who).name;
}

/** "steps": follow the checklist. "outcome": no steps given, they figure it out. */
export type HandOffMode = "steps" | "outcome";

export interface Delegation {
  to: HelperId;
  mode: HandOffMode;
  /** Per-step owner overrides, by checklist step id. Unlisted steps belong to `to`. */
  stepOwners: Record<string, Who>;
  /** Outcome mode: they finished their own plan, so it is back with you. */
  outcomeDone?: boolean;
  /** They couldn't take it; it comes back to you to hand on. */
  passed?: { label: string; by: HelperId };
  at: string;
}

export type Delegations = Record<string, Delegation>;

// The slice of a dashboard task the prototype reads.
export interface RelayStep {
  id: string;
  text: string;
  order: number;
  done: boolean;
  doneAt?: string;
  optional?: boolean;
}
export interface RelayChecklist {
  id: string;
  order: number;
  steps: RelayStep[];
}
export interface RelayTask {
  _id: string;
  title: string;
  dueDate?: string;
  status: string;
  checklists?: RelayChecklist[];
  assistantRun?: AssistantRunView | null;
}

/** A real hand-off to the Assistant, saved on the task (see ~/server/assistant-routine). */
export interface AssistantRunView {
  mode: HandOffMode;
  stepOwners: Record<string, Who>;
  status: "working" | "done" | "blocked";
  requestedAt: string;
  sessionUrl?: string;
  finishedAt?: string;
  result?: string;
}

/**
 * The relay for a task handed to the Assistant, from what the server saved.
 * "done" in outcome mode means it's back with you to check; "blocked" reads as
 * the Assistant passing its current step back to you.
 */
export function delegationFromRun(task: RelayTask, run: AssistantRunView): Delegation {
  const d: Delegation = { to: "assistant", mode: run.mode, stepOwners: run.stepOwners, at: run.requestedAt };
  if (run.status === "done") d.outcomeDone = true;
  if (run.status === "blocked") {
    const stuck = relaySteps(task).find(({ step }) => !step.done && (run.stepOwners[step.id] ?? "assistant") === "assistant");
    d.passed = { label: stuck?.step.text.trim() ?? task.title, by: "assistant" };
  }
  return d;
}

export type ChipState = "done" | "now" | "later" | "passed";
/** What tapping a "You" chip does. */
export type ChipAction = "tick" | "complete" | "handOn";

export interface RelayChip {
  key: string;
  label: string;
  who: Who;
  state: ChipState;
  action?: ChipAction;
  checklistId?: string;
  stepId?: string;
  doneAt?: string;
}

/** Required, non-blank steps across every attached checklist, in order. */
export function relaySteps(task: RelayTask): { checklistId: string; step: RelayStep }[] {
  return [...(task.checklists ?? [])]
    .sort((a, b) => a.order - b.order)
    .flatMap((c) =>
      [...c.steps]
        .sort((a, b) => a.order - b.order)
        .filter((s) => s.text.trim() && !s.optional && !s.id.startsWith("tmp-"))
        .map((step) => ({ checklistId: c.id, step })),
    );
}

export function buildRelay(task: RelayTask, d: Delegation): RelayChip[] {
  if (d.passed) {
    return [
      { key: "passed", label: d.passed.label, who: d.passed.by, state: "passed" },
      { key: "hand-on", label: "Hand it on", who: "you", state: "now", action: "handOn" },
    ];
  }

  const steps = relaySteps(task);
  if (d.mode === "steps" && steps.length > 0) {
    let foundNow = false;
    const chips: RelayChip[] = steps.map(({ checklistId, step }) => {
      let state: ChipState;
      if (step.done) state = "done";
      else if (!foundNow) { state = "now"; foundNow = true; }
      else state = "later";
      return {
        key: step.id,
        label: step.text.trim(),
        who: d.stepOwners[step.id] ?? d.to,
        state,
        action: "tick",
        checklistId,
        stepId: step.id,
        doneAt: step.doneAt,
      };
    });
    if (!foundNow) chips.push({ key: "close", label: "Close it out", who: "you", state: "now", action: "complete" });
    return chips;
  }

  const ownPlan = d.to === "assistant" ? "Working from its own plan" : "Doing it their way";
  return [
    { key: "plan", label: d.outcomeDone ? "Finished" : ownPlan, who: d.to, state: d.outcomeDone ? "done" : "now" },
    { key: "review", label: "Check it and close", who: "you", state: d.outcomeDone ? "now" : "later", action: "complete" },
  ];
}

export function currentChip(chips: RelayChip[]): RelayChip | undefined {
  return chips.find((c) => c.state === "now");
}

/** One line on the most recent thing that happened. */
export function latestLine(chips: RelayChip[], d: Delegation): string {
  if (d.passed) return `${helper(d.passed.by).name} couldn't take “${d.passed.label}”.`;
  const lastDone = chips
    .filter((c) => c.state === "done" && c.doneAt)
    .sort((a, b) => new Date(b.doneAt!).getTime() - new Date(a.doneAt!).getTime())[0];
  if (lastDone) {
    return `${nameOf(lastDone.who)} finished “${lastDone.label}” · ${format(new Date(lastDone.doneAt!), "EEE h:mm a")}`;
  }
  if (d.outcomeDone) return `${helper(d.to).name} says it's done.`;
  return `Handed to ${helper(d.to).name} · ${format(new Date(d.at), "EEE h:mm a")}`;
}

const STORAGE_KEY = "eisenq.delegate-prototype.v1";

export function loadDelegations(): Delegations {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Delegations) : {};
  } catch {
    return {};
  }
}

export function saveDelegations(all: Delegations): void {
  try {
    const kept = Object.fromEntries(Object.entries(all).filter(([id]) => !id.startsWith(SAMPLE_PREFIX)));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage blocked (private mode): the prototype still works for this visit.
  }
}

export const SAMPLE_PREFIX = "sample-";

/** In-memory sample tasks, so the quadrant can be tried without touching real data. */
export function sampleData(now = new Date()): { tasks: RelayTask[]; delegations: Delegations } {
  const day = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 9).toISOString();
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const step = (id: string, text: string, order: number, doneAt?: string): RelayStep =>
    ({ id, text, order, done: !!doneAt, doneAt });
  const at = ago(30);

  const tasks: RelayTask[] = [
    {
      _id: `${SAMPLE_PREFIX}lease`, title: "Reply to the landlord about the lease renewal", dueDate: day(0), status: "pending",
      checklists: [{ id: "c1", order: 0, steps: [
        step("lease-1", "Read the terms", 0, ago(3)),
        step("lease-2", "Draft the reply", 1, ago(2)),
        step("lease-3", "Approve the draft", 2),
        step("lease-4", "Send", 3),
      ] }],
    },
    {
      _id: `${SAMPLE_PREFIX}tires`, title: "Take the car in for winter tires", dueDate: day(1), status: "pending",
      checklists: [{ id: "c1", order: 0, steps: [
        step("tires-1", "Book the garage", 0, ago(20)),
        step("tires-2", "Drop the car off", 1),
        step("tires-3", "Pick it up", 2),
      ] }],
    },
    { _id: `${SAMPLE_PREFIX}internet`, title: "Compare internet plans and summarize", dueDate: day(3), status: "pending" },
    {
      _id: `${SAMPLE_PREFIX}rego`, title: "Renew the car registration", dueDate: day(5), status: "pending",
      checklists: [{ id: "c1", order: 0, steps: [
        step("rego-1", "Fill in the form", 0),
        step("rego-2", "Pay the fee", 1),
        step("rego-3", "Put the sticker on", 2),
      ] }],
    },
    { _id: `${SAMPLE_PREFIX}ink`, title: "Order printer ink", dueDate: day(2), status: "pending" },
  ];

  const delegations: Delegations = {
    [`${SAMPLE_PREFIX}lease`]: { to: "assistant", mode: "steps", stepOwners: { "lease-3": "you" }, at },
    [`${SAMPLE_PREFIX}tires`]: { to: "sam", mode: "steps", stepOwners: {}, at },
    [`${SAMPLE_PREFIX}internet`]: { to: "assistant", mode: "outcome", stepOwners: {}, at },
    [`${SAMPLE_PREFIX}rego`]: { to: "assistant", mode: "steps", stepOwners: { "rego-2": "you", "rego-3": "sam" }, at },
  };

  return { tasks, delegations };
}
