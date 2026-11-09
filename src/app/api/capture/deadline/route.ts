import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { userSettingsCollection } from "~/server/db";
import { decrypt } from "~/server/crypto";
import { DeadlineServiceError, detectDeadline, isValidTimeZone } from "~/server/deadline";

// POST /api/capture/deadline — the capture form asks for the deadline in what the
// user just captured. Clerk-authenticated like the rest of the app (the form is a
// signed-in page), and the user's own Gemini key is decrypted here, server-side,
// so it never reaches the browser.

// Per user, so a stuck page can't run up the user's Gemini bill. Per-instance on
// serverless, like the app's other limiters.
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

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!checkRateLimit(userId)) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const parsed = deadlineSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data;

    if (!input.title.trim() && !input.text.trim()) {
      return NextResponse.json({ configured: true, dueDate: null });
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
      return NextResponse.json({ configured: false, dueDate: null });
    }

    const result = await detectDeadline(apiKey, input);
    return NextResponse.json({ configured: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof DeadlineServiceError || (err instanceof Error && err.name === "TimeoutError")) {
      return NextResponse.json({ error: "Deadline check unavailable" }, { status: 502 });
    }
    return NextResponse.json({ error: "Failed to check for a deadline" }, { status: 500 });
  }
}
