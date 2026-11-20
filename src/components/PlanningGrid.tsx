"use client";

// Time-grid view for the Task Planning drawer: one or two days side by side,
// calendar events and timed tasks drawn as blocks. Click a free slot to pick a
// task for it (ranked suggestions first); drag a task to move it, drag its
// bottom edge to change its length.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { addMinutes, differenceInMinutes, endOfDay, format, isSameDay, isToday, startOfDay } from "date-fns";
import { Calendar, Plus, Search, Sparkles, X } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  DEFAULT_DURATION,
  formatMinutes,
  isSchedulable,
  rankTasks,
  type PlanGoal,
  type PlanTask,
  type Suggestion,
} from "~/lib/plan-suggestions";

export interface GridEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
}

interface Props<T extends PlanTask> {
  days: Date[];
  events: GridEvent[];
  tasks: T[];
  goals: PlanGoal[];
  loading?: boolean;
  onSchedule: (task: T, start: Date, duration: number) => void | Promise<void>;
  onOpenTask: (task: T) => void;
  onCreateAt: (start: Date) => void;
}

const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
const SLOT_MIN = 30;
const SNAP_MIN = 15;
const DAY_MIN = 24 * 60;
const GUTTER_PX = 52;
const SCROLL_TO_HOUR = 7;

const QUADRANT_STYLE: Record<PlanTask["quadrant"], string> = {
  "urgent-important": "bg-red-500/15 border-red-500",
  "important-not-urgent": "bg-yellow-500/15 border-yellow-500",
  "urgent-not-important": "bg-blue-500/15 border-blue-500",
  "not-urgent-not-important": "bg-green-500/15 border-green-500",
};

interface Block<T> {
  key: string;
  kind: "event" | "task";
  title: string;
  sub?: string;
  startMin: number; // minutes from midnight, clipped to the day
  endMin: number;
  task?: T;
  completed?: boolean;
  quadrant?: PlanTask["quadrant"];
  lane: number;
  lanes: number;
}

interface Drag {
  taskId: string;
  mode: "move" | "resize";
  pointerX: number;
  pointerY: number;
  origDay: number;
  origStart: number;
  origDuration: number;
  day: number;
  start: number;
  duration: number;
  moved: boolean;
}

interface Picker {
  day: number;
  minute: number;
}

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Assign side-by-side lanes to overlapping blocks. */
function layoutLanes<T>(blocks: Omit<Block<T>, "lane" | "lanes">[]): Block<T>[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Block<T>[] = [];
  let cluster: Block<T>[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((b) => b.lane + 1));
    cluster.forEach((b) => (b.lanes = lanes));
    out.push(...cluster);
    cluster = [];
  };
  for (const b of sorted) {
    if (b.startMin >= clusterEnd && cluster.length) flush();
    const laneEnds: number[] = [];
    cluster.forEach((c) => (laneEnds[c.lane] = Math.max(laneEnds[c.lane] ?? 0, c.endMin)));
    let lane = laneEnds.findIndex((end) => end <= b.startMin);
    if (lane === -1) lane = laneEnds.length;
    cluster.push({ ...b, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function PlanningGrid<T extends PlanTask>({
  days,
  events,
  tasks,
  goals,
  loading,
  onSchedule,
  onOpenTask,
  onCreateAt,
}: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => new Date());

  const dayKey = days.map((d) => d.toDateString()).join("|");

  // Open at the start of the working day, and on day change.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_PX;
    setPicker(null);
  }, [dayKey]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Close the picker on outside click
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPicker(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picker]);

  const allDayByDay = useMemo(
    () =>
      days.map((day) =>
        events.filter((ev) => {
          if (!ev.allDay) return false;
          const s = new Date(ev.start).getTime();
          const e = new Date(ev.end).getTime();
          return s <= endOfDay(day).getTime() && e > startOfDay(day).getTime();
        }),
      ),
    [days, events],
  );

  const blocksByDay = useMemo(
    () =>
      days.map((day) => {
        const dayStart = startOfDay(day);
        const raw: Omit<Block<T>, "lane" | "lanes">[] = [];
        for (const ev of events) {
          if (ev.allDay) continue;
          const s = new Date(ev.start);
          const e = new Date(ev.end);
          if (e <= dayStart || s > endOfDay(day)) continue;
          const startMin = Math.max(0, differenceInMinutes(s, dayStart));
          const endMin = Math.min(DAY_MIN, differenceInMinutes(e, dayStart));
          raw.push({
            key: `ev-${ev.id}-${day.toDateString()}`,
            kind: "event",
            title: ev.title,
            sub: ev.calendar,
            startMin,
            endMin: Math.max(endMin, startMin + 15),
          });
        }
        for (const task of tasks) {
          if (!task.dueDate || task.archivedAt || task.parentTaskId) continue;
          const s = new Date(task.dueDate);
          if (!isSameDay(s, day)) continue;
          const startMin = minutesOfDay(s);
          const len = task.duration ?? DEFAULT_DURATION;
          raw.push({
            key: `task-${task._id}`,
            kind: "task",
            title: task.title,
            startMin,
            endMin: Math.min(DAY_MIN, startMin + Math.max(len, 15)),
            task,
            completed: task.status === "completed",
            quadrant: task.quadrant,
          });
        }
        return layoutLanes(raw);
      }),
    [days, events, tasks],
  );

  // ----- picker -----

  const pickerStart = picker ? addMinutes(startOfDay(days[picker.day]!), picker.minute) : null;

  const freeMinutes = useMemo(() => {
    if (!picker) return 0;
    let free = DAY_MIN - picker.minute;
    for (const b of blocksByDay[picker.day] ?? []) {
      if (b.completed) continue;
      if (b.startMin <= picker.minute && b.endMin > picker.minute) return 0;
      if (b.startMin > picker.minute) free = Math.min(free, b.startMin - picker.minute);
    }
    return free;
  }, [picker, blocksByDay]);

  const { suggested, schedule, doFirst } = useMemo(() => {
    if (!pickerStart) return { suggested: [], schedule: [], doFirst: [] };
    // Already placed on a visible day? It is on the grid; don't offer it again.
    const candidates = tasks.filter(
      (t) => isSchedulable(t) && !(t.dueDate && days.some((d) => isSameDay(new Date(t.dueDate!), d))),
    );
    const q = query.trim().toLowerCase();
    const matches = (s: Suggestion) => !q || s.task.title.toLowerCase().includes(q);
    const ranked = rankTasks(candidates, pickerStart, freeMinutes, goals, now);
    const q2 = ranked.filter((s) => s.task.quadrant === "important-not-urgent");
    const top = q ? [] : q2.filter((s) => s.fits).slice(0, 3);
    const topIds = new Set(top.map((s) => s.task._id));
    return {
      suggested: top,
      schedule: q2.filter((s) => !topIds.has(s.task._id) && matches(s)),
      doFirst: ranked.filter((s) => s.task.quadrant === "urgent-important" && matches(s)),
    };
    // pickerStart is derived from picker + days
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, dayKey, tasks, goals, freeMinutes, query, now]);

  const openPicker = (day: number, minute: number) => {
    setQuery("");
    setPicker({ day, minute });
  };

  const choose = (s: Suggestion) => {
    if (!pickerStart) return;
    void onSchedule(s.task as T, pickerStart, s.task.duration ?? DEFAULT_DURATION);
    setPicker(null);
  };

  // ----- drag to move / resize -----

  const columnWidth = () => {
    const el = columnsRef.current;
    return el ? el.getBoundingClientRect().width / days.length : 1;
  };

  const beginDrag = (e: ReactPointerEvent, block: Block<T>, dayIndex: number, mode: Drag["mode"]) => {
    if (!block.task || block.completed) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPicker(null);
    setDrag({
      taskId: block.task._id,
      mode,
      pointerX: e.clientX,
      pointerY: e.clientY,
      origDay: dayIndex,
      origStart: block.startMin,
      origDuration: block.endMin - block.startMin,
      day: dayIndex,
      start: block.startMin,
      duration: block.endMin - block.startMin,
      moved: false,
    });
  };

  const onDragMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.pointerX;
    const dy = e.clientY - drag.pointerY;
    const moved = drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4;
    const dMin = Math.round(dy / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
    if (drag.mode === "resize") {
      const duration = Math.max(15, Math.min(DAY_MIN - drag.origStart, drag.origDuration + dMin));
      setDrag({ ...drag, moved, duration });
    } else {
      const dDay = Math.round(dx / columnWidth());
      const day = Math.max(0, Math.min(days.length - 1, drag.origDay + dDay));
      const start = Math.max(0, Math.min(DAY_MIN - drag.duration, drag.origStart + dMin));
      setDrag({ ...drag, moved, day, start });
    }
  };

  const endDrag = (block: Block<T>) => {
    if (!drag || !block.task) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) {
      onOpenTask(block.task);
      return;
    }
    if (d.day === d.origDay && d.start === d.origStart && d.duration === d.origDuration) return;
    void onSchedule(block.task, addMinutes(startOfDay(days[d.day]!), d.start), d.duration);
  };

  // ----- render -----

  const hasAllDay = allDayByDay.some((list) => list.length > 0);
  const twoCols = days.length > 1;

  return (
    <div className="rounded-lg border border-[var(--drawer-bd)] overflow-hidden select-none">
      {/* Day headers */}
      <div className="flex border-b border-[var(--drawer-bd)] bg-[var(--drawer)]">
        <div style={{ width: GUTTER_PX }} className="shrink-0" />
        {days.map((day) => (
          <div key={day.toDateString()} className="flex-1 py-2 text-center border-l border-[var(--drawer-bd)]">
            <div className={cn("text-[11px] uppercase tracking-[0.08em]", isToday(day) ? "text-[var(--accent)]" : "text-[var(--muted)]")}>
              {format(day, "EEE")}
            </div>
            <div className={cn("text-lg font-semibold leading-tight", isToday(day) && "text-[var(--accent)]")}>
              {format(day, "d")}
            </div>
          </div>
        ))}
      </div>

      {/* All-day strip */}
      {hasAllDay && (
        <div className="flex border-b border-[var(--drawer-bd)]">
          <div style={{ width: GUTTER_PX }} className="shrink-0 text-[10px] text-[var(--muted)] text-right pr-2 pt-1.5">all-day</div>
          {allDayByDay.map((list, i) => (
            <div key={i} className="flex-1 border-l border-[var(--drawer-bd)] p-1 space-y-1 min-w-0">
              {list.map((ev) => (
                <div key={ev.id} className="text-xs truncate px-2 py-0.5 rounded bg-[#7f6a45]/25 text-[var(--ink)]" title={ev.title}>
                  {ev.title}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Time grid */}
      <div ref={scrollRef} className="relative overflow-y-auto" style={{ height: "calc(100vh - 380px)", minHeight: 320 }}>
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          {/* Hour gutter */}
          <div style={{ width: GUTTER_PX }} className="shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-[var(--muted)] -translate-y-1/2" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : format(new Date(2000, 0, 1, h), "h a")}
              </div>
            ))}
          </div>

          <div ref={columnsRef} className="flex-1 flex relative">
            {days.map((day, di) => {
              const today = isToday(day);
              const nowMin = minutesOfDay(now);
              return (
                <div key={day.toDateString()} className="flex-1 relative border-l border-[var(--drawer-bd)] min-w-0">
                  {/* Clickable slots */}
                  {Array.from({ length: DAY_MIN / SLOT_MIN }, (_, i) => {
                    const minute = i * SLOT_MIN;
                    const past = today ? minute + SLOT_MIN <= nowMin : day < startOfDay(now);
                    const active = picker?.day === di && picker.minute === minute;
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-label={`Plan ${format(addMinutes(startOfDay(day), minute), "EEE h:mm a")}`}
                        onClick={() => openPicker(di, minute)}
                        className={cn(
                          "absolute inset-x-0 group",
                          i % 2 === 0 ? "border-t border-[var(--drawer-bd)]" : "border-t border-dashed border-[var(--drawer-bd)]/50",
                          past && "bg-[var(--tint)]/60",
                          active ? "bg-[var(--accent)]/20" : "hover:bg-[var(--hover)]",
                        )}
                        style={{ top: minute * PX_PER_MIN, height: SLOT_MIN * PX_PER_MIN }}
                      >
                        <span className="hidden group-hover:flex items-center gap-1 pl-2 text-[11px] text-[var(--muted)]">
                          <Plus className="w-3 h-3" />
                          {format(addMinutes(startOfDay(day), minute), "h:mm")}
                        </span>
                      </button>
                    );
                  })}

                  {/* Blocks */}
                  {blocksByDay[di]!.map((b) => {
                    const dragging = !!(drag && b.task && drag.taskId === b.task._id);
                    // Dragged to the other day: leave a faint copy here. It must stay
                    // mounted, since it holds the pointer capture.
                    const leftBehind = dragging && drag.day !== di;
                    const live = dragging && !leftBehind;
                    const startMin = live ? drag.start : b.startMin;
                    const len = live ? drag.duration : b.endMin - b.startMin;
                    const width = 100 / b.lanes;
                    const short = len < 45;
                    return (
                      <div
                        key={b.key}
                        onPointerDown={(e) => b.kind === "task" && beginDrag(e, b, di, "move")}
                        onPointerMove={onDragMove}
                        onPointerUp={() => endDrag(b)}
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "absolute rounded-md border-l-[3px] px-1.5 py-0.5 overflow-hidden text-xs",
                          b.kind === "event"
                            ? "bg-[#7f6a45]/25 border-[var(--accent)] pointer-events-none"
                            : cn(QUADRANT_STYLE[b.quadrant!], b.completed ? "opacity-50 cursor-pointer" : "cursor-grab active:cursor-grabbing"),
                          live && "z-20 shadow-lg ring-1 ring-[var(--accent)]",
                          leftBehind && "opacity-30",
                        )}
                        style={{
                          top: startMin * PX_PER_MIN + 1,
                          height: Math.max(len * PX_PER_MIN - 2, 14),
                          left: `calc(${b.lane * width}% + 2px)`,
                          width: `calc(${width}% - 4px)`,
                          touchAction: "none",
                        }}
                        title={b.title}
                      >
                        <div className={cn("font-medium truncate flex items-center gap-1", b.completed && "line-through")}>
                          {b.kind === "event" && <Calendar className="w-3 h-3 shrink-0 text-[var(--accent)]" />}
                          <span className="truncate">{b.title}</span>
                          {short && (
                            <span className="text-[10px] text-[var(--muted)] shrink-0">
                              {format(addMinutes(startOfDay(day), startMin), "H:mm")}
                            </span>
                          )}
                        </div>
                        {!short && (
                          <div className="text-[10px] text-[var(--muted)] truncate">
                            {format(addMinutes(startOfDay(day), startMin), "H:mm")}–
                            {format(addMinutes(startOfDay(day), startMin + len), "H:mm")}
                            {b.sub ? ` · ${b.sub}` : ""}
                          </div>
                        )}
                        {b.kind === "task" && !b.completed && (
                          <div
                            onPointerDown={(e) => beginDrag(e, b, di, "resize")}
                            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                            style={{ touchAction: "none" }}
                          />
                        )}
                      </div>
                    );
                  })}

                  {/* Block being dragged in from the other day */}
                  {drag && drag.day === di && drag.day !== drag.origDay && (() => {
                    const src = blocksByDay[drag.origDay]!.find((b) => b.task?._id === drag.taskId);
                    if (!src) return null;
                    return (
                      <div
                        className={cn("absolute rounded-md border-l-[3px] px-1.5 py-0.5 text-xs z-20 shadow-lg ring-1 ring-[var(--accent)] pointer-events-none", QUADRANT_STYLE[src.quadrant!])}
                        style={{ top: drag.start * PX_PER_MIN + 1, height: drag.duration * PX_PER_MIN - 2, left: 2, right: 2 }}
                      >
                        <div className="font-medium truncate">{src.title}</div>
                      </div>
                    );
                  })()}

                  {/* Now line */}
                  {today && (
                    <div className="absolute inset-x-0 z-10 pointer-events-none" style={{ top: nowMin * PX_PER_MIN }}>
                      <div className="h-px bg-red-500" />
                      <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Slot picker */}
            {picker && pickerStart && (
              <div
                ref={pickerRef}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setPicker(null);
                  }
                }}
                className="absolute z-30 w-[320px] max-w-[calc(100%-8px)] rounded-lg border border-[var(--drawer-bd)] bg-[var(--drawer)] shadow-2xl text-sm"
                style={{
                  ...(picker.minute > 15 * 60
                    ? { bottom: (DAY_MIN - picker.minute) * PX_PER_MIN + 4 }
                    : { top: (picker.minute + SLOT_MIN) * PX_PER_MIN + 4 }),
                  ...(twoCols && picker.day === days.length - 1 ? { right: 4 } : { left: twoCols ? 4 : 8 }),
                }}
              >
                <div className="flex items-start justify-between px-3 pt-3 pb-2 border-b border-[var(--drawer-bd)]">
                  <div>
                    <div className="font-semibold">{format(pickerStart, "EEE h:mm a")}</div>
                    <div className="text-xs text-[var(--muted)]">
                      {freeMinutes > 0 ? `${formatMinutes(freeMinutes)} free` : "Overlaps something already booked"}
                    </div>
                  </div>
                  <button type="button" onClick={() => setPicker(null)} className="p-1 rounded hover:bg-[var(--hover)] text-[var(--ink3)]" aria-label="Close">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="max-h-[340px] overflow-y-auto py-1">
                  {suggested.length > 0 && (
                    <Section title="Suggested" icon={<Sparkles className="w-3 h-3" />}>
                      {suggested.map((s) => <Row key={s.task._id} s={s} onPick={choose} highlight />)}
                    </Section>
                  )}

                  <div className="px-3 py-2">
                    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-[var(--field)] border border-[var(--field-bd)]">
                      <Search className="w-3.5 h-3.5 text-[var(--muted)]" />
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search tasks"
                        className="flex-1 bg-transparent outline-none text-sm"
                      />
                    </div>
                  </div>

                  {schedule.length > 0 && (
                    <Section title="Schedule">
                      {schedule.map((s) => <Row key={s.task._id} s={s} onPick={choose} />)}
                    </Section>
                  )}
                  {doFirst.length > 0 && (
                    <Section title="Do First">
                      {doFirst.map((s) => <Row key={s.task._id} s={s} onPick={choose} />)}
                    </Section>
                  )}
                  {suggested.length + schedule.length + doFirst.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-[var(--muted)]">
                      {query ? "No matching tasks" : "Nothing left to schedule"}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    onCreateAt(pickerStart);
                    setPicker(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 border-t border-[var(--drawer-bd)] text-[var(--accent)] font-medium hover:bg-[var(--hover)]"
                >
                  <Plus className="w-4 h-4" />
                  New task at {format(pickerStart, "h:mm a")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {loading && <div className="h-0.5 bg-[var(--accent)]/60 animate-pulse" />}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] flex items-center gap-1">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ s, onPick, highlight }: { s: Suggestion; onPick: (s: Suggestion) => void; highlight?: boolean }) {
  const moving = s.task.dueDate ? `Moves from ${format(new Date(s.task.dueDate), "EEE MMM d, H:mm")}` : null;
  return (
    <button
      type="button"
      onClick={() => onPick(s)}
      className={cn(
        "w-full text-left px-3 py-2 hover:bg-[var(--hover)] flex flex-col gap-1",
        !s.fits && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            s.task.quadrant === "urgent-important" ? "bg-red-500" : "bg-yellow-500",
          )}
        />
        <span className={cn("truncate", highlight && "font-medium")}>{s.task.title}</span>
      </div>
      <div className="flex flex-wrap gap-1 pl-3.5">
        {s.reasons.map((r) => (
          <span
            key={r}
            className={cn(
              "text-[10px] px-1.5 py-px rounded",
              r.startsWith("Needs") ? "bg-red-500/15 text-red-400" : "bg-[var(--chip)] text-[var(--muted5)]",
            )}
          >
            {r}
          </span>
        ))}
        {moving && <span className="text-[10px] px-1.5 py-px rounded text-[var(--muted)]">{moving}</span>}
      </div>
    </button>
  );
}
