// Where a task came from, in words a person recognises. Shared by the server
// (which stores the AI app's name) and the dashboard (which shows it), so a
// task stamped with a raw client name like "Anthropic/Toolbox" still reads
// "Claude".

export type TaskSourceLike = {
  kind: "gmail" | "page" | "selection" | "agent";
  title?: string;
  url?: string;
};

const APP_NAMES: [RegExp, string][] = [
  [/anthropic|claude/i, "Claude"],
  [/openai|chatgpt/i, "ChatGPT"],
];

/** "Anthropic/Toolbox" → "Claude", "openai-mcp" → "ChatGPT"; anything else as given. */
export function friendlyAppName(raw: string | undefined): string | undefined {
  const name = raw?.trim();
  if (!name) return undefined;
  return APP_NAMES.find(([re]) => re.test(name))?.[1] ?? name;
}

export type SourceKind = "ai" | "extension" | "app";

export interface SourceLabel {
  kind: SourceKind;
  label: string; // "Claude", "Chrome extension · Gmail", "Added in EisenQ"
  url?: string;  // link back to the email or page, captures only
}

export function describeSource(source: TaskSourceLike | undefined): SourceLabel {
  if (!source) return { kind: "app", label: "Added in EisenQ" };
  if (source.kind === "agent") return { kind: "ai", label: friendlyAppName(source.title) ?? "an AI app" };
  const url = source.url && /^https?:\/\//i.test(source.url) ? source.url : undefined;
  if (source.kind === "gmail") return { kind: "extension", label: "Chrome extension · Gmail", url };
  return { kind: "extension", label: "Chrome extension", url };
}
