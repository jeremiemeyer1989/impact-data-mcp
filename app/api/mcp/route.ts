// MCP route for /api/mcp.
// This is the public entry point. It checks the shared API key, then exposes
// the four impact-data tools. The key is compared and then discarded so it is
// never written to a log.

import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerImpactTools } from "../../../lib/tools";

const handler = createMcpHandler(
  (server) => {
    registerImpactTools(server);
  },
  {
    serverInfo: {
      name: "impact-data",
      version: "0.1.0",
    },
  },
);

function apiKeysMatch(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

const verifyToken = async (
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const expected = process.env.MCP_API_KEY?.trim();
  if (!expected || !bearerToken || !apiKeysMatch(bearerToken, expected)) {
    return undefined;
  }
  return {
    token: "accepted",
    clientId: "shared-api-key",
    scopes: ["mcp"],
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };

export const runtime = "nodejs";
// Comparing a definition calls Claude, which can take longer than the default
// function limit on Vercel.
export const maxDuration = 60;
