import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Deny by default: everything the matcher below reaches requires a signed-in
// user unless it is listed here. A new route is private until it is added,
// rather than public until someone remembers to guard it.
//
// /capture needs no entry: being private is what gives a signed-out user the
// sign-in screen and returns them to a pre-filled capture form. The token-
// authenticated /api/capture route of Phase 1 is the opposite case — it must be
// listed here, or this middleware answers 401 before the handler can check the
// token. See docs/chrome-extension-capture-design.md.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/contact",
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
