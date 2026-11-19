import { z } from "zod";
import { userSettingsCollection } from "~/server/db";
import type { McpActivity, McpClient, McpPermissions, McpPreferences, McpSettings } from "~/server/db/schema";
import { DEFAULT_TIME_ZONE, isValidTimeZone, ymdInZone } from "~/server/timezone";
import { taskQuadrantSchema } from "~/server/task-service";

// Settings for AI connectors (MCP): what an outside AI app may do, how it
// should do it, which apps have connected, and what they did.

export const MCP_RESOURCE_URL = "https://www.eisenq.app/api/mcp";
export const MCP_METADATA_URL = "https://www.eisenq.app/.well-known/oauth-protected-resource/api/mcp";

export const ACTIVITY_CAP = 50;
const CLIENT_CAP = 20;

export const DEFAULT_MCP_PERMISSIONS: McpPermissions = {
  readTasks: true,
  createTasks: true,
  editTasks: true,
  completeTasks: true,
  deleteTasks: false,
  readGoals: true,
  editGoals: false,
};

export const DEFAULT_MCP_PREFERENCES: McpPreferences = {
  defaultQuadrant: "important-not-urgent",
  deleteMode: "archive",
  labelAiTasks: true,
  shareCompleted: false,
  dailyWriteLimit: 50,
  timeZone: DEFAULT_TIME_ZONE,
};

/** Fills in defaults for anything never saved, so readers never see a partial object. */
export function normalizeMcpSettings(mcp?: Partial<McpSettings>): McpSettings {
  const prefs = { ...DEFAULT_MCP_PREFERENCES, ...mcp?.preferences };
  if (!isValidTimeZone(prefs.timeZone)) prefs.timeZone = DEFAULT_TIME_ZONE;
  return {
    enabled: mcp?.enabled ?? false,
    permissions: { ...DEFAULT_MCP_PERMISSIONS, ...mcp?.permissions },
    preferences: prefs,
    clients: mcp?.clients ?? [],
    activity: mcp?.activity ?? [],
    writes: mcp?.writes,
  };
}

// What the Settings tab may change. Clients and activity are server-written.
export const mcpSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  permissions: z
    .object({
      readTasks: z.boolean(),
      createTasks: z.boolean(),
      editTasks: z.boolean(),
      completeTasks: z.boolean(),
      deleteTasks: z.boolean(),
      readGoals: z.boolean(),
      editGoals: z.boolean(),
    })
    .partial()
    .optional(),
  preferences: z
    .object({
      defaultQuadrant: taskQuadrantSchema,
      deleteMode: z.enum(["archive", "delete"]),
      labelAiTasks: z.boolean(),
      shareCompleted: z.boolean(),
      dailyWriteLimit: z.number().int().min(1).max(500),
      timeZone: z.string().max(64).refine(isValidTimeZone, "Unknown time zone"),
    })
    .partial()
    .optional(),
});
export type McpSettingsUpdate = z.infer<typeof mcpSettingsUpdateSchema>;

/** Dot-path $set entries for a settings update, so unrelated fields are left alone. */
export function mcpUpdateToSet(update: McpSettingsUpdate): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (update.enabled !== undefined) set["mcp.enabled"] = update.enabled;
  for (const [k, v] of Object.entries(update.permissions ?? {})) {
    if (v !== undefined) set[`mcp.permissions.${k}`] = v;
  }
  for (const [k, v] of Object.entries(update.preferences ?? {})) {
    if (v !== undefined) set[`mcp.preferences.${k}`] = v;
  }
  return set;
}

export async function loadMcpSettings(userId: string): Promise<{ mcp: McpSettings; autoArchiveCompleted: boolean }> {
  const doc = await userSettingsCollection.findOne(
    { userId },
    { projection: { mcp: 1, autoArchiveCompleted: 1 } },
  );
  return { mcp: normalizeMcpSettings(doc?.mcp), autoArchiveCompleted: doc?.autoArchiveCompleted ?? false };
}

/**
 * Records that `clientId` called in. Adds it on first sight, otherwise bumps
 * lastUsedAt and keeps the best name we have. Returns the stored entry.
 */
export async function touchClient(userId: string, mcp: McpSettings, clientId: string, name?: string): Promise<McpClient> {
  const now = new Date();
  const existing = mcp.clients.find((c) => c.clientId === clientId);
  if (existing) {
    // Names come from a known-host mapping first, so a fresh one is at least as good as what's stored.
    const better = name && name !== existing.name ? name : undefined;
    await userSettingsCollection.updateOne(
      { userId, "mcp.clients.clientId": clientId },
      { $set: { "mcp.clients.$.lastUsedAt": now, ...(better ? { "mcp.clients.$.name": better } : {}) } },
    );
    return { ...existing, lastUsedAt: now, name: better ?? existing.name };
  }
  const entry: McpClient = { clientId, name: name ?? clientId, firstSeenAt: now, lastUsedAt: now, blocked: false };
  await userSettingsCollection.updateOne(
    { userId, "mcp.clients.clientId": { $ne: clientId } },
    {
      // Keep the most recently used apps if someone connects a great many, but
      // never drop a blocked one: it would come back unblocked on its next call.
      $push: { "mcp.clients": { $each: [entry], $sort: { blocked: -1, lastUsedAt: -1 }, $slice: CLIENT_CAP } },
      $set: { updatedAt: now },
    },
  );
  return entry;
}

export async function setClientBlocked(userId: string, clientId: string, blocked: boolean): Promise<boolean> {
  const res = await userSettingsCollection.updateOne(
    { userId, "mcp.clients.clientId": clientId },
    { $set: { "mcp.clients.$.blocked": blocked, updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

export async function logActivity(userId: string, entry: Omit<McpActivity, "at">): Promise<void> {
  await userSettingsCollection.updateOne(
    { userId },
    { $push: { "mcp.activity": { $each: [{ ...entry, at: new Date() }], $position: 0, $slice: ACTIVITY_CAP } } },
  );
}

/**
 * Counts one write against today's limit (the day as the person sees it).
 * Atomic: two calls racing for the last slot can't both win. Returns false
 * when the limit is already reached.
 */
export async function takeWriteSlot(userId: string, prefs: McpPreferences): Promise<boolean> {
  const day = ymdInZone(new Date(), prefs.timeZone);
  // New day (or never counted): reset to 1.
  const reset = await userSettingsCollection.updateOne(
    { userId, "mcp.writes.day": { $ne: day } },
    { $set: { "mcp.writes": { day, count: 1 } } },
  );
  if (reset.modifiedCount > 0) return true;
  const inc = await userSettingsCollection.updateOne(
    { userId, "mcp.writes.day": day, "mcp.writes.count": { $lt: prefs.dailyWriteLimit } },
    { $inc: { "mcp.writes.count": 1 } },
  );
  return inc.modifiedCount > 0;
}
