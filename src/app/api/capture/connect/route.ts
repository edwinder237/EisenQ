import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { userSettingsCollection } from "~/server/db";
import {
  generateCaptureToken,
  hashCaptureToken,
  labelFromUserAgent,
} from "~/server/capture-token";

// /api/capture/connect — manages the browsers connected to the capture extension.
// Clerk-authenticated like the rest of the app; only /api/capture itself takes a
// token. Tokens are minted here by the /connect-extension page and handed straight
// to the extension, so the user never sees or copies one.

// Generous for one person's browsers, and stops the array growing without bound.
const MAX_CONNECTED_BROWSERS = 10;

// Defence in depth against a cross-site POST minting tokens: the response could
// never be read cross-origin anyway, but there's no reason to create the entry.
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetches from some browsers omit it
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

// GET — list connected browsers. `id` is the token's hash: not reversible, and
// only ever shown to the user who owns it.
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settings = await userSettingsCollection.findOne(
      { userId },
      { projection: { captureTokens: 1 } },
    );

    const browsers = (settings?.captureTokens ?? []).map((t) => ({
      id: t.hash,
      label: t.label,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt ?? null,
    }));

    return NextResponse.json({ browsers }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to load connected browsers" }, { status: 500 });
  }
}

// POST — mint a token for a newly connected browser. The token is returned once
// and never again; only its hash is stored.
export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isSameOrigin(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await userSettingsCollection.findOne(
      { userId },
      { projection: { captureTokens: 1 } },
    );
    if ((existing?.captureTokens?.length ?? 0) >= MAX_CONNECTED_BROWSERS) {
      return NextResponse.json(
        { error: `You already have ${MAX_CONNECTED_BROWSERS} browsers connected. Disconnect one first.` },
        { status: 409 },
      );
    }

    const token = generateCaptureToken();
    const label = labelFromUserAgent(request.headers.get("user-agent"));
    const now = new Date();

    await userSettingsCollection.updateOne(
      { userId },
      {
        $push: { captureTokens: { hash: hashCaptureToken(token), label, createdAt: now } },
        $set: { updatedAt: now },
        $setOnInsert: { userId, createdAt: now },
      },
      { upsert: true },
    );

    return NextResponse.json({ token, label }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to connect browser" }, { status: 500 });
  }
}

// DELETE ?id=<hash> — disconnect one browser. Its next capture gets a 401.
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isSameOrigin(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const id = request.nextUrl.searchParams.get("id");
    if (!id || !/^[0-9a-f]{64}$/.test(id)) {
      return NextResponse.json({ error: "A valid browser id is required" }, { status: 400 });
    }

    const result = await userSettingsCollection.updateOne(
      { userId, "captureTokens.hash": id },
      { $pull: { captureTokens: { hash: id } }, $set: { updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Browser not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to disconnect browser" }, { status: 500 });
  }
}
