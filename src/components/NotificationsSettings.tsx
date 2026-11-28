"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { privacyNoticePublished } from "~/lib/privacy-notice";
import type { NotificationsApi } from "~/lib/notifications/client";
import {
  REMINDER_LEAD_LABELS,
  type NotificationEvent,
  type NotificationPreferences,
  type ReminderLead,
} from "~/lib/notifications/types";

// Settings → Notifications. A controlled draft, like AiConnectorsPanel: the
// dashboard holds it and saves it with the rest of Settings on "Save changes".
// The daily email and bell switches are Socle's: EisenQ's server reads and
// writes them there, and this shows what Socle answered, including an email
// turned off from an email's link.

const EVENTS: { id: NotificationEvent; label: string; hint: string }[] = [
  { id: "due", label: "Due today & overdue", hint: "Tasks with a due date" },
  { id: "upcoming", label: "Upcoming maintenance", hint: "Before it comes due" },
  { id: "missed_routines", label: "Missed routines", hint: "When one slips by" },
  { id: "ai_activity", label: "AI app activity", hint: "Claude, ChatGPT, Muse, the extension" },
];

const LEADS: Exclude<ReminderLead, "off">[] = ["same_day", "1_day", "2_days", "1_week"];

export function notificationPrefsEqual(a: NotificationPreferences | null, b: NotificationPreferences | null) {
  if (!a || !b) return a === b;
  // Only what the person can change: not the address, nor whether Socle answered.
  const strip = ({ channelsUnavailable: _unavailable, ...p }: NotificationPreferences) => ({
    ...p,
    digest: { enabled: p.digest.enabled, sendAt: p.digest.sendAt },
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function Switch({ on, onToggle, label, disabled }: { on: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="relative shrink-0 rounded-full disabled:opacity-40"
      style={{ width: 32, height: 18, background: on ? "var(--pill-active)" : "var(--line)" }}
    >
      <span className="absolute rounded-full" style={{ top: 2, left: on ? 16 : 2, width: 14, height: 14, background: "var(--drawer)", transition: "left .15s ease" }} />
    </button>
  );
}

export function NotificationsSettings({ api, draft, onChange }: {
  api: NotificationsApi;
  draft: NotificationPreferences | null;
  onChange: (next: NotificationPreferences) => void;
}) {
  const [sending, setSending] = useState(false);

  if (!draft) {
    return <div className="text-[13px]" style={{ color: "var(--muted)" }}>Loading…</div>;
  }

  const setEvent = (id: NotificationEvent, channel: "inApp" | "email", value: boolean) =>
    onChange({ ...draft, events: { ...draft.events, [id]: { ...draft.events[id], [channel]: value } } });

  const sendTest = async () => {
    setSending(true);
    try {
      const { sentTo } = await api.sendTestEmail();
      toast.success(`Test email sent to ${sentTo}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the test email");
    } finally {
      setSending(false);
    }
  };

  const heading = (title: string, sub?: string) => (
    <div className="mb-3">
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>{title}</div>
      {sub && <div className="text-[12.5px] mt-0.5" style={{ color: "var(--muted)" }}>{sub}</div>}
    </div>
  );
  const box = { background: "var(--field)", border: "1px solid var(--field-bd)" } as const;
  // Socle couldn't be reached: the two switches show EisenQ's last copy and stay still.
  const locked = draft.channelsUnavailable === true;
  // No email can go to an address Clerk hasn't verified, so it can't be turned on.
  const noAddress = draft.digest.addressUnverified === true && !draft.digest.enabled;

  return (
    <div className="flex flex-col gap-7">
      <section>
        {heading("What to tell you about", "In-app shows under the bell right away. Email comes once a day, as one summary.")}
        <div className="rounded-[12px] overflow-hidden" style={box}>
          <div className="flex items-center text-[10.5px] tracking-[0.12em] uppercase" style={{ padding: "9px 14px", color: "var(--muted)" }}>
            <span className="flex-1">Event</span>
            <span className="w-[64px] text-center">In-app</span>
            <span className="w-[64px] text-center">Email</span>
          </div>
          {EVENTS.map((e) => {
            const ch = draft.events[e.id];
            return (
              <div key={e.id} className="flex items-center" style={{ padding: "11px 14px", borderTop: "1px solid var(--line2)" }}>
                <div className="flex-1 min-w-0 pr-2">
                  <div className="text-[13.5px]" style={{ color: "var(--ink)" }}>{e.label}</div>
                  <div className="text-[12px]" style={{ color: "var(--muted)" }}>{e.hint}</div>
                </div>
                <span className="w-[64px] flex justify-center">
                  <Switch on={ch.inApp} onToggle={() => setEvent(e.id, "inApp", !ch.inApp)} label={`${e.label} in the app`} />
                </span>
                <span className="w-[64px] flex justify-center">
                  {ch.email === null
                    ? <span className="text-[12px]" style={{ color: "var(--muted3)" }} title="Not included in the daily email">—</span>
                    : <Switch on={ch.email} disabled={!draft.digest.enabled} onToggle={() => setEvent(e.id, "email", !ch.email)} label={`${e.label} in the daily email`} />}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        {heading("Heads-up for maintenance", "The default. Each item can choose its own in Routines → Maintenance.")}
        <div className="flex flex-wrap gap-1.5">
          {LEADS.map((l) => {
            const active = draft.defaultLead === l;
            return (
              <button key={l} type="button" onClick={() => onChange({ ...draft, defaultLead: l })}
                className="text-[12.5px] rounded-[9px]"
                style={{ padding: "7px 13px", fontWeight: active ? 600 : 400, color: active ? "var(--btn-fg)" : "var(--ink3)", background: active ? "var(--pill-active)" : "var(--chip)" }}>
                {REMINDER_LEAD_LABELS[l]}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        {heading("Daily email", "Skipped on days with nothing to report.")}
        <div className="rounded-[12px] flex flex-wrap items-center gap-x-3 gap-y-2" style={{ ...box, padding: "11px 14px" }}>
          <label className="flex items-center gap-2 text-[13.5px]" style={{ color: "var(--ink)" }}>
            Send at
            <input
              type="time"
              value={draft.digest.sendAt}
              disabled={!draft.digest.enabled}
              onChange={(e) => e.target.value && onChange({ ...draft, digest: { ...draft.digest, sendAt: e.target.value } })}
              className="rounded-[8px] text-[13px] outline-none disabled:opacity-50"
              style={{ padding: "4px 8px", background: "var(--drawer)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
            />
          </label>
          <span className="flex-1 min-w-0 truncate text-[12.5px]" style={{ color: "var(--muted)" }}>
            {draft.digest.address
              ? `to ${draft.digest.address}`
              : draft.digest.addressUnverified
                ? "Verify your account email to get it"
                : "to your account email"}
          </span>
          <button type="button" onClick={() => void sendTest()} disabled={sending || !draft.digest.enabled || !draft.digest.address}
            className="text-[12.5px] disabled:opacity-50" style={{ color: "var(--accent)" }}>
            {sending ? "Sending…" : "Send a test"}
          </button>
          <Switch on={draft.digest.enabled} disabled={locked || noAddress} onToggle={() => onChange({ ...draft, digest: { ...draft.digest, enabled: !draft.digest.enabled } })} label="Daily email" />
        </div>
      </section>

      <section>
        {heading("Bell notices", "One-off notices in the bell, such as a copy of the daily summary. Your reminders show either way.")}
        <div className="rounded-[12px] flex items-center gap-3" style={{ ...box, padding: "11px 14px" }}>
          <span className="flex-1 min-w-0 text-[13.5px]" style={{ color: "var(--ink)" }}>Show notices in the bell</span>
          <Switch on={draft.bell.enabled} disabled={locked} onToggle={() => onChange({ ...draft, bell: { enabled: !draft.bell.enabled } })} label="Bell notices" />
        </div>
        {locked && (
          <div className="text-[12px] mt-2" style={{ color: "var(--muted)" }}>
            Couldn&apos;t load your email and bell choices just now, so they can&apos;t be changed. Try again later.
          </div>
        )}
        {/* Only once the notice has its contact address (~/lib/privacy-notice.ts). */}
        {privacyNoticePublished() && (
          <p className="text-[12px] mt-3" style={{ color: "var(--muted)" }}>
            The daily email and bell notices are optional, and you can turn them off here at any time.{" "}
            <a href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: "var(--accent)" }}>Privacy notice</a>
          </p>
        )}
      </section>
    </div>
  );
}
