import "server-only";
import { ObjectId } from "mongodb";
import {
  checklistItemsCollection,
  maintenanceItemsCollection,
  notificationStatesCollection,
  tasksCollection,
  userSettingsCollection,
} from "~/server/db";
import type {
  DigestRecord,
  NotificationState,
  UserSettings,
} from "~/server/db/schema";
import type { NotificationAction } from "~/lib/notifications/client";
import {
  deriveNotifications,
  notNowUntil,
  snoozeUntil,
  type DeriveMaintenance,
  type DeriveMissedRoutine,
  type DeriveTask,
} from "~/lib/notifications/derive";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type AppNotification,
  type ItemReminder,
  type NotificationEvent,
  type NotificationGroup,
  type NotificationList,
  type NotificationPreferences,
  type ReminderLead,
} from "~/lib/notifications/types";
import { carriesOver, missedDates } from "~/lib/routine";
import { normalizeMcpSettings } from "~/server/mcp-settings";
import { ymdInZone } from "~/server/timezone";

// The bell's back end (docs/notifications/README.md). Notifications are
// derived, never stored: deriveNotifications() runs here on EisenQ's own data,
// in the person's time zone, and the only things stored are what the person
// did to each id (read, hidden until, the previous hidden-until for Undo),
// their preferences, and the "Remind me" heads-up on maintenance items.

export class NotificationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const DAY = 86_400_000;

// ----------------------------------------------------------- preferences ----

const LEADS = ["same_day", "1_day", "2_days", "1_week"] as const;
const SEND_AT = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Saved preferences with every gap filled from DEFAULT_NOTIFICATION_PREFERENCES.
 * The email and bell switches are Socle's: here they come from EisenQ's copy
 * of Socle's last answer, and with no copy, Socle's defaults (email off, the
 * bell on). An older build's stored digest.enabled is never read.
 */
export function normalizePreferences(
  stored?: UserSettings["notifications"],
  channels?: UserSettings["notificationChannels"],
): NotificationPreferences {
  const d = DEFAULT_NOTIFICATION_PREFERENCES;
  const toggle = (event: NotificationEvent) => {
    const saved = stored?.events?.[event];
    const fallback = d.events[event];
    return {
      inApp: typeof saved?.inApp === "boolean" ? saved.inApp : fallback.inApp,
      // AI activity is never emailed.
      email:
        fallback.email === null
          ? null
          : typeof saved?.email === "boolean"
            ? saved.email
            : fallback.email,
    };
  };
  const lead = stored?.defaultLead;
  const sendAt = stored?.digest?.sendAt;
  return {
    events: {
      due: toggle("due"),
      upcoming: toggle("upcoming"),
      missed_routines: toggle("missed_routines"),
      ai_activity: toggle("ai_activity"),
    },
    defaultLead:
      lead && (LEADS as readonly string[]).includes(lead)
        ? lead
        : d.defaultLead,
    digest: {
      enabled: channels ? channels.email === true : d.digest.enabled,
      sendAt: sendAt && SEND_AT.test(sendAt) ? sendAt : d.digest.sendAt,
    },
    bell: { enabled: channels ? channels.bell !== false : d.bell.enabled },
  };
}

/**
 * What EisenQ stores itself: the per-event switches, the heads-up and the send
 * time. Never the address, and never the email and bell switches, which are
 * Socle's.
 */
export function preferencesToStore(
  prefs: Pick<NotificationPreferences, "events" | "defaultLead" | "digest">,
): NonNullable<UserSettings["notifications"]> {
  return {
    events: {
      due: { inApp: prefs.events.due.inApp, email: prefs.events.due.email },
      upcoming: {
        inApp: prefs.events.upcoming.inApp,
        email: prefs.events.upcoming.email,
      },
      missed_routines: {
        inApp: prefs.events.missed_routines.inApp,
        email: prefs.events.missed_routines.email,
      },
      ai_activity: { inApp: prefs.events.ai_activity.inApp, email: null },
    },
    defaultLead: prefs.defaultLead,
    digest: { sendAt: prefs.digest.sendAt },
  };
}

export async function savePreferences(
  userId: string,
  prefs: Pick<NotificationPreferences, "events" | "defaultLead" | "digest">,
  now = new Date(),
) {
  // The digest needs no rescheduling: the cron reads sendAt on every run.
  await userSettingsCollection.updateOne(
    { userId },
    {
      $set: { notifications: preferencesToStore(prefs), updatedAt: now },
      $setOnInsert: { userId, createdAt: now },
    },
    { upsert: true },
  );
}

/** Keeps EisenQ's copy of what Socle just answered for the person's email and bell. */
export async function saveChannelsCopy(
  userId: string,
  channels: { email: boolean; bell: boolean },
  now = new Date(),
) {
  await userSettingsCollection.updateOne(
    { userId },
    {
      $set: {
        notificationChannels: { ...channels, checkedAt: now },
        updatedAt: now,
      },
      $setOnInsert: { userId, createdAt: now },
    },
    { upsert: true },
  );
}

// ------------------------------------------------------------ derivation ----

export interface NotificationContext {
  userId: string;
  now: Date;
  timeZone: string;
  prefs: NotificationPreferences;
  /** EisenQ's copy of Socle's email and bell switches, if Socle ever answered. */
  channels?: UserSettings["notificationChannels"];
  /** The daily email's sent-today record, for the latest day it ran. */
  digest?: DigestRecord;
}

/** The fields of a person's UserSettings the notifications read. */
export const CONTEXT_PROJECTION = {
  userId: 1,
  notifications: 1,
  notificationChannels: 1,
  notificationDigest: 1,
  "mcp.preferences.timeZone": 1,
} as const;

export type ContextDoc = Pick<
  UserSettings,
  "notifications" | "notificationChannels" | "notificationDigest" | "mcp"
>;

/** The context from a UserSettings document already read (the daily job's pages). */
export function contextFrom(
  userId: string,
  doc: Partial<ContextDoc> | null | undefined,
  now: Date,
): NotificationContext {
  return {
    userId,
    now,
    timeZone: normalizeMcpSettings(doc?.mcp).preferences.timeZone,
    prefs: normalizePreferences(doc?.notifications, doc?.notificationChannels),
    ...(doc?.notificationChannels ? { channels: doc.notificationChannels } : {}),
    ...(doc?.notificationDigest ? { digest: doc.notificationDigest } : {}),
  };
}

/** The person's preferences and zone (UserSettings.mcp.preferences.timeZone, else UTC). */
export async function loadContext(
  userId: string,
  now = new Date(),
): Promise<NotificationContext> {
  const doc = await userSettingsCollection.findOne(
    { userId },
    { projection: CONTEXT_PROJECTION },
  );
  return contextFrom(userId, doc, now);
}

/**
 * Everything the rules read, from EisenQ's database, whatever created it: the
 * dashboard, the capture extension, AI connectors over MCP, the assistant or
 * a routine. The same inputs the dashboard gives the mock.
 */
export async function loadDeriveInputs(
  userId: string,
  now: Date,
  timeZone: string,
) {
  const today = ymdInZone(now, timeZone);
  const [taskDocs, maintenanceDocs, checklistDocs] = await Promise.all([
    tasksCollection
      .find(
        {
          userId,
          // { field: null } matches null OR missing
          parentTaskId: null as unknown as undefined,
          archivedAt: null as unknown as undefined,
          $or: [
            {
              dueDate: { $exists: true, $ne: null as unknown as Date },
              status: { $ne: "completed" },
            },
            {
              "source.kind": "agent",
              createdAt: { $gte: new Date(now.getTime() - DAY) },
            },
          ],
        },
        {
          projection: {
            _id: 1,
            title: 1,
            quadrant: 1,
            status: 1,
            dueDate: 1,
            archivedAt: 1,
            parentTaskId: 1,
            createdAt: 1,
            "source.kind": 1,
            "source.title": 1,
          },
        },
      )
      .limit(2000)
      .toArray(),
    maintenanceItemsCollection
      .find(
        { userId },
        {
          projection: {
            _id: 1,
            title: 1,
            nextDueDate: 1,
            lastCompletedDate: 1,
            reminderLead: 1,
          },
        },
      )
      .toArray(),
    checklistItemsCollection
      .find(
        { userId },
        {
          projection: {
            _id: 1,
            title: 1,
            frequency: 1,
            daysOfWeek: 1,
            completedDates: 1,
            carryOver: 1,
            caughtUpThrough: 1,
            createdAt: 1,
          },
        },
      )
      .toArray(),
  ]);

  const tasks: DeriveTask[] = taskDocs.map((t) => ({
    _id: String(t._id),
    title: t.title,
    quadrant: t.quadrant,
    status: t.status,
    ...(t.dueDate ? { dueDate: new Date(t.dueDate).toISOString() } : {}),
    ...(t.archivedAt
      ? { archivedAt: new Date(t.archivedAt).toISOString() }
      : {}),
    ...(t.parentTaskId ? { parentTaskId: String(t.parentTaskId) } : {}),
    createdAt: new Date(t.createdAt).toISOString(),
    ...(t.source
      ? {
          source: {
            kind: t.source.kind,
            ...(t.source.title ? { title: t.source.title } : {}),
          },
        }
      : {}),
  }));

  const maintenance: DeriveMaintenance[] = maintenanceDocs.map((m) => ({
    _id: String(m._id),
    title: m.title,
    nextDueDate: m.nextDueDate,
    ...(m.lastCompletedDate ? { lastCompletedDate: m.lastCompletedDate } : {}),
  }));
  const itemLeads: Record<string, ReminderLead | null> = {};
  for (const m of maintenanceDocs)
    itemLeads[`maintenance:${String(m._id)}`] = m.reminderLead ?? null;

  // The dashboard's routine card rule: items that carry over, with the
  // scheduled days before today that weren't done.
  const missedRoutines: DeriveMissedRoutine[] = [];
  for (const c of checklistDocs) {
    if (!carriesOver(c)) continue;
    const missed = missedDates(
      {
        frequency: c.frequency,
        ...(c.daysOfWeek ? { daysOfWeek: c.daysOfWeek } : {}),
        completedDates: c.completedDates ?? [],
        ...(c.carryOver !== undefined ? { carryOver: c.carryOver } : {}),
        ...(c.caughtUpThrough ? { caughtUpThrough: c.caughtUpThrough } : {}),
        // missedDates() reads the creation day in the runtime's zone, and the
        // server runs in UTC: a local noon on the person's creation day keeps
        // it the same day.
        createdAt: `${ymdInZone(new Date(c.createdAt), timeZone)}T12:00:00`,
      },
      today,
    );
    if (missed.length > 0)
      missedRoutines.push({ _id: String(c._id), title: c.title, missed });
  }

  return { tasks, maintenance, missedRoutines, itemLeads };
}

export function isHidden(
  state: Pick<NotificationState, "hiddenUntil"> | undefined,
  now: Date,
): boolean {
  const h = state?.hiddenUntil;
  if (h === undefined) return false;
  if (h === "forever") return true;
  return new Date(h).getTime() > now.getTime();
}

async function statesFor(
  userId: string,
  ids: string[],
): Promise<Map<string, NotificationState>> {
  if (ids.length === 0) return new Map();
  const rows = await notificationStatesCollection
    .find({ userId, id: { $in: ids } })
    .toArray();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The current notifications with the person's state on top, hidden ones left
 * out. `prefs` can be swapped, so the digest runs the same rules with its
 * email switches.
 */
export async function currentNotifications(
  ctx: NotificationContext,
  prefs = ctx.prefs,
): Promise<AppNotification[]> {
  const inputs = await loadDeriveInputs(ctx.userId, ctx.now, ctx.timeZone);
  const derived = deriveNotifications({
    ...inputs,
    now: ctx.now,
    prefs,
    timeZone: ctx.timeZone,
  });
  const states = await statesFor(
    ctx.userId,
    derived.map((n) => n.id),
  );
  return derived
    .filter((n) => !isHidden(states.get(n.id), ctx.now))
    .map((n) => {
      const readAt = states.get(n.id)?.readAt;
      return {
        ...n,
        readAt: readAt ? new Date(readAt).toISOString() : null,
        snoozedUntil: null,
      };
    })
    .sort((a, b) =>
      a.group === b.group
        ? b.createdAt.localeCompare(a.createdAt)
        : a.group === "needs"
          ? -1
          : 1,
    );
}

export async function listNotifications(
  userId: string,
  now = new Date(),
): Promise<NotificationList> {
  const items = await currentNotifications(await loadContext(userId, now));
  return { items, unreadCount: items.filter((n) => !n.readAt).length };
}

// --------------------------------------------------------------- actions ----

const KINDS = [
  "task_overdue",
  "task_due_today",
  "maintenance_upcoming",
  "maintenance_overdue",
  "routine_missed",
  "ai_activity",
];
const ID_SHAPE = new RegExp(`^(${KINDS.join("|")}):[^\\u0000-\\u001f]{1,250}$`);

/** The group an id belongs to, from its kind prefix; null for anything that isn't a notification id. */
export function groupOfId(id: string): NotificationGroup | null {
  if (!ID_SHAPE.test(id)) return null;
  return id.startsWith("routine_missed:") || id.startsWith("ai_activity:")
    ? "fyi"
    : "needs";
}

/** What `hiddenUntil` becomes for a hide action, in the person's zone. */
export function hiddenUntilFor(
  action: Exclude<
    NotificationAction,
    { action: "read" } | { action: "restore" }
  >,
  group: NotificationGroup,
  now: Date,
  timeZone: string,
): Date | "forever" {
  if (action.action === "mute") return "forever";
  if (action.action === "snooze")
    return snoozeUntil(action.option, now, timeZone);
  // dismiss: FYI goes for good; Needs you is "Not now", back tomorrow at 09:00.
  return group === "fyi" ? "forever" : notNowUntil(now, timeZone);
}

export async function applyAction(
  userId: string,
  id: string,
  action: NotificationAction,
  now = new Date(),
) {
  const group = groupOfId(id);
  if (!group) throw new NotificationError("Unknown notification", 404);
  const filter = { userId, id };

  if (action.action === "read") {
    await notificationStatesCollection.updateOne(
      filter,
      { $set: { readAt: now, updatedAt: now } },
      { upsert: true },
    );
    return;
  }

  const current = await notificationStatesCollection.findOne(filter);
  if (action.action === "restore") {
    // Undo: put back what hiddenUntil held before the last change.
    const previous = current?.previousHiddenUntil ?? null;
    await notificationStatesCollection.updateOne(
      filter,
      previous === null
        ? { $unset: { hiddenUntil: "" }, $set: { updatedAt: now } }
        : { $set: { hiddenUntil: previous, updatedAt: now } },
      { upsert: true },
    );
    return;
  }

  if (action.action === "snooze" && group !== "needs") {
    throw new NotificationError("Only Needs you items can be snoozed");
  }
  const { timeZone } = await loadContext(userId, now);
  await notificationStatesCollection.updateOne(
    filter,
    {
      $set: {
        hiddenUntil: hiddenUntilFor(action, group, now, timeZone),
        previousHiddenUntil: current?.hiddenUntil ?? null,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}

/** read_all: every listed item is read. clear_fyi: every listed FYI item goes for good; Needs you is never touched. */
export async function applyBulk(
  userId: string,
  action: "read_all" | "clear_fyi",
  now = new Date(),
) {
  const items = await currentNotifications(await loadContext(userId, now));
  const targets =
    action === "read_all"
      ? items.filter((n) => !n.readAt)
      : items.filter((n) => n.group === "fyi");
  if (targets.length === 0) return;
  await notificationStatesCollection.bulkWrite(
    targets.map((n) => ({
      updateOne: {
        filter: { userId, id: n.id },
        update: {
          $set:
            action === "read_all"
              ? { readAt: now, updatedAt: now }
              : { hiddenUntil: "forever" as const, updatedAt: now },
        },
        upsert: true,
      },
    })),
  );
}

// --------------------------------------------------- per-item heads-up ------

function itemObjectId(itemId: string): ObjectId {
  if (!ObjectId.isValid(itemId))
    throw new NotificationError("Item not found", 404);
  return new ObjectId(itemId);
}

export async function getItemReminder(
  userId: string,
  kind: ItemReminder["kind"],
  itemId: string,
): Promise<ItemReminder> {
  const _id = itemObjectId(itemId);
  if (kind === "routine") {
    // Routines have no heads-up of their own yet: always the default.
    const routine = await checklistItemsCollection.findOne(
      { _id, userId },
      { projection: { _id: 1 } },
    );
    if (!routine) throw new NotificationError("Item not found", 404);
    return { kind, itemId, lead: null };
  }
  const item = await maintenanceItemsCollection.findOne(
    { _id, userId },
    { projection: { reminderLead: 1 } },
  );
  if (!item) throw new NotificationError("Item not found", 404);
  return { kind, itemId, lead: item.reminderLead ?? null };
}

export async function setItemReminder(
  userId: string,
  reminder: ItemReminder,
  now = new Date(),
): Promise<ItemReminder> {
  if (reminder.kind === "routine")
    throw new NotificationError(
      "Remind me is only available for maintenance items for now",
    );
  const _id = itemObjectId(reminder.itemId);
  const result = await maintenanceItemsCollection.updateOne(
    { _id, userId },
    reminder.lead === null
      ? { $unset: { reminderLead: "" }, $set: { updatedAt: now } }
      : { $set: { reminderLead: reminder.lead, updatedAt: now } },
  );
  if (result.matchedCount === 0)
    throw new NotificationError("Item not found", 404);
  return { kind: reminder.kind, itemId: reminder.itemId, lead: reminder.lead };
}
