"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import { Check, ChevronDown, Copy } from "lucide-react";

// Settings → AI connectors. The configuration (switch, permissions,
// preferences) is a draft owned by the dashboard and saved with the rest of
// Settings. Connected apps and activity are live: they load when the tab opens,
// and revoking applies immediately rather than waiting for Save.

export const MCP_CONNECTOR_URL = "https://www.eisenq.app/api/mcp";

type Quadrant = "urgent-important" | "important-not-urgent" | "urgent-not-important" | "not-urgent-not-important";

// Mirrors McpPermissions / McpPreferences in ~/server/db/schema (that module is server-only).
export interface McpPermissionsDraft {
  readTasks: boolean;
  createTasks: boolean;
  editTasks: boolean;
  completeTasks: boolean;
  deleteTasks: boolean;
  readGoals: boolean;
  editGoals: boolean;
}
export interface McpPreferencesDraft {
  defaultQuadrant: Quadrant;
  deleteMode: "archive" | "delete";
  labelAiTasks: boolean;
  shareCompleted: boolean;
  dailyWriteLimit: number;
}
export interface McpConfigDraft {
  enabled: boolean;
  permissions: McpPermissionsDraft;
  preferences: McpPreferencesDraft;
}

interface ConnectedApp {
  clientId: string;
  name: string;
  firstSeenAt: string;
  lastUsedAt: string;
  blocked: boolean;
}
interface ActivityLine {
  at: string;
  clientId: string;
  clientName: string;
  tool: string;
  summary: string;
}

export const DEFAULT_MCP_CONFIG: McpConfigDraft = {
  enabled: false,
  permissions: {
    readTasks: true,
    createTasks: true,
    editTasks: true,
    completeTasks: true,
    deleteTasks: false,
    readGoals: true,
    editGoals: false,
  },
  preferences: {
    defaultQuadrant: "important-not-urgent",
    deleteMode: "archive",
    labelAiTasks: true,
    shareCompleted: false,
    dailyWriteLimit: 50,
  },
};

/** Just the editable part of what GET /api/settings returns as `mcp`. */
export function mcpConfigFrom(raw: unknown): McpConfigDraft {
  const m = (raw ?? {}) as Partial<McpConfigDraft>;
  return {
    enabled: m.enabled ?? DEFAULT_MCP_CONFIG.enabled,
    permissions: { ...DEFAULT_MCP_CONFIG.permissions, ...m.permissions },
    preferences: {
      defaultQuadrant: m.preferences?.defaultQuadrant ?? DEFAULT_MCP_CONFIG.preferences.defaultQuadrant,
      deleteMode: m.preferences?.deleteMode ?? DEFAULT_MCP_CONFIG.preferences.deleteMode,
      labelAiTasks: m.preferences?.labelAiTasks ?? DEFAULT_MCP_CONFIG.preferences.labelAiTasks,
      shareCompleted: m.preferences?.shareCompleted ?? DEFAULT_MCP_CONFIG.preferences.shareCompleted,
      dailyWriteLimit: m.preferences?.dailyWriteLimit ?? DEFAULT_MCP_CONFIG.preferences.dailyWriteLimit,
    },
  };
}

export function mcpConfigEqual(a: McpConfigDraft, b: McpConfigDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const PERMISSIONS: { key: keyof McpPermissionsDraft; label: string; hint: string; risky?: boolean }[] = [
  { key: "readTasks", label: "Read tasks", hint: "See your open tasks, due dates and each quadrant's next action." },
  { key: "createTasks", label: "Add tasks", hint: "Add new tasks to the matrix." },
  { key: "editTasks", label: "Edit tasks", hint: "Rename, reschedule, change quadrant or priority, link goals." },
  { key: "completeTasks", label: "Complete tasks", hint: "Tick tasks off. Required checklists still apply." },
  { key: "deleteTasks", label: "Remove tasks", hint: "Archive or delete tasks, per the setting below.", risky: true },
  { key: "readGoals", label: "Read goals", hint: "See your weekly, monthly and yearly goals and their progress." },
  { key: "editGoals", label: "Create & edit goals", hint: "Add goals, rename them, move them to another period.", risky: true },
];

const QUADRANTS: { id: Quadrant; label: string }[] = [
  { id: "urgent-important", label: "Do First" },
  { id: "important-not-urgent", label: "Schedule" },
  { id: "urgent-not-important", label: "Delegate" },
  { id: "not-urgent-not-important", label: "Eliminate" },
];

const FIELD = { background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" } as const;

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="relative shrink-0 rounded-full"
      style={{ width: 32, height: 18, background: on ? "var(--pill-active)" : "var(--line)" }}
    >
      <span
        className="absolute rounded-full"
        style={{ top: 2, left: on ? 16 : 2, width: 14, height: 14, background: "var(--drawer)", transition: "left .15s ease" }}
      />
    </button>
  );
}

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3" style={{ padding: "10px 12px", borderBottom: "1px solid var(--line2)" }}>
      <div className="min-w-0">
        <div className="text-[13px]" style={{ color: "var(--ink2)" }}>{title}</div>
        {hint && <div className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>{hint}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="pt-5">
      <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>{title}</label>
      {note && <p className="text-[12px] mb-2" style={{ color: "var(--muted)" }}>{note}</p>}
      {children}
    </div>
  );
}

function Guide({ title, steps }: { title: string; steps: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid var(--line2)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between text-left text-[12.5px]"
        style={{ padding: "9px 12px", color: "var(--ink2)" }}
      >
        {title}
        <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s ease", color: "var(--muted)" }} />
      </button>
      {open && (
        <ol className="list-decimal text-[12px] space-y-1" style={{ padding: "0 14px 12px 32px", color: "var(--ink3)" }}>
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : new Date(iso).toLocaleDateString();
}

interface Props {
  draft: McpConfigDraft;
  onChange: (next: McpConfigDraft) => void;
  savedEnabled: boolean; // what the server has, to say whether apps can connect right now
}

export function AiConnectorsPanel({ draft, onChange, savedEnabled }: Props) {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [busyClient, setBusyClient] = useState<string | null>(null);
  const zone = browserTimeZone();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { mcp?: { clients?: ConnectedApp[]; activity?: ActivityLine[] } };
      setApps(data.mcp?.clients ?? []);
      setActivity(data.mcp?.activity ?? []);
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setPerm = (key: keyof McpPermissionsDraft) =>
    onChange({ ...draft, permissions: { ...draft.permissions, [key]: !draft.permissions[key] } });
  const setPref = <K extends keyof McpPreferencesDraft>(key: K, value: McpPreferencesDraft[K]) =>
    onChange({ ...draft, preferences: { ...draft.preferences, [key]: value } });

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(MCP_CONNECTOR_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy. Select the address and copy it by hand.");
    }
  };

  const changeAccess = async (app: ConnectedApp, action: "revoke" | "allow") => {
    if (action === "revoke" && !confirm(`Revoke ${app.name}'s access to EisenQ? Its next request will be refused.`)) return;
    setBusyClient(app.clientId);
    try {
      const res = await fetch("/api/mcp/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: app.clientId, action }),
      });
      if (!res.ok) throw new Error();
      toast.success(action === "revoke" ? `${app.name} revoked` : `${app.name} allowed again`);
      await refresh();
    } catch {
      toast.error("Couldn't change that app's access");
    } finally {
      setBusyClient(null);
    }
  };

  const dim = draft.enabled ? undefined : { opacity: 0.55 };

  return (
    <div>
      <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
        Add EisenQ as a connector in Claude or ChatGPT, then ask in plain words: “add <em>call the accountant</em> to Schedule for Friday”,
        “what&apos;s my next action?”, “mark the invoice task done”. You choose below what an AI app may do.{" "}
        <a href="/help/integrations#ai-connectors" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: "var(--accent)" }}>
          Full guide
        </a>
      </p>

      {/* 1. Master switch */}
      <div className="rounded-[10px] overflow-hidden" style={{ background: "var(--field)", border: "1px solid var(--field-bd)" }}>
        <Row
          title={<span className="font-semibold">Allow AI connectors</span>}
          hint={
            savedEnabled
              ? "On: connected apps can reach your tasks within the permissions below."
              : "Off: every request from an AI app is refused, even from apps you connected before."
          }
        >
          <Switch on={draft.enabled} onToggle={() => onChange({ ...draft, enabled: !draft.enabled })} label="Allow AI connectors" />
        </Row>
      </div>

      <div style={dim}>
        {/* 2. Connector URL + guides */}
        <Section title="Connector address">
          <div className="rounded-[10px] overflow-hidden" style={FIELD}>
            <div className="flex items-center gap-2" style={{ padding: "8px 8px 8px 12px" }}>
              <code className="flex-1 min-w-0 truncate text-[12.5px]">{MCP_CONNECTOR_URL}</code>
              <button
                type="button"
                onClick={() => void copyUrl()}
                className="shrink-0 inline-flex items-center gap-1 text-[12px] font-medium rounded-[8px]"
                style={{ padding: "5px 10px", background: "var(--chip)", color: "var(--ink2)" }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <Guide
              title="Add to Claude"
              steps={[
                <>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</>,
                <>Name it <strong>EisenQ</strong> and paste the address above.</>,
                <>Choose <strong>Connect</strong>, sign in to EisenQ, and approve.</>,
                <>In a chat, turn EisenQ on from the tools menu and ask away.</>,
              ]}
            />
            <Guide
              title="Add to ChatGPT"
              steps={[
                <>In ChatGPT, open <strong>Settings → Apps &amp; Connectors</strong>. Custom connectors may need <strong>Developer mode</strong> under Advanced.</>,
                <>Choose <strong>Create</strong>, name it <strong>EisenQ</strong>, paste the address above, and pick <strong>OAuth</strong>.</>,
                <>Sign in to EisenQ and approve.</>,
                <>In a chat, add EisenQ from the <strong>+</strong> menu and ask away.</>,
              ]}
            />
          </div>
        </Section>

        {/* 3. Permissions */}
        <Section title="What AI apps may do">
          <div className="rounded-[10px] overflow-hidden" style={FIELD}>
            {PERMISSIONS.map((p) => (
              <Row
                key={p.key}
                title={
                  <>
                    {p.label}
                    {p.risky && (
                      <span className="ml-1.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--tag-fg)" }}>
                        careful
                      </span>
                    )}
                  </>
                }
                hint={p.hint}
              >
                <Switch on={draft.permissions[p.key]} onToggle={() => setPerm(p.key)} label={p.label} />
              </Row>
            ))}
          </div>
        </Section>

        {/* 4. Preferences */}
        <Section title="Preferences">
          <div className="rounded-[10px] overflow-hidden" style={FIELD}>
            <Row title="New tasks go to" hint="When the AI doesn't say which quadrant.">
              <select
                value={draft.preferences.defaultQuadrant}
                onChange={(e) => setPref("defaultQuadrant", e.target.value as Quadrant)}
                className="text-[12.5px] rounded-[8px] outline-none"
                style={{ padding: "5px 8px", ...FIELD }}
              >
                {QUADRANTS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
              </select>
            </Row>
            <Row
              title="Removing a task"
              hint={draft.preferences.deleteMode === "archive" ? "Archived: you can restore it from Settings → Tasks." : "Deleted for good, with its subtasks."}
            >
              <select
                value={draft.preferences.deleteMode}
                onChange={(e) => setPref("deleteMode", e.target.value as "archive" | "delete")}
                className="text-[12.5px] rounded-[8px] outline-none"
                style={{ padding: "5px 8px", ...FIELD }}
              >
                <option value="archive">Archives it</option>
                <option value="delete">Deletes it</option>
              </select>
            </Row>
            <Row title="Label tasks added by AI" hint="Shows “via Claude” (or the app's name) in the task editor.">
              <Switch on={draft.preferences.labelAiTasks} onToggle={() => setPref("labelAiTasks", !draft.preferences.labelAiTasks)} label="Label tasks added by AI" />
            </Row>
            <Row title="Share completed tasks" hint="Off: AI apps only see what's still open.">
              <Switch on={draft.preferences.shareCompleted} onToggle={() => setPref("shareCompleted", !draft.preferences.shareCompleted)} label="Share completed tasks" />
            </Row>
            <Row title="Daily limit" hint="Most changes AI apps can make per day, a guard against a runaway agent.">
              <input
                type="number"
                min={1}
                max={500}
                value={draft.preferences.dailyWriteLimit}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setPref("dailyWriteLimit", Math.min(500, Math.max(1, n)));
                }}
                className="w-[72px] text-[12.5px] rounded-[8px] outline-none text-right"
                style={{ padding: "5px 8px", ...FIELD }}
              />
            </Row>
          </div>
          <p className="text-[11.5px] mt-1.5" style={{ color: "var(--muted)" }}>
            Dates from AI apps are read in <strong>{zone}</strong>, this device&apos;s time zone, saved when you save. A plain date means 9:00 AM.
          </p>
        </Section>
      </div>

      {/* 5. Connected apps (live, not dimmed: revoking matters most when off is not enough) */}
      <Section title="Connected apps" note="Apps appear here after their first request. Revoking takes effect immediately.">
        <div className="rounded-[10px] overflow-hidden" style={FIELD}>
          {apps === null ? (
            <div className="text-[12.5px]" style={{ padding: "10px 12px", color: "var(--muted)" }}>Loading…</div>
          ) : apps.length === 0 ? (
            <div className="text-[12.5px]" style={{ padding: "10px 12px", color: "var(--muted)" }}>No apps have connected yet.</div>
          ) : (
            apps.map((app) => (
              <Row
                key={app.clientId}
                title={
                  <>
                    {app.name}
                    {app.blocked && (
                      <span className="ml-1.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--tag-fg)" }}>revoked</span>
                    )}
                  </>
                }
                hint={`Connected ${new Date(app.firstSeenAt).toLocaleDateString()} · last used ${ago(app.lastUsedAt)}`}
              >
                <button
                  type="button"
                  disabled={busyClient === app.clientId}
                  onClick={() => void changeAccess(app, app.blocked ? "allow" : "revoke")}
                  className="text-[12px] font-semibold disabled:opacity-40"
                  style={{ color: app.blocked ? "var(--accent)" : "var(--tag-fg)" }}
                >
                  {app.blocked ? "Allow again" : "Revoke"}
                </button>
              </Row>
            ))
          )}
        </div>
      </Section>

      {/* 6. Recent activity */}
      <Section title="Recent activity" note="Changes made by AI apps and by the built-in assistant.">
        <div className="rounded-[10px] overflow-hidden" style={FIELD}>
          {activity.length === 0 ? (
            <div className="text-[12.5px]" style={{ padding: "10px 12px", color: "var(--muted)" }}>Nothing yet.</div>
          ) : (
            <div className="max-h-[240px] overflow-y-auto">
              {activity.slice(0, 20).map((a, i) => (
                <div key={`${a.at}-${i}`} className="flex items-baseline justify-between gap-3" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line2)" }}>
                  <span className="text-[12.5px] min-w-0" style={{ color: "var(--ink3)" }}>
                    <strong style={{ color: "var(--ink2)", fontWeight: 600 }}>{a.clientName}</strong> · {a.summary}
                  </span>
                  <span className="shrink-0 text-[11.5px]" style={{ color: "var(--muted)" }}>{ago(a.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
