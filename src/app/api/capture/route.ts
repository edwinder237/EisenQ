import { type NextRequest } from "next/server";
import { z } from "zod";
import { tasksCollection } from "~/server/db";
import type { Task } from "~/server/db/schema";
import { findUserIdByCaptureToken } from "~/server/capture-token";
import { extensionJson as json, extensionPreflight } from "~/server/extension-cors";

// POST /api/capture — the browser capture extension files a task here.
//
// Authenticated by X-Capture-Token, NOT by Clerk: the extension's origin can't
// carry the session cookie. That is why this route is listed in isPublicRoute in
// middleware.ts — "public" there only means the middleware doesn't check Clerk.
// Every request is still authenticated below, before anything is read or written.

// Simple in-memory rate limiting, per IP, applied BEFORE the token lookup so that
// guessing tokens can't hammer the database. Per-instance on serverless, like the
// limiters in the other routes — adequate for a single-user tool with 256-bit
// tokens, not a hard guarantee (design doc, Pitfall 9).
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetTime) rateLimitMap.delete(key);
  }
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// source.url becomes a clickable link in the dashboard, so it must be http(s).
// z.string().url() alone accepts javascript: URLs.
const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "URL must be http or https");

const captureSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(500, "Title too long"),
  description: z.string().max(5000, "Description too long").optional(),
  quadrant: z.enum([
    "urgent-important",
    "important-not-urgent",
    "urgent-not-important",
    "not-urgent-not-important",
  ]),
  priority: z.enum(["high", "medium", "low"]).optional(),
  // Full ISO datetime, same as POST /api/tasks — "2026-11-07" alone is rejected.
  dueDate: z.string().datetime().optional(),
  source: z
    .object({
      kind: z.enum(["gmail", "page", "selection"]),
      url: httpUrl,
      title: z.string().max(500).optional(),
      from: z.string().max(320).optional(),
      externalId: z.string().max(200).optional(),
    })
    .optional(),
});

export async function OPTIONS(request: NextRequest) {
  return extensionPreflight(request.headers.get("origin"));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!checkRateLimit(ip)) {
      return json({ error: "Too many requests" }, 429, origin);
    }

    const token = request.headers.get("x-capture-token");
    const userId = token ? await findUserIdByCaptureToken(token) : null;
    if (!userId) {
      return json({ error: "Unauthorized" }, 401, origin);
    }

    const rawBody: unknown = await request.json();
    const parsed = captureSchema.safeParse(rawBody);
    if (!parsed.success) {
      return json(
        { error: "Invalid request data", details: parsed.error.flatten() },
        400,
        origin,
      );
    }
    const body = parsed.data;

    // Dedupe on externalId ONLY — never on source.url. One offers page holds many
    // separately actionable items that share a URL; a URL-keyed rule would accept
    // the first and silently return it for every capture after (Pitfall 18).
    const externalId = body.source?.externalId;
    if (externalId) {
      const existing = await tasksCollection.findOne({
        userId,
        "source.externalId": externalId,
        status: { $ne: "completed" },
        // null matches "missing" too; same cast as the tasks route uses.
        archivedAt: null as unknown as undefined,
      });
      if (existing) {
        return json({ task: existing, deduped: true }, 200, origin);
      }
    }

    const now = new Date();
    const newTask: Task = {
      title: body.title,
      description: body.description,
      quadrant: body.quadrant,
      // Mirrors the dashboard's rule: Do First is always high priority.
      priority: body.quadrant === "urgent-important" ? "high" : (body.priority ?? "medium"),
      status: "pending",
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      source: body.source ? { ...body.source, capturedAt: now } : undefined,
      createdAt: now,
      updatedAt: now,
      userId,
      // parentTaskId and archivedAt are deliberately never set: GET /api/tasks
      // filters both on null, so either would hide the task from the matrix.
    };

    const result = await tasksCollection.insertOne(newTask);
    return json({ task: { ...newTask, _id: result.insertedId }, deduped: false }, 201, origin);
  } catch {
    return json({ error: "Failed to capture task" }, 500, origin);
  }
}
