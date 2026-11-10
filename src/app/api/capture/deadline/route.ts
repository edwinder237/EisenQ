import { type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { userSettingsCollection } from "~/server/db";
import { decrypt } from "~/server/crypto";
import { findUserIdByCaptureToken } from "~/server/capture-token";
import { extensionJson as json, extensionPreflight } from "~/server/extension-cors";
import { DeadlineServiceError, detectKeyDate, isValidTimeZone } from "~/server/deadline";

// POST /api/capture/deadline — asks for the date that matters in what the user
// just captured: a deadline, or an event worth a reminder.
//
// Two callers, two kinds of authentication, both checked here before anything is
// read: the app's own /capture page sends the Clerk session cookie, and the
// extension's side panel sends its X-Capture-Token (it can't carry the cookie).
// That is why this route is listed in isPublicRoute in middleware.ts — "public"
// there only means the middleware doesn't insist on Clerk.
//
// The user's own Gemini key is decrypted here, server-side, so it never reaches
// the browser.

// Per IP before authenticating, so guessing tokens can't hammer the database, and
// per user after, so a stuck page can't run up the user's Gemini bill.
// Per-instance on serverless, like the app's other limiters.
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 20;
const RATE_WINDOW = 60_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  for (const [k, val] of rateLimitMap) {
    if (now > val.resetTime) rateLimitMap.delete(k);
  }
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

const deadlineSchema = z.object({
  title: z.string().max(500),
  text: z.string().max(8000).default(""),
  sentAt: z.string().max(100).optional(),
  timeZone: z.string().max(64).refine(isValidTimeZone, "Unknown time zone"),
});

export async function OPTIONS(request: NextRequest) {
  return extensionPreflight(request.headers.get("origin"));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!checkRateLimit(`ip:${ip}`)) {
      return json({ error: "Too many requests" }, 429, origin);
    }

    const { userId: sessionUserId } = await auth();
    const token = request.headers.get("x-capture-token");
    const userId = sessionUserId ?? (token ? await findUserIdByCaptureToken(token) : null);
    if (!userId) {
      return json({ error: "Unauthorized" }, 401, origin);
    }
    if (!checkRateLimit(`user:${userId}`)) {
      return json({ error: "Too many requests" }, 429, origin);
    }

    const parsed = deadlineSchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: "Invalid request data", details: parsed.error.flatten() }, 400, origin);
    }
    const input = parsed.data;

    if (!input.title.trim() && !input.text.trim()) {
      return json({ configured: true, date: null }, 200, origin);
    }

    const settings = await userSettingsCollection.findOne(
      { userId },
      { projection: { geminiApiKeyEnc: 1 } },
    );
    let apiKey = "";
    if (settings?.geminiApiKeyEnc) {
      try { apiKey = decrypt(settings.geminiApiKeyEnc); } catch { /* corrupt/rotated key */ }
    }
    if (!apiKey) {
      return json({ configured: false, date: null }, 200, origin);
    }

    const result = await detectKeyDate(apiKey, input);
    return json({ configured: true, ...result }, 200, origin, { "Cache-Control": "no-store" });
  } catch (err) {
    if (err instanceof DeadlineServiceError || (err instanceof Error && err.name === "TimeoutError")) {
      return json({ error: "Deadline check unavailable" }, 502, origin);
    }
    return json({ error: "Failed to check for a deadline" }, 500, origin);
  }
}
