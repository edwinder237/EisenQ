"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { addDays, endOfDay, format } from "date-fns";
import { Check, ExternalLink, Loader2 } from "lucide-react";
// Imported rather than redeclared: the dashboard already keeps its own copy of this
// union (page.tsx:91), and a third would be one too many. `import type` is erased at
// compile time, so nothing from the server schema reaches the client bundle.
import type { TaskQuadrant } from "~/server/db/schema";
import { useEditorialTheme } from "~/hooks/useEditorialTheme";

// Same names, subtitles, numbering and colour tokens as the dashboard's matrix,
// so filing a task here looks like dropping it into that quadrant.
const QUADRANTS: {
  key: TaskQuadrant;
  name: string;
  subtitle: string;
  index: string;
  color: string;
}[] = [
  { key: "urgent-important", name: "Do First", subtitle: "Urgent & Important", index: "01", color: "var(--q-do-first)" },
  { key: "important-not-urgent", name: "Schedule", subtitle: "Important & Not Urgent", index: "02", color: "var(--q-schedule)" },
  { key: "urgent-not-important", name: "Delegate", subtitle: "Urgent & Not Important", index: "03", color: "var(--q-delegate)" },
  { key: "not-urgent-not-important", name: "Eliminate", subtitle: "Not Urgent & Not Important", index: "04", color: "var(--q-eliminate)" },
];

type Deadline = "none" | "today" | "tomorrow" | "3days" | "pick";

const DEADLINE_CHIPS: { key: Deadline; label: string }[] = [
  { key: "none", label: "No date" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "3days", label: "3 days" },
  { key: "pick", label: "Pick…" },
];

// What the automatic deadline check found, if anything.
type Detection =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "found"; date: string; quote: string }
  | { state: "past"; date: string; quote: string }
  | { state: "none" }
  | { state: "unconfigured" }
  | { state: "unavailable" };

const TITLE_MAX = 500;
const DESCRIPTION_MAX = 5000;

const label = "text-[10px] tracking-[0.14em] uppercase";
const field =
  "w-full rounded-[10px] border px-3 py-2 text-[14px] outline-none transition-colors placeholder:text-[var(--muted)] focus:border-[color:var(--accent)]";
const fieldStyle: CSSProperties = {
  background: "var(--field)",
  borderColor: "var(--field-bd)",
  color: "var(--ink)",
};

// The extension passes the open email's text and sent date in the URL #fragment
// (never sent to the server). Read once, client-side.
function readCaptureContext(): { body: string; sentAt: string } {
  try {
    const match = /(?:^#|&)ctx=([^&]*)/.exec(window.location.hash);
    if (!match?.[1]) return { body: "", sentAt: "" };
    const ctx = JSON.parse(decodeURIComponent(match[1])) as { body?: unknown; sentAt?: unknown };
    return {
      body: typeof ctx.body === "string" ? ctx.body : "",
      sentAt: typeof ctx.sentAt === "string" ? ctx.sentAt : "",
    };
  } catch {
    return { body: "", sentAt: "" };
  }
}

function localYmd(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export default function CaptureForm() {
  useEditorialTheme();
  const params = useSearchParams();

  const sourceUrl = params.get("url") ?? "";
  const initialTitle = (params.get("title") ?? "").slice(0, TITLE_MAX);
  const initialText = params.get("text") ?? "";

  const [title, setTitle] = useState(initialTitle);
  const [notes, setNotes] = useState(initialText);
  const [deadline, setDeadline] = useState<Deadline>("none");
  const [pickedDate, setPickedDate] = useState("");
  const [detection, setDetection] = useState<Detection>({ state: "idle" });
  const [submitting, setSubmitting] = useState<TaskQuadrant | null>(null);
  const [done, setDone] = useState<TaskQuadrant | null>(null);
  const [error, setError] = useState("");

  // Once the user picks a deadline themselves, a late answer from the automatic
  // check must not overwrite it.
  const userChoseDeadline = useRef(false);

  // The window is opened by the extension purely to capture one item, so start
  // focused on the title — the user often wants to trim it before filing.
  useEffect(() => {
    document.getElementById("capture-title")?.focus();
  }, []);

  // Look for a deadline in what was captured: the title, any selected text, and
  // for an email its body and sent date.
  useEffect(() => {
    const ctx = readCaptureContext();
    const text = [initialText, ctx.body].filter(Boolean).join("\n\n").slice(0, 8000);
    if (!initialTitle.trim() && !text.trim()) return;

    const controller = new AbortController();
    setDetection({ state: "checking" });

    void (async () => {
      try {
        const res = await fetch("/api/capture/deadline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            title: initialTitle,
            text,
            sentAt: ctx.sentAt || undefined,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });
        if (!res.ok) {
          setDetection({ state: "unavailable" });
          return;
        }
        const data = (await res.json()) as {
          configured?: boolean;
          dueDate?: string | null;
          past?: boolean;
          quote?: string;
        };
        if (data.configured === false) {
          setDetection({ state: "unconfigured" });
        } else if (!data.dueDate) {
          setDetection({ state: "none" });
        } else if (data.past) {
          setDetection({ state: "past", date: data.dueDate, quote: data.quote ?? "" });
        } else {
          setDetection({ state: "found", date: data.dueDate, quote: data.quote ?? "" });
          if (!userChoseDeadline.current) applyDetectedDate(data.dueDate);
        }
      } catch {
        if (!controller.signal.aborted) setDetection({ state: "unavailable" });
      }
    })();

    return () => controller.abort();
    // Runs once per opened window, on what was captured — not on later edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A detected date selects the matching chip when there is one, else "Pick…".
  function applyDetectedDate(ymd: string) {
    const now = new Date();
    if (ymd === localYmd(now)) setDeadline("today");
    else if (ymd === localYmd(addDays(now, 1))) setDeadline("tomorrow");
    else if (ymd === localYmd(addDays(now, 3))) setDeadline("3days");
    else {
      setPickedDate(ymd);
      setDeadline("pick");
    }
  }

  function chooseDeadline(next: Deadline) {
    userChoseDeadline.current = true;
    setDeadline(next);
  }

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

  // The link back to the original page lives in the description.
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
          // Mirrors the dashboard's rule — Do First is always high.
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

      setDone(quadrant);
      // Opened by the extension via chrome.windows.create, so this is allowed.
      setTimeout(() => window.close(), 900);
    } catch {
      setError("Couldn't reach EisenQ. Check your connection.");
      setSubmitting(null);
    }
  }

  if (done) {
    const q = QUADRANTS.find((x) => x.key === done)!;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: "var(--pill-active)", color: "var(--btn-fg)" }}
        >
          <Check className="h-6 w-6" />
        </div>
        <div className="text-center">
          <p style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px] leading-tight">
            Filed in {q.name}
          </p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
            This window will close.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-[22px] py-5">
      <div className="mx-auto flex max-w-[440px] flex-col gap-[18px]">
        <header className="flex flex-col gap-1">
          <span className={label} style={{ color: "var(--muted2)" }}>
            Capture
          </span>
          <h1 style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[26px] leading-none">
            Add to EisenQ
          </h1>
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex max-w-full items-center gap-1.5 truncate text-[12px] hover:underline"
              style={{ color: "var(--muted)" }}
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{sourceUrl.replace(/^https?:\/\//, "")}</span>
            </a>
          )}
        </header>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="capture-title" className={label} style={{ color: "var(--muted2)" }}>
            Title
          </label>
          <input
            id="capture-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            placeholder="What needs doing?"
            className={field}
            style={fieldStyle}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="capture-notes" className={label} style={{ color: "var(--muted2)" }}>
            Notes
          </label>
          <textarea
            id="capture-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything worth remembering"
            className={`${field} resize-none`}
            style={fieldStyle}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className={label} style={{ color: "var(--muted2)" }}>
            Deadline
          </span>
          <div className="flex flex-wrap gap-1.5">
            {DEADLINE_CHIPS.map((chip) => {
              const active = deadline === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => chooseDeadline(chip.key)}
                  className="rounded-full border px-3 py-[5px] text-[12px] transition-colors"
                  style={
                    active
                      ? { background: "var(--pill-active)", borderColor: "var(--pill-active)", color: "var(--btn-fg)" }
                      : { background: "var(--chip)", borderColor: "var(--line)", color: "var(--ink3)" }
                  }
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
          {deadline === "pick" && (
            <input
              type="date"
              value={pickedDate}
              onChange={(e) => {
                userChoseDeadline.current = true;
                setPickedDate(e.target.value);
              }}
              className={`${field} w-fit`}
              style={fieldStyle}
            />
          )}
          <DetectionNote detection={detection} />
          {dueDateIso && (
            <p className="text-[12px]" style={{ color: "var(--muted)" }}>
              Due {format(new Date(dueDateIso), "EEE, MMM d")}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className={label} style={{ color: "var(--muted2)" }}>
            File it in
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            {QUADRANTS.map((q) => (
              <button
                key={q.key}
                type="button"
                disabled={submitting !== null}
                onClick={() => void capture(q.key)}
                className="flex flex-col items-start gap-1 rounded-[14px] border px-3.5 py-3 text-left transition-all hover:-translate-y-px hover:border-[color:var(--qc)] disabled:translate-y-0 disabled:opacity-50"
                style={
                  {
                    "--qc": q.color,
                    background: "var(--surface)",
                    borderColor: "var(--surface-bd)",
                    boxShadow: "0 10px 24px -18px rgba(70,55,30,0.45)",
                  } as CSSProperties
                }
              >
                <span className="flex w-full items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: q.color }} />
                  <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[19px] leading-tight">
                    {q.name}
                  </span>
                  <span className="ml-auto" style={{ fontFamily: "var(--font-serif)", color: "var(--num)" }}>
                    {submitting === q.key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--muted)" }} />
                    ) : (
                      <span className="text-[13px]">{q.index}</span>
                    )}
                  </span>
                </span>
                <span className="ml-4 text-[9.5px] tracking-[0.12em] uppercase" style={{ color: "var(--muted3)" }}>
                  {q.subtitle}
                </span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-[13px]" style={{ color: "var(--tag-fg)" }}>
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function DetectionNote({ detection }: { detection: Detection }) {
  const base = "flex items-start gap-1.5 text-[12px] leading-snug";

  switch (detection.state) {
    case "checking":
      return (
        <p className={base} style={{ color: "var(--muted)" }}>
          <Loader2 className="mt-px h-3 w-3 shrink-0 animate-spin" /> Looking for a deadline…
        </p>
      );
    case "found":
      // Only the evidence: the "Due …" line below always shows the date that
      // will actually be saved, even after the user changes it.
      return (
        <p className={base} style={{ color: "var(--muted)" }}>
          <span>
            <span style={{ color: "var(--accent)" }}>Deadline found</span>
            {detection.quote ? <>: &ldquo;{detection.quote}&rdquo;</> : null}
          </span>
        </p>
      );
    case "past":
      return (
        <p className={base} style={{ color: "var(--tag-fg)" }}>
          <span>
            Mentions {format(new Date(`${detection.date}T00:00:00`), "MMM d, yyyy")}, which has already passed
            {detection.quote && <> (&ldquo;{detection.quote}&rdquo;)</>}. Pick a date yourself if it still matters.
          </span>
        </p>
      );
    case "none":
      return (
        <p className={base} style={{ color: "var(--muted)" }}>
          No deadline mentioned.
        </p>
      );
    case "unconfigured":
      return (
        <p className={base} style={{ color: "var(--muted)" }}>
          Add a Gemini key in EisenQ&apos;s settings to fill this in automatically.
        </p>
      );
    case "unavailable":
      return (
        <p className={base} style={{ color: "var(--muted)" }}>
          Couldn&apos;t check for a deadline this time.
        </p>
      );
    default:
      return null;
  }
}
