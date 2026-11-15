# Task and goal services: the one rulebook

`src/server/task-service.ts` and `src/server/goal-service.ts` hold every rule about writing tasks
and goals. Every write path goes through them:

| Caller | Uses |
|---|---|
| Dashboard: `/api/tasks`, `/api/goals` | create / update / delete, schemas |
| In-app assistant: `/api/assistant/apply` | `applySuggestion` |
| AI connectors: `/api/mcp` (`src/server/mcp-server.ts`) | create / update / complete / remove, list helpers |

Routes only authenticate, parse with the exported zod schemas, and map `TaskServiceError`
(`message`, `status`, `extra`) to a response. Not yet on the services: `/api/capture` (creates
tasks with its own dedupe rules), `/api/tasks/reorder`, `/api/tasks/[taskId]/*`.

## Task rules

- **Do First is always high priority.** `createTask` defaults the priority from the quadrant
  (`defaultPriorityFor`), and `updateTask` sets `high` when a task moves into Do First without an
  explicit priority. MCP's `add_task` forces `high` in Do First even if the AI asks otherwise.
- **Checklist gate.** Completing is refused while a checklist with `blockCompletion` has required
  steps left (`TaskServiceError` with `extra: { checklistBlocked, remaining, checklistName }`).
  Reopening is never gated.
- **Ownership.** Every query includes `userId`. A `goalId` must be the user's own goal.
- **Subtasks.** A subtask's parent must be a top-level task of the same user; the subtask inherits
  its quadrant, and a parent's quadrant change cascades. Deleting a task deletes its real subtasks
  and unlinks soft-linked ones (`linkedParentId`). A soft link can't form a two-way loop.
- **Absent means unchanged.** `updateTask` / `updateGoal` drop keys whose value is `undefined`
  (`definedOnly`), because the MongoDB driver would store them as `null`. `null` means "clear".
- **Completion.** `completeTask(…, { autoArchive })` stamps `completedAt` and archives straight away
  when the user has "archive automatically" on. The dashboard still applies auto-archive itself,
  in the browser, after its own PUT.
- **Display order.** `compareMatrixOrder` mirrors the dashboard's `getOrderedQuadrantTasks`: open
  before completed, dated before undated (soonest first), then manual `sortOrder`, then oldest.
  The first open task in a quadrant is its "next action".

## Goal rules

- Period keys: week = the Sunday that starts it (`YYYY-MM-DD`), month `YYYY-MM`, year `YYYY`,
  custom = start date, with `startDate ≤ endDate`. `weekKeyFor(date)` finds the Sunday.
- Parents: week → month → year only.
- Moving a goal to another period drops its parent link and detaches its children, after the
  move itself succeeds.

## Dates and time zones

The server runs in UTC; people don't. `src/server/timezone.ts` converts a wall-clock time in an
IANA zone to UTC without a library (`zonedWallTimeToUtc`, DST-safe), and `dayToDueDate(ymd, tz)`
applies the app-wide rule that a plain date means 9:00 that day. The assistant gets the zone from
the browser on each apply; AI connectors use `mcp.preferences.timeZone`, saved from the browser
with the AI connectors tab.
