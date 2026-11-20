import { metadataCorsOptionsRequestHandler, protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";
import { MCP_RESOURCE_URL } from "~/server/mcp-settings";

// Same RFC 9728 metadata as /.well-known/oauth-protected-resource/api/mcp,
// at the site root. Clients given only the host (Muse / Meta AI) look here
// instead of at the path-suffixed URL.
const handler = protectedResourceHandlerClerk({ resource: MCP_RESOURCE_URL });
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
