"use client";

// The Delegate quadrant. Closed, it reads like the other three quadrants (a
// "Next action" headline over an "Up next" list); tapping a task opens its
// hand-off panel: who has it, the relay of step chips, and actions.
//
// Handing a task to Assistant is real: it fires the person's Claude Code
// routine (see ~/server/assistant-routine), which reports back through the
// EisenQ connector; this card polls while it works. Handing to a household
// member is still a prototype kept in localStorage (~/lib/delegate-prototype).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { format, startOfDay } from "date-fns";
import { Check, ChevronDown, ChevronRight, ExternalLink, FlaskConical, Loader2, Sparkles } from "lucide-react";
import { LinkifiedText } from "~/components/LinkifiedText";
import toast from "react-hot-toast";
import { cn } from "~/lib/utils";
import {
  HELPERS,
  SAMPLE_PREFIX,
  buildRelay,
  currentChip,
  delegationFromRun,
  helper,
  latestLine,
  loadDelegations,
  nameOf,
  relaySteps,
  sampleData,
  saveDelegations,
  type AssistantRunView,
  type Delegation,
  type Delegations,
  type HandOffMode,
  type HelperId,
  type RelayChip,
  type RelayTask,
  type Who,
} from "~/lib/delegate-prototype";

const MENU_CLS = "min-w-[196px] max-w-[300px] rounded-[12px] p-1.5 shadow-lg z-[200] bg-[var(--drawer)] border border-[var(--drawer-bd)]";
const MENU_ITEM = "flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] data-[highlighted]:bg-[var(--hover)] text-[var(--ink2)]";
const MENU_LABEL = "px-3 pt-1.5 pb-1 text-[10.5px] tracking-[0.12em] uppercase text-[var(--muted5)]";

interface Props {
  tasks: RelayTask[];
  meta: { name: string; subtitle: string; color: string; index: string; emptyTitle: string; emptySub: string };
  quickValue: string;
  onQuickChange: (value: string) => void;
  onQuickAdd: () => void;
  onOpenTask: (taskId: string) => void;
  onToggleStep: (taskId: string, checklistId: string, stepId: string) => void;
  onCompleteTask: (taskId: string) => void;
  /** Merge server changes to a task (its Assistant hand-off, its checklists) into the dashboard. */
  onTaskPatch: (taskId: string, patch: Partial<RelayTask>) => void;
}

interface RoutineStatus { connected: boolean; triggerId?: string }

interface Item {
  task: RelayTask;
  delegation?: Delegation;
  chips: RelayChip[];
  /** Who holds it right now: "you" when it waits on you, undefined when no one has it. */
  holder?: Who;
  /** Set when the task is really handed to the Assistant (not a prototype hand-off). */
  run?: AssistantRunView;
}

export function DelegateQuadrant(props: Props) {
  const { tasks, meta } = props;
  const [delegations, setDelegations] = useState<Delegations>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [samples, setSamples] = useState<RelayTask[] | null>(null);
  const [routine, setRoutine] = useState<RoutineStatus | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // A hand-off waiting on the routine being connected, fired right after it is.
  const pendingRef = useRef<{ taskId: string; mode: HandOffMode } | null>(null);

  // Read after mount: the dashboard is server-rendered first, where there is no storage.
  useEffect(() => setDelegations(loadDelegations()), []);

  useEffect(() => {
    fetch("/api/settings/assistant-routine")
      .then((r) => (r.ok ? (r.json() as Promise<RoutineStatus>) : null))
      .then((s) => s && setRoutine(s))
      .catch(() => undefined);
  }, []);

  // Latest props for the polling loop, so it needn't restart on every render.
  const latest = useRef(props);
  latest.current = props;

  // While the Assistant works on something, check back every 15 s and on focus.
  const workingIds = tasks.filter((t) => t.assistantRun?.status === "working").map((t) => t._id).join(",");
  useEffect(() => {
    if (!workingIds) return;
    const ids = workingIds.split(",");
    const poll = async () => {
      for (const id of ids) {
        try {
          const res = await fetch(`/api/tasks/${id}/assistant`, { cache: "no-store" });
          if (!res.ok) continue;
          const data = (await res.json()) as { assistantRun: AssistantRunView | null; checklists: RelayTask["checklists"] };
          if (data.assistantRun?.status === "working") continue;
          latest.current.onTaskPatch(id, { assistantRun: data.assistantRun, checklists: data.checklists });
          const title = latest.current.tasks.find((t) => t._id === id)?.title ?? "a task";
          if (data.assistantRun?.status === "done") toast.success(`Assistant finished “${title}”`);
          else if (data.assistantRun?.status === "blocked") toast(`Assistant needs you on “${title}”`);
        } catch {
          // offline for a moment: try again next round
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 15_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [workingIds]);

  const update = (fn: (prev: Delegations) => Delegations) =>
    setDelegations((prev) => {
      const next = fn(prev);
      saveDelegations(next);
      return next;
    });

  const isSample = (task: RelayTask) => task._id.startsWith(SAMPLE_PREFIX);

  // Same order idea as the other quadrants: what needs you first, then what
  // others are carrying, then what nobody has yet. Within each, incoming order.
  const items = useMemo(() => {
    const you: Item[] = [];
    const them: Item[] = [];
    const none: Item[] = [];
    for (const task of [...(samples ?? []), ...tasks]) {
      const run = !isSample(task) && task.assistantRun ? task.assistantRun : undefined;
      let delegation = run ? delegationFromRun(task, run) : delegations[task._id];
      // A prototype hand-off to Assistant on a real task, from before it was real: not a hand-off.
      if (!run && delegation?.to === "assistant" && !isSample(task)) delegation = undefined;
      if (!delegation) {
        none.push({ task, chips: [] });
        continue;
      }
      const chips = buildRelay(task, delegation);
      let holder = currentChip(chips)?.who ?? delegation.to;
      // The Assistant reported back but its step is next: it waits on you to send it back.
      if (run && run.status !== "working" && holder === "assistant") holder = "you";
      (holder === "you" ? you : them).push({ task, delegation, chips, holder, run });
    }
    return [...you, ...them, ...none];
  }, [samples, tasks, delegations]);

  // ===== actions =====

  const forgetLocal = (taskId: string) =>
    update((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });

  /** Hand a real task to the Assistant: fires the Claude routine. */
  const fireAssistant = async (task: RelayTask, mode: HandOffMode) => {
    if (busy) return;
    const stepOwners = task.assistantRun?.stepOwners ?? delegations[task._id]?.stepOwners ?? {};
    setBusy(task._id);
    try {
      const res = await fetch(`/api/tasks/${task._id}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, stepOwners }),
      });
      const data = (await res.json().catch(() => ({}))) as { assistantRun?: AssistantRunView; error?: string; code?: string };
      if (!res.ok || !data.assistantRun) {
        if (data.code === "no_routine") {
          setRoutine({ connected: false });
          pendingRef.current = { taskId: task._id, mode };
          setConnectOpen(true);
          toast("Connect your Claude routine first, and the task goes straight to it.");
        } else {
          toast.error(data.error ?? "Couldn't hand it to the Assistant.");
        }
        return;
      }
      forgetLocal(task._id);
      props.onTaskPatch(task._id, { assistantRun: data.assistantRun });
      toast.success("Handed to Assistant. Claude is starting on it.");
    } catch {
      toast.error("Couldn't reach EisenQ. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const onRoutineConnected = (status: RoutineStatus) => {
    setRoutine(status);
    setConnectOpen(false);
    const pending = pendingRef.current;
    pendingRef.current = null;
    const task = pending && tasks.find((t) => t._id === pending.taskId);
    if (task && pending) void fireAssistant(task, pending.mode);
    else toast.success("Claude routine connected");
  };

  const disconnectRoutine = async () => {
    const res = await fetch("/api/settings/assistant-routine", { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setRoutine({ connected: false });
      toast("Claude routine disconnected");
    }
  };

  const handOff = (task: RelayTask, to: HelperId, mode: HandOffMode) => {
    if (to === "assistant" && !isSample(task)) {
      void fireAssistant(task, mode);
      return;
    }
    update((prev) => ({ ...prev, [task._id]: { to, mode, stepOwners: {}, at: new Date().toISOString() } }));
    toast.success(`Handed to ${helper(to).name}`);
  };

  const takeBack = async (task: RelayTask) => {
    if (task.assistantRun && !isSample(task)) {
      const res = await fetch(`/api/tasks/${task._id}/assistant`, { method: "DELETE" }).catch(() => null);
      if (!res?.ok) {
        toast.error("Couldn't take it back. Try again.");
        return;
      }
      props.onTaskPatch(task._id, { assistantRun: null });
    }
    forgetLocal(task._id);
    toast(`Took back “${task.title}”`);
  };

  const setOwner = (task: RelayTask, stepId: string, who: Who) => {
    const run = !isSample(task) ? task.assistantRun : undefined;
    if (run) {
      const stepOwners = { ...run.stepOwners, [stepId]: who };
      props.onTaskPatch(task._id, { assistantRun: { ...run, stepOwners } });
      void fetch(`/api/tasks/${task._id}/assistant`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepOwners }),
      }).then((r) => { if (!r.ok) toast.error("Couldn't save who does that step."); }).catch(() => undefined);
      return;
    }
    update((prev) => {
      const d = prev[task._id];
      return d ? { ...prev, [task._id]: { ...d, stepOwners: { ...d.stepOwners, [stepId]: who } } } : prev;
    });
  };

  const tick = (task: RelayTask, chip: RelayChip) => {
    if (!chip.checklistId || !chip.stepId) return;
    if (isSample(task)) {
      const nowIso = new Date().toISOString();
      setSamples((prev) => prev?.map((t) => t._id !== task._id ? t : {
        ...t,
        checklists: t.checklists?.map((c) => c.id !== chip.checklistId ? c : {
          ...c,
          steps: c.steps.map((s) => s.id === chip.stepId ? { ...s, done: !s.done, doneAt: s.done ? undefined : nowIso } : s),
        }),
      }) ?? null);
      return;
    }
    props.onToggleStep(task._id, chip.checklistId, chip.stepId);
  };

  const complete = (task: RelayTask) => {
    forgetLocal(task._id);
    if (openId === task._id) setOpenId(null);
    if (isSample(task)) {
      setSamples((prev) => prev?.filter((t) => t._id !== task._id) ?? null);
      toast.success("Done");
      return;
    }
    props.onCompleteTask(task._id);
  };

  // Stand in for the helper, so the hand-back can be felt without real accounts.
  const simulateDone = (task: RelayTask, chip: RelayChip) => {
    if (chip.stepId) tick(task, chip);
    else update((prev) => ({ ...prev, [task._id]: { ...prev[task._id]!, outcomeDone: true } }));
  };

  const simulatePass = (task: RelayTask, chip: RelayChip) =>
    update((prev) => ({ ...prev, [task._id]: { ...prev[task._id]!, passed: { label: chip.label, by: chip.who as HelperId } } }));

  const openTask = (task: RelayTask) => {
    if (isSample(task)) toast("Sample task: it only exists in this quadrant.");
    else props.onOpenTask(task._id);
  };

  const toggleOpen = (id: string) => setOpenId((prev) => (prev === id ? null : id));

  const toggleSamples = () => {
    if (samples) {
      setSamples(null);
      return;
    }
    const data = sampleData();
    setSamples(data.tasks);
    setDelegations((prev) => ({ ...prev, ...data.delegations }));
  };

  // ===== closed view: same look as the other quadrants =====

  const dueLabel = (task: RelayTask) => {
    if (!task.dueDate) return null;
    const overdue = new Date(task.dueDate) < startOfDay(new Date());
    return { text: format(new Date(task.dueDate), "MMM d"), overdue };
  };

  /** The one quiet extra on a closed row: who has the task. */
  const holderMark = (item: Item) => {
    if (item.holder === "you") {
      return (
        <span className="shrink-0 text-[10.5px] font-semibold rounded-full px-[7px] py-px"
          style={{ background: "var(--q-delegate)", color: "#ffffff" }}>Your turn</span>
      );
    }
    if (item.holder) return <Avatar who={item.holder} size={18} />;
    return <span aria-label="No one yet" role="img" className="w-[18px] h-[18px] rounded-full shrink-0" style={{ border: "1.5px dashed var(--muted2)" }} />;
  };

  const check = (item: Item, style?: React.CSSProperties) => (
    <button aria-label={`Complete ${item.task.title}`} onClick={() => complete(item.task)}
      className="qcheck" style={{ background: "transparent", ...style }} />
  );

  // ===== open view: the hand-off panel =====

  const renderChip = (item: Item, chip: RelayChip) => {
    const { task } = item;
    if (chip.state === "done") {
      return (
        <span className="inline-flex items-center gap-[5px] h-[26px] pl-[7px] pr-2.5 rounded-full text-[12px]"
          style={{ background: "var(--tint)", color: "var(--ink3)" }}>
          <Check className="w-3 h-3 shrink-0" strokeWidth={2.5} style={{ color: "var(--accent)" }} aria-label="Done" />
          {chip.label}
        </span>
      );
    }
    if (chip.state === "passed") {
      return (
        <span className="inline-flex items-center gap-1.5 h-[26px] pl-[5px] pr-2.5 rounded-full text-[12px]"
          style={{ border: "1px solid var(--check-bd)", color: "var(--ink4)" }}>
          <Avatar who={chip.who} size={16} />
          <span className="line-through">{chip.label}</span>
        </span>
      );
    }
    if (chip.who === "you" && chip.state === "now") {
      const solid = (
        <span className="inline-flex items-center h-[30px] px-[13px] rounded-full text-[12.5px] font-semibold"
          style={{ background: "var(--q-delegate)", color: "#ffffff" }}>
          You · {chip.label}
        </span>
      );
      if (chip.action === "handOn") {
        return (
          <HandOffMenu hasSteps={relaySteps(task).length > 0} onPick={(to, mode) => handOff(task, to, mode)}>
            <button className="inline-flex items-center min-h-[40px]">{solid}</button>
          </HandOffMenu>
        );
      }
      return (
        <button className="inline-flex items-center min-h-[40px]"
          onClick={() => (chip.action === "complete" ? complete(task) : tick(task, chip))}>
          {solid}
        </button>
      );
    }

    const current = chip.state === "now";
    const body = (
      <span className={cn("inline-flex items-center gap-1.5 h-[26px] rounded-full text-[12px]", chip.who === "you" ? "px-2.5" : "pl-[5px] pr-2.5", current && "font-medium")}
        style={current
          ? { background: "var(--surface)", border: "1.5px solid var(--ink)", color: "var(--ink)" }
          : { border: "1px dashed var(--muted2)", color: "var(--ink3)" }}>
        {chip.who === "you" ? "You · " : <Avatar who={chip.who} size={16} />}
        {chip.label}
        {chip.stepId && <ChevronDown className="w-3 h-3 shrink-0" style={{ color: "var(--ink4)" }} />}
      </span>
    );
    // Any step not finished yet can be handed to someone else.
    if (chip.stepId) {
      return (
        <OwnerMenu current={chip.who} step={chip.label} onPick={(who) => setOwner(task, chip.stepId!, who)}>
          <button className="inline-flex items-center min-h-[36px]" aria-label={`${chip.label}: ${nameOf(chip.who)}. Change who does it`}>
            {body}
          </button>
        </OwnerMenu>
      );
    }
    return body;
  };

  const renderPanel = (item: Item) => {
    const { task, delegation, chips } = item;
    const panelStyle = { border: "1px solid var(--surface-bd)", background: "var(--card)" };

    if (!delegation) {
      return (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 mt-2 mb-1 pl-3 pr-1 py-1 rounded-[10px]" style={panelStyle}>
          <span className="flex-1 min-w-[140px] text-[12.5px]" style={{ color: "var(--ink3)" }}>No one has this yet.</span>
          <LinkButton onClick={() => openTask(task)}>Open task</LinkButton>
          <HandOffMenu hasSteps={relaySteps(task).length > 0} onPick={(to, mode) => handOff(task, to, mode)}>
            <button className="inline-flex items-center min-h-[40px] px-1">
              <span className="inline-flex items-center h-[30px] px-[13px] rounded-full text-[12.5px] font-medium"
                style={{ background: "var(--btn-primary)", color: "var(--btn-fg)" }}>
                {busy === task._id ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Handing off…</> : "Hand off"}
              </span>
            </button>
          </HandOffMenu>
        </div>
      );
    }

    const { run } = item;
    const now = currentChip(chips);
    const theirTurn = !run && now && now.who !== "you" ? now : undefined;
    // The Assistant reported back, and the next step (or a retry) is its again.
    const sendBack = run && run.status !== "working" && (now?.who === "assistant" || run.status === "blocked");
    return (
      <div className="flex flex-col gap-2 mt-2 mb-1 px-3 pt-2.5 pb-1 rounded-[10px]" style={panelStyle}>
        <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--ink4)" }}>
          <Avatar who={delegation.to} size={18} />
          <span>
            Handed to <span style={{ color: "var(--ink2)", fontWeight: 500 }}>{helper(delegation.to).name}</span>
            {" · "}{delegation.mode === "steps" && relaySteps(task).length > 0 ? "following the checklist" : "figuring it out"}
          </span>
        </div>
        <ol aria-label="Steps" className="flex flex-wrap items-center gap-1.5 list-none m-0 p-0">
          {chips.map((chip, j) => (
            <li key={chip.key} className="flex items-center gap-1.5">
              {renderChip(item, chip)}
              {j < chips.length - 1 && <ChevronRight className="w-3 h-3 shrink-0" style={{ color: "var(--muted5)" }} aria-hidden />}
            </li>
          ))}
        </ol>
        {run ? <RunStatus run={run} /> : (
          <div className="text-[12.5px] leading-[1.4]" style={{ color: "var(--ink3)" }}>{latestLine(chips, delegation)}</div>
        )}
        <div className="flex flex-wrap items-center -mx-2" style={{ borderTop: "1px solid var(--line2)" }}>
          <LinkButton onClick={() => openTask(task)}>Open task</LinkButton>
          <LinkButton onClick={() => void takeBack(task)}>Take it back</LinkButton>
          {sendBack && (
            <LinkButton onClick={() => void fireAssistant(task, run.mode)}>
              {busy === task._id ? "Sending…" : run.status === "blocked" ? "Ask Assistant to try again" : "Send back to Assistant"}
            </LinkButton>
          )}
          {theirTurn && (
            <>
              <span className="flex-1" />
              <span className="pl-2 text-[11px] tracking-[0.08em] uppercase inline-flex items-center gap-1" style={{ color: "var(--muted5)" }}>
                <FlaskConical className="w-3 h-3" /> Pretend
              </span>
              <LinkButton onClick={() => simulateDone(task, theirTurn)}>{nameOf(theirTurn.who)} finishes</LinkButton>
              <LinkButton onClick={() => simulatePass(task, theirTurn)}>{nameOf(theirTurn.who)} passes</LinkButton>
            </>
          )}
        </div>
      </div>
    );
  };

  const sampleTag = (task: RelayTask) =>
    isSample(task) && <span className="ml-2 align-middle text-[10px] tracking-[0.08em] uppercase font-semibold" style={{ color: "var(--muted5)" }}>Sample</span>;

  const [headline, ...upNext] = items;

  return (
    <div className="rounded-2xl overflow-hidden flex flex-col min-h-[300px]"
      style={{ background: "var(--surface)", border: "1px solid var(--surface-bd)", boxShadow: "0 14px 34px -20px rgba(70,55,30,0.45)" }}>
      {/* quadrant header — identical to the others, plus the prototype tag */}
      <div className="flex items-start justify-between px-[22px] py-[15px]" style={{ borderBottom: "1px solid var(--line2)" }}>
        <div>
          <div className="flex items-center gap-[9px]">
            <span className="w-[9px] h-[9px] rounded-full shrink-0" style={{ background: meta.color }} />
            <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px] leading-tight">{meta.name}</span>
            <span className="text-[10px] tracking-[0.08em] uppercase font-semibold rounded-full px-[7px] py-px"
              title="Hand-offs to Assistant are real. Hand-offs to household members are saved in this browser only."
              style={{ border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>Prototype</span>
          </div>
          <div className="text-[11px] tracking-[0.12em] uppercase mt-[3px] ml-[18px]" style={{ color: "var(--muted3)" }}>{meta.subtitle}</div>
        </div>
        <span style={{ fontFamily: "var(--font-serif)", color: "var(--num)" }} className="text-[15px]">{meta.index}</span>
      </div>

      <div className="px-[22px] pt-5 pb-[22px] flex-1 flex flex-col">
        {connectOpen && (
          <ConnectRoutine
            onSaved={onRoutineConnected}
            onCancel={() => { pendingRef.current = null; setConnectOpen(false); }}
          />
        )}
        {headline ? (
          <>
            {/* next action */}
            <div style={{ borderLeft: `2px solid ${meta.color}`, paddingLeft: 14 }}>
              <span className="text-[11px] tracking-[0.1em] uppercase" style={{ color: "var(--muted3)" }}>Next action</span>
              <div className="flex items-start gap-[11px] mt-[3px]">
                {check(headline, { marginTop: 5 })}
                <button onClick={() => toggleOpen(headline.task._id)} aria-expanded={openId === headline.task._id}
                  className="flex-1 min-w-0 text-left text-[17px] font-semibold" style={{ color: "var(--ink)" }}>
                  {headline.task.title}
                  {sampleTag(headline.task)}
                  {dueLabel(headline.task) && (
                    <span className="text-[12px] font-normal" style={{ color: dueLabel(headline.task)!.overdue ? "var(--tag-fg)" : "var(--muted3)" }}>
                      {" "}· {dueLabel(headline.task)!.overdue ? "overdue " : ""}{dueLabel(headline.task)!.text}
                    </span>
                  )}
                </button>
                <span className="mt-[5px] flex">{holderMark(headline)}</span>
              </div>
              {openId === headline.task._id && <div className="ml-[26px]">{renderPanel(headline)}</div>}
            </div>

            {upNext.length > 0 && (
              <div className="mt-4 pt-[15px]" style={{ borderTop: "1px solid var(--line2)" }}>
                <div className="text-[10px] tracking-[0.12em] uppercase mb-3" style={{ color: "var(--muted4)" }}>Up next</div>
                <div className="flex flex-col gap-[11px]">
                  {upNext.map((item) => {
                    const due = dueLabel(item.task);
                    const open = openId === item.task._id;
                    return (
                      <div key={item.task._id} className="flex flex-col">
                        <div className="flex items-center gap-[11px]">
                          {check(item)}
                          <button onClick={() => toggleOpen(item.task._id)} aria-expanded={open}
                            className="text-[14px] flex-1 min-w-0 truncate text-left" style={{ color: "var(--ink3)" }}>
                            {item.task.title}
                            {sampleTag(item.task)}
                          </button>
                          {due && (
                            <span className="text-[12px] shrink-0 tabular-nums" style={{ color: due.overdue ? "var(--tag-fg)" : "var(--muted3)" }}>{due.text}</span>
                          )}
                          {holderMark(item)}
                        </div>
                        {open && <div className="ml-[26px]">{renderPanel(item)}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="pt-[18px] pb-2">
            <div className="text-[15px]" style={{ color: "var(--ink3)" }}>{meta.emptyTitle}</div>
            <div className="text-[12.5px] mt-1" style={{ color: "var(--muted)" }}>{meta.emptySub}</div>
          </div>
        )}

        {/* quick add */}
        <div className="mt-auto pt-[18px] flex flex-col gap-1">
          <div className="hovrow flex items-center gap-[9px] px-3 py-[9px] rounded-[10px]" style={{ border: "1px dashed var(--dash)" }}>
            <span className="text-[15px] leading-none" style={{ color: "var(--muted3)" }}>+</span>
            <input
              type="text"
              value={props.quickValue}
              placeholder="Add a task to hand off"
              aria-label="Add a task to hand off"
              onChange={(e) => props.onQuickChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && props.quickValue.trim()) props.onQuickAdd(); }}
              className="bg-transparent outline-none text-[13px] w-full placeholder:text-[color:var(--muted3)]"
              style={{ color: "var(--ink)" }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4">
            <button onClick={toggleSamples} className="inline-flex items-center gap-1.5 min-h-[32px] text-[12px]" style={{ color: "var(--accent)" }}>
              <FlaskConical className="w-3.5 h-3.5" />
              {samples ? "Hide sample tasks" : "Try it with sample tasks"}
            </button>
            {routine && !connectOpen && (
              routine.connected ? (
                <span className="inline-flex items-center gap-1.5 min-h-[32px] text-[12px]" style={{ color: "var(--ink4)" }}>
                  <Sparkles className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                  Assistant runs on your Claude routine
                  <button onClick={() => void disconnectRoutine()} className="underline underline-offset-2" style={{ color: "var(--ink4)" }}>Disconnect</button>
                </span>
              ) : (
                <button onClick={() => setConnectOpen(true)} className="inline-flex items-center gap-1.5 min-h-[32px] text-[12px]" style={{ color: "var(--accent)" }}>
                  <Sparkles className="w-3.5 h-3.5" />
                  Connect Claude for Assistant
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Avatar({ who, size }: { who: Who; size: number }) {
  if (who === "you") return null;
  const h = helper(who);
  if (h.kind === "ai") {
    return (
      <span role="img" aria-label={h.name} title={h.name} className="flex items-center justify-center shrink-0"
        style={{ width: size, height: size, borderRadius: Math.round(size * 0.31), background: "var(--chip)", color: "var(--accent)" }}>
        <Sparkles style={{ width: size * 0.6, height: size * 0.6 }} strokeWidth={2.2} />
      </span>
    );
  }
  return (
    <span role="img" aria-label={h.name} title={h.name} className="flex items-center justify-center shrink-0 rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: "var(--chip)", border: "1px solid var(--check-bd)", color: "var(--ink2)" }}>
      {h.initial}
    </span>
  );
}

/** While the Assistant works: a live line. After: what it reported back. */
function RunStatus({ run }: { run: AssistantRunView }) {
  if (run.status === "working") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-[1.4]" style={{ color: "var(--ink3)" }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color: "var(--accent)" }} aria-hidden />
        <span>Claude is working on it · started {format(new Date(run.requestedAt), "EEE h:mm a")}</span>
        {run.sessionUrl && (
          <a href={run.sessionUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium" style={{ color: "var(--accent)" }}>
            Watch in Claude <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    );
  }
  const stuck = run.status === "blocked";
  return (
    <div className="rounded-[8px] px-3 py-2.5" style={{ background: "var(--tint)" }}>
      <div className="flex flex-wrap items-center gap-x-2 mb-1 text-[10.5px] tracking-[0.1em] uppercase" style={{ color: stuck ? "var(--tag-fg)" : "var(--muted5)" }}>
        <span>{stuck ? "Assistant got stuck" : "Assistant's report"}</span>
        {run.finishedAt && <span className="normal-case tracking-normal">· {format(new Date(run.finishedAt), "EEE h:mm a")}</span>}
        {run.sessionUrl && (
          <a href={run.sessionUrl} target="_blank" rel="noopener noreferrer"
            className="normal-case tracking-normal inline-flex items-center gap-1" style={{ color: "var(--accent)" }}>
            See the run <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      <div className="text-[13px] leading-[1.5] whitespace-pre-wrap break-words max-h-[260px] overflow-y-auto" style={{ color: "var(--ink2)" }}>
        <LinkifiedText text={run.result ?? "No details."} linkStyle={{ color: "var(--accent)" }} />
      </div>
    </div>
  );
}

/** Paste the routine's API trigger URL and token. The token is stored encrypted and never shown again. */
function ConnectRoutine({ onSaved, onCancel }: { onSaved: (s: RoutineStatus) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/assistant-routine", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, token }),
      });
      const data = (await res.json().catch(() => ({}))) as RoutineStatus & { error?: string };
      if (!res.ok) setError(data.error ?? "Couldn't save it.");
      else onSaved(data);
    } catch {
      setError("Couldn't reach EisenQ. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-[8px] px-3 py-2 text-[13px] outline-none bg-[var(--card)] border border-[var(--surface-bd)] focus:border-[var(--accent)]";
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}
      className="flex flex-col gap-2 mb-4 p-3 rounded-[10px]" style={{ border: "1px solid var(--surface-bd)", background: "var(--card)" }}>
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>Connect Claude for Assistant</div>
      <p className="text-[12.5px] leading-[1.45] m-0" style={{ color: "var(--ink3)" }}>
        Assistant runs as a routine on your own Claude plan. At{" "}
        <a href="https://claude.ai/code/routines" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>claude.ai/code/routines</a>,
        open your EisenQ routine, choose Add another trigger → API → Generate token, and paste both here.
      </p>
      <input className={field} style={{ color: "var(--ink)" }} value={url} onChange={(e) => setUrl(e.target.value)}
        name="routine-trigger-url" type="url" inputMode="url"
        placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" aria-label="Trigger URL"
        autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} />
      {/* A text field masked with CSS, not type="password": browsers otherwise offer
          the person's saved site password here and their email in the URL field. */}
      <input className={field} style={{ color: "var(--ink)", WebkitTextSecurity: "disc" } as React.CSSProperties} value={token}
        onChange={(e) => setToken(e.target.value)} name="routine-token" type="text"
        placeholder="sk-ant-oat01-…" aria-label="Token" autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} />
      {error && <div className="text-[12.5px]" style={{ color: "var(--tag-fg)" }} role="alert">{error}</div>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving || !url.trim() || !token.trim()}
          className="inline-flex items-center h-[32px] px-[14px] rounded-full text-[12.5px] font-medium disabled:opacity-50"
          style={{ background: "var(--btn-primary)", color: "var(--btn-fg)" }}>
          {saving ? "Connecting…" : "Connect"}
        </button>
        <LinkButton onClick={onCancel}>Cancel</LinkButton>
      </div>
    </form>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="inline-flex items-center min-h-[40px] px-2 text-[12.5px] font-medium" style={{ color: "var(--accent)" }}>
      {children}
    </button>
  );
}

/** Pick who gets the task and, when it has a checklist, whether they follow it. */
function HandOffMenu({ hasSteps, onPick, children }: { hasSteps: boolean; onPick: (to: HelperId, mode: HandOffMode) => void; children: ReactNode }) {
  const [mode, setMode] = useState<HandOffMode>(hasSteps ? "steps" : "outcome");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CLS}>
          {hasSteps && (
            <>
              <DropdownMenu.Label className={MENU_LABEL}>How</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={mode} onValueChange={(v) => setMode(v as HandOffMode)}>
                {([["steps", "Follow the checklist"], ["outcome", "Figure it out"]] as const).map(([value, label]) => (
                  <DropdownMenu.RadioItem key={value} value={value} className={MENU_ITEM} onSelect={(e) => e.preventDefault()}>
                    <span className="w-4 flex justify-center">
                      <DropdownMenu.ItemIndicator><Check className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} /></DropdownMenu.ItemIndicator>
                    </span>
                    {label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
            </>
          )}
          <DropdownMenu.Label className={MENU_LABEL}>Hand to</DropdownMenu.Label>
          {HELPERS.map((h) => (
            <DropdownMenu.Item key={h.id} className={MENU_ITEM} onSelect={() => onPick(h.id, hasSteps ? mode : "outcome")}>
              <Avatar who={h.id} size={20} />
              {h.name}
              <span className="ml-auto text-[11.5px]" style={{ color: "var(--muted5)" }}>{h.kind === "ai" ? "AI" : "Household"}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Change who does one step of the relay. */
function OwnerMenu({ current, step, onPick, children }: { current: Who; step: string; onPick: (who: Who) => void; children: ReactNode }) {
  const options: Who[] = ["you", ...HELPERS.map((h) => h.id)];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CLS}>
          <DropdownMenu.Label className={cn(MENU_LABEL, "normal-case tracking-normal text-[12px] truncate")}>Who does “{step}”?</DropdownMenu.Label>
          {options.map((who) => (
            <DropdownMenu.Item key={who} className={MENU_ITEM} onSelect={() => onPick(who)}>
              {who === "you"
                ? <span className="w-5 h-5 flex items-center justify-center text-[10px] font-semibold rounded-full" style={{ border: "1px dashed var(--muted2)", color: "var(--ink3)" }}>Me</span>
                : <Avatar who={who} size={20} />}
              {nameOf(who)}
              {who === current && <Check className="w-3.5 h-3.5 ml-auto" style={{ color: "var(--accent)" }} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
