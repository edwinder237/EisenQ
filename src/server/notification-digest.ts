import "server-only";
import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { userSettingsCollection } from "~/server/db";
import type { DigestRecord, DigestRecordCounts } from "~/server/db/schema";
import type {
  AppNotification,
  NotificationPreferences,
} from "~/lib/notifications/types";
import {
  accountAddressFor,
  errorNameOf,
  logNotifications,
  type AccountAddress,
} from "~/server/notification-access";
import {
  deleteNotificationsFor,
  isNotificationsDeleted,
  requeueDeletion,
  retryPendingDeletions,
} from "~/server/notification-deletion";
import { channelsFrom } from "~/server/notification-preferences";
import {
  CONTEXT_PROJECTION,
  NotificationError,
  contextFrom,
  currentNotifications,
  loadContext,
  saveChannelsCopy,
  type NotificationContext,
} from "~/server/notification-service";
import type {
  DigestCounts,
  SendResult,
  SocleClient,
  SocleFailure,
  SocleRecipient,
} from "~/server/socle";
import { ymdInZone } from "~/server/timezone";

// The daily summary (docs/notifications/README.md, "Daily email"). A Vercel
// cron every 15 minutes (GET /api/cron/notifications-digest) sends it to every
// account whose digest.sendAt has come in its own time zone, at most once per
// local day, through Socle, as one event that Socle delivers by email and as a
// copy in the bell. It holds counts only: no task name, no date, no time and
// no time zone ever goes to Socle.
//
// Who gets what is Socle's to say (amended design record, points 6 and 8):
// before each send the job asks Socle for the person's switches. With both
// off, nothing goes. With email off, the event goes without an address, to
// the bell only. With email on, it goes to the account's own verified primary
// email, and without one nothing goes. Socle gates every send again itself
// (409 recipient-opted-out).

const CATCH_UP_MINUTES = 120; // a missed or failed run is retried until sendAt + 2 h
const MAX_RETRY_WAIT_MS = 5_000;
const STALE_CLAIM_MS = 10 * 60_000; // a run that died mid-send frees the day after this
// Accounts are read 100 at a time, in _id order. A run calls Socle for at most
// 50 people and starts nobody new after 30 seconds; the rest are reached by
// the next runs, inside the 2-hour catch-up window. Every call of a run, to
// Socle or Clerk, ends by its 50-second deadline (maxDuration is 60): each is
// given only the time left, and none starts with less than half a second.
export const PAGE_SIZE = 100;
export const MAX_PEOPLE_PER_RUN = 50;
export const RUN_BUDGET_MS = 30_000;
export const RUN_DEADLINE_MS = 50_000;
// Deleted accounts' retries take at most the run's first 10 seconds.
export const DELETIONS_BUDGET_MS = 10_000;
const CLERK_TIMEOUT_MS = 5_000;
const MIN_CALL_MS = 500;
// vercel.json runs the job every 15 minutes. When a run stops at its cap, it
// counts who it didn't reach whose window closes before the next one
// (digest_window_missed), reading at most 10 more pages.
const RUN_EVERY_MS = 15 * 60_000;
const MISSED_SCAN_PAGES = 10;
// An account Clerk says it doesn't have (404) is deleted only on a second 404
// at least an hour after the first, only if the same run also found someone
// else in Clerk, and only if the run saw at most 5 404s. A run where Clerk
// found nobody, or answered 404 for more than 5, looks like a Clerk key for
// the wrong instance, not deletions: marks stay, and nobody is deleted.
export const CLERK_MISSING_CONFIRM_MS = 60 * 60_000;
export const CLERK_MISSING_TRIP = 5;
const FINAL: ReadonlySet<DigestRecord["status"]> = new Set([
  "sent",
  "empty",
  "refused",
  "no-email",
  "opted-out",
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

/**
 * Worth sending again with the same key: Socle unreachable, any 5xx, a 429,
 * or the key still in use. Socle's idempotency makes a repeat safe.
 */
export function retryable(r: SendResult): boolean {
  return (
    r.kind === "unreachable" ||
    (r.kind === "problem" &&
      (r.status >= 500 ||
        r.status === 429 ||
        (r.status === 409 && r.type === "idempotency-key-in-use")))
  );
}

// Statuses only: nothing else from Socle's answer is logged (legal, Socle's #52).
function logRefusal(event: string, r: SocleFailure) {
  if (r.kind === "problem")
    logNotifications("warn", event, { status: r.status });
  else logNotifications("warn", event, { unreachable: r.reason });
}

/** What happened to one person's summary on a run. Never logged with anything about them. */
export type DigestOutcome =
  | "sent" // Socle accepted it
  | "already-sent" // today's is done (sent, empty, opted out, no address or refused)
  | "in-progress" // another run holds today's
  | "not-due" // their sendAt hasn't come, or its window has passed
  | "empty" // nothing to report: nothing sent
  | "opted-out" // email and bell both off in Socle: nothing sent
  | "no-email" // email on, but no verified address: nothing sent
  | "refused" // Socle refused it: not retried today
  | "missing-in-clerk" // Clerk answered 404: nothing sent; the run's end decides (settleMissing)
  | "account-deleted" // deleted while the run was on them: nothing sent
  | "unavailable"; // Socle or Clerk unreachable: the next run retries, same key

export interface DigestRunSummary {
  status: "done" | "off";
  reason?: string;
  /** Accounts read this run. */
  scanned?: number;
  /** How many of each outcome. */
  outcomes?: Partial<Record<DigestOutcome, number>>;
  /** True when the run stopped at its cap or its time budget; the next run carries on. */
  capped?: boolean;
  /** Deleted accounts Socle confirmed this run, and those still waiting. */
  deletions?: { done: number; pending: number };
  /** When capped: people not reached whose window closes before the next run, so who get nothing today. */
  windowMissed?: number;
  /** People Clerk answered 404 for: newly marked, deleted on a second 404, or none of it because Clerk looked misconfigured. */
  clerkMissing?: { marked: number; deleted: number; misconfigured: boolean };
}

export interface DigestRunOptions {
  socle: SocleClient | null;
  now?: Date;
  addressFor?: (userId: string) => Promise<AccountAddress>;
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  maxPeople?: number;
  budgetMs?: number;
  /** Milliseconds since the run started. Not Date, which tests freeze. */
  elapsed?: () => number;
}

/** Someone Clerk answered 404 for this run, and since when it has (their mark, if any). */
type MissingInClerk = { userId: string; since?: Date };

/** What one person's summary may use: the hooks, the time left in the run, and where to note Clerk's answers. */
type PersonOptions = Pick<DigestRunOptions, "addressFor" | "sleep"> & {
  left: () => number;
  missing: MissingInClerk[];
  /** Clerk look-ups this run that found the account. */
  clerk: { found: number };
};

class OutOfTime extends Error {
  override name = "TimeoutError";
}

/** The promise, or a TimeoutError after `ms`. For Clerk's SDK, which takes no timeout of its own. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OutOfTime()), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Today's record, once this run holds it: its key, and the counts that key first went with, if it went. */
type Claim = { key: string; counts?: DigestRecordCounts };

/**
 * Takes today's sent-today record for this run: a new one with a new random
 * key, or today's unfinished one with its own key and counts. null when it's
 * already done, or another run holds it.
 */
async function claimToday(
  userId: string,
  record: DigestRecord | undefined,
  today: string,
  now: Date,
): Promise<Claim | null> {
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
    return r.modifiedCount === 1 ? { key } : null;
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
  if (r.modifiedCount !== 1) return null;
  // The counts as the record holds them now, not as this run's page read
  // them: a run in between may have sent with this key.
  const held = (
    await userSettingsCollection.findOne(
      { userId },
      { projection: { notificationDigest: 1 } },
    )
  )?.notificationDigest;
  return held?.day === today && held.key === record.key && held.counts
    ? { key: record.key, counts: held.counts }
    : { key: record.key };
}

type PersonResult = { outcome: DigestOutcome; calledSocle: boolean };

/** One person's summary for today, if it's due. */
async function digestFor(
  ctx: NotificationContext,
  socle: SocleClient,
  opts: PersonOptions,
): Promise<PersonResult> {
  const { userId, now } = ctx;
  const done = (outcome: DigestOutcome, calledSocle = false) => ({
    outcome,
    calledSocle,
  });
  if (!inSendWindow(ctx.prefs.digest.sendAt, now, ctx.timeZone))
    return done("not-due");
  const today = ymdInZone(now, ctx.timeZone);
  if (ctx.digest?.day === today && FINAL.has(ctx.digest.status))
    return done("already-sent");

  const claim = await claimToday(userId, ctx.digest, today, now);
  if (!claim) return done("in-progress");
  const { key } = claim;
  const ours = {
    userId,
    "notificationDigest.day": today,
    "notificationDigest.key": key,
  };
  const settle = (status: DigestRecord["status"], nextKey?: string) =>
    userSettingsCollection.updateOne(ours, {
      $set: {
        "notificationDigest.status": status,
        ...(nextKey ? { "notificationDigest.key": nextKey } : {}),
      },
      // A new key starts with fresh counts.
      $unset: {
        "notificationDigest.claimedAt": "",
        ...(nextKey ? { "notificationDigest.counts": "" } : {}),
      },
    });
  const pin = async (counts: DigestRecordCounts) =>
    (
      await userSettingsCollection.updateOne(ours, {
        $set: { "notificationDigest.counts": counts },
      })
    ).matchedCount === 1;

  try {
    return await sendClaimed(ctx, socle, opts, {
      key,
      ...(claim.counts ? { pinned: claim.counts } : {}),
      pin,
      settle,
      done,
    });
  } catch (err) {
    // One person's failure never stops the run: their day stays open, with
    // the same key, for the next run inside their window.
    logNotifications("error", "digest_person_failed", {
      errorName: errorNameOf(err),
    });
    await settle("pending").catch(() => undefined);
    return done("unavailable", true);
  }
}

type Claimed = {
  key: string;
  /** The counts this key already went to Socle with: sent again exactly. */
  pinned?: DigestRecordCounts;
  /** Keeps the counts with the key, before its first send. False when the record is gone. */
  pin: (counts: DigestRecordCounts) => Promise<boolean>;
  settle: (
    status: DigestRecord["status"],
    nextKey?: string,
  ) => Promise<{ matchedCount: number }>;
  done: (outcome: DigestOutcome, calledSocle?: boolean) => PersonResult;
};

/** The rest of one person's summary, once today's record is theirs. */
async function sendClaimed(
  ctx: NotificationContext,
  socle: SocleClient,
  opts: PersonOptions,
  { key, pinned, pin, settle, done }: Claimed,
): Promise<PersonResult> {
  const { userId, now } = ctx;
  // Out of run time before a call: the day stays open, same key, for the next run.
  const outOfTime = async (calledSocle: boolean) => {
    logNotifications("warn", "digest_out_of_time");
    await settle("pending");
    return done("unavailable", calledSocle);
  };
  // A key that already went to Socle goes again with the same counts, even
  // if a task changed since: Socle keeps the first body's hash, even after a
  // failure, and would answer any other body "key reused".
  const counts: DigestCounts = pinned
    ? { ...pinned, isTest: false }
    : digestCounts(
        await currentNotifications(ctx, emailPreferences(ctx.prefs)),
        false,
      );
  // Nothing in it: nothing today, and Socle isn't asked.
  if (isEmpty(counts)) {
    await settle("empty");
    return done("empty");
  }

  // The account must still exist, whatever goes: one Clerk call per person
  // per send, which also gives the address. An account deleted in Clerk
  // whose event EisenQ missed would otherwise read as "bell on" (no copy)
  // and reach Socle every day (legal's deletion rule).
  if (opts.left() < MIN_CALL_MS) return outOfTime(false);
  let address: AccountAddress;
  try {
    address = await withTimeout(
      (opts.addressFor ?? accountAddressFor)(userId),
      Math.min(CLERK_TIMEOUT_MS, opts.left()),
    );
  } catch {
    logNotifications("warn", "digest_address_unavailable");
    await settle("pending");
    return done("unavailable");
  }
  if (address.kind === "gone") {
    // Nothing goes, and nothing is decided yet: the run's end marks or
    // deletes them once it knows how many 404s it saw (settleMissing). Their
    // day stays open, so a later run asks Clerk again.
    opts.missing.push({ userId, ...(ctx.clerkMissingSince ? { since: ctx.clerkMissingSince } : {}) });
    await settle("pending");
    return done("missing-in-clerk");
  }
  opts.clerk.found++;
  // Clerk knows them: an earlier 404 was a blip.
  if (ctx.clerkMissingSince)
    await userSettingsCollection
      .updateOne({ userId }, { $unset: { clerkMissingSince: "" } })
      .catch(() => undefined);

  // The person's switches, as Socle holds them now.
  if (opts.left() < MIN_CALL_MS) return outOfTime(false);
  const looked = await socle.lookupPreferences(userId, { timeoutMs: opts.left() });
  if (looked.kind !== "ok") {
    logRefusal("digest_preferences_unavailable", looked);
    await settle("pending");
    return done("unavailable", true);
  }
  const channels = channelsFrom(looked.choices);
  const kept = await saveChannelsCopy(userId, channels, now).catch(() => true);
  // Deleted while this run was on them (Clerk's event): nothing goes.
  if (!kept) return done("account-deleted", true);
  if (!channels.email && !channels.bell) {
    await settle("opted-out");
    return done("opted-out", true);
  }

  const recipient: SocleRecipient = { id: userId };
  if (channels.email) {
    // Only the account's own primary email, once Clerk has verified it
    // (legal's A1). Without one nothing goes, not even the bell copy: Socle
    // refuses an event without an address while email is on.
    if (address.kind !== "verified") {
      logNotifications("info", "digest_skipped", {
        reason: address.kind === "unverified" ? "email-unverified" : "no-email",
      });
      await settle("no-email");
      return done("no-email", true);
    }
    recipient.email = address.email;
    if (address.locale) recipient.locale = address.locale;
  }

  const event = { idempotencyKey: key, recipient, counts };
  if (opts.left() < MIN_CALL_MS) return outOfTime(true);
  // The key's first send: its counts are kept with it first, for every retry
  // today. If the record is gone, the account was deleted meanwhile (Clerk's
  // event): nothing goes.
  if (!pinned) {
    const { dueCount, comingUpCount, missedRoutinesCount } = counts;
    if (!(await pin({ dueCount, comingUpCount, missedRoutinesCount })))
      return done("account-deleted", true);
  }
  // Once the event may have reached Socle: if the record is gone because the
  // account was deleted meanwhile (Clerk's event), Socle's delete ran before
  // this event, so the ID goes back on the deletions list to run it again.
  const settleSent = async (status: DigestRecord["status"], nextKey?: string) => {
    const r = await settle(status, nextKey);
    if (r.matchedCount === 0 && (await isNotificationsDeleted(userId))) {
      logNotifications("warn", "digest_sent_after_deletion");
      await requeueDeletion(userId, now);
    }
  };
  let result = await socle.sendDigestEvent(event, { timeoutMs: opts.left() });
  if (retryable(result)) {
    const waitS =
      result.kind === "problem" ? (result.retryAfterSeconds ?? 1) : 1;
    const waitMs = Math.min(waitS * 1000, MAX_RETRY_WAIT_MS);
    // Again in this run only if the wait and the call fit before the deadline.
    if (opts.left() >= waitMs + MIN_CALL_MS) {
      await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(waitMs);
      result = await socle.sendDigestEvent(event, { timeoutMs: opts.left() });
    }
  }

  if (result.kind === "accepted") {
    await settleSent("sent");
    if (result.eventId)
      logNotifications("info", "digest_sent", { eventId: result.eventId });
    // Channels without email don't mean the person's email is off: Socle
    // also leaves it out while the event type's email is paused. Only a
    // look-up says what they chose.
    return done("sent", true);
  }
  const problem = result.kind === "problem" ? result : null;
  if (problem?.status === 422 && problem.type === "idempotency-key-reused") {
    await settleSent("sent");
    return done("sent", true);
  }
  logRefusal("digest_refused", result);
  if (problem?.status === 409 && problem.type === "recipient-opted-out") {
    // Nothing today. The copy stays what Socle's look-up said a moment ago:
    // a send's answer doesn't say which switches are off, and the next
    // look-up corrects it.
    await settleSent("opted-out");
    return done("opted-out", true);
  }
  if (
    problem?.status === 422 &&
    problem.type === "recipient-invalid" &&
    !recipient.email &&
    problem.pointers?.includes("/recipient/email")
  ) {
    // Email went on between the look-up and the send. The next run looks
    // again and sends with the address, under a new key, as Socle asks.
    await settleSent("pending", randomUUID());
    return done("unavailable", true);
  }
  if (retryable(result)) {
    // Socle is down: the next run within the window tries again, same key.
    await settleSent("pending");
    return done("unavailable", true);
  }
  // event-type-unknown, event-type-off, or another refusal: not retried today.
  await settleSent("refused");
  return done("refused", true);
}

/**
 * One cron run, over every account whose copy of Socle's switches has email
 * or the bell on. Answers with counts, never with anything about a person.
 */
export async function runDigests(
  opts: DigestRunOptions,
): Promise<DigestRunSummary> {
  const now = opts.now ?? new Date();
  const started = performance.now();
  const elapsed = opts.elapsed ?? (() => performance.now() - started);
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const maxPeople = opts.maxPeople ?? MAX_PEOPLE_PER_RUN;
  const budgetMs = opts.budgetMs ?? RUN_BUDGET_MS;
  const finish = (summary: DigestRunSummary) => {
    const { outcomes, deletions, clerkMissing, ...rest } = summary;
    logNotifications("info", "digest_run", {
      ...rest,
      ...outcomes,
      ...(deletions
        ? { deletionsDone: deletions.done, deletionsPending: deletions.pending }
        : {}),
      ...(clerkMissing
        ? {
            clerkMissingMarked: clerkMissing.marked,
            clerkMissingDeleted: clerkMissing.deleted,
            clerkMisconfigured: clerkMissing.misconfigured,
          }
        : {}),
    });
    return summary;
  };

  const socle = opts.socle;
  if (!socle) return finish({ status: "off", reason: "socle-not-configured" });
  const left = () => Math.max(0, RUN_DEADLINE_MS - elapsed());
  const missing: MissingInClerk[] = [];
  const clerk = { found: 0 };
  const person: PersonOptions = { ...opts, left, missing, clerk };

  // Deleted accounts Socle hasn't confirmed yet go first (legal's deletion
  // rule), in the run's first seconds only.
  const deletions = await retryPendingDeletions(socle, now, {
    left: () => Math.max(0, Math.min(left(), DELETIONS_BUDGET_MS - elapsed())),
  });

  const outcomes: Partial<Record<DigestOutcome, number>> = {};
  let scanned = 0;
  let people = 0;
  let capped = false;
  let after: ObjectId | undefined;
  pages: for (;;) {
    const page = await userSettingsCollection
      .find(
        // Not deleted, and email on or the bell not switched off (no copy:
        // Socle's defaults, so the bell is on).
        { ...(after ? { _id: { $gt: after } } : {}), ...POPULATION },
        { projection: CONTEXT_PROJECTION },
      )
      .sort({ _id: 1 })
      .limit(pageSize)
      .toArray();
    for (const doc of page) {
      if (people >= maxPeople || elapsed() > budgetMs) {
        capped = true;
        break pages;
      }
      after = doc._id;
      scanned++;
      let result: PersonResult;
      try {
        result = await digestFor(contextFrom(doc.userId, doc, now), socle, person);
      } catch (err) {
        // Before their day was claimed (reading or claiming it): nothing to
        // settle, and the next run tries them again.
        logNotifications("error", "digest_person_failed", {
          errorName: errorNameOf(err),
        });
        result = { outcome: "unavailable", calledSocle: false };
      }
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      if (result.calledSocle) people++;
    }
    if (page.length < pageSize) break;
  }
  const clerkMissing =
    missing.length > 0
      ? await settleMissing(missing, clerk.found, socle, now, left)
      : undefined;
  const windowMissed = capped
    ? await countClosingWindows(after, now, pageSize, left)
    : { count: 0, complete: true };
  if (windowMissed.count > 0)
    logNotifications("warn", "digest_window_missed", {
      count: windowMissed.count,
      complete: windowMissed.complete,
    });
  return finish({
    status: "done",
    scanned,
    outcomes,
    capped,
    deletions,
    ...(capped ? { windowMissed: windowMissed.count } : {}),
    ...(clerkMissing ? { clerkMissing } : {}),
  });
}

/**
 * The run's 404s from Clerk, once it knows how many. More than 5: Clerk looks
 * misconfigured (a key for the wrong instance, say), so nobody is marked or
 * deleted, and one warning gives the count. Otherwise each first 404 marks the
 * person (clerkMissingSince), and a 404 at least an hour after their mark
 * deletes their notifications, here and in Socle, but only if this run also
 * found someone else in Clerk. If it found nobody, the marks stay and nobody
 * is deleted (one line, the count), and a later run with a success does it.
 * Counts only in the logs.
 */
async function settleMissing(
  missing: MissingInClerk[],
  found: number,
  socle: SocleClient,
  now: Date,
  left: () => number,
): Promise<NonNullable<DigestRunSummary["clerkMissing"]>> {
  if (missing.length > CLERK_MISSING_TRIP) {
    logNotifications("warn", "digest_clerk_misconfigured", { count: missing.length });
    return { marked: 0, deleted: 0, misconfigured: true };
  }
  const confirmed = ({ since }: MissingInClerk) =>
    since !== undefined && now.getTime() - since.getTime() >= CLERK_MISSING_CONFIRM_MS;
  const held = found === 0 ? missing.filter(confirmed).length : 0;
  if (held > 0)
    logNotifications("warn", "digest_clerk_deletions_held", { count: held });
  let marked = 0;
  let deleted = 0;
  for (const { userId, since } of missing) {
    try {
      if (!since) {
        const r = await userSettingsCollection.updateOne(
          {
            userId,
            clerkMissingSince: { $exists: false },
            notificationsDeletedAt: { $exists: false },
          },
          { $set: { clerkMissingSince: now } },
        );
        marked += r.modifiedCount;
      } else if (found > 0 && confirmed({ userId, since })) {
        // Socle's part may wait for the deletions' retries if time is short.
        if (left() < MIN_CALL_MS) break;
        await deleteNotificationsFor(userId, socle, now, { timeoutMs: left() });
        deleted++;
      }
    } catch (err) {
      logNotifications("error", "digest_person_failed", { errorName: errorNameOf(err) });
    }
  }
  if (marked + deleted > 0)
    logNotifications("info", "digest_clerk_missing", { marked, deleted });
  return { marked, deleted, misconfigured: false };
}

const POPULATION = {
  notificationsDeletedAt: { $exists: false },
  $or: [
    { "notificationChannels.email": true },
    { "notificationChannels.bell": { $ne: false } },
  ],
};

/**
 * After a capped run, from where it stopped: people whose window is open now
 * and closed by the next run, with today not done and something to report,
 * so who get no summary today. Database reads only, and only while the run
 * has time left: `complete` is false when it stopped early, and the count is
 * then a floor. A count: never who.
 */
async function countClosingWindows(
  after: ObjectId | undefined,
  now: Date,
  pageSize: number,
  left: () => number,
): Promise<{ count: number; complete: boolean }> {
  const next = new Date(now.getTime() + RUN_EVERY_MS);
  let missed = 0;
  let cursor = after;
  const enoughTime = () => left() >= 2_000;
  for (let pages = 0; pages < MISSED_SCAN_PAGES; pages++) {
    if (!enoughTime()) return { count: missed, complete: false };
    const page = await userSettingsCollection
      .find(
        { ...(cursor ? { _id: { $gt: cursor } } : {}), ...POPULATION },
        { projection: CONTEXT_PROJECTION },
      )
      .sort({ _id: 1 })
      .limit(pageSize)
      .toArray();
    for (const doc of page) {
      cursor = doc._id;
      const ctx = contextFrom(doc.userId, doc, now);
      const { sendAt } = ctx.prefs.digest;
      if (!inSendWindow(sendAt, now, ctx.timeZone) || inSendWindow(sendAt, next, ctx.timeZone)) continue;
      const today = ymdInZone(now, ctx.timeZone);
      if (ctx.digest?.day === today && FINAL.has(ctx.digest.status)) continue;
      // A key that already went keeps its counts, never empty: a retry sends those.
      if (ctx.digest?.day === today && ctx.digest.counts) {
        missed++;
        continue;
      }
      if (!enoughTime()) return { count: missed, complete: false };
      // Only those who had something to report miss anything.
      const counts = digestCounts(
        await currentNotifications(ctx, emailPreferences(ctx.prefs)),
        false,
      );
      if (!isEmpty(counts)) missed++;
    }
    if (page.length < pageSize) return { count: missed, complete: true };
  }
  return { count: missed, complete: false };
}

// ------------------------------------------------------------- test email ---

export const TEST_LIMIT = 3;

/** One of today's 3 tests, counted in EisenQ's database in the person's zone, so it holds across server instances. */
async function takeTestSlot(
  userId: string,
  day: string,
  now: Date,
): Promise<boolean> {
  await userSettingsCollection.updateOne(
    { userId },
    { $setOnInsert: { userId, createdAt: now, updatedAt: now } },
    { upsert: true },
  );
  const sameDay = () =>
    userSettingsCollection.updateOne(
      {
        userId,
        "notificationTests.day": day,
        "notificationTests.count": { $lt: TEST_LIMIT },
      },
      { $inc: { "notificationTests.count": 1 } },
    );
  if ((await sameDay()).modifiedCount === 1) return true;
  const firstToday = await userSettingsCollection.updateOne(
    { userId, "notificationTests.day": { $ne: day } },
    { $set: { notificationTests: { day, count: 1 } } },
  );
  if (firstToday.modifiedCount === 1) return true;
  // Another request started the day a moment ago.
  return (await sameDay()).modifiedCount === 1;
}

/** Gives back that day's test when Socle couldn't take it. Never below 0, and never another day's. */
async function giveBackTestSlot(userId: string, day: string): Promise<void> {
  await userSettingsCollection.updateOne(
    {
      userId,
      "notificationTests.day": day,
      "notificationTests.count": { $gt: 0 },
    },
    { $inc: { "notificationTests.count": -1 } },
  );
}

/**
 * "Send a test": today's summary now, even if empty, marked as a test, to the
 * account's own verified primary email, and only while its email is on in
 * Socle. 3 a day. Returns that address.
 */
export async function sendTestDigest(
  userId: string,
  opts: Pick<DigestRunOptions, "socle" | "now" | "addressFor">,
): Promise<{ sentTo: string }> {
  const now = opts.now ?? new Date();
  const socle = opts.socle;
  if (!socle)
    throw new NotificationError("Email isn't set up for EisenQ yet.", 503);

  const looked = await socle.lookupPreferences(userId);
  if (looked.kind !== "ok") {
    logRefusal("digest_test_refused", looked);
    throw new NotificationError(
      "Email is unavailable right now. Try again in a few minutes.",
      503,
    );
  }
  const channels = channelsFrom(looked.choices);
  await saveChannelsCopy(userId, channels, now).catch(() => undefined);
  if (!channels.email)
    throw new NotificationError(
      "Turn the daily email on and save first.",
      409,
    );

  let address: AccountAddress;
  try {
    address = await withTimeout(
      (opts.addressFor ?? accountAddressFor)(userId),
      CLERK_TIMEOUT_MS,
    );
  } catch {
    throw new NotificationError(
      "Couldn't check your account's email address. Try again.",
      503,
    );
  }
  if (address.kind === "unverified")
    throw new NotificationError(
      "Your account's email address isn't verified yet, so nothing was sent.",
      400,
    );
  if (address.kind !== "verified")
    throw new NotificationError("Your account has no email address.", 400);

  const ctx = await loadContext(userId, now);
  const day = ymdInZone(now, ctx.timeZone);
  if (!(await takeTestSlot(userId, day, now)))
    throw new NotificationError(
      `That's ${TEST_LIMIT} test emails today. Try again tomorrow.`,
      429,
    );

  const counts = digestCounts(
    await currentNotifications(ctx, emailPreferences(ctx.prefs)),
    true,
  );
  // A test always sends, with a random key of its own, so it never touches
  // the day's real summary.
  const result = await socle.sendDigestEvent({
    idempotencyKey: randomUUID(),
    recipient: {
      id: userId,
      email: address.email,
      ...(address.locale ? { locale: address.locale } : {}),
    },
    counts,
  });
  if (result.kind === "accepted") {
    logNotifications(
      "info",
      "digest_test_sent",
      result.eventId ? { eventId: result.eventId } : {},
    );
    return { sentTo: address.email };
  }

  logRefusal("digest_test_refused", result);
  // The copy stays what Socle's look-up said above: a send's answer doesn't
  // say which switches are off.
  if (result.kind === "problem" && result.type === "recipient-opted-out") {
    throw new NotificationError(
      "Your daily email is off, so nothing was sent.",
      409,
    );
  }
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
  if (retryable(result)) {
    // Socle down, busy or unreachable: an outage doesn't use up the day's tests.
    await giveBackTestSlot(userId, day).catch(() => undefined);
    throw new NotificationError(
      "Email is unavailable right now. Try again in a few minutes.",
      503,
    );
  }
  throw new NotificationError("Socle refused the test email.", 502);
}
