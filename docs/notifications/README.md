# Notifications

In-app and daily-email notifications, for every EisenQ account. The front end
and the backend are both built, and the app runs **live** by default. This
document began as the backend handoff; the contract and rules below are what
both sides follow, and "Backend" at the end describes what was built.

Since edwinder237/socle#63 (Socle's amended design, 2026-11-27): the bell is
**Socle's bell component**, a copy of Marc's bell kept in Socle, and each
person's **daily email and bell switches are kept in Socle**. EisenQ talks
only to Socle, from its server; it never calls Socle's delivery services.

## What the person sees

- **Bell** in the dashboard header with an unread count. It opens a panel: a
  popover on desktop, a bottom sheet on a phone. The panel has two groups:
  - **Needs you**: overdue tasks, tasks due today, maintenance coming up or late.
    These come back until the underlying thing is handled.
  - **FYI**: AI app activity (one line per app per day), missed routines, and
    **notices** sent through Socle, such as the daily summary's copy. These
    are gone once dismissed. Notices can be read, dismissed and undone, never
    snoozed.
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
  - **Bell notices**, an on/off switch for the notices (the reminders follow
    the in-app column either way)
- **Routines → Maintenance → (item) → Remind me**: a per-item heads-up that
  overrides the default, e.g. a week ahead for the annual doctor visit.

## Switching it on

**Live by default** since the backend shipped (PR #76).

| Mode | What it does |
|---|---|
| `live` (default) | Calls `/api/notifications/*`, served by `src/server/notification-service.ts`. |
| `off` | No bell, no Settings tab, no Remind me. |
| `mock` | Everything runs in the browser on the dashboard's data, with state in `localStorage`. For development and demos without a database. The bell shows the reminders only: no notices, and nothing reaches Socle. |

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
| `src/vendor/socle-bell/` | **The bell**: Socle's bell component (bell, panel, row actions, swipe, Undo), copied from Socle's `packages/bell`. Never edited here: `VERSION` names the Socle version and commit, and `SHA256SUMS` with `socle-bell.copy.test.ts` fail the tests if a file changes. To change it, change it in Socle and copy it again with Socle's `npm run vendor -- <this folder>`. |
| `src/components/NotificationBell.tsx` | Marc's bell before the swap. Kept, unused. |
| `src/components/NotificationsSettings.tsx` | The Settings tab. |
| `src/components/ReminderPicker.tsx` | Remind me, per maintenance item. |

## Endpoints to implement

All routes require a signed-in Clerk session (the middleware already returns 401 otherwise), and all are scoped to `userId`.

| Method & path | Body → response | Notes |
|---|---|---|
| `GET /api/notifications` | → `NotificationList` | Derive, merge state, filter hidden, sort: `needs` first, newest first. |
| `POST /api/notifications` | `{ action: "read_all" \| "clear_fyi" }` → 204 | `clear_fyi` never touches `needs`. |
| `PATCH /api/notifications/:id` | `NotificationAction` → 204 | `read` / `dismiss` / `snooze` / `mute` / `restore`, rules below. |
| `GET /api/notifications/preferences` | → `NotificationPreferences` | Fill gaps from `DEFAULT_NOTIFICATION_PREFERENCES`. `digest.enabled` and `bell.enabled` are Socle's, asked by the server. `digest.address` is the verified Clerk primary email. `?cached=1`: EisenQ's last copy of the two switches, without asking Socle (the bell's footer). |
| `PUT /api/notifications/preferences` | `NotificationPreferences` → same | The two switches go to Socle first, only if changed; if Socle can't take them, 503 and nothing is saved. Ignore `digest.address`. |
| `GET /api/notifications/bell-session` | → `{ session, expiresAt }` or `{ session: null }` | For the bell, once per page load: the signed-in person's own session from Socle, passed on unread. `null` without asking Socle when their bell is off. |
| `GET /api/notifications/reminders?kind=&itemId=` | → `ItemReminder` | `lead: null` means "use the default". |
| `PUT /api/notifications/reminders` | `ItemReminder` → same | Check the item belongs to `userId`. |
| `POST /api/notifications/test-email` | → `{ sentTo }` | Send today's digest now, only while email is on, to the verified address; 3 a day. |

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

- Runs once per person at `prefs.digest.sendAt` local. A Vercel Cron every 15 minutes picks up everyone due in that window. It goes by email when the person has email on in Socle, and as a copy in the bell when they have the bell on.
- Content is the same derivation, keeping only events whose `email` switch is on, minus anything hidden at send time.
- Sections, in order:
  1. **Overdue & due today**
  2. **Coming up**
  3. **Missed routines** (only if switched on)
  4. An *Open EisenQ* button
  5. A footer link to Settings → Notifications
- **Skip the email entirely** when there's nothing in it. `test-email` sends anyway and says it's a test.
- AI activity is never emailed (`email: null` in preferences).
- Delivery: Socle's (`src/server/socle.ts` is the only call out). Socle writes the words, adds a one-click unsubscribe link to every email, and sends from its own domain. EisenQ links to nothing for unsubscribing.

## Acceptance checklist (live mode)

- [ ] The bell count matches the unread items. *Mark all read* clears it.
- [ ] Snooze, Not now and Dismiss each hide the row. Undo within 5 s brings it back.
- [ ] A dismissed FYI item stays gone after a reload. A Not now item returns the next morning while still true.
- [ ] Completing an overdue task removes its notification without any action on the notification.
- [ ] Setting an item's Remind me to *1 week* surfaces it 7 days ahead; *Off* never does.
- [ ] Turning an event's in-app switch off removes those rows. Turning its email switch off removes it from the digest.
- [ ] No digest is sent on an empty day. *Send a test* always sends while email is on.
- [ ] Email is off for every account until it's switched on and saved, and goes only to a verified address.
- [ ] A second account sees only its own reminders and notices, and gets its own summary at its own address.
- [ ] Turning email off from an email's link shows as off in Settings.
- [ ] With Bell notices off, the browser makes no request for notices.
- [ ] Deleting an account in Clerk removes its notifications in EisenQ and in Socle.

## Backend (built for `live`)

Code: `src/server/notification-service.ts` (the bell's reminders and EisenQ's
own preferences), `src/server/notification-preferences.ts` (the email and bell
switches, through Socle), `src/server/notification-bell.ts` (the bell's
session), `src/server/notification-digest.ts` (the daily summary),
`src/server/notification-deletion.ts` (deleted accounts),
`src/server/notification-access.ts` (where email may go) and
`src/server/socle.ts` (the only call out).

- **Every account** has its own bell, reminders, settings and daily summary.
  There is no owner-only rule any more.
- **Rules:** `deriveNotifications()` runs on the server, on EisenQ's own data,
  with the person's zone from `UserSettings.mcp.preferences.timeZone` (UTC if
  never saved). `derive.ts` and `snoozeUntil()` take that zone as an optional
  last argument; the browser leaves it out.
- **Stored in EisenQ:** `notificationStates` (per user and id: `readAt`,
  `hiddenUntil`, `previousHiddenUntil`), `UserSettings.notifications` (the
  per-event switches, the heads-up and the send time, never the address),
  `UserSettings.notificationChannels` (a copy of Socle's last answer for the
  two switches), `UserSettings.notificationDigest` (the sent-today record),
  `UserSettings.notificationTests` (today's test count),
  `notificationDeletions` (deleted accounts Socle hasn't confirmed yet: the
  user ID only) and `MaintenanceItem.reminderLead`.
- **Stored in Socle:** each person's daily email and bell switches. Email is
  off until the person turns it on and saves, for everyone, existing accounts
  included; the bell is on until they turn it off. An email's unsubscribe
  link turns email off in Socle, and Settings shows it. EisenQ's copy only
  chooses whom the daily job reads, whether the bell asks for a session, and
  the bell's footer.
- **Actions** answer 204; `client.ts` reads a 204 as "no body".
- **The bell:** Socle's bell component (`src/vendor/socle-bell/`), with the
  reminders from `/api/notifications` and the notices through Socle. Its
  session comes from `GET /api/notifications/bell-session`, once per
  dashboard load, for the signed-in person only, and never when their bell is
  off. Only the copy's own adapter uses `@novu/js` (3.21.0, pinned exactly),
  loaded once a session arrives; EisenQ's code never imports it.
- **Daily summary:** `GET /api/cron/notifications-digest`, every 15 minutes
  (`vercel.json`), with `Authorization: Bearer <CRON_SECRET>`. It sends
  through Socle as `eisenq.digest.ready` with counts only:
  `{ dueCount, comingUpCount, missedRoutinesCount, isTest }`, each capped at
  999. Never a task name, a date, a time or a time zone. Socle writes the text.
  - Who: every account with a settings record whose copy has email or the
    bell on, read 100 at a time. A run asks Socle about at most 50 people and
    starts nobody new after 40 seconds; the next runs carry on.
  - Before each send it asks Socle for the person's switches. Both off:
    nothing. Email off: the event goes with no address, to the bell only.
    Email on: only to the account's own verified primary email; without one
    nothing goes, and the skip is logged with no address. Socle gates again
    (409 `recipient-opted-out`).
  - When: from `digest.sendAt` local, retried for two hours if Socle is down,
    at most once per local day. Skipped when empty, without asking Socle.
  - The Idempotency-Key is a random UUID kept in the sent-today record and
    reused on a retry. *Send a test* uses a new one each time, 3 a day per
    person, counted in the database.
- **A deleted account:** Clerk's `user.deleted` event, on
  `POST /api/webhooks/clerk`, signed with `CLERK_WEBHOOK_SIGNING_SECRET`.
  EisenQ deletes its own notification data for the person and leaves both
  switches off, then calls Socle's `recipients/delete`. Until Socle answers
  204, the user ID waits in `notificationDeletions` and the daily job retries
  it each run. EisenQ's other data for the account (tasks, other settings)
  isn't part of this.
- **Logs** hold statuses, counts and Socle's eventId only: never an email, a
  user ID, a task title, a key or a bell session.
- **Variables** (all optional; without them nothing reaches Socle and builds
  still pass): `SOCLE_API_URL`, `SOCLE_API_KEY` (its key needs the scopes
  `notifications:send` and `notifications:bell`), `CRON_SECRET` and
  `CLERK_WEBHOOK_SIGNING_SECRET`. The UI is live by default.
