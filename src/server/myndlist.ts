import { userSettingsCollection } from "~/server/db";
import { decrypt } from "~/server/crypto";
import { safeFetch } from "~/server/safe-fetch";
import type { TaskChecklist, TaskChecklistStep } from "~/server/db/schema";
import { isBlankStep, mergeStepsIntoSections, type EditedStep } from "~/lib/checklist-steps";

// One place that knows how to talk to a user's Myndlist account, so the library
// drawer, the attach picker and the Settings "Test connection" button all
// exercise the same request path. Mirrors src/server/finance.ts deliberately.
//
// Myndlist stores the reusable checklists; the ticked copy lives on the task
// (see TaskChecklist in db/schema.ts) and never travels back here, except when
// the user explicitly pushes edits to the template. Where per-task progress
// should ultimately live is still open; nothing here assumes it stays on the task.

export interface MyndlistCredentials {
  apiUrl: string;
  apiKey: string;
}

/** Shapes returned by the Myndlist REST API (docs/API.md in edwinder237/myndlist). */
export interface MyndlistItem { id: string; text: string; done: boolean; note?: string; optional?: boolean }
export interface MyndlistSection { id: string; title: string; collapsed?: boolean; items: MyndlistItem[] }
export interface MyndlistChecklist {
  id: string;
  title: string;
  subtitle?: string;
  sections: MyndlistSection[];
  createdAt?: string;
  updatedAt?: string;
}

export interface FlatStep {
  id: string;
  text: string;
  done: boolean;
  optional: boolean;
  note: string;
}

/** A Myndlist checklist as this app consumes it: one flat, ordered step list. */
export interface FlatTemplate {
  id: string;
  name: string;
  /** Blank items are left out: they count for nothing and only show as empty rows. */
  steps: FlatStep[];
  /** Kept so a step can be written back to the right place in Myndlist. */
  lastSectionId: string | null;
}

/** A template step as the browser sees it in the library. */
export function publicStep(step: FlatStep) {
  return { id: step.id, text: step.text, optional: step.optional, note: step.note };
}

/**
 * Reads the caller's stored Myndlist credentials. Per-user and encrypted at
 * rest: a shared server credential would show one person's checklists to every
 * signed-in user.
 */
export async function loadMyndlistCredentials(userId: string): Promise<MyndlistCredentials> {
  const doc = await userSettingsCollection.findOne({ userId });
  const read = (enc?: string) => {
    if (!enc) return "";
    try { return decrypt(enc); } catch { return ""; } // corrupt, or encrypted under a rotated key
  };
  return {
    apiUrl: read(doc?.myndlistApiUrlEnc),
    apiKey: read(doc?.myndlistApiKeyEnc),
  };
}

/**
 * Normalises whatever the user pasted into a base ending in /api/v1, so both
 * "https://myndlist.example.com" and ".../api/v1" (with or without a trailing
 * slash) work. Returns null if it isn't a usable absolute URL.
 */
export function normaliseBase(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let u: URL;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const base = u.toString().replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export type MyndlistResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "bad-url" }
  | { outcome: "unreachable"; host: string }
  | { outcome: "http-error"; status: number; code: string; message: string }
  | { outcome: "bad-json" };

interface MyndlistErrorBody { error?: { code?: string; message?: string } }

/**
 * Issues one authenticated request. `path` is relative to the /api/v1 base,
 * e.g. "/checklists" or "/checklists/abc/items/xyz".
 */
export async function callMyndlist<T>(
  creds: MyndlistCredentials,
  path: string,
  init?: RequestInit
): Promise<MyndlistResult<T>> {
  const base = normaliseBase(creds.apiUrl);
  if (!base) return { outcome: "bad-url" };

  const url = `${base}${path}`;
  let res: Response;
  try {
    // The base URL comes from the user, so it goes through the same guard as
    // calendar feeds and CashFold — otherwise this is a proxy into the private
    // network. Note this also refuses a Myndlist on localhost, by design.
    res = await safeFetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    let host = "that host";
    try { host = new URL(url).host; } catch { /* base already validated, belt and braces */ }
    return { outcome: "unreachable", host };
  }

  if (!res.ok) {
    let code = "http_error";
    let message = `Myndlist responded with HTTP ${res.status}.`;
    try {
      const body = (await res.json()) as MyndlistErrorBody;
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch { /* non-JSON error body */ }
    return { outcome: "http-error", status: res.status, code, message };
  }

  try {
    return { outcome: "ok", data: (await res.json()) as T };
  } catch {
    return { outcome: "bad-json" };
  }
}

/**
 * Collapses Myndlist's sections into the single ordered list this app's design
 * shows. Section titles are not displayed here, and nothing is destroyed: edits
 * are written back with mergeStepsIntoSections, which keeps sections, ids,
 * notes and optional flags intact in Myndlist.
 */
export function flattenChecklist(checklist: MyndlistChecklist): FlatTemplate {
  const sections = checklist.sections ?? [];
  const steps = sections.flatMap((section) =>
    (section.items ?? [])
      .filter((item) => !isBlankStep(item))
      .map((item) => ({
        id: item.id,
        text: item.text,
        done: Boolean(item.done),
        optional: item.optional === true,
        note: typeof item.note === "string" ? item.note : "",
      }))
  );
  return {
    id: checklist.id,
    name: checklist.title || "Untitled checklist",
    steps,
    lastSectionId: sections.length ? (sections[sections.length - 1]?.id ?? null) : null,
  };
}

/**
 * Deep-copies a template's steps for attachment to a task. Fresh ids, every step
 * unticked: the instance is independent from this moment on, so editing the
 * template later does not rewrite history on tasks that already ran it. The
 * optional flag and note come along, and `sourceItemId` remembers which
 * Myndlist item each step came from so "Save changes to checklist" can update
 * that item in place.
 */
export function copyStepsForAttach(template: FlatTemplate): TaskChecklistStep[] {
  return template.steps.map((step, index) => ({
    id: crypto.randomUUID(),
    text: step.text,
    order: index,
    done: false,
    optional: step.optional,
    ...(step.note ? { note: step.note } : {}),
    sourceItemId: step.id,
  }));
}

/**
 * Saves an edited flat step list back to a Myndlist checklist without losing
 * what this app doesn't show: reads the checklist as it is now, merges the
 * edits into it (see mergeStepsIntoSections), and writes the result.
 */
export async function saveStepsToMyndlist(
  creds: MyndlistCredentials,
  checklistId: string,
  steps: EditedStep[],
  extra: { title?: string } = {}
): Promise<MyndlistResult<{ checklist: MyndlistChecklist }>> {
  const path = `/checklists/${encodeURIComponent(checklistId)}`;
  const current = await callMyndlist<{ checklist: MyndlistChecklist }>(creds, path);
  if (current.outcome !== "ok") return current;

  const sections = mergeStepsIntoSections(current.data.checklist.sections ?? [], steps);
  return callMyndlist<{ checklist: MyndlistChecklist }>(creds, path, {
    method: "PATCH",
    body: JSON.stringify({ ...extra, sections }),
  });
}

/**
 * Fetches a template and deep-copies it into a TaskChecklist, ready to push
 * onto a task. Shared by the attach picker and routine runs so a copy is made
 * the same way wherever it comes from. Returns an error message on failure.
 */
export async function copyChecklistFromMyndlist(
  userId: string,
  creds: MyndlistCredentials,
  sourceId: string,
  order: number,
): Promise<{ checklist: TaskChecklist } | { error: string }> {
  const result = await callMyndlist<{ checklist: MyndlistChecklist }>(creds, `/checklists/${encodeURIComponent(sourceId)}`);
  if (result.outcome !== "ok") {
    return { error: result.outcome === "http-error" ? result.message : "Couldn't reach Myndlist." };
  }
  const flat = flattenChecklist(result.data.checklist);
  const settings = await userSettingsCollection.findOne({ userId });
  return {
    checklist: {
      id: crypto.randomUUID(),
      sourceId: flat.id,
      name: flat.name,
      blockCompletion: settings?.checklistGates?.[flat.id] ?? false,
      order,
      steps: copyStepsForAttach(flat),
      attachedAt: new Date(),
    },
  };
}
