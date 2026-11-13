import type { ObjectId } from "mongodb";

export type TaskQuadrant = "urgent-important" | "important-not-urgent" | "urgent-not-important" | "not-urgent-not-important";
export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "pending" | "in-progress" | "completed";

// Where a task came from, when it was filed by the browser capture extension
// rather than typed into the app. Absent on hand-made tasks.
export type TaskSourceKind = "gmail" | "page" | "selection";

export interface TaskSource {
  kind: TaskSourceKind;
  url: string;              // thread permalink or page URL; the link back
  title?: string;           // page title or email subject, as captured
  from?: string;            // sender, when the capture knew one
  // A per-item id such as a Gmail thread id. The ONLY safe dedupe key: a page
  // URL is not one, because an offers page or a newsletter holds many separately
  // actionable items that all share it.
  externalId?: string;
  capturedAt: Date;
}

// A reusable checklist ("Photography gig") is authored in Myndlist and COPIED
// into a task on attach. These embedded types are the copy: independent of the
// Myndlist original from that moment on, so a checklist you ran last month still
// reads as it did when you ran it.
//
// Not to be confused with ChecklistItem below, which is the daily/weekly routine
// habit rendered in "Today's routine" — an unrelated feature.
export interface TaskChecklistStep {
  id: string;                 // unique within its checklist only
  text: string;
  order: number;
  done: boolean;
  doneAt?: Date;
  optional?: boolean;         // copied from Myndlist; optional steps never block completion
  note?: string;              // copied from Myndlist; read-only reference shown under the step
  sourceItemId?: string;      // the Myndlist item this step was copied from, so edits can be saved back in place
}

export interface TaskChecklist {
  id: string;                 // unique within its task only
  sourceId: string | null;    // Myndlist checklist id; null once deleted there
  name: string;               // snapshotted at attach time
  blockCompletion: boolean;   // snapshotted; false = steps are a memory aid, not a gate
  order: number;              // a task may hold several, in attach order
  steps: TaskChecklistStep[];
  attachedAt: Date;
}

export interface Task {
  _id?: ObjectId;
  title: string;
  description?: string;
  quadrant: TaskQuadrant;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate?: Date;
  duration?: number;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  userId?: string;
  parentTaskId?: ObjectId;  // References parent task if this is a subtask (removes it from the matrix)
  linkedParentId?: ObjectId; // Soft link: task stays top-level in the matrix but also appears under this parent's subtasks
  goalId?: ObjectId;        // Optional link to a weekly/monthly goal
  sortOrder?: number;       // Manual position within its quadrant; lower = higher up (top = Next action)
  archivedAt?: Date;        // Set when archived; archived tasks drop out of the matrix
  checklists?: TaskChecklist[]; // Reusable checklists copied in from Myndlist; never surface as tasks
  source?: TaskSource;      // Set only by the browser capture extension
}

export type GoalPeriodType = "week" | "month" | "year" | "custom";
export type GoalStatus = "active" | "achieved" | "dropped";

export interface Goal {
  _id?: ObjectId;
  title: string;
  icon?: string;            // Emoji marker, shown beside tasks linked to this goal
  note?: string;
  periodType: GoalPeriodType;
  periodKey: string;        // week: Sunday start "YYYY-MM-DD"; month: "YYYY-MM"; year: "YYYY"; custom: start date "YYYY-MM-DD"
  startDate?: string;       // custom only, "YYYY-MM-DD"
  endDate?: string;         // custom only, "YYYY-MM-DD"
  status: GoalStatus;
  pinned?: boolean;         // starred to appear in the masthead "In focus" stack
  parentGoalId?: ObjectId;  // link up one level: week → month, month → year
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ChecklistFrequency = "daily" | "weekly";

export interface ChecklistItem {
  _id?: ObjectId;
  title: string;
  description?: string;        // Optional detail, shown on demand from the routine card
  frequency: ChecklistFrequency;
  daysOfWeek?: number[];       // 0=Sunday..6=Saturday, only for weekly
  completedDates: string[];    // Array of "YYYY-MM-DD" strings
  sortOrder: number;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MaintenanceItem {
  _id?: ObjectId;
  title: string;
  description?: string;         // Optional detail, shown on demand from the routine card
  intervalDays: number;         // e.g. 90 = every 3 months, 365 = yearly
  lastCompletedDate?: string;   // ISO date "YYYY-MM-DD"
  nextDueDate: string;          // ISO date "YYYY-MM-DD"
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSettings {
  _id?: ObjectId;
  userId: string;
  geminiApiKeyEnc?: string;  // AES-256-GCM encrypted Gemini API key
  icalUrlsEnc?: string;      // AES-256-GCM encrypted JSON array of iCal URLs
  autoArchiveCompleted?: boolean; // Archive a task as soon as it is completed
  financeApiUrlEnc?: string; // AES-256-GCM encrypted CashFold API URL
  financeApiKeyEnc?: string; // AES-256-GCM encrypted CashFold API key
  financeUserIdEnc?: string; // AES-256-GCM encrypted CashFold user id (sent as ?userId=)
  myndlistApiUrlEnc?: string; // AES-256-GCM encrypted Myndlist API base URL
  myndlistApiKeyEnc?: string; // AES-256-GCM encrypted Myndlist API key
  anthropicApiKeyEnc?: string; // AES-256-GCM encrypted Anthropic (Claude) API key, for the AI assistant
  // Myndlist has no field for the completion gate, so it is kept here,
  // keyed by Myndlist checklist id. Not a secret, so not encrypted.
  checklistGates?: Record<string, boolean>;
  // One entry per browser connected through /connect-extension. An array so that
  // connecting a second browser doesn't silently disconnect the first.
  captureTokens?: CaptureToken[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CaptureToken {
  hash: string;             // SHA-256 hex of the token; the token itself is never stored
  label: string;            // "Chrome on macOS", from the user agent at connect time
  createdAt: Date;
  lastUsedAt?: Date;
}

export const collections = {
  tasks: "tasks",
  goals: "goals",
  checklistItems: "checklistItems",
  maintenanceItems: "maintenanceItems",
  userSettings: "userSettings",
} as const;