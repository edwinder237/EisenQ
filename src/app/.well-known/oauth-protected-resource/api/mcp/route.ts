import { metadataCorsOptionsRequestHandler, protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";
import { MCP_RESOURCE_URL } from "~/server/mcp-settings";

// RFC 9728 protected-resource metadata for the AI connectors endpoint. Claude
// and ChatGPT read this after a 401 from /api/mcp to learn that Clerk is the
// sign-in server, then send the person through the normal EisenQ sign-in.
const handler = protectedResourceHandlerClerk({ resource: MCP_RESOURCE_URL });
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
