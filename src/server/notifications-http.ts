import { NextResponse } from "next/server";

/** 400 for a request body that fails the shared zod schemas in ~/lib/notifications/schema.ts. */
export function badRequest(error: unknown) {
  return NextResponse.json({ error: "Invalid request", details: error }, { status: 400 });
}
