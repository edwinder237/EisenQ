import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Deny by default: everything the matcher below reaches requires a signed-in
// user unless it is listed here. A new route is private until it is added,
// rather than public until someone remembers to guard it.
//
// /capture and /connect-extension need no entry: being private is what gives a
// signed-out user the sign-in screen and returns them to the page afterwards.
// See docs/chrome-extension-capture-design.md.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/contact",
  // NOT unauthenticated: the capture extension can't send the Clerk cookie, so
  // this route checks an X-Capture-Token in its own handler instead. Listing it
  // here only stops this middleware answering 401 before that check can run.
  // Exact path on purpose — /api/capture/connect must stay Clerk-protected.
  "/api/capture",
  // Same reason: the side panel calls this with its token. The handler accepts
  // a Clerk session or a valid token, and rejects everything else.
  "/api/capture/deadline",
  // AI connectors (MCP). Same reason again: Claude and ChatGPT send an OAuth
  // bearer token, not the Clerk cookie, and the handler verifies it (audience
  // included) itself. Exact path — /api/mcp/clients must stay Clerk-protected.
  "/api/mcp",
  // The daily waiting-task job. Vercel's cron call carries a Bearer
  // CRON_SECRET, not the Clerk cookie, and the handler checks it before
  // anything else. Exact path.
  "/api/cron/stale-tasks",
  // RFC 9728 metadata telling those apps where to sign in. Public by design.
  "/.well-known/oauth-protected-resource(.*)",
  // Clerk's authorization-server metadata, mirrored for older MCP clients.
  "/.well-known/oauth-authorization-server",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  // API routes answer 401 rather than redirecting to a sign-in page, so the
  // client sees the same shape the route handlers already return.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return;
  }

  await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
