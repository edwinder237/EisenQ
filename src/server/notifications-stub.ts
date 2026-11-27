import { NextResponse } from "next/server";

// Every /api/notifications/* handler answers this until the backend is built.
// The front end runs in "mock" mode meanwhile; see docs/notifications/README.md.
export function notImplemented(todo: string) {
  return NextResponse.json({ error: "Notifications backend not implemented yet", todo }, { status: 501 });
}

export function badRequest(error: unknown) {
  return NextResponse.json({ error: "Invalid request", details: error }, { status: 400 });
}
