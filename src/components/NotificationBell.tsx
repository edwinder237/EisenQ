"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import toast from "react-hot-toast";
import {
  AlertCircle, Bell, CalendarClock, CheckCircle2, Clock, EyeOff, MoreHorizontal, RotateCcw, Sparkles, Wrench, X,
} from "lucide-react";
import type { NotificationAction, NotificationsApi } from "~/lib/notifications/client";
import { snoozeUntil } from "~/lib/notifications/derive";
import type { AppNotification, NotificationTarget, SnoozeOption } from "~/lib/notifications/types";

// The bell in the dashboard header, and its panel: a popover on desktop, a
// bottom sheet on a phone. Two groups: "Needs you" (comes back until handled)
// and "FYI" (gone once dismissed). See docs/notifications/README.md.

interface Props {
  api: NotificationsApi;
  /** Anything that changes when tasks or routines change; triggers a refresh. */
  refreshKey?: unknown;
  onOpen: (target: NotificationTarget) => void;
  onMarkTaskDone: (taskId: string) => void;
  onOpenSettings: () => void;
}

const ICON: Record<AppNotification["kind"], ReactNode> = {
  task_overdue: <AlertCircle size={15} />,
  task_due_today: <CalendarClock size={15} />,
  maintenance_upcoming: <Wrench size={15} />,
  maintenance_overdue: <Wrench size={15} />,
  routine_missed: <RotateCcw size={15} />,
  ai_activity: <Sparkles size={15} />,
};

const TONE: Record<NonNullable<AppNotification["tone"]>, string> = {
  "do-first": "var(--q-do-first)",
  schedule: "var(--q-schedule)",
  delegate: "var(--q-delegate)",
  eliminate: "var(--q-eliminate)",
  accent: "var(--accent)",
  muted: "var(--muted3)",
};

const SNOOZE: { option: SnoozeOption; label: string }[] = [
  { option: "later_today", label: "Later today" },
  { option: "tomorrow", label: "Tomorrow" },
  { option: "next_week", label: "Next week" },
];

const POLL_MS = 60_000;

function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const set = () => setPhone(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);
  return phone;
}

function Sentence({ n }: { n: AppNotification }) {
  const [before, after] = n.text.split("{subject}");
  return <>{before}<b className="font-semibold">{n.subject}</b>{after}</>;
}

function whenLabel(d: Date) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? t : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${t}`;
}

export function NotificationBell({ api, refreshKey, onOpen, onMarkTaskDone, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digestAt, setDigestAt] = useState<string | null>(null);
  const isPhone = useIsPhone();
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.list();
      setItems(list.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load notifications");
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    api.getPreferences().then((p) => setDigestAt(p.digest.enabled ? p.digest.sendAt : null)).catch(() => setDigestAt(null));
  }, [open, api, refresh]);

  // Close on outside click (desktop) and Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (isPhone) return;
      const t = e.target as HTMLElement;
      // The row menu and the Undo toast live outside the panel in the DOM.
      if (rootRef.current?.contains(t) || t.closest("[data-notif-keep]")) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open, isPhone]);

  const unread = (items ?? []).filter((n) => !n.readAt).length;
  const needs = (items ?? []).filter((n) => n.group === "needs");
  const fyi = (items ?? []).filter((n) => n.group === "fyi");

  // Optimistic: drop it from the list now, tell the server, offer Undo.
  const hide = async (n: AppNotification, action: NotificationAction, message: string) => {
    setItems((prev) => prev?.filter((x) => x.id !== n.id) ?? prev);
    try {
      await api.act(n.id, action);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update that notification");
      void refresh();
      return;
    }
    toast((t) => (
      <span data-notif-keep className="flex items-center gap-4 text-[13.5px]">
        <span>{message} · <b>{n.subject}</b></span>
        <button
          className="font-semibold"
          style={{ color: "var(--accent)" }}
          onClick={() => {
            toast.dismiss(t.id);
            void api.act(n.id, { action: "restore" }).then(refresh, () => toast.error("Couldn't undo"));
          }}
        >
          Undo
        </button>
      </span>
    ), { duration: 5000 });
  };

  const dismiss = (n: AppNotification) =>
    hide(n, { action: "dismiss" }, n.group === "fyi" ? "Dismissed" : "Hidden until tomorrow");
  const snooze = (n: AppNotification, option: SnoozeOption) =>
    hide(n, { action: "snooze", option }, `Snoozed until ${whenLabel(snoozeUntil(option, new Date()))}`);
  const mute = (n: AppNotification) => hide(n, { action: "mute" }, "Won't remind you again");

  const openItem = (n: AppNotification) => {
    if (!n.readAt) {
      setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? prev);
      void api.act(n.id, { action: "read" }).catch(() => undefined);
    }
    if (n.target.type !== "none") {
      setOpen(false);
      onOpen(n.target);
    }
  };

  const markAllRead = async () => {
    setItems((prev) => prev?.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })) ?? prev);
    try { await api.markAllRead(); } catch { toast.error("Couldn't mark them read"); void refresh(); }
  };
  const clearFyi = async () => {
    const before = items;
    setItems((prev) => prev?.filter((x) => x.group !== "fyi") ?? prev);
    try { await api.clearFyi(); } catch { toast.error("Couldn't clear them"); setItems(before); }
  };

  const row = (n: AppNotification) => (
    <NotificationRow
      key={n.id}
      n={n}
      swipe={isPhone}
      onOpen={() => openItem(n)}
      onDismiss={() => void dismiss(n)}
      onSnooze={(o) => void snooze(n, o)}
      onMute={() => void mute(n)}
      onMarkDone={n.target.type === "task" ? () => { const id = n.target.type === "task" ? n.target.id : ""; setItems((p) => p?.filter((x) => x.id !== n.id) ?? p); onMarkTaskDone(id); } : undefined}
    />
  );

  const groupLabel = (text: string, right?: ReactNode) => (
    <div className="flex items-center justify-between" style={{ padding: "12px 16px 6px" }}>
      <span className="text-[10.5px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>{text}</span>
      {right}
    </div>
  );

  const panel = (
    <div
      role="dialog"
      aria-label="Notifications"
      className="flex flex-col overflow-hidden"
      style={{
        background: "var(--drawer)",
        border: "1px solid var(--drawer-bd)",
        boxShadow: "0 24px 60px rgba(0,0,0,.35)",
        color: "var(--ink)",
        ...(isPhone
          ? { borderRadius: "18px 18px 0 0", maxHeight: "82vh", width: "100%" }
          : { borderRadius: 16, width: 400, maxHeight: "min(640px, 80vh)" }),
      }}
    >
      {isPhone && <div className="mx-auto mt-2 rounded-full" style={{ width: 40, height: 4, background: "var(--muted3)" }} />}
      <div className="shrink-0 flex items-center justify-between" style={{ padding: "14px 16px 6px" }}>
        <div className="text-[19px]" style={{ fontFamily: "var(--font-serif)" }}>Notifications</div>
        {unread > 0 && (
          <button onClick={() => void markAllRead()} className="text-[12.5px] hover:underline" style={{ color: "var(--ink3)" }}>Mark all read</button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="text-[13px]" style={{ padding: "18px 16px", color: "var(--muted)" }}>
            Notifications aren&apos;t available right now.
          </div>
        )}
        {!error && items === null && (
          <div className="text-[13px]" style={{ padding: "18px 16px", color: "var(--muted)" }}>Loading…</div>
        )}
        {!error && items?.length === 0 && (
          <div className="flex flex-col items-center gap-2 text-center" style={{ padding: "34px 16px 38px" }}>
            <CheckCircle2 size={22} style={{ color: "var(--accent)" }} />
            <div className="text-[14px]" style={{ color: "var(--ink2)" }}>You&apos;re all caught up.</div>
            <div className="text-[12.5px]" style={{ color: "var(--muted)" }}>Due dates, upcoming maintenance and AI activity show up here.</div>
          </div>
        )}
        {needs.length > 0 && (
          <div>
            {groupLabel(`Needs you · ${needs.length}`)}
            {needs.map(row)}
          </div>
        )}
        {fyi.length > 0 && (
          <div>
            {groupLabel("FYI", (
              <button onClick={() => void clearFyi()} className="text-[12px] hover:underline" style={{ color: "var(--ink3)" }}>Clear all</button>
            ))}
            {fyi.map(row)}
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center justify-between text-[12.5px]" style={{ padding: "11px 16px", borderTop: "1px solid var(--line2)", color: "var(--muted)" }}>
        <span>{digestAt ? `Daily email at ${formatHm(digestAt)}` : "Daily email is off"}</span>
        <button onClick={() => { setOpen(false); onOpenSettings(); }} className="hover:underline" style={{ color: "var(--ink3)" }}>Settings ›</button>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        className="navbtn relative"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        style={open ? { borderColor: "var(--accent)" } : undefined}
      >
        <Bell className="w-[17px] h-[17px]" />
        {unread > 0 && (
          <span
            className="absolute grid place-items-center rounded-full text-[10px] font-bold tabular-nums"
            style={{ top: -5, right: -5, minWidth: 18, height: 18, padding: "0 4px", background: "var(--accent)", color: "var(--btn-fg)", border: "2px solid var(--bg)" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && !isPhone && <div className="absolute right-0 z-[60]" style={{ top: "calc(100% + 10px)" }}>{panel}</div>}
      {open && isPhone && (
        <>
          <div className="fixed inset-0 z-[60]" style={{ background: "var(--overlay)" }} onClick={() => setOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 z-[61]">{panel}</div>
        </>
      )}
    </div>
  );
}

function formatHm(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 7, m ?? 0, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------- row -----

const ACTION_W = 84;

function NotificationRow({ n, swipe, onOpen, onDismiss, onSnooze, onMute, onMarkDone }: {
  n: AppNotification;
  swipe: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onSnooze: (o: SnoozeOption) => void;
  onMute: () => void;
  onMarkDone?: () => void;
}) {
  const needs = n.group === "needs";
  const reveal = needs ? ACTION_W * 2 : ACTION_W;
  const [dx, setDx] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const drag = useRef<{ x: number; y: number; start: number; moved: boolean } | null>(null);

  // Swipe left on touch to reveal Snooze / Not now (or Dismiss for FYI).
  const onPointerDown = (e: React.PointerEvent) => {
    if (!swipe || e.pointerType === "mouse") return;
    drag.current = { x: e.clientX, y: e.clientY, start: dx, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    if (!d.moved && Math.abs(e.clientY - d.y) > Math.abs(mx)) { drag.current = null; return; }
    if (Math.abs(mx) > 6) d.moved = true;
    setDx(Math.max(-reveal - 24, Math.min(0, d.start + mx)));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { if (dx !== 0) setDx(0); else onOpen(); return; }
    setDx(dx < -reveal / 2 ? -reveal : 0);
  };

  const iconBtn = (label: string, child: ReactNode, onClick?: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      className="grid place-items-center rounded-[8px]"
      style={{ width: 28, height: 28, background: "var(--chip)", color: "var(--ink3)" }}
    >
      {child}
    </button>
  );

  const body = (
    <div
      className="group relative flex items-start gap-3 cursor-pointer select-none hover:bg-[var(--hover)]"
      style={{ padding: "12px 16px", background: menuOpen ? "var(--hover)" : "var(--drawer)", transform: `translateX(${dx}px)`, transition: drag.current ? "none" : "transform .18s ease", touchAction: "pan-y" } as CSSProperties}
      // React bubbles clicks from the portalled row menu up to here; only a
      // click that physically landed on the row opens it.
      onClick={swipe ? undefined : (e) => { if (e.currentTarget.contains(e.target as Node)) onOpen(); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; setDx(0); }}
    >
      <span className="shrink-0 mt-0.5 grid place-items-center rounded-full" style={{ width: 28, height: 28, background: "var(--chip)", color: TONE[n.tone ?? "muted"] }}>
        {ICON[n.kind]}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] leading-snug break-words" style={{ color: n.readAt ? "var(--ink3)" : "var(--ink)" }}><Sentence n={n} /></div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px]" style={{ color: "var(--muted)" }}>
          <span>{n.meta}</span>
          {n.target.type !== "none" && <><span>·</span><span className="font-medium" style={{ color: "var(--accent)" }}>Open</span></>}
        </div>
      </div>

      {/* Desktop: unread dot, swapped for actions on hover / keyboard focus. */}
      {!swipe && (
        <div className="shrink-0 flex items-center gap-1">
          <span className={menuOpen ? "hidden" : "group-hover:hidden group-focus-within:hidden"}>
            {!n.readAt ? <span className="block mt-2 rounded-full" style={{ width: 7, height: 7, background: "var(--accent)" }} /> : <span className="block" style={{ width: 7 }} />}
          </span>
          <span className={menuOpen ? "flex gap-1" : "hidden group-hover:flex group-focus-within:flex gap-1"}>
            {needs && (
              <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  {iconBtn("More", <MoreHorizontal size={15} />)}
                </DropdownMenu.Trigger>
                <RowMenu onSnooze={onSnooze} onMute={onMute} onMarkDone={onMarkDone} />
              </DropdownMenu.Root>
            )}
            {iconBtn(needs ? "Not now" : "Dismiss", <X size={15} />, onDismiss)}
          </span>
        </div>
      )}
      {swipe && !n.readAt && <span className="shrink-0 mt-2 rounded-full" style={{ width: 7, height: 7, background: "var(--accent)" }} />}
    </div>
  );

  if (!swipe) return <div style={{ borderTop: "1px solid var(--line2)" }}>{body}</div>;

  const action = (label: string, icon: ReactNode, bg: string, onClick: () => void) => (
    <button type="button" onClick={() => { setDx(0); onClick(); }}
      className="flex flex-col items-center justify-center gap-1 text-[11.5px] font-medium"
      style={{ width: ACTION_W, background: bg, color: "#fff" }}>
      {icon}{label}
    </button>
  );

  return (
    <div className="relative overflow-hidden" style={{ borderTop: "1px solid var(--line2)" }}>
      <div className="absolute inset-y-0 right-0 flex">
        {needs && (
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="flex flex-col items-center justify-center gap-1 text-[11.5px] font-medium" style={{ width: ACTION_W, background: "#6b5a3a", color: "#fff" }}>
                <Clock size={16} />Snooze
              </button>
            </DropdownMenu.Trigger>
            <RowMenu onSnooze={(o) => { setDx(0); onSnooze(o); }} onMute={() => { setDx(0); onMute(); }} onMarkDone={onMarkDone && (() => { setDx(0); onMarkDone(); })} />
          </DropdownMenu.Root>
        )}
        {action(needs ? "Not now" : "Dismiss", <X size={16} />, needs ? "#4a4336" : "#7a2e2e", onDismiss)}
      </div>
      {body}
    </div>
  );
}

function RowMenu({ onSnooze, onMute, onMarkDone }: { onSnooze: (o: SnoozeOption) => void; onMute: () => void; onMarkDone?: () => void }) {
  const item = "flex items-center gap-2 outline-none cursor-pointer data-[highlighted]:bg-[var(--hover)]";
  const now = new Date();
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        data-notif-keep
        align="end"
        sideOffset={6}
        className="z-[80] rounded-[12px] overflow-hidden text-[13px]"
        style={{ width: 220, background: "var(--drawer)", border: "1px solid var(--drawer-bd)", boxShadow: "0 16px 40px rgba(0,0,0,.4)", color: "var(--ink2)" }}
      >
        <DropdownMenu.Label className="text-[10.5px] tracking-[0.14em] uppercase" style={{ padding: "10px 14px 4px", color: "var(--muted)" }}>Snooze</DropdownMenu.Label>
        {SNOOZE.map((s) => (
          <DropdownMenu.Item key={s.option} onSelect={() => onSnooze(s.option)} className={item} style={{ padding: "8px 14px" }}>
            <Clock size={14} style={{ color: "var(--muted3)" }} />
            <span className="flex-1">{s.label}</span>
            <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>{whenLabel(snoozeUntil(s.option, now))}</span>
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Separator style={{ height: 1, background: "var(--line2)" }} />
        {onMarkDone && (
          <DropdownMenu.Item onSelect={onMarkDone} className={item} style={{ padding: "9px 14px" }}>
            <CheckCircle2 size={14} style={{ color: "var(--accent)" }} />Mark task done
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Item onSelect={onMute} className={item} style={{ padding: "9px 14px" }}>
          <EyeOff size={14} style={{ color: "var(--muted3)" }} />Stop reminding me
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
