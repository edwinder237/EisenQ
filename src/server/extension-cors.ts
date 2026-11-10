import { NextResponse } from "next/server";
import { EXTENSION_ORIGIN } from "~/lib/extension";

// CORS for the routes the capture extension calls directly (POST /api/capture,
// POST /api/capture/deadline). Only the extension may call them cross-origin;
// any other origin gets no CORS headers at all, so the browser blocks it from
// reading the response.
export function extensionCorsHeaders(origin: string | null): Record<string, string> {
  if (origin !== EXTENSION_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Capture-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function extensionJson(body: unknown, status: number, origin: string | null, extra?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { ...extensionCorsHeaders(origin), ...extra } });
}

export function extensionPreflight(origin: string | null) {
  return new NextResponse(null, { status: 204, headers: extensionCorsHeaders(origin) });
}
