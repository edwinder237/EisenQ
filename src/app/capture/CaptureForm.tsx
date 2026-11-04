"use client";

import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { addDays, endOfDay, format } from "date-fns";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "~/lib/utils";
// Imported rather than redeclared: the dashboard already keeps its own copy of this
// union (page.tsx:91), and a third would be one too many. `import type` is erased at
// compile time, so nothing from the server schema reaches the client bundle.
import type { TaskQuadrant } from "~/server/db/schema";

const QUADRANTS: {
  key: TaskQuadrant;
  title: string;
  subtitle: string;
  color: string;
  ring: string;
}[] = [
  {
    key: "urgent-important",
    title: "Do First",
    subtitle: "Urgent & Important",
    color: "bg-red-600",
    ring: "ring-red-500",
  },
  {
    key: "important-not-urgent",
    title: "Schedule",
    subtitle: "Important & Not Urgent",
    color: "bg-yellow-600",
    ring: "ring-yellow-500",
  },
  {
    key: "urgent-not-important",
    title: "Delegate",
    subtitle: "Urgent & Not Important",
    color: "bg-blue-600",
    ring: "ring-blue-500",
  },
  {
    key: "not-urgent-not-important",
    title: "Eliminate",
    subtitle: "Not Urgent & Not Important",
    color: "bg-green-600",
    ring: "ring-green-500",
  },
];

type Deadline = "none" | "today" | "tomorrow" | "3days" | "pick";

const DEADLINE_CHIPS: { key: Deadline; label: string }[] = [
  { key: "none", label: "No date" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "3days", label: "3 days" },
  { key: "pick", label: "Pick…" },
];

const TITLE_MAX = 500;
const DESCRIPTION_MAX = 5000;

export default function CaptureForm() {
  const params = useSearchParams();

  const sourceUrl = params.get("url") ?? "";
  const initialTitle = (params.get("title") ?? "").slice(0, TITLE_MAX);
  const initialText = params.get("text") ?? "";

  const [title, setTitle] = useState(initialTitle);
  const [notes, setNotes] = useState(initialText);
  const [deadline, setDeadline] = useState<Deadline>("none");
  const [pickedDate, setPickedDate] = useState("");
  const [submitting, setSubmitting] = useState<TaskQuadrant | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  // The window is opened by the extension purely to capture one item, so start
  // focused on the title — the user often wants to trim it before filing.
  useEffect(() => {
    document.getElementById("capture-title")?.focus();
  }, []);

  const dueDateIso = useMemo(() => {
    const now = new Date();
    switch (deadline) {
      case "today":
        return endOfDay(now).toISOString();
      case "tomorrow":
        return endOfDay(addDays(now, 1)).toISOString();
      case "3days":
        return endOfDay(addDays(now, 3)).toISOString();
      case "pick": {
        if (!pickedDate) return undefined;
        const parsed = new Date(`${pickedDate}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return undefined;
        return endOfDay(parsed).toISOString();
      }
      default:
        return undefined;
    }
  }, [deadline, pickedDate]);

  // Phase 0 has no `source` field on Task yet (that arrives in Phase 1), so the
  // link back to the original page lives in the description.
  const description = useMemo(() => {
    const parts: string[] = [];
    if (notes.trim()) parts.push(notes.trim());
    if (sourceUrl) parts.push(`Source: ${sourceUrl}`);
    return parts.join("\n\n").slice(0, DESCRIPTION_MAX);
  }, [notes, sourceUrl]);

  async function capture(quadrant: TaskQuadrant) {
    if (!title.trim()) {
      setError("Give it a title first.");
      document.getElementById("capture-title")?.focus();
      return;
    }

    setError("");
    setSubmitting(quadrant);

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim().slice(0, TITLE_MAX),
          description: description || undefined,
          quadrant,
          // Mirrors the dashboard's rule (page.tsx:1472) — Do First is always high.
          priority: quadrant === "urgent-important" ? "high" : "medium",
          status: "pending",
          dueDate: dueDateIso,
        }),
      });

      if (!response.ok) {
        setError("Couldn't save that. Try again.");
        setSubmitting(null);
        return;
      }

      setDone(true);
      // Opened by the extension via chrome.windows.create, so this is allowed.
      setTimeout(() => window.close(), 700);
    } catch {
      setError("Couldn't reach EisenQ. Check your connection.");
      setSubmitting(null);
    }
  }

  if (done) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-950 p-6 text-white">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-600">
          <Check className="h-7 w-7" />
        </div>
        <p className="text-lg font-medium">Added to EisenQ</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 p-5 text-white">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Add to EisenQ</h1>
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex max-w-[55%] items-center gap-1 truncate text-xs text-gray-400 hover:text-gray-200"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{sourceUrl.replace(/^https?:\/\//, "")}</span>
            </a>
          )}
        </header>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="capture-title" className="text-xs font-medium text-gray-400">
            Title
          </label>
          <input
            id="capture-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            placeholder="What needs doing?"
            className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm outline-none placeholder:text-gray-600 focus:border-gray-600"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="capture-notes" className="text-xs font-medium text-gray-400">
            Notes
          </label>
          <textarea
            id="capture-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything worth remembering"
            className="resize-none rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm outline-none placeholder:text-gray-600 focus:border-gray-600"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Deadline</span>
          <div className="flex flex-wrap gap-1.5">
            {DEADLINE_CHIPS.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setDeadline(chip.key)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  deadline === chip.key
                    ? "border-white bg-white text-gray-950"
                    : "border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-600",
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {deadline === "pick" && (
            <input
              type="date"
              value={pickedDate}
              onChange={(e) => setPickedDate(e.target.value)}
              className="mt-1 w-fit rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm outline-none focus:border-gray-600"
            />
          )}
          {dueDateIso && (
            <p className="text-xs text-gray-500">
              Due {format(new Date(dueDateIso), "EEE, MMM d")}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">File it in</span>
          <div className="grid grid-cols-2 gap-2">
            {QUADRANTS.map((q) => (
              <button
                key={q.key}
                type="button"
                disabled={submitting !== null}
                onClick={() => void capture(q.key)}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg p-3 text-left transition-opacity disabled:opacity-50",
                  q.color,
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {submitting === q.key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {q.title}
                </span>
                <span className="text-[11px] leading-tight opacity-80">{q.subtitle}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}
