"use client";

// Socle bell. Source: edwinder237/socle, packages/bell. Apps copy it with
// scripts/vendor.ts and never edit their copy: changes go through Socle.
//
// Marc's bell from EisenQ (src/components/NotificationBell.tsx), moved into
// Socle almost line for line (amended design record,
// docs/decisions/2026-11-27-eisenq-notifications-amended-design.md, point 1):
// the "Needs you" and "FYI" groups, the rows, the ⋯ menu, swipe on a phone,
// Undo, the popover and bottom sheet, the 60-second refresh and the footer.
// One list and one unread count, from two feeds:
// - the app's own reminders, through `reminders` (EisenQ's NotificationsApi);
// - notices sent through Socle, which the adapter fetches on load, when the
//   panel opens and every 5 minutes, with no live connection, and only once
//   the app's own route has answered with a session (controller.ts).
// The provider's mark never appears: the bell draws every pixel itself.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import toast from "react-hot-toast";
import {
  AlertCircle, Bell, CalendarClock, CheckCircle2, Clock, EyeOff, MoreHorizontal, RotateCcw, Sparkles, Wrench, X,
} from "lucide-react";
import { NOTICE_POLL_MS, REMINDER_POLL_MS, bellActions, createNoticeSource } from "./controller";
import type { NoticeSource } from "./controller";
import { badge, groups, mergeFeeds, unreadCount } from "./feed";
import { noticeItem } from "./notices";
import { snoozeUntil, whenLabel } from "./snooze";
import { themeStyle, v } from "./theme";
import type { BellAction, BellItem, BellLabels, BellTarget, SnoozeOption, SocleBellProps } from "./types";

export const DEFAULT_LABELS: BellLabels = {
  title: "Notifications",
  bellButton: "Notifications",
  bellButtonUnread: (count) => `Notifications, ${count} unread`,
  markAllRead: "Mark all read",
  needsYou: (count) => `Needs you · ${count}`,
  fyi: "FYI",
  clearAll: "Clear all",
  loading: "Loading…",
  unavailable: "Notifications aren't available right now.",
  caughtUp: "You're all caught up.",
  caughtUpHint: "Due dates, upcoming maintenance and AI activity show up here.",
  open: "Open",
  more: "More",
  notNow: "Not now",
  dismiss: "Dismiss",
  snooze: "Snooze",
  snoozeOptions: { later_today: "Later today", tomorrow: "Tomorrow", next_week: "Next week" },
  markDone: "Mark task done",
  stopReminding: "Stop reminding me",
  settings: "Settings ›",
  undo: "Undo",
  dismissed: "Dismissed",
  hiddenUntilTomorrow: "Hidden until tomorrow",
  snoozedUntil: (when) => `Snoozed until ${when}`,
  wontRemind: "Won't remind you again",
  updateFailed: "Couldn't update that notification",
  undoFailed: "Couldn't undo",
  markReadFailed: "Couldn't mark them read",
  clearFailed: "Couldn't clear them",
};

const ICON: Record<string, ReactNode> = {
  task_overdue: <AlertCircle size={15} />,
  task_due_today: <CalendarClock size={15} />,
  maintenance_upcoming: <Wrench size={15} />,
  maintenance_overdue: <Wrench size={15} />,
  routine_missed: <RotateCcw size={15} />,
  ai_activity: <Sparkles size={15} />,
  notice: <Bell size={15} />,
};

const TONE: Record<NonNullable<BellItem["tone"]>, string> = {
  "do-first": v("doFirst"),
  schedule: v("schedule"),
  delegate: v("delegate"),
  eliminate: v("eliminate"),
  accent: v("accent"),
  muted: v("muted3"),
};

const SNOOZE: SnoozeOption[] = ["later_today", "tomorrow", "next_week"];

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

function Sentence({ n }: { n: BellItem }) {
  const [before, after] = n.text.split("{subject}");
  return <>{before}<b className="font-semibold">{n.subject}</b>{after}</>;
}

export function SocleBell(props: SocleBellProps) {
  const { sessionUrl, reminders, refreshKey, onOpen, onMarkDone, onOpenSettings, footer, onOpenChange, appearance } = props;
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...props.labels }), [props.labels]);
  const pollMs = props.pollMs ?? REMINDER_POLL_MS;
  const theme = useMemo(() => themeStyle(appearance), [appearance]);
  const notices = useMemo<NoticeSource>(() => createNoticeSource({ sessionUrl: sessionUrl ?? null }), [sessionUrl]);
  const actions = useMemo(() => bellActions(reminders, notices), [reminders, notices]);

  const [open, setOpenState] = useState(false);
  const [reminderItems, setReminderItems] = useState<BellItem[] | null>(reminders ? null : []);
  const [noticeItems, setNoticeItems] = useState<BellItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isPhone = useIsPhone();
  const rootRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback((next: boolean | ((was: boolean) => boolean)) => {
    setOpenState((was) => {
      const value = typeof next === "function" ? next(was) : next;
      if (value !== was) onOpenChange?.(value);
      return value;
    });
  }, [onOpenChange]);

  const refreshReminders = useCallback(async () => {
    if (!reminders) return;
    try {
      const list = await reminders.list();
      setReminderItems(list.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load notifications");
    }
  }, [reminders]);

  // Notices never block the reminders: if they can't be reached, the bell
  // shows the reminders alone.
  const refreshNotices = useCallback(async () => {
    try {
      const feed = await notices.feed();
      setNoticeItems(feed ? (await feed.list()).map((notice) => noticeItem(notice, (d) => whenLabel(d))) : []);
    } catch {
      /* keep the last notices */
    }
  }, [notices]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshReminders(), refreshNotices()]);
  }, [refreshReminders, refreshNotices]);

  useEffect(() => { void refreshReminders(); }, [refreshReminders, refreshKey]);
  useEffect(() => { void refreshNotices(); }, [refreshNotices]);
  useEffect(() => {
    const id = setInterval(() => void refreshReminders(), pollMs);
    return () => clearInterval(id);
  }, [refreshReminders, pollMs]);
  useEffect(() => {
    const id = setInterval(() => void refreshNotices(), NOTICE_POLL_MS);
    return () => clearInterval(id);
  }, [refreshNotices]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

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
  }, [open, isPhone, setOpen]);

  const items = reminderItems === null ? null : mergeFeeds(reminderItems, noticeItems);

  // Optimistic: drop it from its list now, tell its feed, offer Undo.
  const without = (n: BellItem) => (prev: BellItem[] | null) => prev?.filter((x) => x.id !== n.id) ?? prev;
  const hide = async (n: BellItem, action: BellAction, message: string) => {
    setReminderItems(without(n));
    setNoticeItems((prev) => without(n)(prev) ?? prev);
    try {
      await actions.act(n, action);
    } catch {
      toast.error(labels.updateFailed);
      void refresh();
      return;
    }
    toast((t) => (
      <span data-notif-keep className="flex items-center gap-4 text-[13.5px]" style={theme}>
        <span>{message} · <b>{n.subject}</b></span>
        <button
          className="font-semibold"
          style={{ color: v("accent") }}
          onClick={() => {
            toast.dismiss(t.id);
            void actions.act(n, { action: "restore" }).then(refresh, () => toast.error(labels.undoFailed));
          }}
        >
          {labels.undo}
        </button>
      </span>
    ), { duration: 5000 });
  };

  const dismiss = (n: BellItem) => hide(n, { action: "dismiss" }, n.group === "fyi" ? labels.dismissed : labels.hiddenUntilTomorrow);
  const snooze = (n: BellItem, option: SnoozeOption) =>
    hide(n, { action: "snooze", option }, labels.snoozedUntil(whenLabel(snoozeUntil(option, new Date()))));
  const mute = (n: BellItem) => hide(n, { action: "mute" }, labels.wontRemind);

  const openItem = (n: BellItem) => {
    if (!n.readAt) {
      const read = (prev: BellItem[] | null) => prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? prev;
      setReminderItems(read);
      setNoticeItems((prev) => read(prev) ?? prev);
      void actions.act(n, { action: "read" }).catch(() => undefined);
    }
    if (n.target.type !== "none") {
      setOpen(false);
      onOpen(n.target);
    }
  };

  const markAllRead = async () => {
    const read = (prev: BellItem[] | null) => prev?.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })) ?? prev;
    setReminderItems(read);
    setNoticeItems((prev) => read(prev) ?? prev);
    try { await actions.markAllRead(); } catch { toast.error(labels.markReadFailed); void refresh(); }
  };
  const clearFyi = async () => {
    const before = { reminders: reminderItems, notices: noticeItems };
    setReminderItems((prev) => prev?.filter((x) => x.group !== "fyi") ?? prev);
    setNoticeItems([]);
    try {
      await actions.clearFyi();
    } catch {
      toast.error(labels.clearFailed);
      setReminderItems(before.reminders);
      setNoticeItems(before.notices);
    }
  };

  const markDoneFor = (n: BellItem): (() => void) | undefined => {
    if (n.target.type !== "task" || !onMarkDone) return undefined;
    const target: BellTarget = n.target;
    return () => { setReminderItems(without(n)); onMarkDone(target); };
  };

  return (
    <BellView
      rootRef={rootRef}
      theme={theme}
      labels={labels}
      open={open}
      isPhone={isPhone}
      items={items}
      error={error}
      footer={footer}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      onOpenSettings={onOpenSettings ? () => { setOpen(false); onOpenSettings(); } : undefined}
      onMarkAllRead={() => void markAllRead()}
      onClearFyi={() => void clearFyi()}
      row={(n) => (
        <NotificationRow
          key={n.id}
          n={n}
          swipe={isPhone}
          labels={labels}
          theme={theme}
          onOpen={() => openItem(n)}
          onDismiss={() => void dismiss(n)}
          onSnooze={(o) => void snooze(n, o)}
          onMute={() => void mute(n)}
          onMarkDone={markDoneFor(n)}
        />
      )}
    />
  );
}

// The button and the panel, drawn from the state above. Exported for the
// tests, which render it on the server.
export function BellView(p: {
  rootRef?: React.RefObject<HTMLDivElement | null>;
  theme: CSSProperties;
  labels: BellLabels;
  open: boolean;
  isPhone: boolean;
  items: BellItem[] | null;
  error: string | null;
  footer?: ReactNode;
  onToggle: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  onMarkAllRead: () => void;
  onClearFyi: () => void;
  row: (n: BellItem) => ReactNode;
}) {
  const { labels, items, error, isPhone } = p;
  const unread = unreadCount(items ?? []);
  const { needs, fyi } = groups(items ?? []);

  const groupLabel = (text: string, right?: ReactNode) => (
    <div className="flex items-center justify-between" style={{ padding: "12px 16px 6px" }}>
      <span className="text-[10.5px] tracking-[0.14em] uppercase" style={{ color: v("muted") }}>{text}</span>
      {right}
    </div>
  );

  const panel = (
    <div
      role="dialog"
      aria-label={labels.title}
      className="flex flex-col overflow-hidden"
      style={{
        background: v("drawer"),
        border: `1px solid ${v("drawerBorder")}`,
        boxShadow: "0 24px 60px rgba(0,0,0,.35)",
        color: v("ink"),
        ...(isPhone
          ? { borderRadius: "18px 18px 0 0", maxHeight: "82vh", width: "100%" }
          : { borderRadius: "var(--sb-radius)", width: 400, maxHeight: "min(640px, 80vh)" }),
      }}
    >
      {isPhone && <div className="mx-auto mt-2 rounded-full" style={{ width: 40, height: 4, background: v("muted3") }} />}
      <div className="shrink-0 flex items-center justify-between" style={{ padding: "14px 16px 6px" }}>
        <div className="text-[19px]" style={{ fontFamily: "var(--sb-title-font)" }}>{labels.title}</div>
        {unread > 0 && (
          <button onClick={p.onMarkAllRead} className="text-[12.5px] hover:underline" style={{ color: v("ink3") }}>{labels.markAllRead}</button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="text-[13px]" style={{ padding: "18px 16px", color: v("muted") }}>
            {labels.unavailable}
          </div>
        )}
        {!error && items === null && (
          <div className="text-[13px]" style={{ padding: "18px 16px", color: v("muted") }}>{labels.loading}</div>
        )}
        {!error && items?.length === 0 && (
          <div className="flex flex-col items-center gap-2 text-center" style={{ padding: "34px 16px 38px" }}>
            <CheckCircle2 size={22} style={{ color: v("accent") }} />
            <div className="text-[14px]" style={{ color: v("ink2") }}>{labels.caughtUp}</div>
            <div className="text-[12.5px]" style={{ color: v("muted") }}>{labels.caughtUpHint}</div>
          </div>
        )}
        {needs.length > 0 && (
          <div>
            {groupLabel(labels.needsYou(needs.length))}
            {needs.map(p.row)}
          </div>
        )}
        {fyi.length > 0 && (
          <div>
            {groupLabel(labels.fyi, (
              <button onClick={p.onClearFyi} className="text-[12px] hover:underline" style={{ color: v("ink3") }}>{labels.clearAll}</button>
            ))}
            {fyi.map(p.row)}
          </div>
        )}
      </div>

      {(p.footer !== undefined || p.onOpenSettings) && (
        <div className="shrink-0 flex items-center justify-between text-[12.5px]" style={{ padding: "11px 16px", borderTop: `1px solid ${v("line")}`, color: v("muted") }}>
          <span>{p.footer}</span>
          {p.onOpenSettings && (
            <button onClick={p.onOpenSettings} className="hover:underline" style={{ color: v("ink3") }}>{labels.settings}</button>
          )}
        </div>
      )}
    </div>
  );

  const count = badge(unread);
  return (
    <div ref={p.rootRef} className="relative" style={p.theme}>
      <button
        className="navbtn relative"
        onClick={p.onToggle}
        title={labels.bellButton}
        aria-label={unread ? labels.bellButtonUnread(unread) : labels.bellButton}
        aria-expanded={p.open}
        style={p.open ? { borderColor: v("accent") } : undefined}
      >
        <Bell className="w-[17px] h-[17px]" />
        {count && (
          <span
            className="absolute grid place-items-center rounded-full text-[10px] font-bold tabular-nums"
            style={{ top: -5, right: -5, minWidth: 18, height: 18, padding: "0 4px", background: v("accent"), color: v("accentText"), border: `2px solid ${v("background")}` }}
          >
            {count}
          </span>
        )}
      </button>

      {p.open && !isPhone && <div className="absolute right-0 z-[60]" style={{ top: "calc(100% + 10px)" }}>{panel}</div>}
      {p.open && isPhone && (
        <>
          <div className="fixed inset-0 z-[60]" style={{ background: v("overlay") }} onClick={p.onClose} />
          <div className="fixed inset-x-0 bottom-0 z-[61]">{panel}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- row -----

const ACTION_W = 84;

export function NotificationRow({ n, swipe, labels, theme, onOpen, onDismiss, onSnooze, onMute, onMarkDone }: {
  n: BellItem;
  swipe: boolean;
  labels: BellLabels;
  theme: CSSProperties;
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
      style={{ width: 28, height: 28, background: v("chip"), color: v("ink3") }}
    >
      {child}
    </button>
  );

  const body = (
    <div
      className="group relative flex items-start gap-3 cursor-pointer select-none hover:bg-[var(--sb-hover)]"
      style={{ padding: "12px 16px", background: menuOpen ? v("hover") : v("drawer"), transform: `translateX(${dx}px)`, transition: drag.current ? "none" : "transform .18s ease", touchAction: "pan-y" } as CSSProperties}
      // React bubbles clicks from the portalled row menu up to here; only a
      // click that physically landed on the row opens it.
      onClick={swipe ? undefined : (e) => { if (e.currentTarget.contains(e.target as Node)) onOpen(); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { drag.current = null; setDx(0); }}
    >
      <span className="shrink-0 mt-0.5 grid place-items-center rounded-full" style={{ width: 28, height: 28, background: v("chip"), color: TONE[n.tone ?? "muted"] }}>
        {ICON[n.kind] ?? ICON.notice}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] leading-snug break-words" style={{ color: n.readAt ? v("ink3") : v("ink") }}><Sentence n={n} /></div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px]" style={{ color: v("muted") }}>
          <span>{n.meta}</span>
          {n.target.type !== "none" && <><span>·</span><span className="font-medium" style={{ color: v("accent") }}>{labels.open}</span></>}
        </div>
      </div>

      {/* Desktop: unread dot, swapped for actions on hover / keyboard focus. */}
      {!swipe && (
        <div className="shrink-0 flex items-center gap-1">
          <span className={menuOpen ? "hidden" : "group-hover:hidden group-focus-within:hidden"}>
            {!n.readAt ? <span className="block mt-2 rounded-full" style={{ width: 7, height: 7, background: v("accent") }} /> : <span className="block" style={{ width: 7 }} />}
          </span>
          <span className={menuOpen ? "flex gap-1" : "hidden group-hover:flex group-focus-within:flex gap-1"}>
            {needs && (
              <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  {iconBtn(labels.more, <MoreHorizontal size={15} />)}
                </DropdownMenu.Trigger>
                <RowMenu labels={labels} theme={theme} onSnooze={onSnooze} onMute={onMute} onMarkDone={onMarkDone} />
              </DropdownMenu.Root>
            )}
            {iconBtn(needs ? labels.notNow : labels.dismiss, <X size={15} />, onDismiss)}
          </span>
        </div>
      )}
      {swipe && !n.readAt && <span className="shrink-0 mt-2 rounded-full" style={{ width: 7, height: 7, background: v("accent") }} />}
    </div>
  );

  if (!swipe) return <div style={{ borderTop: `1px solid ${v("line")}` }}>{body}</div>;

  const action = (label: string, icon: ReactNode, bg: string, onClick: () => void) => (
    <button type="button" onClick={() => { setDx(0); onClick(); }}
      className="flex flex-col items-center justify-center gap-1 text-[11.5px] font-medium"
      style={{ width: ACTION_W, background: bg, color: "#fff" }}>
      {icon}{label}
    </button>
  );

  return (
    <div className="relative overflow-hidden" style={{ borderTop: `1px solid ${v("line")}` }}>
      <div className="absolute inset-y-0 right-0 flex">
        {needs && (
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="flex flex-col items-center justify-center gap-1 text-[11.5px] font-medium" style={{ width: ACTION_W, background: "#6b5a3a", color: "#fff" }}>
                <Clock size={16} />{labels.snooze}
              </button>
            </DropdownMenu.Trigger>
            <RowMenu labels={labels} theme={theme} onSnooze={(o) => { setDx(0); onSnooze(o); }} onMute={() => { setDx(0); onMute(); }} onMarkDone={onMarkDone && (() => { setDx(0); onMarkDone(); })} />
          </DropdownMenu.Root>
        )}
        {action(needs ? labels.notNow : labels.dismiss, <X size={16} />, needs ? "#4a4336" : "#7a2e2e", onDismiss)}
      </div>
      {body}
    </div>
  );
}

function RowMenu({ labels, theme, onSnooze, onMute, onMarkDone }: { labels: BellLabels; theme: CSSProperties; onSnooze: (o: SnoozeOption) => void; onMute: () => void; onMarkDone?: () => void }) {
  const item = "flex items-center gap-2 outline-none cursor-pointer data-[highlighted]:bg-[var(--sb-hover)]";
  const now = new Date();
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        data-notif-keep
        align="end"
        sideOffset={6}
        className="z-[80] rounded-[12px] overflow-hidden text-[13px]"
        style={{ ...theme, width: 220, background: v("drawer"), border: `1px solid ${v("drawerBorder")}`, boxShadow: "0 16px 40px rgba(0,0,0,.4)", color: v("ink2") }}
      >
        <DropdownMenu.Label className="text-[10.5px] tracking-[0.14em] uppercase" style={{ padding: "10px 14px 4px", color: v("muted") }}>{labels.snooze}</DropdownMenu.Label>
        {SNOOZE.map((option) => (
          <DropdownMenu.Item key={option} onSelect={() => onSnooze(option)} className={item} style={{ padding: "8px 14px" }}>
            <Clock size={14} style={{ color: v("muted3") }} />
            <span className="flex-1">{labels.snoozeOptions[option]}</span>
            <span className="text-[11.5px]" style={{ color: v("muted") }}>{whenLabel(snoozeUntil(option, now))}</span>
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Separator style={{ height: 1, background: v("line") }} />
        {onMarkDone && (
          <DropdownMenu.Item onSelect={onMarkDone} className={item} style={{ padding: "9px 14px" }}>
            <CheckCircle2 size={14} style={{ color: v("accent") }} />{labels.markDone}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Item onSelect={onMute} className={item} style={{ padding: "9px 14px" }}>
          <EyeOff size={14} style={{ color: v("muted3") }} />{labels.stopReminding}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
