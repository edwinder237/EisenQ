import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { userSettingsCollection } from "~/server/db";
import { encrypt, decrypt } from "~/server/crypto";

const updateSettingsSchema = z.object({
  geminiApiKey: z.string().max(200).optional(),
  icalUrls: z.array(z.string().url()).max(10).optional(),
  autoArchiveCompleted: z.boolean().optional(),
  financeApiUrl: z.string().max(500).optional(),
  financeApiKey: z.string().max(200).optional(),
  financeUserId: z.string().max(200).optional(),
  myndlistApiUrl: z.string().max(500).optional(),
  myndlistApiKey: z.string().max(200).optional(),
  anthropicApiKey: z.string().max(300).optional(),
});

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const doc = await userSettingsCollection.findOne({ userId });

    let geminiApiKey = "";
    let icalUrls: string[] = [];
    let financeApiUrl = "";
    let financeApiKey = "";
    let financeUserId = "";
    let myndlistApiUrl = "";
    let myndlistApiKey = "";
    let anthropicApiKey = "";

    if (doc?.geminiApiKeyEnc) {
      try { geminiApiKey = decrypt(doc.geminiApiKeyEnc); } catch { /* corrupt/rotated key */ }
    }
    if (doc?.icalUrlsEnc) {
      try { icalUrls = JSON.parse(decrypt(doc.icalUrlsEnc)) as string[]; } catch { /* corrupt/rotated key */ }
    }
    if (doc?.financeApiUrlEnc) {
      try { financeApiUrl = decrypt(doc.financeApiUrlEnc); } catch { /* corrupt/rotated key */ }
    }
    if (doc?.financeApiKeyEnc) {
      try { financeApiKey = decrypt(doc.financeApiKeyEnc); } catch { /* corrupt/rotated key */ }
    }
    if (doc?.financeUserIdEnc) {
      try { financeUserId = decrypt(doc.financeUserIdEnc); } catch { /* corrupt/rotated key */ }
    }
    if (doc?.myndlistApiUrlEnc) {
      try { myndlistApiUrl = decrypt(doc.myndlistApiUrlEnc); } catch { /* corrupt/rotated key */ }
    }
    if (doc?.myndlistApiKeyEnc) {
      try { myndlistApiKey = decrypt(doc.myndlistApiKeyEnc); } catch { /* corrupt/rotated key */ }
    }
    if (doc?.anthropicApiKeyEnc) {
      try { anthropicApiKey = decrypt(doc.anthropicApiKeyEnc); } catch { /* corrupt/rotated key */ }
    }

    return NextResponse.json(
      { geminiApiKey, icalUrls, autoArchiveCompleted: doc?.autoArchiveCompleted ?? false, financeApiUrl, financeApiKey, financeUserId, myndlistApiUrl, myndlistApiKey, anthropicApiKey },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody: unknown = await request.json();
    const parsed = updateSettingsSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { geminiApiKey, icalUrls, autoArchiveCompleted, financeApiUrl, financeApiKey, financeUserId, myndlistApiUrl, myndlistApiKey, anthropicApiKey } = parsed.data;

    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, ""> = {};

    if (geminiApiKey !== undefined) {
      if (geminiApiKey.trim()) set.geminiApiKeyEnc = encrypt(geminiApiKey.trim());
      else unset.geminiApiKeyEnc = "";
    }
    if (icalUrls !== undefined) {
      if (icalUrls.length) set.icalUrlsEnc = encrypt(JSON.stringify(icalUrls));
      else unset.icalUrlsEnc = "";
    }
    if (autoArchiveCompleted !== undefined) {
      set.autoArchiveCompleted = autoArchiveCompleted;
    }
    if (financeApiUrl !== undefined) {
      if (financeApiUrl.trim()) set.financeApiUrlEnc = encrypt(financeApiUrl.trim());
      else unset.financeApiUrlEnc = "";
    }
    if (financeApiKey !== undefined) {
      if (financeApiKey.trim()) set.financeApiKeyEnc = encrypt(financeApiKey.trim());
      else unset.financeApiKeyEnc = "";
    }
    if (financeUserId !== undefined) {
      if (financeUserId.trim()) set.financeUserIdEnc = encrypt(financeUserId.trim());
      else unset.financeUserIdEnc = "";
    }
    if (myndlistApiUrl !== undefined) {
      if (myndlistApiUrl.trim()) set.myndlistApiUrlEnc = encrypt(myndlistApiUrl.trim());
      else unset.myndlistApiUrlEnc = "";
    }
    if (myndlistApiKey !== undefined) {
      if (myndlistApiKey.trim()) set.myndlistApiKeyEnc = encrypt(myndlistApiKey.trim());
      else unset.myndlistApiKeyEnc = "";
    }
    if (anthropicApiKey !== undefined) {
      if (anthropicApiKey.trim()) set.anthropicApiKeyEnc = encrypt(anthropicApiKey.trim());
      else unset.anthropicApiKeyEnc = "";
    }

    const update: Record<string, unknown> = {
      $set: set,
      $setOnInsert: { userId, createdAt: new Date() },
    };
    if (Object.keys(unset).length) update.$unset = unset;

    await userSettingsCollection.updateOne({ userId }, update, { upsert: true });

    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
