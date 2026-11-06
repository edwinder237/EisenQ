import crypto from "crypto";
import { tasksCollection, userSettingsCollection } from "~/server/db";

// Capture tokens authenticate the browser extension, which can't carry the Clerk
// session cookie across origins. The token is shown to the extension exactly once
// and only its SHA-256 hash is stored, so a database leak yields nothing usable.
//
// Hashing (not the AES helper in crypto.ts) is deliberate: the server never needs
// the token back, only to recognise one.

// A recognisable prefix makes a leaked token easy to spot in logs and lets
// secret scanners flag it.
const TOKEN_PREFIX = "eqc_";

export function generateCaptureToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function hashCaptureToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// "Chrome on macOS" — enough to tell connected browsers apart in Settings
// without storing the raw user agent.
export function labelFromUserAgent(ua: string | null): string {
  if (!ua) return "Unknown browser";

  const browser = ua.includes("Edg/")
    ? "Edge"
    : ua.includes("OPR/")
      ? "Opera"
      : ua.includes("Brave")
        ? "Brave"
        : ua.includes("Chrome/")
          ? "Chrome"
          : "Browser";

  const os = ua.includes("Mac OS X")
    ? "macOS"
    : ua.includes("Windows")
      ? "Windows"
      : ua.includes("CrOS")
        ? "ChromeOS"
        : ua.includes("Linux")
          ? "Linux"
          : "unknown OS";

  return `${browser} on ${os}`;
}

// The two lookups on the capture path. Created lazily, once per server instance,
// and never awaited: queries work without them, only slower, so a failed or slow
// createIndex must never hold up a capture. createIndex is a no-op when the index
// already exists.
//
// The token index is deliberately NOT unique. A unique index on an array path
// treats an empty `captureTokens: []` as a key, so the second user to disconnect
// their last browser would hit a duplicate-key error — and 256-bit tokens can't
// collide anyway.
let indexesRequested: Promise<unknown> | null = null;

function ensureCaptureIndexes() {
  indexesRequested ??= Promise.all([
    userSettingsCollection.createIndex({ "captureTokens.hash": 1 }, { name: "captureTokens_hash" }),
    tasksCollection.createIndex(
      { userId: 1, "source.externalId": 1 },
      {
        name: "userId_sourceExternalId",
        partialFilterExpression: { "source.externalId": { $exists: true } },
      },
    ),
  ]).catch(() => {
    indexesRequested = null; // try again on the next capture
  });
  return indexesRequested;
}

// Resolves a presented token to its owner. The lookup is by hash on an indexed
// field, so there is no secret-dependent comparison to time: a wrong token is
// simply a miss.
export async function findUserIdByCaptureToken(token: string): Promise<string | null> {
  void ensureCaptureIndexes();
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  const hash = hashCaptureToken(token);
  const settings = await userSettingsCollection.findOne(
    { "captureTokens.hash": hash },
    { projection: { userId: 1 } },
  );
  if (!settings) return null;

  // Fire-and-forget: a failed timestamp must never fail the capture.
  void userSettingsCollection
    .updateOne(
      { "captureTokens.hash": hash },
      { $set: { "captureTokens.$.lastUsedAt": new Date() } },
    )
    .catch(() => undefined);

  return settings.userId;
}
