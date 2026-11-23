import { clerkClient } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { MCP_RESOURCE_URL } from "~/server/mcp-settings";
import { handleVerifiedMcpRequest, unauthorized } from "~/server/mcp-handler";

// AI connectors endpoint: add https://www.eisenq.app/api/mcp as a custom
// connector in Claude or ChatGPT. Stateless — every request is authenticated
// here, then checked against the person's AI connector settings and served by
// ~/server/mcp-handler.
//
// Public in middleware.ts on purpose: the token is checked here, audience
// included, so a Clerk token issued for some other resource is refused.

export const dynamic = "force-dynamic";

// The connector URL as people may type it. Clerk copies whatever the app sent
// as `resource` into the token's audience, so match the common spellings.
const ACCEPTED_AUDIENCES = [
  MCP_RESOURCE_URL,
  `${MCP_RESOURCE_URL}/`,
  MCP_RESOURCE_URL.replace("://www.", "://"),
  `${MCP_RESOURCE_URL.replace("://www.", "://")}/`,
];

/** True when Clerk recognises the token and it carries no audience. False on any error. */
async function hasNoAudience(clerk: Awaited<ReturnType<typeof clerkClient>>, token: string): Promise<boolean> {
  try {
    const verified = await clerk.idPOAuthAccessToken.verify(token);
    const aud = (verified as { aud?: unknown }).aud;
    return aud === undefined || aud === null || aud === "" || (Array.isArray(aud) && aud.length === 0);
  } catch {
    return false;
  }
}

async function handler(req: Request): Promise<Response> {
  const token = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return unauthorized();

  const clerk = await clerkClient();
  let state = await clerk.authenticateRequest(req, { acceptsToken: "oauth_token", audience: ACCEPTED_AUDIENCES });
  if (!state.isAuthenticated && (await hasNoAudience(clerk, token))) {
    // Some apps (Muse, for one) sign in without RFC 8707's `resource`
    // parameter, so Clerk issues the token with no audience at all. Accept
    // those once Clerk has verified the token itself. A token bound to some
    // OTHER audience still fails above and is never retried here.
    state = await clerk.authenticateRequest(req, { acceptsToken: "oauth_token" });
  }
  const authInfo = verifyClerkToken(state.toAuth(), token);
  const userId = authInfo?.extra?.userId;
  if (!authInfo || typeof userId !== "string") {
    console.warn("[mcp] token rejected:", state.reason ?? "unknown", state.message ?? "");
    return unauthorized();
  }

  return handleVerifiedMcpRequest(req, authInfo, userId);
}

export { handler as GET, handler as POST, handler as DELETE };
