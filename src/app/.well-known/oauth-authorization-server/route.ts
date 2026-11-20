import { authServerMetadataHandlerClerk, metadataCorsOptionsRequestHandler } from "@clerk/mcp-tools/next";

// RFC 8414 authorization-server metadata, mirrored from Clerk. Older MCP
// clients skip the protected-resource step and look for this on the MCP
// server's own host; it points them at Clerk's authorize, token and
// registration endpoints.
const handler = authServerMetadataHandlerClerk();
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
