import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { setClientBlocked } from "~/server/mcp-settings";

// Revoke or re-allow a connected AI app. Signed-in only (Clerk session,
// not an MCP token), and applied at once rather than waiting for Save: revoking
// is a security action. The very next call from a revoked app is refused.

const schema = z.object({
  clientId: z.string().min(1).max(500),
  action: z.enum(["revoke", "allow"]),
});

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request data" }, { status: 400 });

  const { clientId, action } = parsed.data;
  try {
    if (!(await setClientBlocked(userId, clientId, action === "revoke"))) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to update app access" }, { status: 500 });
  }
}
