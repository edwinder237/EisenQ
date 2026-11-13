"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Loader2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { cn } from "~/lib/utils";

// Mirrors AssistantSuggestion in ~/server/assistant (kept separate: that module is server-only).
export interface AssistantSuggestion {
  id: string;
  taskId: string;
  taskTitle: string;
  action: "move_quadrant" | "set_priority" | "set_due_date" | "archive" | "link_goal" | "move_to_top";
  value: string;
  label: string;
  reason: string;
}

type SuggestionState = "pending" | "applying" | "applied" | "dismissed" | "failed";

interface Turn {
  role: "user" | "assistant";
  content: string;
  suggestions?: AssistantSuggestion[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Applies one suggestion through the dashboard's own task handlers; resolves true on success.
  onApply: (s: AssistantSuggestion) => Promise<boolean>;
  onOpenSettings: () => void;
}

const STARTERS = [
  "Triage my matrix",
  "What should I focus on today?",
  "What can I drop or archive?",
];

export function AssistantPanel({ open, onOpenChange, onApply, onOpenSettings }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [states, setStates] = useState<Record<string, SuggestionState>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, loading, error]);

  // What Claude sees of earlier assistant turns: the reply plus what happened to its suggestions.
  const historyContent = (turn: Turn) => {
    if (turn.role === "user" || !turn.suggestions?.length) return turn.content;
    const lines = turn.suggestions.map((s) => {
      const st = states[s.id] ?? "pending";
      const outcome = st === "applied" ? "applied" : st === "dismissed" ? "dismissed" : "not acted on yet";
      return `- ${s.taskTitle}: ${s.label} (${outcome})`;
    });
    return `${turn.content}\n\nSuggestions I made:\n${lines.join("\n")}`;
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || loading) return;
    const next: Turn[] = [...turns, { role: "user", content: message }];
    setTurns(next);
    setInput("");
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.slice(-20).map((t) => ({ role: t.role, content: historyContent(t) })),
        }),
      });
      const data = (await res.json()) as {
        reply?: string;
        suggestions?: AssistantSuggestion[];
        error?: string;
        code?: string;
      };
      if (!res.ok || typeof data.reply !== "string") {
        setError({ message: data.error ?? "The assistant failed. Try again.", code: data.code });
        setTurns(turns); // drop the unanswered message so a retry doesn't double it
        setInput(message);
        return;
      }
      setTurns([...next, { role: "assistant", content: data.reply, suggestions: data.suggestions ?? [] }]);
    } catch {
      setError({ message: "Couldn't reach the assistant. Check your connection." });
      setTurns(turns);
      setInput(message);
    } finally {
      setLoading(false);
    }
  };

  const apply = async (s: AssistantSuggestion) => {
    setStates((prev) => ({ ...prev, [s.id]: "applying" }));
    const ok = await onApply(s);
    setStates((prev) => ({ ...prev, [s.id]: ok ? "applied" : "failed" }));
  };

  const applyAll = async (list: AssistantSuggestion[]) => {
    for (const s of list) {
      if ((states[s.id] ?? "pending") === "pending") await apply(s);
    }
  };

  const reset = () => {
    setTurns([]);
    setStates({});
    setError(null);
    setInput("");
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed right-0 top-0 h-full w-full max-w-md z-50 shadow-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
            "duration-300 ease-in-out",
            "bg-[var(--drawer)] text-[var(--ink)]",
          )}
        >
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-[var(--drawer-bd)]">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[#7f6a45]/20">
                  <Sparkles className="w-5 h-5 text-[var(--accent)]" />
                </div>
                <div>
                  <Dialog.Title className="text-lg font-semibold">Assistant</Dialog.Title>
                  <Dialog.Description className="text-sm text-[var(--ink3)]">
                    Suggestions you can apply or dismiss
                  </Dialog.Description>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {turns.length > 0 && (
                  <button
                    onClick={reset}
                    title="New conversation"
                    className="p-2 rounded-lg transition-colors hover:bg-[var(--hover)] text-[var(--ink3)]"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
                <Dialog.Close asChild>
                  <button className="p-2 rounded-lg transition-colors hover:bg-[var(--hover)] text-[var(--ink3)]" aria-label="Close">
                    <X className="w-5 h-5" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            {/* Conversation */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              {turns.length === 0 && !loading && (
                <div className="flex flex-col gap-3">
                  <p className="text-[13.5px]" style={{ color: "var(--ink3)" }}>
                    Ask about your priorities, or start with a triage. The assistant reads your open tasks and goals and
                    proposes changes. Nothing changes until you apply it.
                  </p>
                  <div className="flex flex-col gap-2">
                    {STARTERS.map((s) => (
                      <button
                        key={s}
                        onClick={() => void send(s)}
                        className="text-left text-[13.5px] rounded-[10px] px-3.5 py-2.5 transition-colors hover:bg-[var(--hover)]"
                        style={{ border: "1px solid var(--field-bd)", color: "var(--ink2)" }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {turns.map((turn, i) =>
                turn.role === "user" ? (
                  <div
                    key={i}
                    className="self-end max-w-[85%] text-[13.5px] rounded-[12px] px-3.5 py-2 whitespace-pre-wrap"
                    style={{ background: "var(--tint)", color: "var(--ink)" }}
                  >
                    {turn.content}
                  </div>
                ) : (
                  <div key={i} className="flex flex-col gap-2.5">
                    <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--ink2)" }}>
                      {turn.content}
                    </p>
                    {turn.suggestions?.map((s) => (
                      <SuggestionCard
                        key={s.id}
                        suggestion={s}
                        state={states[s.id] ?? "pending"}
                        onApply={() => void apply(s)}
                        onDismiss={() => setStates((prev) => ({ ...prev, [s.id]: "dismissed" }))}
                      />
                    ))}
                    {(turn.suggestions?.filter((s) => (states[s.id] ?? "pending") === "pending").length ?? 0) > 1 && (
                      <button
                        onClick={() => void applyAll(turn.suggestions ?? [])}
                        className="self-start text-[12.5px] font-semibold"
                        style={{ color: "var(--accent)" }}
                      >
                        Apply all remaining
                      </button>
                    )}
                  </div>
                ),
              )}

              {loading && (
                <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--muted)" }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Reading your matrix…
                </div>
              )}

              {error && (
                <div className="text-[13px] rounded-[10px] px-3.5 py-2.5" style={{ background: "var(--tint)", color: "var(--tag-fg)" }}>
                  {error.message}
                  {(error.code === "no_key" || error.code === "bad_key") && (
                    <button onClick={onOpenSettings} className="block mt-1.5 font-semibold" style={{ color: "var(--accent)" }}>
                      Open Settings
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Composer */}
            <form
              className="p-3 border-t border-[var(--drawer-bd)] flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                placeholder="e.g. I'm out Thursday, what should move?"
                className="flex-1 resize-none text-[13.5px] rounded-[10px] outline-none"
                style={{ padding: "9px 12px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                aria-label="Send"
                className="p-2.5 rounded-[10px] transition-opacity disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--drawer)" }}
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SuggestionCard({
  suggestion,
  state,
  onApply,
  onDismiss,
}: {
  suggestion: AssistantSuggestion;
  state: SuggestionState;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const done = state === "applied" || state === "dismissed";
  return (
    <div
      className={cn("rounded-[12px] px-3.5 py-3 transition-opacity", done && "opacity-55")}
      style={{ border: "1px solid var(--field-bd)", background: "var(--field)" }}
    >
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
        {suggestion.taskTitle}
      </div>
      <div className="text-[12.5px] font-medium mt-0.5" style={{ color: "var(--accent)" }}>
        {suggestion.label}
      </div>
      <p className="text-[12.5px] mt-1" style={{ color: "var(--ink3)" }}>
        {suggestion.reason}
      </p>
      <div className="flex items-center gap-3 mt-2.5 text-[12.5px] font-semibold">
        {state === "pending" && (
          <>
            <button onClick={onApply} style={{ color: "var(--accent)" }}>
              Apply
            </button>
            <button onClick={onDismiss} style={{ color: "var(--muted)" }}>
              Dismiss
            </button>
          </>
        )}
        {state === "applying" && (
          <span className="flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying…
          </span>
        )}
        {state === "applied" && (
          <span className="flex items-center gap-1" style={{ color: "var(--accent)" }}>
            <Check className="w-3.5 h-3.5" /> Applied
          </span>
        )}
        {state === "dismissed" && <span style={{ color: "var(--muted)" }}>Dismissed</span>}
        {state === "failed" && (
          <span style={{ color: "var(--tag-fg)" }}>
            Couldn&apos;t apply.{" "}
            <button onClick={onApply} className="underline">
              Retry
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
