import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { ensureRoutineRuns } from "~/server/routine-runs";

// POST /api/routine/runs — create the runs (tasks with fresh checklist copies)
// for routine items that are up today. The dashboard calls it on load; it's
// idempotent, so calling it again only fills in what's missing.

const bodySchema = z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

    return NextResponse.json(await ensureRoutineRuns(userId, parsed.data.today));
  } catch (err) {
    console.error("Routine runs: request failed", err);
    return NextResponse.json({ error: "Failed to prepare routine runs" }, { status: 500 });
  }
}
