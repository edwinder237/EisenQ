"use client";

// PROTOTYPE of the Delegate quadrant. Closed, it reads like the other three
// quadrants (a "Next action" headline over an "Up next" list); tapping a task
// opens its hand-off panel: who has it, the relay of step chips, and actions.
// Hand-offs and step owners are kept in localStorage only (see
// ~/lib/delegate-prototype); nothing new reaches the server.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { format, startOfDay } from "date-fns";
import { Check, ChevronDown, ChevronRight, FlaskConical, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "~/lib/utils";
import {
  HELPERS,
  SAMPLE_PREFIX,
  buildRelay,
  currentChip,
  helper,
  latestLine,
  loadDelegations,
  nameOf,
  relaySteps,
  sampleData,
  saveDelegations,
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
}

interface Item {
  task: RelayTask;
  delegation?: Delegation;
  chips: RelayChip[];
  /** Who holds it right now: "you" when it waits on you, undefined when no one has it. */
  holder?: Who;
}

export function DelegateQuadrant(props: Props) {
  const { tasks, meta } = props;
  const [delegations, setDelegations] = useState<Delegations>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [samples, setSamples] = useState<RelayTask[] | null>(null);

  // Read after mount: the dashboard is server-rendered first, where there is no storage.
  useEffect(() => setDelegations(loadDelegations()), []);

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
      const delegation = delegations[task._id];
      if (!delegation) {
        none.push({ task, chips: [] });
        continue;
      }
      const chips = buildRelay(task, delegation);
      const holder = currentChip(chips)?.who ?? delegation.to;
      (holder === "you" ? you : them).push({ task, delegation, chips, holder });
    }
    return [...you, ...them, ...none];
  }, [samples, tasks, delegations]);

  // ===== actions =====

  const handOff = (task: RelayTask, to: HelperId, mode: HandOffMode) => {
    update((prev) => ({ ...prev, [task._id]: { to, mode, stepOwners: {}, at: new Date().toISOString() } }));
    toast.success(`Handed to ${helper(to).name}`);
  };

  const takeBack = (task: RelayTask) => {
    update((prev) => {
      const next = { ...prev };
      delete next[task._id];
      return next;
    });
    toast(`Took back “${task.title}”`);
  };

  const setOwner = (task: RelayTask, stepId: string, who: Who) =>
    update((prev) => {
      const d = prev[task._id];
      return d ? { ...prev, [task._id]: { ...d, stepOwners: { ...d.stepOwners, [stepId]: who } } } : prev;
    });

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
    update((prev) => {
      const next = { ...prev };
      delete next[task._id];
      return next;
    });
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
                style={{ background: "var(--btn-primary)", color: "var(--btn-fg)" }}>Hand off</span>
            </button>
          </HandOffMenu>
        </div>
      );
    }

    const now = currentChip(chips);
    const theirTurn = now && now.who !== "you" ? now : undefined;
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
        <div className="text-[12.5px] leading-[1.4]" style={{ color: "var(--ink3)" }}>{latestLine(chips, delegation)}</div>
        <div className="flex flex-wrap items-center -mx-2" style={{ borderTop: "1px solid var(--line2)" }}>
          <LinkButton onClick={() => openTask(task)}>Open task</LinkButton>
          <LinkButton onClick={() => takeBack(task)}>Take it back</LinkButton>
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
              title="Hand-offs are saved in this browser only"
              style={{ border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>Prototype</span>
          </div>
          <div className="text-[11px] tracking-[0.12em] uppercase mt-[3px] ml-[18px]" style={{ color: "var(--muted3)" }}>{meta.subtitle}</div>
        </div>
        <span style={{ fontFamily: "var(--font-serif)", color: "var(--num)" }} className="text-[15px]">{meta.index}</span>
      </div>

      <div className="px-[22px] pt-5 pb-[22px] flex-1 flex flex-col">
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
          <button onClick={toggleSamples} className="self-start inline-flex items-center gap-1.5 min-h-[32px] text-[12px]" style={{ color: "var(--accent)" }}>
            <FlaskConical className="w-3.5 h-3.5" />
            {samples ? "Hide sample tasks" : "Try it with sample tasks"}
          </button>
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
