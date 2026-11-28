import "server-only";
import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { userSettingsCollection } from "~/server/db";
import type { DigestRecord } from "~/server/db/schema";
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
import { retryPendingDeletions } from "~/server/notification-deletion";
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
// 50 people and starts nobody new after 40 seconds (maxDuration is 60): the
// rest are reached by the next runs, inside the 2-hour catch-up window.
export const PAGE_SIZE = 100;
export const MAX_PEOPLE_PER_RUN = 50;
export const RUN_BUDGET_MS = 40_000;
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

function retryable(r: SendResult): boolean {
  return (
    r.kind === "unreachable" ||
    (r.kind === "problem" &&
      (r.status === 503 ||
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

type PersonResult = { outcome: DigestOutcome; calledSocle: boolean };

/** One person's summary for today, if it's due. */
async function digestFor(
  ctx: NotificationContext,
  socle: SocleClient,
  opts: Pick<DigestRunOptions, "addressFor" | "sleep">,
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

  const key = await claimToday(userId, ctx.digest, today, now);
  if (!key) return done("in-progress");
  const settle = (status: DigestRecord["status"], nextKey?: string) =>
    userSettingsCollection.updateOne(
      {
        userId,
        "notificationDigest.day": today,
        "notificationDigest.key": key,
      },
      {
        $set: {
          "notificationDigest.status": status,
          ...(nextKey ? { "notificationDigest.key": nextKey } : {}),
        },
        $unset: { "notificationDigest.claimedAt": "" },
      },
    );

  try {
    return await sendClaimed(ctx, socle, opts, { key, settle, done });
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
  settle: (
    status: DigestRecord["status"],
    nextKey?: string,
  ) => Promise<unknown>;
  done: (outcome: DigestOutcome, calledSocle?: boolean) => PersonResult;
};

/** The rest of one person's summary, once today's record is theirs. */
async function sendClaimed(
  ctx: NotificationContext,
  socle: SocleClient,
  opts: Pick<DigestRunOptions, "addressFor" | "sleep">,
  { key, settle, done }: Claimed,
): Promise<PersonResult> {
  const { userId, now } = ctx;
  const counts = digestCounts(
    await currentNotifications(ctx, emailPreferences(ctx.prefs)),
    false,
  );
  // Nothing in it: nothing today, and Socle isn't asked.
  if (isEmpty(counts)) {
    await settle("empty");
    return done("empty");
  }

  // The person's switches, as Socle holds them now.
  const looked = await socle.lookupPreferences(userId);
  if (looked.kind !== "ok") {
    logRefusal("digest_preferences_unavailable", looked);
    await settle("pending");
    return done("unavailable", true);
  }
  const channels = channelsFrom(looked.choices);
  await saveChannelsCopy(userId, channels, now).catch(() => undefined);
  if (!channels.email && !channels.bell) {
    await settle("opted-out");
    return done("opted-out", true);
  }

  const recipient: SocleRecipient = { id: userId };
  if (channels.email) {
    // Only the account's own primary email, once Clerk has verified it
    // (legal's A1). Without one nothing goes, not even the bell copy: Socle
    // refuses an event without an address while email is on.
    let address: AccountAddress;
    try {
      address = await (opts.addressFor ?? accountAddressFor)(userId);
    } catch {
      logNotifications("warn", "digest_address_unavailable");
      await settle("pending");
      return done("unavailable", true);
    }
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
  let result = await socle.sendDigestEvent(event);
  if (retryable(result)) {
    const waitS =
      result.kind === "problem" ? (result.retryAfterSeconds ?? 1) : 1;
    await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(
      Math.min(waitS * 1000, MAX_RETRY_WAIT_MS),
    );
    result = await socle.sendDigestEvent(event);
  }

  if (result.kind === "accepted") {
    await settle("sent");
    if (result.eventId)
      logNotifications("info", "digest_sent", { eventId: result.eventId });
    // An address went, but Socle sent no email: its email is off now.
    if (recipient.email && result.channels && !result.channels.includes("email"))
      await saveChannelsCopy(userId, { ...channels, email: false }, now).catch(
        () => undefined,
      );
    return done("sent", true);
  }
  const problem = result.kind === "problem" ? result : null;
  if (problem?.status === 422 && problem.type === "idempotency-key-reused") {
    await settle("sent");
    return done("sent", true);
  }
  logRefusal("digest_refused", result);
  if (problem?.status === 409 && problem.type === "recipient-opted-out") {
    await settle("opted-out");
    await saveChannelsCopy(userId, { email: false, bell: false }, now).catch(
      () => undefined,
    );
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
    await settle("pending", randomUUID());
    return done("unavailable", true);
  }
  if (retryable(result)) {
    // Socle is down: the next run within the window tries again, same key.
    await settle("pending");
    return done("unavailable", true);
  }
  // event-type-unknown, event-type-off, or another refusal: not retried today.
  await settle("refused");
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
    const { outcomes, deletions, ...rest } = summary;
    logNotifications("info", "digest_run", {
      ...rest,
      ...outcomes,
      ...(deletions
        ? { deletionsDone: deletions.done, deletionsPending: deletions.pending }
        : {}),
    });
    return summary;
  };

  const socle = opts.socle;
  if (!socle) return finish({ status: "off", reason: "socle-not-configured" });

  // Deleted accounts Socle hasn't confirmed yet go first (legal's deletion rule).
  const deletions = await retryPendingDeletions(socle, now);

  const outcomes: Partial<Record<DigestOutcome, number>> = {};
  let scanned = 0;
  let people = 0;
  let capped = false;
  let after: ObjectId | undefined;
  pages: for (;;) {
    const page = await userSettingsCollection
      .find(
        {
          ...(after ? { _id: { $gt: after } } : {}),
          // Email on, or the bell not switched off (no copy: Socle's defaults,
          // so the bell is on).
          $or: [
            { "notificationChannels.email": true },
            { "notificationChannels.bell": { $ne: false } },
          ],
        },
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
        result = await digestFor(contextFrom(doc.userId, doc, now), socle, opts);
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
  return finish({ status: "done", scanned, outcomes, capped, deletions });
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
    address = await (opts.addressFor ?? accountAddressFor)(userId);
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
  if (address.kind === "none")
    throw new NotificationError("Your account has no email address.", 400);

  const ctx = await loadContext(userId, now);
  if (!(await takeTestSlot(userId, ymdInZone(now, ctx.timeZone), now)))
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
  if (result.kind === "problem" && result.type === "recipient-opted-out") {
    await saveChannelsCopy(userId, { email: false, bell: false }, now).catch(
      () => undefined,
    );
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
  if (retryable(result))
    throw new NotificationError(
      "Email is unavailable right now. Try again in a few minutes.",
      503,
    );
  throw new NotificationError("Socle refused the test email.", 502);
}
