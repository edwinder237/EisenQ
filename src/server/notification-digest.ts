import "server-only";
import { randomUUID } from "node:crypto";
import { userSettingsCollection } from "~/server/db";
import type { DigestRecord } from "~/server/db/schema";
import type {
  AppNotification,
  NotificationPreferences,
} from "~/lib/notifications/types";
import {
  clerkRecipientFor,
  eisenqOwnerId,
  logNotifications,
} from "~/server/notification-access";
import {
  NotificationError,
  currentNotifications,
  loadContext,
} from "~/server/notification-service";
import type {
  DigestCounts,
  SendResult,
  SocleClient,
  SocleRecipient,
} from "~/server/socle";
import { ymdInZone } from "~/server/timezone";

// The daily email (docs/notifications/README.md, "Daily email"). A Vercel cron
// every 15 minutes (GET /api/cron/notifications-digest) sends it once per local
// day, at the person's digest.sendAt, through Socle. It holds counts only: no
// task name, no date, no time and no time zone ever goes to Socle.
//
// Only EisenQ's owner account is emailed for now (legal, Socle's #50), and only
// once they have saved their notification preferences with the daily email on.

const CATCH_UP_MINUTES = 120; // a missed or failed run is retried until sendAt + 2 h
const MAX_RETRY_WAIT_MS = 5_000;
const STALE_CLAIM_MS = 10 * 60_000; // a run that died mid-send frees the day after this
const FINAL: ReadonlySet<DigestRecord["status"]> = new Set([
  "sent",
  "empty",
  "refused",
  "no-email",
]);

/** The same rules as the bell, with each event's email switch in place of its in-app one. */
export function emailPreferences(
  prefs: NotificationPreferences,
): NotificationPreferences {
  const on = (email: boolean | null) => ({ inApp: email === true, email });
  return {
    ...prefs,
    events: {
      due: on(prefs.events.due.email),
      upcoming: on(prefs.events.upcoming.email),
      missed_routines: on(prefs.events.missed_routines.email),
      // AI activity is never emailed.
      ai_activity: { inApp: false, email: null },
    },
  };
}

/** Counts only: overdue (tasks and maintenance) plus due today; coming up; missed routines. */
export function digestCounts(
  items: readonly AppNotification[],
  isTest: boolean,
): DigestCounts {
  const count = (...kinds: AppNotification["kind"][]) =>
    items.filter((n) => kinds.includes(n.kind)).length;
  return {
    dueCount: count("task_overdue", "task_due_today", "maintenance_overdue"),
    comingUpCount: count("maintenance_upcoming"),
    missedRoutinesCount: count("routine_missed"),
    isTest,
  };
}

export function isEmpty(c: DigestCounts): boolean {
  return c.dueCount + c.comingUpCount + c.missedRoutinesCount === 0;
}

/** Whether "HH:mm" local has come, within the catch-up window, on this local day. */
export function inSendWindow(
  sendAt: string,
  now: Date,
  timeZone: string,
): boolean {
  const [h = 0, m = 0] = sendAt.split(":").map(Number);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(local.find((p) => p.type === type)?.value ?? 0);
  const minutes = get("hour") * 60 + get("minute");
  const target = h * 60 + m;
  return minutes >= target && minutes < target + CATCH_UP_MINUTES;
}

function retryable(r: SendResult): boolean {
  return (
    r.kind === "unreachable" ||
    (r.kind === "problem" &&
      (r.status === 503 ||
        (r.status === 409 && r.type === "idempotency-key-in-use")))
  );
}

// Statuses only: nothing else from Socle's answer is logged (legal, Socle's #52).
function logRefusal(event: string, r: SendResult) {
  if (r.kind === "problem")
    logNotifications("warn", event, { status: r.status });
  else if (r.kind === "unreachable")
    logNotifications("warn", event, { unreachable: r.reason });
}

export interface DigestRunSummary {
  status: "done" | "off";
  reason?: string;
  // What happened to the owner's digest on this run: "sent", "already-sent",
  // "in-progress", "empty", "not-due", "digest-off", "no-email", "refused" or
  // "unavailable" (retried by the next run, with the same key).
  outcome?: string;
}

export interface DigestRunOptions {
  socle: SocleClient | null;
  now?: Date;
  ownerId?: () => Promise<string | null>;
  recipientFor?: (userId: string) => Promise<SocleRecipient | null>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Takes today's sent-today record for this run: a new one with a new random
 * key, or today's unfinished one with its own key. null when it's already
 * done, or another run holds it.
 */
async function claimToday(
  userId: string,
  record: DigestRecord | undefined,
  today: string,
  now: Date,
): Promise<string | null> {
  if (record?.day !== today) {
    const key = randomUUID();
    const r = await userSettingsCollection.updateOne(
      { userId, "notificationDigest.day": { $ne: today } },
      {
        $set: {
          notificationDigest: {
            day: today,
            key,
            status: "sending",
            claimedAt: now,
          },
        },
      },
    );
    return r.modifiedCount === 1 ? key : null;
  }
  const r = await userSettingsCollection.updateOne(
    {
      userId,
      "notificationDigest.day": today,
      "notificationDigest.key": record.key,
      $or: [
        { "notificationDigest.status": "pending" },
        {
          "notificationDigest.status": "sending",
          "notificationDigest.claimedAt": {
            $lt: new Date(now.getTime() - STALE_CLAIM_MS),
          },
        },
      ],
    },
    {
      $set: {
        "notificationDigest.status": "sending",
        "notificationDigest.claimedAt": now,
      },
    },
  );
  return r.modifiedCount === 1 ? record.key : null;
}

/** One cron run. Answers with what happened, never with anything about the person. */
export async function runDigests(
  opts: DigestRunOptions,
): Promise<DigestRunSummary> {
  const now = opts.now ?? new Date();
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const finish = (summary: DigestRunSummary, eventId?: string) => {
    logNotifications("info", "digest_run", {
      ...summary,
      ...(eventId ? { eventId } : {}),
    });
    return summary;
  };

  if (!opts.socle)
    return finish({ status: "off", reason: "socle-not-configured" });
  const userId = await (
    opts.ownerId ?? (() => eisenqOwnerId({ fresh: true }))
  )();
  if (!userId) return finish({ status: "off", reason: "no-owner-account" });

  const ctx = await loadContext(userId, now);
  // Opt-in: only once the person has saved their preferences with the daily email on.
  if (!ctx.prefsSaved || !ctx.prefs.digest.enabled)
    return finish({ status: "done", outcome: "digest-off" });
  if (!inSendWindow(ctx.prefs.digest.sendAt, now, ctx.timeZone))
    return finish({ status: "done", outcome: "not-due" });

  const today = ymdInZone(now, ctx.timeZone);
  if (ctx.digest?.day === today && FINAL.has(ctx.digest.status))
    return finish({ status: "done", outcome: "already-sent" });

  const key = await claimToday(userId, ctx.digest, today, now);
  if (!key) return finish({ status: "done", outcome: "in-progress" });
  const settle = (status: DigestRecord["status"]) =>
    userSettingsCollection.updateOne(
      {
        userId,
        "notificationDigest.day": today,
        "notificationDigest.key": key,
      },
      {
        $set: { "notificationDigest.status": status },
        $unset: { "notificationDigest.claimedAt": "" },
      },
    );

  const counts = digestCounts(
    await currentNotifications(ctx, emailPreferences(ctx.prefs)),
    false,
  );
  // Nothing in it: no email today.
  if (isEmpty(counts)) {
    await settle("empty");
    return finish({ status: "done", outcome: "empty" });
  }

  const recipient = await (opts.recipientFor ?? clerkRecipientFor)(
    userId,
  ).catch(() => null);
  if (!recipient) {
    await settle("no-email");
    return finish({ status: "done", outcome: "no-email" });
  }

  const event = { idempotencyKey: key, recipient, counts };
  let result = await opts.socle.sendDigestEvent(event);
  if (retryable(result)) {
    const waitS =
      result.kind === "problem" ? (result.retryAfterSeconds ?? 1) : 1;
    await sleep(Math.min(waitS * 1000, MAX_RETRY_WAIT_MS));
    result = await opts.socle.sendDigestEvent(event);
  }

  if (
    result.kind === "accepted" ||
    (result.kind === "problem" &&
      result.status === 422 &&
      result.type === "idempotency-key-reused")
  ) {
    await settle("sent");
    return finish(
      { status: "done", outcome: "sent" },
      result.kind === "accepted" ? result.eventId : undefined,
    );
  }
  logRefusal("digest_refused", result);
  if (retryable(result)) {
    // Socle or Novu is down: the next run within the window tries again, same key.
    await settle("pending");
    return finish({ status: "done", outcome: "unavailable" });
  }
  // event-type-unknown (until Socle has eisenq.digest.ready), event-type-off,
  // or another refusal: not retried today.
  await settle("refused");
  return finish({ status: "done", outcome: "refused" });
}

// ------------------------------------------------------------- test email ---

const TEST_LIMIT = 3;
const TEST_WINDOW_MS = 60 * 60_000;
// Per server instance, like EisenQ's other limiters: enough for one person.
const testSends = new Map<string, number[]>();

export function resetTestEmailLimit() {
  testSends.clear();
}

function takeTestSlot(userId: string, now: number): boolean {
  const recent = (testSends.get(userId) ?? []).filter(
    (t) => now - t < TEST_WINDOW_MS,
  );
  if (recent.length >= TEST_LIMIT) {
    testSends.set(userId, recent);
    return false;
  }
  testSends.set(userId, [...recent, now]);
  return true;
}

/**
 * "Send a test": today's digest now, even if empty, marked as a test, to the
 * account's own primary email. Returns that address.
 */
export async function sendTestDigest(
  userId: string,
  opts: Omit<DigestRunOptions, "sleep"> & { socle: SocleClient | null },
): Promise<{ sentTo: string }> {
  const now = opts.now ?? new Date();
  const owner = await (opts.ownerId ?? (() => eisenqOwnerId()))();
  if (owner === null || owner !== userId) {
    throw new NotificationError(
      "The daily email isn't available for this account yet.",
      403,
    );
  }
  if (!opts.socle)
    throw new NotificationError("Email isn't set up for EisenQ yet.", 503);
  if (!takeTestSlot(userId, now.getTime())) {
    throw new NotificationError(
      `That's ${TEST_LIMIT} test emails this hour. Try again later.`,
      429,
    );
  }

  const recipient = await (opts.recipientFor ?? clerkRecipientFor)(
    userId,
  ).catch(() => null);
  if (!recipient)
    throw new NotificationError("Your account has no email address.", 400);

  const ctx = await loadContext(userId, now);
  const counts = digestCounts(
    await currentNotifications(ctx, emailPreferences(ctx.prefs)),
    true,
  );
  // A test always sends, with a random key of its own, so it never touches
  // the day's real digest.
  const result = await opts.socle.sendDigestEvent({
    idempotencyKey: randomUUID(),
    recipient,
    counts,
  });
  if (result.kind === "accepted") {
    logNotifications(
      "info",
      "digest_test_sent",
      result.eventId ? { eventId: result.eventId } : {},
    );
    return { sentTo: recipient.email };
  }

  logRefusal("digest_test_refused", result);
  if (result.kind === "problem" && result.type === "event-type-unknown") {
    throw new NotificationError(
      "Socle doesn't know EisenQ's daily email yet, so nothing was sent.",
      503,
    );
  }
  if (result.kind === "problem" && result.type === "event-type-off") {
    throw new NotificationError(
      "The daily email is switched off in Socle, so nothing was sent.",
      503,
    );
  }
  if (retryable(result))
    throw new NotificationError(
      "Email is unavailable right now. Try again in a few minutes.",
      503,
    );
  throw new NotificationError("Socle refused the test email.", 502);
}
