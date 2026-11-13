import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { AssistantError, hasAssistantKey, runAssistant } from "~/server/assistant";

// Claude can take a while on a full matrix.
export const maxDuration = 120;

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(30)
    .refine((m) => m[m.length - 1]?.role === "user", "Last message must be from the user"),
});

// Whether the assistant is usable (a Claude key is saved). Never returns the key.
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ enabled: await hasAssistantKey(userId) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to check the assistant" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await runAssistant(userId, parsed.data.messages);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AssistantError) {
      const status = error.code === "rate_limited" ? 429 : error.code === "failed" ? 502 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "The assistant failed. Try again.", code: "failed" }, { status: 500 });
  }
}
