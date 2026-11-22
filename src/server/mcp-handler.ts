import type { AuthInfo } from "@modelcontextprotocol/server";
import { CLIENT_INFO_META_KEY, createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer, type McpCallContext } from "~/server/mcp-server";
import { MCP_METADATA_URL, loadMcpSettings, touchClient } from "~/server/mcp-settings";
import { friendlyAppName } from "~/lib/task-source";

// Everything /api/mcp does once the bearer token is verified: the master
// switch, revoked apps, client tracking, and a server built for exactly what
// the person's settings allow. Kept apart from the Clerk check so it can be
// exercised without a real token.

const mcp = createMcpHandler((ctx) => {
  const call = ctx.authInfo?.extra?.eisenq as McpCallContext | undefined;
  if (!call) throw new Error("MCP request reached the server without a verified caller");
  return buildMcpServer(call);
});

export function unauthorized() {
  return new Response(JSON.stringify({ error: "Sign in to EisenQ to use this connector." }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${MCP_METADATA_URL}"`,
    },
  });
}

/** Refusal the AI app can show the person, as a JSON-RPC error. */
function refused(message: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

const KNOWN_APPS: [RegExp, string][] = [
  [/(^|\.)claude\.ai$|(^|\.)anthropic\.com$/, "Claude"],
  [/(^|\.)openai\.com$|(^|\.)chatgpt\.com$/, "ChatGPT"],
];

/**
 * Best human name for the calling app: what the client says about itself in
 * this request, else the host of its client-metadata URL, else nothing.
 */
async function clientNameFrom(req: Request, clientId: string): Promise<string | undefined> {
  // The client-metadata URL's host is the most reliable signal (claude.ai →
  // Claude); the name a client reports about itself ("Anthropic/Toolbox") is
  // only a fallback, and is cleaned up the same way the dashboard shows it.
  try {
    const host = new URL(clientId).hostname;
    const known = KNOWN_APPS.find(([re]) => re.test(host))?.[1];
    if (known) return known;
  } catch {
    /* an opaque client id, not a metadata URL */
  }
  if (req.method === "POST") {
    try {
      const body = (await req.clone().json()) as {
        params?: { clientInfo?: { name?: unknown }; _meta?: Record<string, { name?: unknown } | undefined> };
      };
      const name = body.params?._meta?.[CLIENT_INFO_META_KEY]?.name ?? body.params?.clientInfo?.name;
      if (typeof name === "string" && name.trim()) return friendlyAppName(name.slice(0, 60));
    } catch {
      /* not JSON, or a batch; fall through */
    }
  }
  try {
    return new URL(clientId).hostname;
  } catch {
    return undefined;
  }
}

/** Serves one MCP request for a caller whose token has already been verified. */
export async function handleVerifiedMcpRequest(req: Request, authInfo: AuthInfo, userId: string): Promise<Response> {
  const { mcp: settings, autoArchiveCompleted } = await loadMcpSettings(userId);
  if (!settings.enabled) {
    return refused("AI connectors are switched off in EisenQ. Turn them on in Settings → Integrations → AI connectors.");
  }

  const clientId = authInfo.clientId;
  const known = settings.clients.find((c) => c.clientId === clientId);
  if (known?.blocked) {
    return refused("This app's access to EisenQ was revoked. Allow it again in EisenQ → Settings → Integrations → AI connectors.");
  }
  const client = await touchClient(userId, settings, clientId, await clientNameFrom(req, clientId));

  const call: McpCallContext = {
    userId,
    clientId,
    clientName: client.name,
    mcp: settings,
    autoArchive: autoArchiveCompleted,
  };
  return mcp.fetch(req, {
    authInfo: { ...authInfo, resourceMetadataUrl: MCP_METADATA_URL, extra: { ...authInfo.extra, eisenq: call } },
  });
}
