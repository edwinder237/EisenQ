import type { ObjectId } from "mongodb";
import type { NotificationPreferences, ReminderLead } from "~/lib/notifications/types";

export type TaskQuadrant = "urgent-important" | "important-not-urgent" | "urgent-not-important" | "not-urgent-not-important";
export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "pending" | "in-progress" | "completed";

// Where a task came from, when it was filed by the browser capture extension or
// by an AI connector rather than typed into the app. Absent on hand-made tasks.
export type TaskSourceKind = "gmail" | "page" | "selection" | "agent";

export interface TaskSource {
  kind: TaskSourceKind;
  url?: string;             // thread permalink or page URL; the link back. Captures only, never agents.
  title?: string;           // page title or email subject; for "agent", the AI app's name
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
  quadrantSince?: Date;     // When it entered its current quadrant; drives the "sitting for 5d" hint. Older tasks fall back to createdAt
  archivedAt?: Date;        // Set when archived; archived tasks drop out of the matrix
  checklists?: TaskChecklist[]; // Reusable checklists copied in from Myndlist; never surface as tasks
  source?: TaskSource;      // Set only by the browser capture extension
  assistantRun?: AssistantRun; // Set while the task is handed to the Assistant (a Claude routine)
  routineRef?: RoutineRef;  // Set when a routine item was put on the schedule; completing one completes the other
}

// Links a scheduled task to one occurrence of a routine item. `date` is the
// occurrence ("YYYY-MM-DD"): the day a checklist item was due, or a maintenance
// item's nextDueDate when it was scheduled.
export interface RoutineRef {
  kind: "checklist" | "maintenance";
  itemId: ObjectId;
  date: string;
}

// Who does a checklist step in the Delegate quadrant relay. Household members
// are placeholders until household accounts exist.
export type StepOwner = "you" | "assistant" | "sam" | "noor";

// A hand-off to the Assistant: EisenQ fires the person's Claude Code routine,
// which reads the task through the EisenQ connector, does its steps and reports
// back with report_assistant_result.
export interface AssistantRun {
  mode: "steps" | "outcome";        // follow the checklist, or figure it out
  stepOwners: Record<string, StepOwner>; // per-step overrides; unlisted steps are the Assistant's
  status: "working" | "done" | "blocked";
  requestedAt: Date;
  sessionUrl?: string;              // the Claude Code session the routine started
  finishedAt?: Date;
  result?: string;                  // the Assistant's report, draft or reason it got stuck
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

// A Myndlist checklist attached to a routine or maintenance item. Only the
// reference is kept: each time the item comes up, a fresh copy of the steps is
// made onto that occurrence's run (a task with a routineRef), so edits in
// Myndlist reach the next run and past runs keep their own ticks.
export interface RoutineChecklistRef {
  sourceId: string;
  name: string;   // shown in Manage without a round trip to Myndlist
}

export interface ChecklistItem {
  _id?: ObjectId;
  title: string;
  description?: string;        // Optional detail, shown on demand from the routine card
  frequency: ChecklistFrequency;
  daysOfWeek?: number[];       // 0=Sunday..6=Saturday, only for weekly
  completedDates: string[];    // Array of "YYYY-MM-DD" strings
  // Missed occurrences stay on the routine card until done or dismissed. Unset
  // means the default: weekly items carry over, daily ones don't.
  carryOver?: boolean;
  caughtUpThrough?: string;    // "YYYY-MM-DD": misses on or before this day are resolved
  checklists?: RoutineChecklistRef[]; // copied fresh onto a run each time the item comes up
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
  checklists?: RoutineChecklistRef[]; // copied fresh onto a run each time the item comes due
  reminderLead?: ReminderLead;  // "Remind me" heads-up for notifications; unset = the default from preferences
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
  // The Claude Code routine the Delegate quadrant fires: its API trigger URL and
  // bearer token, both encrypted. The token is never sent back to the browser.
  assistantRoutineUrlEnc?: string;
  assistantRoutineTokenEnc?: string;
  // Myndlist has no field for the completion gate, so it is kept here,
  // keyed by Myndlist checklist id. Not a secret, so not encrypted.
  checklistGates?: Record<string, boolean>;
  // One entry per browser connected through /connect-extension. An array so that
  // connecting a second browser doesn't silently disconnect the first.
  captureTokens?: CaptureToken[];
  // AI connectors (MCP). Absent until the user first saves the AI connectors
  // tab; readers fill in defaults with normalizeMcpSettings().
  mcp?: McpSettings;
  // Notifications (docs/notifications/README.md): what EisenQ keeps itself.
  // Absent until first saved; readers fill gaps from
  // DEFAULT_NOTIFICATION_PREFERENCES. The address is never stored: it's always
  // the verified Clerk primary email. The email and bell switches are Socle's
  // (notificationChannels below); `digest.enabled` is an older build's value,
  // read by nothing.
  notifications?: {
    events?: Partial<NotificationPreferences["events"]>;
    defaultLead?: NotificationPreferences["defaultLead"];
    digest?: { enabled?: boolean; sendAt?: string };
  };
  // EisenQ's copy of the person's email and bell switches, as Socle last
  // answered them. Socle is the source of truth and gates every send; the copy
  // only chooses whom the daily job considers, whether the bell asks Socle for
  // a session, and the bell's footer. Absent: Socle's defaults, email off and
  // the bell on.
  notificationChannels?: NotificationChannels;
  // The daily email's sent-today record: one per person, for their latest
  // local day. At most one digest per day. `key` is the Idempotency-Key, a
  // random UUID made when the day's record is created and reused on a retry,
  // with the counts it first went with, so Socle never sends that day twice.
  notificationDigest?: DigestRecord;
  // "Send a test": how many today, in the person's zone (3 a day).
  notificationTests?: { day: string; count: number };
  // Set when the account was deleted (Clerk's event, or Clerk's 404): its
  // notification data is gone and nothing may write it back.
  notificationsDeletedAt?: Date;
  // When the daily job first found no such account in Clerk. A second 404 at
  // least an hour later deletes its notifications; Clerk finding it clears
  // this. No ID is ever logged with it.
  clerkMissingSince?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationChannels {
  email: boolean;
  bell: boolean;
  checkedAt: Date;      // when Socle last said so
}

export interface DigestRecord {
  day: string;          // the person's local "YYYY-MM-DD" the send time belongs to (after midnight in a late send time's window: the day before)
  key: string;          // random UUID, sent as the Idempotency-Key
  // The counts this key first went to Socle with, set just before that first
  // send. Every retry with the key sends exactly these, so Socle either
  // replays it or takes it as new, never "key reused with another body". A new
  // key starts without them. Counts only.
  counts?: DigestRecordCounts;
  // sending: a run holds it. pending: Socle was unavailable, the next run
  // retries with the same key. The others are final for the day: sent,
  // nothing to report (empty), email and bell both off (opted-out), email on
  // without a verified address (no-email), or refused by Socle.
  status: "sending" | "pending" | "sent" | "empty" | "refused" | "no-email" | "opted-out";
  claimedAt?: Date;
}

export interface DigestRecordCounts {
  dueCount: number;
  comingUpCount: number;
  missedRoutinesCount: number;
}

// A deleted account whose deletion Socle hasn't confirmed yet (legal's
// deletion rule): the user ID only, retried by the daily job until Socle
// answers 204, then removed.
export interface NotificationDeletion {
  _id?: ObjectId;
  userId: string;
  since: Date;
  attempts: number;
  lastTriedAt?: Date;
}

// Per-notification state for one person, keyed by the derived id from
// deriveNotifications() ("task_overdue:<taskId>", …). Notifications themselves
// are derived, never stored, so this holds only what the person did to one.
export interface NotificationState {
  _id?: ObjectId;
  userId: string;
  id: string;
  readAt?: Date;
  hiddenUntil?: Date | "forever";          // absent: shown
  previousHiddenUntil?: Date | "forever" | null; // for Undo: what hiddenUntil held before the last change
  updatedAt: Date;
}

export interface McpPermissions {
  readTasks: boolean;
  createTasks: boolean;
  editTasks: boolean;      // rename, reschedule, move quadrant, priority, goal link
  completeTasks: boolean;
  deleteTasks: boolean;
  readGoals: boolean;
  editGoals: boolean;      // create, rename, move to another period
}

export interface McpPreferences {
  defaultQuadrant: TaskQuadrant;     // used when the AI doesn't name one
  deleteMode: "archive" | "delete";  // archive keeps it recoverable
  labelAiTasks: boolean;             // stamp source.kind "agent" so the editor can show "via Claude"
  shareCompleted: boolean;           // let the AI see completed tasks when it lists them
  dailyWriteLimit: number;           // guard against a runaway agent
  timeZone: string;                  // IANA zone from the browser, for "due Friday" → 9:00 local
}

export interface McpClient {
  clientId: string;        // OAuth client id from the verified token
  name: string;            // best name we know: the MCP client's own name, else the id
  firstSeenAt: Date;
  lastUsedAt: Date;
  blocked: boolean;        // revoked in Settings; every call from it is refused
}

export interface McpActivity {
  at: Date;
  clientId: string;
  clientName: string;
  tool: string;
  summary: string;         // "Added “Call the accountant” to Schedule"
  taskId?: string;
}

export interface McpSettings {
  enabled: boolean;
  permissions: McpPermissions;
  preferences: McpPreferences;
  clients: McpClient[];
  activity: McpActivity[];                  // newest first, capped
  writes?: { day: string; count: number };  // daily write counter, day in the user's zone
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
  notificationStates: "notificationStates",
  notificationDeletions: "notificationDeletions",
} as const;