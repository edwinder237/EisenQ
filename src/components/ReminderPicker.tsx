"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import toast from "react-hot-toast";
import type { NotificationsApi } from "~/lib/notifications/client";
import { REMINDER_LEAD_LABELS, type ItemReminder, type ReminderLead } from "~/lib/notifications/types";

// "Remind me" inside a maintenance item: overrides the default heads-up for
// this one item. Saves on pick, so it works without the editor's Save.

const OPTIONS: (ReminderLead | null)[] = [null, "off", "same_day", "2_days", "1_week"];

export function ReminderPicker({ api, kind, itemId, defaultLabel }: {
  api: NotificationsApi;
  kind: ItemReminder["kind"];
  itemId: string;
  /** Label of the default lead, e.g. "2 days before". */
  defaultLabel: string;
}) {
  const [lead, setLead] = useState<ReminderLead | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    api.getItemReminder(kind, itemId).then((r) => { if (alive) setLead(r.lead); }, () => { if (alive) setLead(null); });
    return () => { alive = false; };
  }, [api, kind, itemId]);

  const pick = async (next: ReminderLead | null) => {
    const prev = lead;
    setLead(next);
    try {
      await api.setItemReminder({ kind, itemId, lead: next });
    } catch (e) {
      setLead(prev);
      toast.error(e instanceof Error ? e.message : "Couldn't save the reminder");
    }
  };

  const label = (o: ReminderLead | null) => (o === null ? `Default (${defaultLabel.toLowerCase()})` : o === "2_days" ? "2 days" : o === "1_week" ? "1 week" : REMINDER_LEAD_LABELS[o]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Bell size={14} style={{ color: "var(--accent)" }} className="mr-0.5" />
      {OPTIONS.map((o) => {
        const active = lead === o;
        return (
          <button key={String(o)} type="button" disabled={lead === undefined} onClick={() => void pick(o)}
            className="text-[12.5px] rounded-[8px] disabled:opacity-50"
            style={{ padding: "6px 12px", fontWeight: active ? 600 : 400, color: active ? "var(--btn-fg)" : "var(--ink3)", background: active ? "var(--pill-active)" : "var(--chip)" }}>
            {label(o)}
          </button>
        );
      })}
    </div>
  );
}
