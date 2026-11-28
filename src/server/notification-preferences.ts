import "server-only";
import type { NotificationPreferences } from "~/lib/notifications/types";
import {
  logNotifications,
  settingsAddressFor,
  type AccountAddress,
} from "~/server/notification-access";
import {
  NotificationError,
  loadContext,
  normalizePreferences,
  preferencesToStore,
  saveChannelsCopy,
  savePreferences,
} from "~/server/notification-service";
import type { SocleChoices, SocleClient, SocleFailure } from "~/server/socle";

// Settings → Notifications (amended design record, point 6). The browser
// calls only EisenQ's own GET and PUT /api/notifications/preferences; EisenQ's
// server asks Socle, with EisenQ's key, for the two switches Socle holds:
// the daily email and the bell. Everything else (the send time, the per-event
// switches, the heads-up) stays in EisenQ's database.
//
// Socle is the source of truth, and an "off" from an email's link wins until
// the person turns email back on here. EisenQ keeps a copy of Socle's last
// answer only to choose whom its daily job considers, whether the bell asks
// for a session, and the bell's footer.

export type Channels = { email: boolean; bell: boolean };

export const channelsFrom = (choices: SocleChoices): Channels => ({
  email: choices.email.enabled,
  bell: choices.in_app.enabled,
});

function withAddress(
  prefs: NotificationPreferences,
  address: AccountAddress | undefined,
): NotificationPreferences {
  if (address?.kind === "verified")
    return { ...prefs, digest: { ...prefs.digest, address: address.email } };
  if (address?.kind === "unverified")
    return { ...prefs, digest: { ...prefs.digest, addressUnverified: true } };
  return prefs;
}

function logFailure(event: string, r: SocleFailure) {
  if (r.kind === "problem")
    logNotifications("warn", event, { status: r.status });
  else logNotifications("warn", event, { unreachable: r.reason });
}

/**
 * The person's preferences, with Socle's email and bell. `cached` reads
 * EisenQ's copy only, with no call to Socle or Clerk: for the bell's footer,
 * which opens often and shouldn't wake Socle's database each time.
 */
export async function readPreferences(
  userId: string,
  socle: SocleClient | null,
  opts: { cached?: boolean; now?: Date } = {},
): Promise<NotificationPreferences> {
  const now = opts.now ?? new Date();
  const ctx = await loadContext(userId, now);
  if (opts.cached) return ctx.prefs;

  const [answer, address] = await Promise.all([
    socle ? socle.lookupPreferences(userId) : Promise.resolve(null),
    settingsAddressFor(userId),
  ]);
  if (answer?.kind !== "ok") {
    if (answer) logFailure("notification_preferences_unavailable", answer);
    // EisenQ's last copy, marked as such: Settings shows it and keeps the two
    // switches still.
    return withAddress({ ...ctx.prefs, channelsUnavailable: true }, address);
  }
  const channels = channelsFrom(answer.choices);
  await saveChannelsCopy(userId, channels, now).catch(() => undefined);
  return withAddress(
    {
      ...ctx.prefs,
      digest: { ...ctx.prefs.digest, enabled: channels.email },
      bell: { enabled: channels.bell },
    },
    address,
  );
}

/**
 * Saves Settings → Notifications. The switches the person changed go to Socle
 * first, and only those, so an "off" from an email's link stays off unless
 * they turn it back on. If Socle can't take them, nothing is saved and the
 * old values stay. Then EisenQ saves its own fields.
 */
export async function writePreferences(
  userId: string,
  next: Omit<NotificationPreferences, "bell"> & {
    bell?: NotificationPreferences["bell"];
  },
  socle: SocleClient | null,
  now = new Date(),
): Promise<NotificationPreferences> {
  const ctx = await loadContext(userId, now);
  const shown = ctx.prefs; // EisenQ's copy: what Settings last showed
  const changes: { email?: boolean; in_app?: boolean } = {};
  if (next.digest.enabled !== shown.digest.enabled)
    changes.email = next.digest.enabled;
  if (next.bell && next.bell.enabled !== shown.bell.enabled)
    changes.in_app = next.bell.enabled;

  let channels: Channels = {
    email: shown.digest.enabled,
    bell: shown.bell.enabled,
  };
  if (changes.email !== undefined || changes.in_app !== undefined) {
    const which = changes.email !== undefined ? "email" : "bell";
    if (!socle)
      throw new NotificationError(
        "Email and bell choices aren't set up for EisenQ yet.",
        503,
      );
    // Consent is recorded only for an address email can actually go to
    // (legal's A1): the account's own, verified.
    if (changes.email === true) {
      const address = await settingsAddressFor(userId);
      if (!address)
        throw new NotificationError(
          "Couldn't check your account's email address. Try again.",
          503,
        );
      if (address.kind !== "verified")
        throw new NotificationError(
          "Verify your account's email address first, then turn the daily email on.",
          400,
        );
    }
    const answer = await socle.setPreferences(userId, changes);
    if (answer.kind !== "ok") {
      logFailure("notification_preferences_not_saved", answer);
      throw new NotificationError(
        `Couldn't save your ${which} choice. Try again.`,
        503,
      );
    }
    channels = channelsFrom(answer.choices);
    await saveChannelsCopy(userId, channels, now).catch(() => undefined);
  }

  await savePreferences(userId, next, now);
  return withAddress(
    normalizePreferences(preferencesToStore(next), {
      ...channels,
      checkedAt: now,
    }),
    await settingsAddressFor(userId),
  );
}
