// Request validation for /api/notifications/*, mirroring ./types.ts. Shared so
// the backend validates exactly what the client sends.

import { z } from "zod";

export const reminderLeadSchema = z.enum(["off", "same_day", "1_day", "2_days", "1_week"]);
export const snoozeOptionSchema = z.enum(["later_today", "tomorrow", "next_week"]);

/** PATCH /api/notifications/:id */
export const notificationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }),
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("snooze"), option: snoozeOptionSchema }),
  z.object({ action: z.literal("mute") }),
  z.object({ action: z.literal("restore") }),
]);

/** POST /api/notifications */
export const bulkActionSchema = z.object({ action: z.enum(["read_all", "clear_fyi"]) });

const channel = (emailable: boolean) =>
  z.object({ inApp: z.boolean(), email: emailable ? z.boolean() : z.null() });

/** PUT /api/notifications/preferences */
export const preferencesSchema = z.object({
  events: z.object({
    due: channel(true),
    upcoming: channel(true),
    missed_routines: channel(true),
    ai_activity: channel(false),
  }),
  defaultLead: reminderLeadSchema.exclude(["off"]),
  digest: z.object({
    enabled: z.boolean(),
    sendAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
    address: z.string().optional(), // ignored on write: always the account email
    addressUnverified: z.boolean().optional(), // ignored on write
  }),
  // Optional, so a page loaded before the bell switch existed can still save.
  bell: z.object({ enabled: z.boolean() }).optional(),
  channelsUnavailable: z.boolean().optional(), // ignored on write
});

/** PUT /api/notifications/reminders */
export const itemReminderSchema = z.object({
  kind: z.enum(["maintenance", "routine"]),
  itemId: z.string().min(1),
  lead: reminderLeadSchema.nullable(),
});
