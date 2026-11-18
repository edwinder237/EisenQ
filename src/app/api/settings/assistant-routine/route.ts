import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { forgetRoutine, normalizeRoutineUrl, routineStatus, saveRoutine } from "~/server/assistant-routine";

// The Claude Code routine the Delegate quadrant fires. GET never returns the
// token; PUT replaces both values; DELETE disconnects.

const NO_STORE = { "Cache-Control": "no-store" };

const putSchema = z.object({
  url: z.string().min(1).max(300),
  token: z.string().min(20).max(500),
});

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await routineStatus(userId), { headers: NO_STORE });
}

export async function PUT(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Paste both the trigger URL and the token." }, { status: 400 });

  const url = normalizeRoutineUrl(parsed.data.url);
  if (!url) {
    return NextResponse.json(
      { error: "That isn't a routine trigger URL. It looks like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" },
      { status: 400 },
    );
  }
  const token = parsed.data.token.trim();
  if (!token.startsWith("sk-ant-")) {
    return NextResponse.json({ error: "That isn't a routine token. It starts with sk-ant-oat01-." }, { status: 400 });
  }

  await saveRoutine(userId, url, token);
  return NextResponse.json(await routineStatus(userId), { headers: NO_STORE });
}

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await forgetRoutine(userId);
  return NextResponse.json({ connected: false }, { headers: NO_STORE });
}
