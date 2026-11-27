# Notifications: backend handoff

The front end for in-app and email notifications is built and runs today on a
**mock** that keeps everything in the browser. This document is what the
backend needs to build so it can run **live**.

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

| Mode | What it does |
|---|---|
| `off` (default) | No bell, no Settings tab, no Remind me. Production looks unchanged. |
| `mock` | Everything works, from data already on the dashboard; state is kept in `localStorage`. |
| `live` | Calls `/api/notifications/*`. Use once the routes below are implemented. |

- **Build-wide:** `NEXT_PUBLIC_NOTIFICATIONS_MODE=mock|live|off`.
- **One browser:** open any page with `?notifications=mock` (or `live` / `off`). It's remembered in that browser.

## Files

| File | What it is |
|---|---|
| `src/lib/notifications/types.ts` | **The contract.** Every request and response shape. |
| `src/lib/notifications/schema.ts` | zod schemas for the request bodies; the stub routes already validate with them. |
| `src/lib/notifications/derive.ts` | **The rules**, as a pure function: which notifications exist right now. Use it server-side too. |
| `src/lib/notifications/client.ts` | `NotificationsApi` with the `live` (HTTP) and `mock` (browser) implementations, plus mode switching. |
| `src/app/api/notifications/**` | Route stubs. Each answers **501** with a `TODO(backend)` comment saying exactly what to do. |
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
