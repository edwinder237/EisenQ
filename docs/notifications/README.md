# Notifications

In-app and daily-email notifications. The front end and the backend are both
built, and the app runs **live** by default. This document began as the
backend handoff; the contract and rules below are what both sides follow, and
"Backend" at the end describes what was built.

## What the person sees

- **Bell** in the dashboard header with an unread count. It opens a panel: a
  popover on desktop, a bottom sheet on a phone. The panel has two groups:
  - **Needs you**: overdue tasks, tasks due today, maintenance coming up or late.
    These come back until the underlying thing is handled.
  - **FYI**: AI app activity (one line per app per day), missed routines.
    These are gone once dismissed.
- **Per row**: tap to open the task or item, which also marks it read.
  - Desktop: hover shows **⋯** (Snooze: later today / tomorrow / next week,
    Mark task done, Stop reminding me) and **✕**. ✕ means *Not now* on Needs you
    and *Dismiss* on FYI.
  - Phone: swipe left for the same.
  - Every hide shows an **Undo** toast for 5 seconds.
- **Settings → Notifications**:
  - event × channel switches (in-app / daily email)
  - the default heads-up for maintenance
  - the daily email time, an on/off switch and *Send a test*
- **Routines → Maintenance → (item) → Remind me**: a per-item heads-up that
  overrides the default, e.g. a week ahead for the annual doctor visit.

## Switching it on

**Live by default** since the backend shipped (PR #76).

| Mode | What it does |
|---|---|
| `live` (default) | Calls `/api/notifications/*`, served by `src/server/notification-service.ts`. |
| `off` | No bell, no Settings tab, no Remind me. |
| `mock` | Everything runs in the browser on the dashboard's data, with state in `localStorage`. For development and demos without a database. |

- **Build-wide:** `NEXT_PUBLIC_NOTIFICATIONS_MODE=live|off|mock`. Leave it unset for live.
- **One page load:** add `?notifications=mock` (or `off` / `live`) to the URL. It isn't remembered. Earlier builds did remember it, so the app now clears that old saved choice.

## Files

| File | What it is |
|---|---|
| `src/lib/notifications/types.ts` | **The contract.** Every request and response shape. |
| `src/lib/notifications/schema.ts` | zod schemas for the request bodies; the stub routes already validate with them. |
| `src/lib/notifications/derive.ts` | **The rules**, as a pure function: which notifications exist right now. Use it server-side too. |
| `src/lib/notifications/client.ts` | `NotificationsApi` with the `live` (HTTP) and `mock` (browser) implementations, plus mode switching. |
| `src/app/api/notifications/**` | The routes, backed by `src/server/notification-service.ts`. |
| `src/components/NotificationBell.tsx` | Bell, panel, row actions, swipe, Undo. |
| `src/components/NotificationsSettings.tsx` | The Settings tab. |
| `src/components/ReminderPicker.tsx` | Remind me, per maintenance item. |

## Endpoints to implement

All routes require a signed-in Clerk session (the middleware already returns 401 otherwise), and all are scoped to `userId`.

| Method & path | Body → response | Notes |
|---|---|---|
| `GET /api/notifications` | → `NotificationList` | Derive, merge state, filter hidden, sort: `needs` first, newest first. |
| `POST /api/notifications` | `{ action: "read_all" \| "clear_fyi" }` → 204 | `clear_fyi` never touches `needs`. |
| `PATCH /api/notifications/:id` | `NotificationAction` → 204 | `read` / `dismiss` / `snooze` / `mute` / `restore`, rules below. |
| `GET /api/notifications/preferences` | → `NotificationPreferences` | Fill gaps from `DEFAULT_NOTIFICATION_PREFERENCES`; `digest.address` is the Clerk primary email. |
| `PUT /api/notifications/preferences` | `NotificationPreferences` → same | Ignore `digest.address`. Reschedule the digest. |
| `GET /api/notifications/reminders?kind=&itemId=` | → `ItemReminder` | `lead: null` means "use the default". |
| `PUT /api/notifications/reminders` | `ItemReminder` → same | Check the item belongs to `userId`. |
| `POST /api/notifications/test-email` | → `{ sentTo }` | Send today's digest now; rate-limit. |

The client sends `Content-Type: application/json`. On an error, answer `{ error: string }`: the UI shows that text.

## Rules

### Ids are the deduplication key
Notifications are **derived, not stored**. `deriveNotifications()` gives each fact a stable id:

| Kind | Id | Group |
|---|---|---|
| Task overdue | `task_overdue:<taskId>` | needs |
| Task due today | `task_due_today:<taskId>:<YYYY-MM-DD>` | needs |
| Maintenance coming up | `maintenance_upcoming:<itemId>:<nextDueDate>` | needs |
| Maintenance late | `maintenance_overdue:<itemId>:<nextDueDate>` | needs |
| Routine missed | `routine_missed:<itemId>:<latest missed date>` | fyi |
| AI activity | `ai_activity:<app>:<YYYY-MM-DD>:<count>` | fyi |

Store only **per-id state** for each user:
- `readAt`
- `hiddenUntil`: an ISO timestamp, or `"forever"`
- the previous `hiddenUntil`, for Undo

Re-deriving can therefore never duplicate an item. Because the id embeds the occurrence, the next maintenance cycle notifies again even if this one was muted.

### Actions

| Action | Effect |
|---|---|
| `read` | `readAt = now` |
| `dismiss` | **fyi**: hidden forever. **needs**: hidden until tomorrow 09:00 local ("Not now"); it comes back then if still true. |
| `snooze` | `later_today` = 18:00, or now + 3 h if already past 18:00; `tomorrow` = 09:00; `next_week` = Monday 09:00. All local. Use `snoozeUntil()`. |
| `mute` | "Stop reminding me": hidden forever for this id. |
| `restore` | Undo: put back the previous `hiddenUntil`. |

A needs item also disappears on its own once it stops being true (the task is completed or rescheduled, or the item is done), because it's no longer derived.

### Heads-up for maintenance
An item is "coming up" when `0 ≤ daysUntilDue ≤ lead`, where:
- `lead` is the item's override, or `prefs.defaultLead` if it has none
- the lead values are `same_day` = 0, `1_day` = 1, `2_days` = 2, `1_week` = 7

A lead of `off` means no heads-up. Late items show regardless of the lead.

**Suggested storage:** a `reminderLead` field on `MaintenanceItem`.

### Time zone
All "today", "tomorrow 09:00" and digest times are in the person's zone. The AI connectors already store one in `UserSettings.mcp.preferences.timeZone`; reuse it, or add one for notifications.

## Daily email (digest)

- Runs once per person at `prefs.digest.sendAt` local, when `digest.enabled` is true. A Vercel Cron every 15 minutes can pick up everyone due in that window.
- Content is the same derivation, keeping only events whose `email` switch is on, minus anything hidden at send time.
- Sections, in order:
  1. **Overdue & due today**
  2. **Coming up**
  3. **Missed routines** (only if switched on)
  4. An *Open EisenQ* button
  5. A footer link to Settings → Notifications
- **Skip the email entirely** when there's nothing in it. `test-email` sends anyway and says it's a test.
- AI activity is never emailed (`email: null` in preferences).
- Provider: not chosen yet. Resend was suggested: free tier, simple API. It needs DNS records on `eisenq.app`.

## Acceptance checklist (live mode)

- [ ] The bell count matches the unread items. *Mark all read* clears it.
- [ ] Snooze, Not now and Dismiss each hide the row. Undo within 5 s brings it back.
- [ ] A dismissed FYI item stays gone after a reload. A Not now item returns the next morning while still true.
- [ ] Completing an overdue task removes its notification without any action on the notification.
- [ ] Setting an item's Remind me to *1 week* surfaces it 7 days ahead; *Off* never does.
- [ ] Turning an event's in-app switch off removes those rows. Turning its email switch off removes it from the digest.
- [ ] No digest is sent on an empty day. *Send a test* always sends.

## Backend (built for `live`)

Code: `src/server/notification-service.ts` (the bell's routes),
`src/server/notification-digest.ts` (the daily email), `src/server/socle.ts`
(the only call out), `src/server/notification-access.ts` (who is emailed).

- **Rules:** `deriveNotifications()` runs on the server, on EisenQ's own data,
  with the person's zone from `UserSettings.mcp.preferences.timeZone` (UTC if
  never saved). `derive.ts` and `snoozeUntil()` take that zone as an optional
  last argument; the browser leaves it out.
- **Stored:** `notificationStates` (per user and id: `readAt`, `hiddenUntil`,
  `previousHiddenUntil`), `UserSettings.notifications` (preferences, never the
  address), `UserSettings.notificationDigest` (the sent-today record) and
  `MaintenanceItem.reminderLead`.
- **Actions** answer 204; `client.ts` reads a 204 as "no body".
- **Daily email:** `GET /api/cron/notifications-digest`, every 15 minutes
  (`vercel.json`), with `Authorization: Bearer <CRON_SECRET>`. It sends through
  Socle as `eisenq.digest.ready` with counts only:
  `{ dueCount, comingUpCount, missedRoutinesCount, isTest }`, each capped at
  999. Never a task name, a date, a time or a time zone. Socle writes the text.
  - Who: only EisenQ's owner account (the first account in EisenQ's Clerk), for
    now, and only once they have saved Settings → Notifications with the daily
    email on.
  - When: from `digest.sendAt` local, retried for two hours if Socle is down,
    at most once per local day. Skipped when empty.
  - The Idempotency-Key is a random UUID kept in the sent-today record and
    reused on a retry. *Send a test* uses a new one each time, three an hour.
- **Variables** (all optional; without them nothing is emailed and builds still
  pass): `SOCLE_API_URL`, `SOCLE_API_KEY`, `CRON_SECRET`. The UI is live
  by default.
