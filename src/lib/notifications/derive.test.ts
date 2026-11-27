import { describe, expect, it } from "vitest";
import {
  deriveNotifications,
  notNowUntil,
  snoozeUntil,
  type DeriveInput,
} from "./derive";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "./types";

const TZ = "America/Toronto";
// Friday 2026-11-27, 10:00 in Toronto (EST, UTC-5).
const NOW = new Date("2026-11-27T15:00:00Z");

function prefs(
  patch: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...patch };
}

function input(patch: Partial<DeriveInput> = {}): DeriveInput {
  return {
    now: NOW,
    tasks: [],
    maintenance: [],
    missedRoutines: [],
    prefs: prefs(),
    timeZone: TZ,
    ...patch,
  };
}

const task = (
  id: string,
  dueDate: string,
  extra: Partial<DeriveInput["tasks"][number]> = {},
) => ({
  _id: id,
  title: `Task ${id}`,
  quadrant: "urgent-important" as const,
  status: "pending",
  dueDate,
  createdAt: "2026-11-01T12:00:00Z",
  ...extra,
});

describe("deriveNotifications in the person's zone", () => {
  it("counts days in Toronto, not UTC", () => {
    // 23:30 on the 26th in Toronto is already the 27th in UTC: it's overdue by one day there.
    const items = deriveNotifications(
      input({ tasks: [task("a", "2026-11-27T04:30:00Z")] }),
    );
    expect(items.map((n) => n.id)).toEqual(["task_overdue:a"]);
    expect(items[0]!.text).toBe("{subject} is 1 day overdue");
    expect(items[0]!.meta).toBe("Do First · was due Thu");
  });

  it("marks a task due later today, with the local time", () => {
    const [n] = deriveNotifications(
      input({ tasks: [task("b", "2026-11-27T19:00:00Z")] }),
    );
    expect(n!.id).toBe("task_due_today:b:2026-11-27");
    expect(n!.text).toBe("{subject} is due today");
    expect(n!.meta).toBe("Do First · 2:00 PM");
    // The start of the person's day, not UTC midnight.
    expect(n!.createdAt).toBe("2026-11-27T05:00:00.000Z");
  });

  it("drops a task once it's done, archived or a subtask", () => {
    const tasks = [
      task("done", "2026-11-20T14:00:00Z", { status: "completed" }),
      task("arch", "2026-11-20T14:00:00Z", {
        archivedAt: "2026-11-21T00:00:00Z",
      }),
      task("sub", "2026-11-20T14:00:00Z", { parentTaskId: "p" }),
    ];
    expect(deriveNotifications(input({ tasks }))).toEqual([]);
  });

  it("gives maintenance its own heads-up: 1 week, or Off", () => {
    const maintenance = [
      { _id: "m1", title: "Doctor", nextDueDate: "2026-12-04" },
    ];
    // Default lead is 2 days: 7 days away is too early.
    expect(deriveNotifications(input({ maintenance }))).toEqual([]);

    const week = deriveNotifications(
      input({ maintenance, itemLeads: { "maintenance:m1": "1_week" } }),
    );
    expect(week.map((n) => n.id)).toEqual([
      "maintenance_upcoming:m1:2026-12-04",
    ]);
    expect(week[0]!.text).toBe("{subject} is due in 7 days");
    expect(week[0]!.meta).toBe("Maintenance · Fri, Dec 4");

    const off = deriveNotifications(
      input({ maintenance, itemLeads: { "maintenance:m1": "off" } }),
    );
    expect(off).toEqual([]);
  });

  it("behaves as before without a zone (the browser)", () => {
    // Tests run with TZ=UTC, so the runtime's zone is UTC.
    const items = deriveNotifications({
      ...input({ tasks: [task("a", "2026-11-27T04:30:00Z")] }),
      timeZone: undefined,
    });
    expect(items.map((n) => n.id)).toEqual(["task_due_today:a:2026-11-27"]);
  });
});

describe("snoozeUntil and Not now, in the person's zone", () => {
  it("later today is 18:00, or three hours once it's evening", () => {
    expect(snoozeUntil("later_today", NOW, TZ).toISOString()).toBe(
      "2026-11-27T23:00:00.000Z",
    );
    const evening = new Date("2026-11-28T00:30:00Z"); // 19:30 in Toronto
    expect(snoozeUntil("later_today", evening, TZ).toISOString()).toBe(
      "2026-11-28T03:30:00.000Z",
    );
  });

  it("tomorrow is 09:00 the next local day", () => {
    expect(snoozeUntil("tomorrow", NOW, TZ).toISOString()).toBe(
      "2026-11-28T14:00:00.000Z",
    );
    // 21:00 on Friday in Toronto is Saturday in UTC: still Saturday 09:00 local.
    expect(
      snoozeUntil(
        "tomorrow",
        new Date("2026-11-28T02:00:00Z"),
        TZ,
      ).toISOString(),
    ).toBe("2026-11-28T14:00:00.000Z");
  });

  it("next week is Monday 09:00, a full week on from a Monday", () => {
    expect(snoozeUntil("next_week", NOW, TZ).toISOString()).toBe(
      "2026-11-30T14:00:00.000Z",
    );
    const monday = new Date("2026-11-30T15:00:00Z");
    expect(snoozeUntil("next_week", monday, TZ).toISOString()).toBe(
      "2026-12-07T14:00:00.000Z",
    );
  });

  it("Not now is tomorrow 09:00, across a DST change too", () => {
    expect(notNowUntil(NOW, TZ).toISOString()).toBe("2026-11-28T14:00:00.000Z");
    // Clocks spring forward on Sunday 2026-03-08: 09:00 EDT is 13:00 UTC.
    expect(
      notNowUntil(new Date("2026-03-07T15:00:00Z"), TZ).toISOString(),
    ).toBe("2026-03-08T13:00:00.000Z");
  });
});
