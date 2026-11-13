import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth } from "@clerk/nextjs/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { buildMcpDependencies, registerRelayMailTools } from "../../lib/relay/mcp/server.ts";

export const runtime = "nodejs";

const handler = createMcpHandler(
  async (server) => {
    const deps = await buildMcpDependencies();
    registerRelayMailTools(server, deps);
  },
  {},
  { basePath: "", disableSse: true, maxDuration: 60 },
);

const authHandler = withMcpAuth(
  handler,
  async (_request, token) => {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    return verifyClerkToken(clerkAuth, token);
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  },
);

export { authHandler as GET, authHandler as POST };
