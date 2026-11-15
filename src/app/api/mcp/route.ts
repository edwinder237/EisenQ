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
// included, so a Clerk token issued for anything else is refused.

export const dynamic = "force-dynamic";

async function handler(req: Request): Promise<Response> {
  const token = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return unauthorized();

  const clerk = await clerkClient();
  const state = await clerk.authenticateRequest(req, { acceptsToken: "oauth_token", audience: MCP_RESOURCE_URL });
  const authInfo = verifyClerkToken(state.toAuth(), token);
  const userId = authInfo?.extra?.userId;
  if (!authInfo || typeof userId !== "string") return unauthorized();

  return handleVerifiedMcpRequest(req, authInfo, userId);
}

export { handler as GET, handler as POST, handler as DELETE };
