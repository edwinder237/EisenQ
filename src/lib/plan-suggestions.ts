// Ranking for the Task Planning grid: which open tasks to offer when the person
// clicks a free slot. Plain rules, no AI, so it is instant and predictable.

export type PlanQuadrant =
  | "urgent-important"
  | "important-not-urgent"
  | "urgent-not-important"
  | "not-urgent-not-important";

export interface PlanTask {
  _id: string;
  title: string;
  quadrant: PlanQuadrant;
  priority: "high" | "medium" | "low";
  status: "pending" | "in-progress" | "completed";
  dueDate?: string;
  duration?: number;
  createdAt: string;
  parentTaskId?: string;
  goalId?: string;
  archivedAt?: string;
}

export interface PlanGoal {
  _id: string;
  title: string;
  status: "active" | "achieved" | "dropped";
}

export interface Suggestion {
  task: PlanTask;
  score: number;
  fits: boolean;
  reasons: string[];
}

export const DEFAULT_DURATION = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Tasks that can be put on the grid: open, top-level, Do First or Schedule. */
export function isSchedulable(task: PlanTask): boolean {
  return (
    task.status !== "completed" &&
    !task.archivedAt &&
    !task.parentTaskId &&
    (task.quadrant === "important-not-urgent" || task.quadrant === "urgent-important")
  );
}

/**
 * Score one task for a slot starting at `slotStart` with `freeMinutes` of room
 * before the next busy block. Higher is better.
 */
export function scoreTask(
  task: PlanTask,
  slotStart: Date,
  freeMinutes: number,
  goalsById: Map<string, PlanGoal>,
  now: Date = new Date(),
): Suggestion {
  const reasons: string[] = [];
  let score = 0;

  score += task.priority === "high" ? 30 : task.priority === "medium" ? 15 : 0;
  if (task.priority === "high") reasons.push("High priority");

  const goal = task.goalId ? goalsById.get(task.goalId) : undefined;
  if (goal && goal.status === "active") {
    score += 20;
    reasons.push(`Goal: ${goal.title}`);
  }

  if (task.dueDate) {
    const daysLeft = (new Date(task.dueDate).getTime() - slotStart.getTime()) / DAY_MS;
    if (daysLeft < 0) {
      score += 25;
      reasons.push("Overdue");
    } else if (daysLeft <= 3) {
      score += 20;
      reasons.push("Due soon");
    } else if (daysLeft <= 7) {
      score += 10;
      reasons.push("Due this week");
    }
  }

  const waitingDays = Math.floor((now.getTime() - new Date(task.createdAt).getTime()) / DAY_MS);
  score += Math.min(15, Math.max(0, waitingDays));
  if (waitingDays >= 7) reasons.push(`Waiting ${waitingDays}d`);

  const length = task.duration ?? DEFAULT_DURATION;
  const fits = length <= freeMinutes;
  if (fits) {
    score += 10;
    reasons.push(`${formatMinutes(length)} fits`);
  } else {
    score -= 40;
    reasons.push(`Needs ${formatMinutes(length)}`);
  }

  return { task, score, fits, reasons };
}

/** Rank candidates, best first. */
export function rankTasks(
  tasks: PlanTask[],
  slotStart: Date,
  freeMinutes: number,
  goals: PlanGoal[],
  now: Date = new Date(),
): Suggestion[] {
  const goalsById = new Map(goals.map((g) => [g._id, g]));
  return tasks
    .map((t) => scoreTask(t, slotStart, freeMinutes, goalsById, now))
    .sort((a, b) => b.score - a.score || a.task.title.localeCompare(b.task.title));
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
